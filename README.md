# Forge — a standalone GitHub-compatible forge

A single Node 22 process, standard library only, that speaks the GitHub
surface well enough for a client to drive it as if it were github.com: git
smart HTTP for clone and push, REST v3 for repositories, issues, pull
requests and contents, GraphQL v4 for the documents `gh` and
`github-mcp-server` send, and the Model Context Protocol over streamable
HTTP. All state lives in memory in `Map`s; nothing is written to disk.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must be set (the trial env's origin). The entry binds an
ephemeral port, registers it with the env, polls `GET /done` until the env
says the run is over, then exits 0.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry <-> env lifecycle: bind, register, wait for done, exit. |
| `app.ts` | The HTTP server and the route table. |
| `store.ts` | The in-memory model: repositories, branches, commits, trees, issues, pull requests, and the deterministic counters every timestamp derives from. |
| `pack.ts` | Git packfiles: writing (deflate level 1), reading, delta application, and the fetch plan. |
| `gitproto.ts` | Git smart HTTP: `info/refs` advertisements, `git-upload-pack` (protocol v2), `git-receive-pack` (protocol v0). |
| `rest.ts` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, merges. |
| `graphql.ts` | GitHub GraphQL v4: a parser for the subset the clients send, resolvers over the same store, and the batch endpoint. |
| `mcp.ts` | Model Context Protocol: `server/discover`, the legacy `initialize` handshake, `tools/list`, `tools/call`. |

## The surface

- `GET /healthz` — 200 `{"ok":true}`.
- `GET /api/v3/` — 200, `X-OAuth-Scopes: repo, read:org`.
- `/api/v3/...` — repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges.
- `POST /api/graphql` — queries, mutations, `node`, `__type`, batched arrays.
- `POST /mcp` — `server/discover`, `initialize`, `tools/list`, `tools/call` (six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).
- `/<owner>/<repo>.git/...` — `info/refs`, `git-upload-pack`, `git-receive-pack`.
- Anything else — 404 `{"message":"Not Found"}`.

## Determinism

State is a pure function of the requests served: timestamps come from a
monotonic counter, never the wall clock, and there is no randomness, so
replaying the same requests produces a byte-identical export.

## Licence

MIT.
