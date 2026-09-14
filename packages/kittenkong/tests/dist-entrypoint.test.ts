/**
 * The BUILT server must start under plain `node` (typescript#3).
 *
 * vitest and tsx resolve extensionless relative imports the way tsc does; Node's
 * ESM loader does not. So `pnpm build` could succeed, every test could pass,
 * and `node dist/mcp-server.js` -- the shape an MCP client config actually
 * launches -- could still fail with ERR_MODULE_NOT_FOUND. This test speaks
 * JSON-RPC to the built artifact over stdio, exactly as a client would.
 *
 * Requires a build (`pnpm build`); CI builds before it tests, and the README
 * says to. A missing dist is a failure, not a skip: skipping is how this class
 * of bug shipped.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, expect, beforeAll } from 'vitest';
import { readHandshake, type ServerHandle } from './helpers/funkygibbon-server';

const ENTRY = resolve(__dirname, '../dist/mcp-server.js');

let server: ServerHandle | null = null;
beforeAll(async () => {
  server = await readHandshake();
});

interface Rpc { id: number; method: string; params?: unknown }

/** Launch the built server, send requests, collect one response per id. */
async function rpc(s: ServerHandle, requests: Rpc[]): Promise<Map<number, any>> {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, FUNKYGIBBON_URL: s.baseUrl, FUNKYGIBBON_TOKEN: s.token, SYNC_INTERVAL_SECONDS: '3600' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map<number, any>();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const done = new Promise<void>((resolveDone, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') replies.set(msg.id, msg);
        if (replies.size === requests.length) resolveDone();
      }
    });
    child.on('exit', (code) => {
      if (replies.size < requests.length) reject(new Error(`server exited ${code} before answering:\n${stderr}`));
    });
    setTimeout(() => reject(new Error(`timed out; stderr:\n${stderr}`)), 25_000).unref();
  });

  for (const r of requests) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
  }
  try {
    await done;
  } finally {
    child.kill();
  }
  return replies;
}

describe('the built server runs under node', () => {
  test('dist/mcp-server.js exists -- build before test', () => {
    expect(existsSync(ENTRY), `${ENTRY} is missing: run pnpm build first`).toBe(true);
  });

  test('answers initialize and lists the 23 tools over stdio', async () => {
    if (!server) {
      console.warn('[skip] FunkyGibbon harness unavailable — set FUNKYGIBBON_REPO');
      return;
    }
    const replies = await rpc(server, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
      { id: 2, method: 'tools/list', params: {} },
    ]);
    expect(replies.get(1).result.serverInfo.name).toBe('kittenkong');
    const names = replies.get(2).result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(23);
    expect(names).toContain('get_devices_in_room');
  });
});
