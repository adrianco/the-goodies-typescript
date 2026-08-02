/**
 * Vitest globalSetup: owns the single isolated FunkyGibbon server for the run.
 *
 * PURPOSE:
 * One server per test session on an ephemeral port, published to the workers
 * via a small handshake file (vitest's `inject` is not usable outside the
 * runner context, and process.env does not reliably cross into workers).
 *
 * FAILURE POLICY:
 * If the Python side is simply absent, we publish nothing and the integration
 * tests skip with an explicit reason — an environment without funkygibbon is
 * not a test failure. But if funkygibbon IS present and the server fails to
 * start, that throws and fails the whole run. A broken harness must never
 * masquerade as a passing suite.
 *
 * VERSION HISTORY:
 * - 2026-08-01: Initial setup/teardown around the ephemeral-port harness.
 */

import {
  startFunkygibbon,
  stopFunkygibbon,
  publishHandshake,
  clearHandshake,
  findFunkygibbonRepo,
} from './funkygibbon-server';

let server: Awaited<ReturnType<typeof startFunkygibbon>> | null = null;

export async function setup(): Promise<void> {
  await clearHandshake();

  if (!findFunkygibbonRepo()) {
    console.warn(
      '\n[kittenkong] FunkyGibbon repo not found — integration tests will skip.\n' +
        '            Set FUNKYGIBBON_REPO to enable them.\n'
    );
    return;
  }

  server = await startFunkygibbon();
  await publishHandshake({
    baseUrl: server.baseUrl,
    token: server.token,
    adminPassword: server.adminPassword,
  });
  console.log(`\n[kittenkong] FunkyGibbon test server ready at ${server.baseUrl} (pid ${server.process.pid})`);
}

export async function teardown(): Promise<void> {
  await clearHandshake();
  if (server) {
    const url = server.baseUrl;
    await stopFunkygibbon(server);
    server = null;
    console.log(`\n[kittenkong] FunkyGibbon test server on ${url} stopped`);
  }
}
