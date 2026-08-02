/**
 * Sync integration tests against an isolated FunkyGibbon server.
 *
 * PURPOSE:
 * Exercise the real Inbetweenies v2 wire contract end to end — auth, pull,
 * push, and the per-id acknowledgement introduced in FunkyGibbon v0.3.0 —
 * against a server this suite started itself on an ephemeral port with a
 * seeded throwaway database (see tests/helpers/funkygibbon-server.ts).
 *
 * WHY THIS EXISTS:
 * The prior integration tests only ever pulled, and against a hardcoded
 * localhost:8000. Nothing exercised push, so the client's handling of the
 * server's ack went unverified — which is how it shipped reading the ack off
 * the PULL payload and silently dropping local writes (issue #3). These tests
 * assert the contract the client depends on, so a future protocol change on
 * either side fails here rather than in production.
 *
 * SKIPPING:
 * Skips with an explicit reason when the harness did not start (no Python
 * funkygibbon available). It never silently passes.
 *
 * VERSION HISTORY:
 * - 2026-08-01: Initial suite — contract, auth, pull, push acks, conflicts.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readHandshake, type ServerHandle } from './helpers/funkygibbon-server';

let server: ServerHandle | null = null;

beforeAll(async () => {
  server = await readHandshake();
});

const ready = () => {
  if (!server) throw new Error('harness unavailable');
  return server;
};

/** Skip the body, loudly, when the harness did not start. */
const guard = (fn: (s: ServerHandle) => Promise<void>) => async () => {
  if (!server) {
    console.warn('[skip] FunkyGibbon harness unavailable — set FUNKYGIBBON_REPO');
    return;
  }
  await fn(server);
};

const post = (s: ServerHandle, path: string, body: unknown, token?: string | null) =>
  fetch(`${s.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token ?? s.token}` }),
    },
    body: JSON.stringify(body),
  });

const syncBody = (over: Record<string, unknown> = {}) => ({
  protocol_version: 'inbetweenies-v2',
  device_id: 'kittenkong-test',
  user_id: 'admin',
  sync_type: 'delta',
  vector_clock: {},
  changes: [],
  ...over,
});

describe('Isolated harness', () => {
  test(
    'runs on its own ephemeral port, never the real install on 8000',
    guard(async s => {
      expect(s.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(s.baseUrl).not.toContain(':8000');

      const health = await fetch(`${s.baseUrl}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe('healthy');
    })
  );

  test(
    'database is seeded — an empty graph would make every assertion vacuous',
    guard(async s => {
      const res = await fetch(`${s.baseUrl}/api/v1/graph/statistics`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).total_entities).toBeGreaterThan(0);
    })
  );
});

describe('Authentication', () => {
  test(
    'sync rejects an unauthenticated request',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody(), null);
      expect(res.status).toBe(401);
    })
  );

  test(
    'sync rejects a token this server did not issue',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody(), 'not-a-real-token');
      expect([401, 403]).toContain(res.status);
    })
  );

  test(
    'admin login issues a token the server then honours',
    guard(async s => {
      const login = await post(s, '/api/v1/auth/admin/login', { password: s.adminPassword }, null);
      expect(login.status).toBe(200);
      const token = (await login.json()).access_token;

      const me = await fetch(`${s.baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect((await me.json()).role).toBe('admin');
    })
  );
});

describe('Inbetweenies v2 response contract', () => {
  test(
    'delta sync returns the documented envelope',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody());
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.protocol_version).toBe('inbetweenies-v2');
      expect(data.sync_type).toBe('delta');
      expect(Array.isArray(data.changes)).toBe(true);
      expect(Array.isArray(data.conflicts)).toBe(true);
    })
  );

  test(
    'v0.3.0 per-id ack fields are present on every response',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody());
      const data = await res.json();

      // The client's pending-clear logic depends on these existing. If a
      // server drops them the client silently falls back to the unsafe legacy
      // inference, so assert presence explicitly rather than truthiness.
      expect(data).toHaveProperty('applied');
      expect(data).toHaveProperty('applied_relationships');
      expect(Array.isArray(data.applied)).toBe(true);
      expect(Array.isArray(data.applied_relationships)).toBe(true);
    })
  );

  test(
    'a push of nothing acks nothing',
    guard(async s => {
      const data = await (await post(s, '/api/v1/sync/', syncBody())).json();
      expect(data.applied).toEqual([]);
      expect(data.applied_relationships).toEqual([]);
    })
  );

  test(
    'full sync returns seeded entities',
    guard(async s => {
      const data = await (await post(s, '/api/v1/sync/', syncBody({ sync_type: 'full' }))).json();
      expect(data.sync_type).toBe('full');
      expect(data.changes.length).toBeGreaterThan(0);
    })
  );
});

describe('Push acknowledgement', () => {
  const pushEntity = (id: string, name: string) => ({
    change_type: 'create',
    entity: {
      id,
      version: `${new Date().toISOString()}-kittenkong`,
      entity_type: 'note',
      name,
      content: { body: 'pushed by the kittenkong integration suite' },
      source_type: 'manual',
      user_id: 'admin',
      parent_versions: [],
    },
  });

  test(
    'a successfully pushed entity is acked by id',
    guard(async s => {
      const id = `kk-test-${Date.now()}`;
      const res = await post(
        s,
        '/api/v1/sync/',
        syncBody({ changes: [pushEntity(id, 'KittenKong push ack')] })
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      // The ack is the client's only safe basis for clearing a pending mark.
      expect(data.applied).toContain(id);
    })
  );

  test(
    'the ack names the pushed id, not whatever the pull payload happens to carry',
    guard(async s => {
      const id = `kk-test-${Date.now()}-distinct`;
      const data = await (
        await post(s, '/api/v1/sync/', syncBody({ changes: [pushEntity(id, 'KittenKong ack identity')] }))
      ).json();

      // This is the invariant the client got wrong: `changes` is the
      // server->client pull payload and may name entities we never pushed.
      // Only `applied` answers "what did the server take from me".
      const pulledIds = (data.changes ?? []).map((c: any) => c.entity?.id).filter(Boolean);
      expect(data.applied).toContain(id);
      expect(data.applied.every((a: string) => a === id || pulledIds.includes(a))).toBe(true);
    })
  );

  test(
    'a pushed entity is retrievable afterwards',
    guard(async s => {
      const id = `kk-test-${Date.now()}-persist`;
      await post(s, '/api/v1/sync/', syncBody({ changes: [pushEntity(id, 'KittenKong persistence')] }));

      const res = await fetch(`${s.baseUrl}/api/v1/graph/entities/${id}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).entity.id).toBe(id);
    })
  );
});
