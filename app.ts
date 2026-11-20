// app.ts — the forge's HTTP server: one store, one process, no filesystem.
//
// Routes, in the order the suite drives them:
//   GET  /healthz                          the env's boot probe: 200 {"ok":true}
//   GET  /api/v3[/]                         the API root (X-OAuth-Scopes) and /meta
//   /api/v3/...                             GitHub REST v3 (rest.ts)
//   POST /api/graphql                       GitHub GraphQL v4 (graphql.ts)
//   POST /mcp                               Model Context Protocol (mcp.ts)
//   /{owner}/{repo}.git/info/refs           git smart HTTP advertisements
//   /{owner}/{repo}.git/git-upload-pack     git smart HTTP fetch (protocol v2)
//   /{owner}/{repo}.git/git-receive-pack    git smart HTTP push (protocol v0)
//   anything else                           404 {"message":"Not Found"}, never HTML
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.
// A request handler never throws out of the server: a failure is a JSON 500
// and the server stays up for the next request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, resolveRepo, type Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The path segments of a request URL, each percent-decoded (never a throw). */
function pathSegments(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((part) => part !== '').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  } catch {
    return [];
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read a request body whole (binary-safe: git packs are not text). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(store: Store = createStore()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const segments = pathSegments(req);
      const query = queryOf(req);
      const host = typeof req.headers.host === 'string' ? req.headers.host : '';
      const headers = req.headers as Record<string, string | string[] | undefined>;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3, including the API root and /meta.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const body = await readBody(req);
          const reply = handleRest(store, method, segments.slice(2), query, headers, body, host);
          sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        // GraphQL v4.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const body = await readBody(req);
          const reply = handleGraphQL(store, method, headers, body);
          sendJson(res, reply.status, reply.body);
          return;
        }

        // Model Context Protocol.
        if (segments.length === 1 && segments[0] === 'mcp') {
          const body = await readBody(req);
          const reply = handleMcp(store, method, headers, body);
          if (reply.status === 204 || reply.body === '') {
            res.writeHead(reply.status, { 'content-type': reply.contentType });
            res.end();
            return;
          }
          sendRaw(res, reply.status, reply.contentType, Buffer.from(reply.body, 'utf8'));
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        if (segments.length >= 3 && typeof segments[1] === 'string' && segments[1].endsWith('.git')) {
          const owner = segments[0] as string;
          const name = (segments[1] as string).slice(0, -'.git'.length);
          const tail = segments.slice(2);
          const gitProtocol2 = req.headers['git-protocol'] === 'version=2';
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = query.get('service') ?? '';
            const result = handleInfoRefs(store, owner, name, service, gitProtocol2);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
            const body = await readBody(req);
            const repo = resolveRepo(store, owner, name);
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const result = handleUploadPack(repo, body, gitProtocol2);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
            const body = await readBody(req);
            const repo = resolveRepo(store, owner, name);
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const result = handleReceivePack(repo, body);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body, never HTML.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
