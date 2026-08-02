/**
 * Per-id push acknowledgement (FunkyGibbon v0.3.0+).
 *
 * Design choices under test:
 * - `applied` is the ONLY safe basis for clearing a pending mark. Inferring it
 *   from `response.changes` reads the server->client pull payload as an ack, so
 *   an entity that lost conflict resolution comes back as the server's winning
 *   version, looks "applied", and the local edit is silently dropped.
 * - An empty `applied: []` is a real answer ("nothing landed"), distinct from a
 *   pre-v0.3.0 server omitting the field, which selects the legacy inference.
 *
 * History: added with the v0.3.0 sync-contract fix. See issue #3.
 */

import { describe, test, expect } from 'vitest';
import { InbetweeniesProtocol, type SyncResponse } from '../src/sync/protocol.js';
import { AuthManager } from '../src/auth';

// parseSyncResult is pure over the response body; the auth manager is only held
// for network calls, which these tests never make.
const protocol = new InbetweeniesProtocol(
  'http://localhost:8000',
  new AuthManager({ serverUrl: 'http://localhost:8000' }),
  'test-device'
);

function response(over: Partial<SyncResponse> = {}): SyncResponse {
  return {
    protocol_version: 'inbetweenies-v2',
    sync_type: 'delta',
    changes: [],
    conflicts: [],
    vector_clock: {},
    sync_stats: {
      entities_synced: 0,
      relationships_synced: 0,
      conflicts_resolved: 0,
      duration_ms: 0,
    },
    ...over,
  };
}

/** A server->client change carrying the server's own version of an entity. */
function serverChange(id: string) {
  return {
    change_type: 'update',
    entity: {
      id,
      version: 'server-version',
      entity_type: 'device',
      name: 'server copy',
      content: {},
past_versions: [],
    },
  } as any;
}

describe('parseSyncResult — per-id acks', () => {
  test('uses the server applied list, not the pull payload', () => {
    const r = response({
      applied: ['entity-a'],
      applied_relationships: ['rel-1'],
      changes: [serverChange('entity-a'), serverChange('entity-b')],
    });

    const { appliedIds, appliedRelationshipIds } = protocol.parseSyncResult(r);

    expect(appliedIds).toEqual(['entity-a']);
    expect(appliedRelationshipIds).toEqual(['rel-1']);
  });

  test('a pushed entity that lost conflict resolution is NOT acked', () => {
    // The server rejected entity-b but returns its own winning copy in changes.
    // The old inference read that as applied and dropped the local write.
    const r = response({
      applied: [],
      changes: [serverChange('entity-b')],
    });

    const { appliedIds } = protocol.parseSyncResult(r);

    expect(appliedIds).not.toContain('entity-b');
    expect(appliedIds).toEqual([]);
  });

  test('empty applied is honoured rather than treated as missing', () => {
    const r = response({ applied: [], changes: [serverChange('entity-c')] });

    expect(protocol.parseSyncResult(r).appliedIds).toEqual([]);
  });

  test('legacy server without applied falls back to change inference', () => {
    const r = response({ changes: [serverChange('entity-d')] });
    delete (r as any).applied;

    expect(protocol.parseSyncResult(r).appliedIds).toEqual(['entity-d']);
  });

  test('missing applied_relationships yields an empty list, never undefined', () => {
    const r = response({ applied: ['entity-e'] });

    expect(protocol.parseSyncResult(r).appliedRelationshipIds).toEqual([]);
  });
});
