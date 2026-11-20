// gitproto.ts — git smart HTTP: info/refs advertisements, ls-refs, fetch and
// receive-pack, protocol v2 for upload-pack and v0 for receive-pack.
//
// The suite's client is the contract: it wants a v2 capability advertisement
// (fetch + ls-refs, object-format sha1), a v0 receive-pack advertisement
// (report-status, side-band-64k, delete-refs), ls-refs with HEAD symref and
// peeled tags, fetches that never re-send held objects and honour
// depth/shallow, and per-ref report-status on push with fast-forward
// enforcement.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  repoKey,
  resolveRepo,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  pktFlush,
  readPack,
  writePack,
  PKT_LINE_MAX_PAYLOAD,
} from './pack.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message: string): GitResult {
  return {
    status: 404,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

const AGENT = 'forge/1.0';

/** Refs in advertisement order: heads, then tags, then the rest, each sorted. */
function sortedRefNames(repo: Repo): string[] {
  const heads: string[] = [];
  const tags: string[] = [];
  const other: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) heads.push(name);
    else if (name.startsWith('refs/tags/')) tags.push(name);
    else other.push(name);
  }
  heads.sort();
  tags.sort();
  other.sort();
  return [...heads, ...tags, ...other];
}

function mainTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** A v0 ref advertisement (upload-pack or receive-pack) with the service preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta thin-pack shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = mainTip(repo);
    const headOid = tip ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      lines.push(`${oid} ${name}\n`);
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** A v2 capability advertisement for upload-pack: the service preamble first, then the capabilities. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-info\n',
    'flush',
  ]);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol2: boolean,
): GitResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json404('Not Found');
  const repo = resolveRepo(store, owner, name);
  if (!repo) return json404('Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack') };
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: Array<{ kind: string; payload?: Buffer }>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function handleLsRefs(repo: Repo, body: Buffer): GitResult {
  const packets = decodePktLines(body);
  const args = parseLsRefsArgs(packets);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const tip = mainTip(repo);
  // HEAD is a pseudo-ref: it is listed when no prefix filters the answer, or
  // when one of the prefixes matches it (git asks for 'HEAD' by prefix).
  const headWanted = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (tip !== undefined) {
      lines.push(`${tip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const out = Buffer.concat([encodePktLines(lines), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
}

// -------------------------------------------------------------------------------------------
// fetch
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchArgs(packets: Array<{ kind: string; payload?: Buffer }>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

/**
 * The objects the client already holds: everything reachable from its haves,
 * except that a shallow boundary's parents are not held (the client never got
 * them). Trees and blobs under a held commit are held with it.
 */
function heldSet(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const held = new Set<string>();
  const boundaries = new Set(shallowBoundaries);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const trees: string[] = [];
  const queue: string[] = [...haves];
  const queued = new Set(queue);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      trees.push(commit.tree);
      if (!boundaries.has(oid)) {
        for (const parent of commit.parents) {
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    }
  }
  for (const entry of collectReachable(trees, lookup)) held.add(entry);
  return held;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const held = heldSet(repo, args.haves, args.shallow);
  const heldCommits = new Set<string>();
  for (const oid of held) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') heldCommits.add(oid);
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = args.wants.map((oid) => ({ oid, dist: 0 }));
  const queued = new Set(args.wants);
  let head = 0;
  while (head < queue.length) {
    const item = queue[head++] as { oid: string; dist: number };
    const { oid, dist } = item;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(oid);
      const target = parseTag(object.data).object;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push({ oid: target, dist });
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    const isHeld = held.has(oid);
    if (!isHeld) {
      included.add(oid);
      if (args.depth !== undefined && dist === args.depth - 1) boundary.add(oid);
    }
    if (args.depth !== undefined && dist >= args.depth - 1) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, dist: dist + 1 });
      }
    }
  }

  // One multi-root walk for every included commit's tree, instead of one per commit.
  const trees: string[] = [];
  for (const oid of included) {
    const object = lookup(oid);
    if (object && object.type === 'commit') trees.push(parseCommit(object.data).tree);
  }
  const send = new Set<string>(included);
  for (const entry of collectReachable(trees, lookup)) send.add(entry);
  for (const oid of held) send.delete(oid);

  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }

  const shallow = args.depth === undefined ? [] : [...boundary].sort();
  const unshallow: string[] = [];
  if (args.shallow.length > 0) {
    for (const s of args.shallow) {
      const object = repo.objects.get(s);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const allKnown = parents.every((p) => included.has(p) || heldCommits.has(p));
      const someNew = parents.some((p) => included.has(p));
      if (allKnown && someNew) unshallow.push(s);
    }
  }
  return { objects, shallow, unshallow: unshallow.sort() };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (each <= 65520 bytes framed). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function fetchResponseV2(plan: FetchPlan): GitResult {
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // Real git (and the suite's client) reads the packfile section straight
  // after an optional shallow-info section: no acknowledgments section is
  // ever sent for a stateless fetch, and the shallow-info section ends with
  // a delim, not a flush.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchResponseV0(plan: FetchPlan): GitResult {
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** Parse a v0 fetch body: want/have/deepen lines in two flush-separated sections. */
function parseFetchArgsV0(packets: Array<{ kind: string; payload?: Buffer }>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol2: boolean): GitResult {
  let packets: Array<{ kind: string; payload?: Buffer }>;
  try {
    packets = decodePktLines(body) as Array<{ kind: string; payload?: Buffer }>;
  } catch {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(`${JSON.stringify({ message: 'malformed pkt-line' })}\n`, 'utf8'),
    };
  }
  const firstData = packets.find((p) => p.kind === 'data' && p.payload);
  const firstLine = firstData?.payload?.toString('utf8') ?? '';
  if (gitProtocol2 || firstLine.startsWith('command=')) {
    if (!firstLine.startsWith('command=ls-refs')) {
      if (!firstLine.startsWith('command=fetch')) {
        return {
          status: 400,
          contentType: 'application/json; charset=utf-8',
          body: Buffer.from(`${JSON.stringify({ message: 'unknown command' })}\n`, 'utf8'),
        };
      }
      const args = parseFetchArgs(packets);
      return fetchResponseV2(planFetch(repo, args));
    }
    return handleLsRefs(repo, body);
  }
  const args = parseFetchArgsV0(packets);
  return fetchResponseV0(planFetch(repo, args));
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Decode pkt-lines until the first flush; return the packets and the offset just past it. */
function decodeUntilFlush(bytes: Buffer): { packets: Array<{ kind: string; payload?: Buffer }>; consumed: number } {
  const packets: Array<{ kind: string; payload?: Buffer }> = [];
  let offset = 0;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!hex4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, consumed: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('no flush packet in the command list');
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResult {
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let clientCaps = '';
  try {
    const { packets, consumed } = decodeUntilFlush(body);
    packBytes = body.subarray(consumed);
    for (const packet of packets) {
      if (packet.kind !== 'data' || !packet.payload) continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      line = line.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error(`bad command line ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch (err) {
    const report = encodePktLines([`unpack ${(err as Error).message}\n`, 'flush']);
    return { status: 200, contentType, body: wrapReport(report, true) };
  }
  if (commands.length === 0) {
    const report = encodePktLines(['unpack ok\n', 'flush']);
    return { status: 200, contentType, body: wrapReport(report, clientCaps.includes('side-band-64k')) };
  }

  const sideband = clientCaps.includes('side-band-64k');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        const { objects } = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
  }

  const lines: Array<string | 'flush'> = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}\n`);
  } else {
    lines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(repo, command);
      lines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
    }
  }
  lines.push('flush');
  return { status: 200, contentType, body: wrapReport(encodePktLines(lines), sideband) };
}

function wrapReport(report: Buffer, sideband: boolean): Buffer {
  if (!sideband) return report;
  const parts: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < report.length; offset += maxData) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + maxData));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!isObjectId(oldOid) || !isObjectId(newOid)) return { ok: false, reason: 'bad object id' };
  if (!ref.startsWith('refs/')) return { ok: false, reason: 'bad ref name' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'old value does not match' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!repo.objects.has(newOid)) return { ok: false, reason: 'object not found' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (oldOid !== current) return { ok: false, reason: 'old value does not match' };
  if (!repo.objects.has(newOid)) return { ok: false, reason: 'object not found' };
  if (oldOid === newOid) return { ok: true, reason: '' };
  if (ref.startsWith('refs/heads/')) {
    const from = peelToCommit(repo, newOid);
    const to = peelToCommit(repo, oldOid);
    if (from === null || to === null) return { ok: false, reason: 'object not found' };
    if (!isAncestor(repo, to, from)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

export { repoKey };
