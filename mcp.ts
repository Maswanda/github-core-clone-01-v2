// mcp.ts — Model Context Protocol over streamable HTTP, at POST /mcp.
//
// The suite's client speaks the 2026-07-28 revision: every request declares
// its revision in `_meta` and the `MCP-Protocol-Version` header, and
// `server/discover` answers identity, capabilities and supportedVersions in
// one request (no handshake, no session). The legacy handshake
// (initialize + notifications/initialized) is answered too, so a client that
// predates discover still negotiates. Answers are plain JSON bodies; the
// client also reads SSE, but a single JSON body is the transport's other
// legal answer and the one this server always gives.
//
// The six tools act on the same store as REST, through rest.ts's service
// layer, so a repository or issue created over MCP reads back over /api/v3
// as the same object.

import { createRepo, parseGlobalId, resolveRepo, type Store } from './store.ts';
import {
  authorized,
  createIssueInRepo,
  createPullInRepo,
  issueJson,
  mergePullInRepo,
  pullJson,
  repoJson,
  resolveRepoOr404,
  ApiError,
} from './rest.ts';

export interface McpReply {
  status: number;
  contentType: string;
  body: string;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The tool list, fixed at load so two tools/list answers are byte-identical. */
const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonReply(status: number, body: unknown): McpReply {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function rpcResult(id: string | number | null, result: unknown): McpReply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpReply {
  return jsonReply(status, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolTextResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function argBoolean(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function argNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Run one tool call; an ApiError becomes an isError tool result, never an HTTP 500. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new ApiError(-32602, `Unknown tool: ${name}`);
  const required = (tool.inputSchema.required ?? []) as string[];
  for (const property of required) {
    if (args[property] === undefined || args[property] === null || args[property] === '') {
      return toolErrorResult(`Missing required argument: ${property}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = argString(args, 'name') as string;
        if (store.repos.has(repoName.toLowerCase())) return toolErrorResult('Repository already exists');
        const repo = createRepo(store, repoName, {
          description: argString(args, 'description') ?? '',
          private: argBoolean(args, 'private', false),
        });
        return toolTextResult(repoJson(store, repo));
      }
      case 'get_repo': {
        const owner = argString(args, 'owner') as string;
        const repoName = argString(args, 'repo') as string;
        const repo = resolveRepo(store, owner, repoName);
        if (!repo) return toolErrorResult('Repository not found');
        return toolTextResult(repoJson(store, repo));
      }
      case 'create_issue': {
        const owner = argString(args, 'owner') as string;
        const repoName = argString(args, 'repo') as string;
        const repo = resolveRepoOr404(store, owner, repoName);
        const issue = createIssueInRepo(store, repo, {
          title: argString(args, 'title') as string,
          body: argString(args, 'body') ?? '',
        });
        return toolTextResult(issueJson(store, repo, issue));
      }
      case 'list_issues': {
        const owner = argString(args, 'owner') as string;
        const repoName = argString(args, 'repo') as string;
        const repo = resolveRepoOr404(store, owner, repoName);
        const state = argString(args, 'state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => b.seq - a.seq);
        const listed = issues.map((issue) => issueJson(store, repo, issue));
        return toolTextResult(listed);
      }
      case 'create_pull_request': {
        const owner = argString(args, 'owner') as string;
        const repoName = argString(args, 'repo') as string;
        const repo = resolveRepoOr404(store, owner, repoName);
        const pull = createPullInRepo(store, repo, {
          title: argString(args, 'title') as string,
          body: argString(args, 'body') ?? '',
          head: argString(args, 'head') as string,
          base: argString(args, 'base') as string,
        });
        return toolTextResult(pullJson(store, repo, pull));
      }
      case 'merge_pull_request': {
        const owner = argString(args, 'owner') as string;
        const repoName = argString(args, 'repo') as string;
        const repo = resolveRepoOr404(store, owner, repoName);
        const number = argNumber(args, 'pull_number');
        if (number === null) return toolErrorResult('Missing required argument: pull_number');
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolErrorResult('Pull request not found');
        mergePullInRepo(store, repo, pull);
        return toolTextResult(pullJson(store, repo, pull));
      }
      default:
        return toolErrorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ApiError) return toolErrorResult(err.message);
    throw err;
  }
}

/** The one entry point app.ts calls for /mcp. */
export function handleMcp(
  store: Store,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): McpReply {
  // A legacy session's goodbye: nothing to forget, answer and move on.
  if (method === 'DELETE') {
    return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
  }
  if (method !== 'POST') {
    return jsonReply(405, { message: 'Method Not Allowed' });
  }
  if (!authorized(headers)) {
    return jsonReply(401, { message: 'Requires authentication' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const methodName = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? (parsed.params as Record<string, unknown>) : {};

  // A notification carries no id and wants no JSON-RPC answer.
  if (id === null) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }

  if (methodName === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (methodName === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!SUPPORTED_VERSIONS.includes(offered)) {
      return rpcError(id, -32602, `Unsupported protocol version: ${offered}`);
    }
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (methodName === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (methodName === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(store, toolName, args);
      return rpcResult(id, result);
    } catch (err) {
      if (err instanceof ApiError && err.status === -32602) {
        return rpcError(id, -32602, err.message);
      }
      return rpcError(id, -32602, err instanceof Error ? err.message : 'tool call failed');
    }
  }

  if (methodName.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }

  return rpcError(id, -32601, `Method not found: ${methodName}`);
}
