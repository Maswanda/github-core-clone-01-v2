// store.ts — in-memory forge store and the Git object model.
//
// Everything the forge serves lives here: repositories, their objects, refs,
// issues, pull requests, labels and comments. No filesystem, no network, no
// git binary. The object model implements git's formats directly (SHA-1 ids,
// commit/tree/tag objects, reachability) from the format's own rules.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** A fixed identity for commits the forge itself writes (deterministic). */
export const FORGE_IDENTITY = 'Forge <forge@localhost>';
/** First timestamp for forge-written commits; a counter keeps them distinct. */
export const FORGE_EPOCH = 1_700_000_000;

// -------------------------------------------------------------------------------------------
// Object ids
// -------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// -------------------------------------------------------------------------------------------
// Trees
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in the order they are stored. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory read as if it ended in '/'. */
function treeNameKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeNameKey(a), treeNameKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Commits and tags
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object; the header block ends at the first blank line. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export interface CommitBuild {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}

/** Build a commit object's bytes. The message is stored with a trailing newline. */
export function buildCommit(fields: CommitBuild): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagBuild {
  object: string;
  type: ObjType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: TagBuild): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${message}`,
    'utf8',
  );
}

// -------------------------------------------------------------------------------------------
// Reachability
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: a commit reaches its tree and parents, a
 * tag its target, a tree its entries (gitlinks excluded), a blob nothing. One
 * call takes every root, so a fetch walks the history once.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) {
    if (isObjectId(root)) stack.push(root);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/**
 * A merge base of two commits: the common ancestor closest to both. A breadth
 * walk from each side, with a head index instead of shift(), finds it.
 */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const depthA = new Map<string, number>();
  const queueA: string[] = [a];
  let headA = 0;
  depthA.set(a, 0);
  while (headA < queueA.length) {
    const oid = queueA[headA++] as string;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const depth = (depthA.get(oid) as number) + 1;
    for (const parent of parseCommit(object.data).parents) {
      if (!depthA.has(parent)) {
        depthA.set(parent, depth);
        queueA.push(parent);
      }
    }
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  let headB = 0;
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  while (headB < queueB.length) {
    const oid = queueB[headB++] as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthInA = depthA.get(oid);
    if (depthInA !== undefined) {
      const total = depthInA + headB;
      if (total < bestDepth) {
        bestDepth = total;
        best = oid;
      }
      continue;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return best;
}

/** Follow a tag (or a commit) down to the commit it names, or null. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current: string | undefined = oid;
  const seen = new Set<string>();
  while (current !== undefined) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Tree paths
// -------------------------------------------------------------------------------------------

export type PathLookup =
  | { kind: 'file'; oid: string; mode: string }
  | { kind: 'dir'; oid: string; entries: TreeEntry[] }
  | { kind: 'missing' };

/**
 * Resolve one path against a tree, walking only the trees on the path (no
 * flattening). Returns the file, the directory, or missing.
 */
export function lookupTreePath(repo: Repo, rootTreeOid: string, path: string): PathLookup {
  const segments = path.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.length === 0) {
    const object = repo.objects.get(rootTreeOid);
    if (!object || object.type !== 'tree') return { kind: 'missing' };
    return { kind: 'dir', oid: rootTreeOid, entries: parseTree(object.data) };
  }
  let treeOid = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return { kind: 'missing' };
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return { kind: 'missing' };
    const last = index === segments.length - 1;
    if (last) {
      if (entry.mode === '40000') {
        const child = repo.objects.get(entry.oid);
        if (!child || child.type !== 'tree') return { kind: 'missing' };
        return { kind: 'dir', oid: entry.oid, entries: parseTree(child.data) };
      }
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return { kind: 'missing' };
    treeOid = entry.oid;
  }
  return { kind: 'missing' };
}

/** The direct children of one tree object. */
export function treeChildren(repo: Repo, treeOid: string): TreeEntry[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/**
 * Rebuild only the trees on `path` (plus their ancestors to the root) after a
 * file is written or removed. `blobOid` null removes the file. Directories left
 * empty by a removal are pruned; an emptied root becomes the empty tree.
 */
export function updateTreePath(
  repo: Repo,
  rootTreeOid: string,
  path: string,
  blobOid: string | null,
): string {
  const segments = path.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.length === 0) return rootTreeOid;
  const rebuild = (treeOid: string, depth: number): string | null => {
    const object = repo.objects.get(treeOid);
    const entries: TreeEntry[] = object && object.type === 'tree' ? parseTree(object.data) : [];
    const name = segments[depth] as string;
    const last = depth === segments.length - 1;
    const at = entries.findIndex((entry) => entry.name === name);
    if (last) {
      if (blobOid === null) {
        if (at < 0) return entries.length === 0 ? null : storeTree(repo, entries);
        entries.splice(at, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (at < 0) entries.push(entry);
        else entries[at] = entry;
      }
    } else {
      const childOid = at < 0 ? storeTree(repo, []) : entries[at].oid;
      const rebuilt = rebuild(childOid, depth + 1);
      if (rebuilt === null) {
        if (at >= 0) entries.splice(at, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: rebuilt };
        if (at < 0) entries.push(entry);
        else entries[at] = entry;
      }
    }
    if (entries.length === 0) return null;
    return storeTree(repo, entries);
  };
  const result = rebuild(rootTreeOid, 0);
  if (result === null) return storeTree(repo, []);
  return result;
}

/** Store a tree object built from entries and return its id. */
export function storeTree(repo: Repo, entries: readonly TreeEntry[]): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Store any object and return its id. */
export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The whole tree flattened to path -> {oid, mode}, for diffs and listings. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Walk commits newest-first from a tip, following first parents only. */
export function walkCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length && out.length < limit) {
    const oid = queue[head++] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// The forge store
// -------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  databaseId: number;
}

export interface Store {
  /** The login the bearer token names, learned from the first owner in a URL. */
  viewerLogin: string | null;
  viewerName: string;
  viewerEmail: string;
  repos: Map<string, Repo>;
  nextDatabaseId: number;
  commitClock: number;
  requestSeq: number;
}

export function createStore(): Store {
  return {
    viewerLogin: null,
    viewerName: 'Forge User',
    viewerEmail: 'forge@localhost',
    repos: new Map<string, Repo>(),
    nextDatabaseId: 1,
    commitClock: FORGE_EPOCH,
    requestSeq: 0,
  };
}

/** The next deterministic timestamp for a forge-written commit. */
export function nextCommitTime(store: Store): number {
  store.commitClock += 1;
  return store.commitClock;
}

/** A repo's key in the store: its lowercase name (every repo belongs to the viewer). */
export function repoKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Learn the viewer login from an owner in a request URL, then look the repo up.
 * A repo under another owner is never this token's: null, never an error.
 */
export function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const wanted = owner.toLowerCase();
  // An empty owner names nobody: never learn the viewer login from it, and
  // never match a repository through it (a collapsed empty segment in a URL
  // must not shift a later segment into the owner's place).
  if (wanted === '' || name === '') return null;
  if (store.viewerLogin === null) {
    store.viewerLogin = wanted;
    store.viewerName = owner;
    store.viewerEmail = `${wanted}@example.invalid`;
    // Repositories created before the login was learned carry an empty owner;
    // stamp the learned login on them so every id and full_name agrees.
    for (const repo of store.repos.values()) {
      if (repo.owner === '') repo.owner = owner;
    }
  }
  if (wanted !== store.viewerLogin) return null;
  return store.repos.get(repoKey(name)) ?? null;
}

/** The viewer login as the token names it, once any owner-bearing request arrived. */
export function viewerLogin(store: Store): string | null {
  return store.viewerLogin;
}

export function createRepo(
  store: Store,
  name: string,
  options: { description?: string; private?: boolean } = {},
): Repo {
  const owner = store.viewerLogin ?? '';
  const repo: Repo = {
    owner,
    name,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: 'main',
    refs: new Map<string, string>(),
    objects: new Map<string, GitObject>(),
    issues: new Map<number, Issue>(),
    pulls: new Map<number, Pull>(),
    labels: new Map<string, Label>(),
    nextNumber: 1,
    nextCommentId: 1,
    databaseId: store.nextDatabaseId++,
  };
  store.repos.set(repoKey(name), repo);
  return repo;
}

/** Delete a repository and everything in it. */
export function deleteRepo(store: Store, name: string): boolean {
  return store.repos.delete(repoKey(name));
}

/** A fresh request id (counter-based, so nothing random reaches a reply). */
export function nextRequestId(store: Store): string {
  store.requestSeq += 1;
  return `req-${store.requestSeq.toString(16).padStart(8, '0')}`;
}

// -------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, never the plain numeric id.
// -------------------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return `R_${b64url(`${repo.owner}/${repo.name}`)}`;
}

export function issueGlobalId(repo: Repo, number: number): string {
  return `I_${b64url(`${repo.owner}/${repo.name}#${number}`)}`;
}

export function pullGlobalId(repo: Repo, number: number): string {
  return `PR_${b64url(`${repo.owner}/${repo.name}#${number}`)}`;
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return `C_${b64url(`${repo.owner}/${repo.name}#${issueNumber}:${commentId}`)}`;
}

/** Resolve an opaque global id back to its repo and kind, or null. */
export function parseGlobalId(
  store: Store,
  id: string,
): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo: Repo; number: number; commentId: number } | null {
  const match = /^(R|I|PR|C)_(.+)$/.exec(id);
  if (!match) return null;
  let text: string;
  try {
    text = Buffer.from(match[2] as string, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const hash = text.indexOf('#');
  if (hash < 0) return null;
  const ownerName = text.slice(0, hash);
  const slash = ownerName.lastIndexOf('/');
  if (slash < 0) return null;
  const owner = ownerName.slice(0, slash);
  const name = ownerName.slice(slash + 1);
  const repo = resolveRepo(store, owner, name);
  if (!repo) return null;
  const rest = text.slice(hash + 1);
  const kind = match[1] as string;
  if (kind === 'R') return { kind: 'repo', repo, number: 0, commentId: 0 };
  if (kind === 'I' || kind === 'PR') {
    const number = Number.parseInt(rest, 10);
    if (!Number.isInteger(number)) return null;
    return { kind: kind === 'I' ? 'issue' : 'pull', repo, number, commentId: 0 };
  }
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const number = Number.parseInt(rest.slice(0, colon), 10);
  const commentId = Number.parseInt(rest.slice(colon + 1), 10);
  if (!Number.isInteger(number) || !Number.isInteger(commentId)) return null;
  return { kind: 'comment', repo, number, commentId };
}
