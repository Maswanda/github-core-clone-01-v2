// rest.ts — GitHub REST v3 surface for the forge, plus the shared service layer
// GraphQL and MCP build on (issues, pull requests, contents commits, merges).
//
// The contract is the kit's conformance suite: every reply is application/json
// with a non-empty X-GitHub-Request-Id; errors are JSON {"message": string}; a
// request without a bearer token is 401; a repository under another owner is
// 404, never 403. Repositories, issues, pulls and comments live in the store;
// contents commits are real git objects (blob/tree/commit) so a push, a clone
// and the REST view always agree on the same bytes.

import {
  buildCommit,
  buildTree,
  createRepo,
  deleteRepo,
  findMergeBase,
  flattenTree,
  hashObject,
  isObjectId,
  lookupTreePath,
  nextCommitTime,
  nextRequestId,
  parseCommit,
  parseTree,
  resolveRepo,
  storeObject,
  storeTree,
  updateTreePath,
  walkCommits,
  FORGE_IDENTITY,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Replies and errors
// -------------------------------------------------------------------------------------------

export interface RestReply {
  status: number;
  /** null means "no body" (a 204). */
  body: unknown;
  headers?: Record<string, string>;
}

/** An error that maps straight onto a REST status and a {"message"} body. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** The owner a repository belongs to: its stored owner, or the viewer login the store learned. */
export function effectiveOwner(store: Store, repo: Repo): string {
  if (repo.owner !== '') return repo.owner;
  return store.viewerLogin ?? '';
}

/** Opaque, stable Relay ids, computed from the effective owner (never the plain number). */
export function repoNodeId(store: Store, repo: Repo): string {
  return `R_${b64url(`${effectiveOwner(store, repo)}/${repo.name}`)}`;
}

export function issueNodeId(store: Store, repo: Repo, number: number): string {
  return `I_${b64url(`${effectiveOwner(store, repo)}/${repo.name}#${number}`)}`;
}

export function pullNodeId(store: Store, repo: Repo, number: number): string {
  return `PR_${b64url(`${effectiveOwner(store, repo)}/${repo.name}#${number}`)}`;
}

export function commentNodeId(store: Store, repo: Repo, issueNumber: number, commentId: number): string {
  return `C_${b64url(`${effectiveOwner(store, repo)}/${repo.name}#${issueNumber}:${commentId}`)}`;
}

// -------------------------------------------------------------------------------------------
// Auth
// -------------------------------------------------------------------------------------------

/** The bearer token this process was given, or null when none was configured. */
export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return token === '' ? null : token;
}

/** True when the request carries a bearer token this forge accepts. */
export function authorized(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  if (!match) return false;
  const token = (match[1] as string).trim();
  if (token === '') return false;
  const expected = expectedToken();
  if (expected === null) return true;
  return token === expected;
}

function requireAuth(headers: Record<string, string | string[] | undefined>): void {
  if (!authorized(headers)) throw new ApiError(401, 'Requires authentication');
}

