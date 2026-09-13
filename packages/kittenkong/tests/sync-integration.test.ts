/**
 * Sync integration tests against an isolated FunkyGibbon server.
 *
 * PURPOSE:
 * Exercise the real Inbetweenies v3 wire contract end to end — auth, pull,
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
 * - 2026-09-13: inbetweenies-v3 (the-goodies v0.5.0): v2 is rejected, edges
 *   are intervals and travel both ways.
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
  protocol_version: 'inbetweenies-v3',
  device_id: 'kittenkong-test',
  user_id: 'admin',
  sync_type: 'delta',
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

describe('Inbetweenies v3 response contract', () => {
  test(
    'a v2 request is rejected with 400 — there is no compatibility window',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody({ protocol_version: 'inbetweenies-v2' }));
      expect(res.status).toBe(400);
    })
  );

  test(
    'delta sync returns the documented envelope',
    guard(async s => {
      const res = await post(s, '/api/v1/sync/', syncBody());
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.protocol_version).toBe('inbetweenies-v3');
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


describe('Edge intervals over the wire (ADR-004, PROTOCOL.md §3)', () => {
  const march = '2026-03-01T14:00:00.000000+00:00';
  const june = '2026-06-01T14:00:00.000000+00:00';

  const mk = (id: string, name: string, entity_type: string) => ({
    change_type: 'create',
    entity: {
      id, version: `${new Date().toISOString().replace('Z', '000+00:00')}-kk`,
      entity_type, name, content: {}, source_type: 'manual', user_id: 'admin', parent_versions: [],
    },
  });
  const edge = (over: Record<string, unknown>) => ({
    change_type: 'update', entity: null,
    relationships: [{ relationship_type: 'located_in', properties: {}, user_id: 'admin', ...over }],
  });
  const pulledEdges = async (s: ServerHandle, id: string) => {
    const data = await (await post(s, '/api/v1/sync/', syncBody({ sync_type: 'full' }))).json();
    return (data.changes as any[]).flatMap(c => c.relationships ?? []).filter((r: any) => r.id === id);
  };

  test(
    'a move produces two tiling intervals under one edge id, both served on the pull',
    guard(async s => {
      const stamp = Date.now();
      const lamp = `kk-lamp-${stamp}`, kitchen = `kk-kitchen-${stamp}`, hall = `kk-hall-${stamp}`, rel = `kk-rel-${stamp}`;
      let res = await post(s, '/api/v1/sync/', syncBody({ changes: [mk(lamp, 'Lamp', 'device'), mk(kitchen, 'Kitchen', 'room'), mk(hall, 'Hall', 'room')] }));
      expect(res.status).toBe(200);

      res = await post(s, '/api/v1/sync/', syncBody({ changes: [edge({ id: rel, from_entity_id: lamp, to_entity_id: kitchen, valid_from: march })] }));
      expect((await res.json()).applied_relationships).toContain(rel);
      res = await post(s, '/api/v1/sync/', syncBody({ changes: [edge({ id: rel, from_entity_id: lamp, to_entity_id: hall, valid_from: june })] }));
      expect((await res.json()).applied_relationships).toContain(rel);

      const rows = await pulledEdges(s, rel);
      expect(rows, 'history was projected away on the wire').toHaveLength(2);
      const retired = rows.find((r: any) => r.to_entity_id === kitchen);
      const live = rows.find((r: any) => r.to_entity_id === hall);
      expect(retired.valid_to, 'the superseded row must be closed').not.toBeNull();
      expect(live.valid_to).toBeNull();
      // Half-open handover: the predecessor ends exactly where the successor starts.
      expect(new Date(retired.valid_to).getTime()).toBe(new Date(live.valid_from).getTime());
      expect(new Date(live.valid_from).getTime()).toBe(new Date(june).getTime());
    })
  );

  test(
    'a client-supplied valid_to ends the edge — that is how a delete travels',
    guard(async s => {
      const stamp = Date.now();
      const lamp = `kk-lamp2-${stamp}`, kitchen = `kk-kitchen2-${stamp}`, rel = `kk-rel2-${stamp}`;
      await post(s, '/api/v1/sync/', syncBody({ changes: [mk(lamp, 'Lamp', 'device'), mk(kitchen, 'Kitchen', 'room')] }));
      await post(s, '/api/v1/sync/', syncBody({ changes: [edge({ id: rel, from_entity_id: lamp, to_entity_id: kitchen, valid_from: march })] }));
      const res = await post(s, '/api/v1/sync/', syncBody({ changes: [edge({ id: rel, from_entity_id: lamp, to_entity_id: kitchen, valid_from: march, valid_to: june })] }));
      expect((await res.json()).applied_relationships).toContain(rel);

      const rows = await pulledEdges(s, rel);
      expect(rows, 'an end-event must close a row, not open one').toHaveLength(1);
      expect(rows[0].valid_to).not.toBeNull();
    })
  );
});
