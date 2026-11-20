// main.ts — the forge's entrypoint and lifecycle.
//
// 1. MAKEFUN_ENV_URL is required (the env always sets it); without it the
//    process exits 1, exactly like the starter.
// 2. The server binds an ephemeral port (never 8080).
// 3. The port is registered with the env with retry/backoff: 200 or 409
//    means registered, 400 or 405 is fatal.
// 4. The process polls GET /done until the env says {"done":true}, then
//    closes the server and exits 0.

import { createApp } from './app.ts';

const MAKEFUN_ENV_URL = process.env.MAKEFUN_ENV_URL;
if (!MAKEFUN_ENV_URL) {
  process.stderr.write('MAKEFUN_ENV_URL not set\n');
  process.exit(1);
}

const BASE_URL = MAKEFUN_ENV_URL.replace(/\/+$/, '');
const server = createApp();

/** Register the listening port with the env, retrying until it sticks. */
async function register(port: number): Promise<void> {
  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      const delay = Math.min(100 * 2 ** attempt, 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      process.stderr.write(`registration rejected: ${response.status}\n`);
      process.exit(1);
    }
    const delay = Math.min(100 * 2 ** attempt, 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }
}

/** Poll the env until it says the grading run is done. */
async function waitForDone(): Promise<void> {
  while (true) {
    try {
      const response = await fetch(`${BASE_URL}/done`);
      const json = (await response.json()) as unknown;
      if (
        json !== null &&
        typeof json === 'object' &&
        (json as Record<string, unknown>).done === true
      ) {
        return;
      }
    } catch {
      // The env is not reachable yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  void (async () => {
    await register(port);
    await waitForDone();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  })();
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