/** Parse a request body as JSON: empty is {}, malformed is a 400. */
export function parseJsonBody(rawBody: Buffer): Record<string, unknown> {
  if (rawBody.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bodyBoolean(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = effectiveOwner(store, repo);
  return {
    id: repo.databaseId,
    node_id: repoNodeId(store, repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label: Label | undefined = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueNodeId(store, repo, issue.number),
    node_id: issueNodeId(store, repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: effectiveOwner(store, repo), type: 'User' },
  };
}

export function commentJson(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: commentNodeId(store, repo, issue.number, comment.id),
    node_id: commentNodeId(store, repo, issue.number, comment.id),
    number: comment.id,
    body: comment.body,
    user: { login: effectiveOwner(store, repo), type: 'User' },
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = effectiveOwner(store, repo);
  return {
    id: pullNodeId(store, repo, pull.number),
    node_id: pullNodeId(store, repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, type: 'User' },
  };
}

export function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

/** "Name <email> 1700000001 +0000" -> {name, email, date} (ISO). */
function identityParts(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(identity.trim());
  if (!match) return { name: identity, email: '', date: '' };
  const timestamp = Number.parseInt(match[3] as string, 10);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : '',
  };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') throw notFound('Not Found');
  const view = parseCommit(object.data);
  const author = identityParts(view.author || `${FORGE_IDENTITY} 1700000000 +0000`);
  const committer = identityParts(view.committer || `${FORGE_IDENTITY} 1700000000 +0000`);
  return {
    sha,
    commit: {
      message: view.message,
      author,
      committer,
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

// -------------------------------------------------------------------------------------------
// Shared service layer (REST, GraphQL and MCP all build on this)
// -------------------------------------------------------------------------------------------

/** Resolve a repository or raise a 404 (a foreign owner is 404, never 403). */
export function resolveRepoOr404(store: Store, owner: string, name: string): Repo {
  const repo = resolveRepo(store, owner, name);
  if (!repo) throw notFound('Not Found');
  return repo;
}

/** Create an issue; an unknown label is a 422. */
export function createIssueInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: readonly string[] },
): Issue {
  const title = input.title;
  if (title === '') throw new ApiError(422, 'title is required');
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) throw new ApiError(422, `label ${JSON.stringify(name)} does not exist`);
    labels.push(name);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: number,
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Close (or reopen) an issue. */
export function setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): Issue {
  issue.state = state;
  return issue;
}

/** Append a comment to an issue. */
export function addCommentToIssue(repo: Repo, issue: Issue, body: string): Comment {
  const comment: Comment = { id: repo.nextCommentId, body };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

/** The tip commit of a branch, or null when the branch has no commits yet. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** One contents commit on a branch: write (or replace) a file, or delete it when blob is null. */
export function commitFileOnBranch(
  store: Store,
  repo: Repo,
  options: { path: string; content: Buffer | null; message: string; branch?: string; sha?: string },
): { contentSha: string | null; commitSha: string; created: boolean } {
  const branch = options.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined) {
    // A new branch starts at the default branch tip (or unborn, for the first commit).
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) {
      tip = baseTip;
      repo.refs.set(refName, tip);
    }
  }
  const currentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const existing = currentTree === null ? { kind: 'missing' as const } : lookupTreePath(repo, currentTree, options.path);
  if (options.sha !== undefined) {
    if (existing.kind !== 'file' || existing.oid !== options.sha) {
      throw new ApiError(409, 'sha does not match the current file');
    }
  }
  const created = existing.kind === 'missing';
  let blobOid: string | null = null;
  if (options.content !== null) {
    blobOid = storeObject(repo, 'blob', options.content);
  }
  const baseTreeOid = currentTree ?? storeTree(repo, []);
  const newTree = updateTreePath(repo, baseTreeOid, options.path, blobOid);
  const timestamp = nextCommitTime(store);
  const commitData = buildCommit({
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    message: options.message,
    timestamp,
  });
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  return { contentSha: blobOid, commitSha, created };
}

/** Read one file (or directory) from a ref's tree. */
export function readContentAt(
  repo: Repo,
  ref: string | null,
  path: string,
): { kind: 'file'; oid: string; mode: string; size: number; content: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> } | { kind: 'missing' } {
  let tip: string | undefined;
  if (ref === null || ref === '') {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  } else if (isObjectId(ref)) {
    tip = ref;
  } else {
    tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  }
  if (tip === undefined) return { kind: 'missing' };
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return { kind: 'missing' };
  const rootTree = parseCommit(object.data).tree;
  const found = lookupTreePath(repo, rootTree, path);
  if (found.kind === 'missing') return { kind: 'missing' };
  if (found.kind === 'file') {
    const blob = repo.objects.get(found.oid);
    if (!blob) return { kind: 'missing' };
    return { kind: 'file', oid: found.oid, mode: found.mode, size: blob.data.length, content: blob.data };
  }
  const entries = found.entries.map((entry) => {
    const child = repo.objects.get(entry.oid);
    const isDir = entry.mode === '40000';
    return {
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      type: (isDir ? 'dir' : 'file') as 'file' | 'dir',
      size: isDir || !child ? 0 : child.data.length,
    };
  });
  return { kind: 'dir', entries };
}

// -------------------------------------------------------------------------------------------
// Diffs, files and merges
// -------------------------------------------------------------------------------------------

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(content: Buffer): string[] {
  if (content.length === 0) return [];
  const lines = content.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts between two versions of a file (a small multiset diff). */
function lineCounts(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : countLines(oldContent);
  const newLines = newContent === null ? [] : countLines(newContent);
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of remaining.values()) deletions += left;
  return { additions, deletions };
}

/** The file-level diff between two commit trees. */
export function diffTrees(repo: Repo, baseSha: string, headSha: string): FileChange[] {
  const baseObject = repo.objects.get(baseSha);
  const headObject = repo.objects.get(headSha);
  if (!baseObject || baseObject.type !== 'commit' || !headObject || headObject.type !== 'commit') return [];
  const baseFlat = flattenTree(repo, parseCommit(baseObject.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headObject.data).tree);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    const oldContent = base === undefined ? null : (repo.objects.get(base.oid)?.data ?? null);
    const newContent = head === undefined ? null : (repo.objects.get(head.oid)?.data ?? null);
    const counts = lineCounts(oldContent, newContent);
    const status = base === undefined ? 'added' : head === undefined ? 'removed' : 'modified';
    changes.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

/** The three-way change sets a squash merge compares (merge-base -> each side). */
function sideChanges(repo: Repo, mergeBase: string, tip: string): Map<string, string | null> {
  const baseObject = repo.objects.get(mergeBase);
  const tipObject = repo.objects.get(tip);
  const out = new Map<string, string | null>();
  if (!baseObject || baseObject.type !== 'commit' || !tipObject || tipObject.type !== 'commit') return out;
  const baseFlat = flattenTree(repo, parseCommit(baseObject.data).tree);
  const tipFlat = flattenTree(repo, parseCommit(tipObject.data).tree);
  for (const path of new Set<string>([...baseFlat.keys(), ...tipFlat.keys()])) {
    const base = baseFlat.get(path);
    const tipEntry = tipFlat.get(path);
    if (base?.oid === tipEntry?.oid) continue;
    out.set(path, tipEntry === undefined ? null : tipEntry.oid);
  }
  return out;
}

/** True when a squash of `head` onto `base` would conflict (both sides changed a path differently). */
export function mergeConflicts(repo: Repo, headSha: string, baseSha: string): boolean {
  const mergeBase = findMergeBase(repo, headSha, baseSha);
  if (mergeBase === null) return false;
  const headSide = sideChanges(repo, mergeBase, headSha);
  const baseSide = sideChanges(repo, mergeBase, baseSha);
  for (const [path, headOid] of headSide) {
    if (!baseSide.has(path)) continue;
    if (baseSide.get(path) !== headOid) return true;
  }
  return false;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request's head against its base. */
export function mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const mergeBase = findMergeBase(repo, pull.headSha, pull.baseSha);
  if (mergeBase === null) return 'UNKNOWN';
  return mergeConflicts(repo, pull.headSha, pull.baseSha) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Create a pull request from a head branch onto a base branch. */
export function createPullInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === null || baseSha === null) {
    throw new ApiError(422, 'head or base branch does not exist');
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === input.head && existing.base === input.base) {
      throw new ApiError(422, 'a pull request is already open for this head and base');
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head: input.head,
    base: input.base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: number,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Squash-merge a pull request onto its base branch. */
export function mergePullInRepo(store: Store, repo: Repo, pull: Pull): { sha: string } {
  if (pull.merged || pull.state !== 'open') throw new ApiError(405, 'pull request is already merged or closed');
  const headObject = repo.objects.get(pull.headSha);
  const baseTip = branchTip(repo, pull.base);
  if (!headObject || headObject.type !== 'commit' || baseTip === null) {
    throw new ApiError(405, 'pull request cannot be merged');
  }
  if (mergeConflicts(repo, pull.headSha, baseTip)) {
    throw new ApiError(405, 'merge conflict');
  }
  const headTree = parseCommit(headObject.data).tree;
  const timestamp = nextCommitTime(store);
  const commitData = buildCommit({
    tree: headTree,
    parents: [baseTip],
    message: `${pull.title} (#${pull.number})`,
    timestamp,
  });
  const sha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(timestamp * 1000).toISOString();
  pull.mergeCommitSha = sha;
  return { sha };
}

// -------------------------------------------------------------------------------------------
// The router
// -------------------------------------------------------------------------------------------

type Query = URLSearchParams;

function pageParams(query: Query): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: Query): { page: T[]; total: number; pageNumber: number; perPage: number } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNumber: page, perPage };
}

/** A Link header for the next page, or null when this page is the last. */
function nextLink(host: string, path: string, query: Query, total: number): string | null {
  const { page, perPage } = pageParams(query);
  if (page * perPage >= total) return null;
  const url = new URL(`http://${host}${path}`);
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('per_page', String(perPage));
  return `<${url.toString()}>; rel="next"`;
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, body, headers };
}

function replyWithRequestId(store: Store, status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return reply(status, body, { 'x-github-request-id': nextRequestId(store), ...headers });
}

/** Sort issues by creation order (seq); direction 'asc' or 'desc'. */
function sortIssues(issues: Issue[], direction: string): Issue[] {
  const sorted = [...issues].sort((a, b) => a.seq - b.seq);
  return direction === 'desc' ? sorted.reverse() : sorted;
}

function filterIssuesByState(issues: Issue[], state: string | null): Issue[] {
  if (state === null || state === '' || state === 'open') return issues.filter((issue) => issue.state === 'open');
  if (state === 'closed') return issues.filter((issue) => issue.state === 'closed');
  return issues;
}

/** The one entry point app.ts calls for everything under /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: Query,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  host: string,
): RestReply {
  try {
    return route(store, method, segments, query, headers, rawBody, host);
  } catch (err) {
    if (err instanceof ApiError) {
      return replyWithRequestId(store, err.status, { message: err.message });
    }
    return replyWithRequestId(store, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

function route(
  store: Store,
  method: string,
  segments: readonly string[],
  query: Query,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  host: string,
): RestReply {
  // The API root and the version probe need no token; everything else does.
  if (segments.length === 0) {
    if (method !== 'GET') throw notFound();
    return replyWithRequestId(store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') throw notFound();
    return replyWithRequestId(store, 200, { installed_version: '1.0.0' });
  }

  requireAuth(headers);
  const body = method === 'GET' || method === 'HEAD' ? {} : parseJsonBody(rawBody);
  const ok = (status: number, payload: unknown, extra: Record<string, string> = {}): RestReply =>
    replyWithRequestId(store, status, payload, extra);

  const [first, second, third, fourth, fifth, sixth, seventh] = segments as (string | undefined)[];

  // GET /api/v3/user — the token owner's login.
  if (first === 'user' && segments.length === 1) {
    if (method !== 'GET') throw notFound();
    const login = store.viewerLogin ?? '';
    return ok(200, { login, name: store.viewerName, email: store.viewerEmail, type: 'User' });
  }

  // /api/v3/user/repos — list (paginated) and create.
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = [...store.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
      const { page, total, pageNumber, perPage } = paginate(repos, query);
      const link = nextLink(host, '/api/v3/user/repos', query, total);
      void pageNumber;
      void perPage;
      return ok(200, page.map((repo) => repoJson(store, repo)), link === null ? {} : { link });
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === '') throw new ApiError(422, 'name is required');
      if (store.repos.has(name.toLowerCase())) throw new ApiError(422, 'Repository already exists');
      const repo = createRepo(store, name, {
        description: bodyString(body, 'description'),
        private: bodyBoolean(body, 'private', false),
      });
      return ok(201, repoJson(store, repo));
    }
    throw notFound();
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second as string;
    const name = third as string;
    const repo = resolveRepoOr404(store, owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        deleteRepo(store, name);
        return { status: 204, body: null, headers: { 'x-github-request-id': nextRequestId(store) } };
      }
      throw notFound();
    }

    // git refs: POST /git/refs, GET /git/refs, GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') {
          const ref = bodyString(body, 'ref');
          const sha = bodyString(body, 'sha');
          if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) throw new ApiError(422, 'invalid ref or sha');
          if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
          const target = repo.objects.get(sha);
          if (!target || target.type !== 'commit') throw new ApiError(422, 'object is not a commit');
          repo.refs.set(ref, sha);
          return ok(201, { ref, object: { sha, type: 'commit' } });
        }
        if (method === 'GET') {
          const refs = [...repo.refs.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
          return ok(200, refs);
        }
        throw notFound();
      }
      if (rest[2] === 'heads' && rest.length >= 4) {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) throw notFound();
        if (method !== 'GET') throw notFound();
        return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      }
      throw notFound();
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') throw notFound();
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) as string));
        return ok(200, branches);
      }
      if (rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) throw notFound();
        if (method !== 'GET') throw notFound();
        return ok(200, branchJson(repo, branch, sha));
      }
      throw notFound();
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') throw notFound();
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam === null || shaParam === '') {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      } else if (isObjectId(shaParam)) {
        tip = shaParam;
      } else {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam);
      }
      if (tip === undefined) return ok(200, []);
      const shas = walkCommits(repo, tip);
      return ok(200, shas.map((sha) => commitJson(repo, sha)));
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const found = readContentAt(repo, ref, path);
        if (found.kind === 'missing') throw notFound();
        if (found.kind === 'file') {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            content: b64encode(found.content),
            sha: found.oid,
            size: found.size,
            name: path.split('/').pop() ?? path,
            path,
          });
        }
        return ok(
          200,
          found.entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
          })),
        );
      }
      if (method === 'PUT') {
        const message = bodyString(body, 'message');
        const contentB64 = bodyString(body, 'content');
        if (contentB64 === '') throw new ApiError(422, 'content is required');
        const content = b64decode(contentB64);
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
        const result = commitFileOnBranch(store, repo, { path, content, message, branch, sha });
        return ok(result.created ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const message = bodyString(body, 'message');
        const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
        const before = readContentAt(repo, null, path);
        if (before.kind !== 'file') throw notFound();
        const result = commitFileOnBranch(store, repo, { path, content: null, message, sha });
        return ok(200, { commit: { sha: result.commitSha, message } });
      }
      throw notFound();
    }

    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const nameLabel = bodyString(body, 'name');
          if (nameLabel === '') throw new ApiError(422, 'name is required');
          const color = bodyString(body, 'color') || 'ededed';
          repo.labels.set(nameLabel, { name: nameLabel, color });
          return ok(201, { name: nameLabel, color });
        }
        if (method === 'GET') {
          return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        }
        throw notFound();
      }
      throw notFound();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state');
          const direction = query.get('direction') ?? 'desc';
          const filtered = filterIssuesByState([...repo.issues.values()], state);
          const sorted = sortIssues(filtered, direction);
          const { page } = paginate(sorted, query);
          return ok(200, page.map((issue) => issueJson(store, repo, issue)));
        }
        if (method === 'POST') {
          const labels = Array.isArray(body.labels) ? (body.labels.filter((entry): entry is string => typeof entry === 'string') as string[]) : [];
          const issue = createIssueInRepo(store, repo, { title: bodyString(body, 'title'), body: bodyString(body, 'body'), labels });
          return ok(201, issueJson(store, repo, issue));
        }
        throw notFound();
      }
      const issueNumber = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(issueNumber)) throw notFound();
      const issue = repo.issues.get(issueNumber);
      if (rest.length === 2) {
        if (issue === undefined) throw notFound();
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return ok(200, issueJson(store, repo, issue));
        }
        throw notFound();
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (issue === undefined) throw notFound();
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => commentJson(store, repo, issue, comment)));
        }
        if (method === 'POST') {
          const comment = addCommentToIssue(repo, issue, bodyString(body, 'body'));
          return ok(201, commentJson(store, repo, issue, comment));
        }
        throw notFound();
      }
      throw notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state');
          let pulls = [...repo.pulls.values()];
          if (state === null || state === '' || state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(pulls, query);
          return ok(200, page.map((pull) => pullJson(store, repo, pull)));
        }
        if (method === 'POST') {
          const pull = createPullInRepo(store, repo, {
            title: bodyString(body, 'title'),
            body: bodyString(body, 'body'),
            head: bodyString(body, 'head'),
            base: bodyString(body, 'base'),
          });
          return ok(201, pullJson(store, repo, pull));
        }
        throw notFound();
      }
      const pullNumber = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(pullNumber)) throw notFound();
      const pull = repo.pulls.get(pullNumber);
      if (rest.length === 2) {
        if (pull === undefined) throw notFound();
        if (method !== 'GET') throw notFound();
        return ok(200, pullJson(store, repo, pull));
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (pull === undefined) throw notFound();
        if (method !== 'GET') throw notFound();
        return ok(200, diffTrees(repo, pull.baseSha, pull.headSha));
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (pull === undefined) throw notFound();
        if (method !== 'PUT') throw notFound();
        const merged = mergePullInRepo(store, repo, pull);
        return ok(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
      }
      throw notFound();
    }

    throw notFound();
  }

  throw notFound();
}
