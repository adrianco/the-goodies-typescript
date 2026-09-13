/**
 * inbetweenies-v3: the client is a temporal replica (ADR-004, ADR-009).
 *
 * "Clients hold the whole graph" is only true if the client holds the whole
 * graph, history included. These pin the interval semantics of the local
 * store and the engine's handling of intervals on both sides of the wire.
 * Unit-level and server-free by design; end-to-end coverage against a real
 * FunkyGibbon lives in sync-integration.test.ts.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SyncEngine } from '../src/sync/engine';
import { AuthManager } from '../src/auth';
import { LocalGraphStorage } from '../src/graph/local-storage';
import { LocalGraphOperations } from '../src/graph/local-operations';
import { EntityType, SourceType, RelationshipType, isCurrentAt, type Entity, type EntityRelationship } from '@the-goodies/inbetweenies';

const SERVER = 'http://127.0.0.1:1'; // never contacted
const MARCH = new Date('2026-03-01T12:00:00Z');
const APRIL = new Date('2026-04-01T12:00:00Z');
const JUNE = new Date('2026-06-01T12:00:00Z');
const JULY = new Date('2026-07-01T12:00:00Z');

function makeEngine() {
  const storage = new LocalGraphStorage();
  const ops = new LocalGraphOperations(storage);
  const engine = new SyncEngine(SERVER, new AuthManager({ serverUrl: SERVER }), 'test-client', 'tester');
  engine.setGraphOperations(ops);
  return { engine, ops, storage };
}
const entity = (id: string, type = EntityType.DEVICE): Entity => ({
  id, version: `v-${id}`, entityType: type, name: id, content: {}, userId: 'tester',
  sourceType: SourceType.MANUAL, parentVersions: [], createdAt: new Date(), lastModified: new Date(),
});
const edge = (to: string, validFrom?: Date, validTo?: Date | null, id = 'rel-1'): EntityRelationship => ({
  id, fromEntityId: 'device-1', toEntityId: to, relationshipType: RelationshipType.LOCATED_IN,
  properties: {}, userId: 'tester', createdAt: validFrom ?? new Date(), validFrom, validTo,
});

describe('interval predicate', () => {
  test('half-open: current at its start, not at its end', () => {
    const e = edge('room-1', MARCH, JUNE);
    expect(isCurrentAt(e, MARCH)).toBe(true);
    expect(isCurrentAt(e, APRIL)).toBe(true);
    expect(isCurrentAt(e, JUNE)).toBe(false);
  });
  test('an open interval is current now and later', () => {
    expect(isCurrentAt(edge('room-1', MARCH), JULY)).toBe(true);
  });
});

describe('local store: end-and-insert, never overwrite', () => {
  let storage: LocalGraphStorage;
  beforeEach(() => { storage = new LocalGraphStorage(); });

  test('a move appends an interval and ends the predecessor at the successor start', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-2', JUNE));

    const history = storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true });
    expect(history, 'the move destroyed the earlier placement').toHaveLength(2);
    const old = history.find(r => r.toEntityId === 'room-1')!;
    expect(old.validTo?.getTime()).toBe(JUNE.getTime());
    expect(storage.getRelationships().map(r => r.toEntityId)).toEqual(['room-2']);
  });

  test('the prior placement is answerable at a past instant', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-2', JUNE));
    expect(storage.getRelationships(undefined, undefined, undefined, { at: APRIL }).map(r => r.toEntityId)).toEqual(['room-1']);
    expect(storage.getRelationships(undefined, undefined, undefined, { at: JULY }).map(r => r.toEntityId)).toEqual(['room-2']);
  });

  test('exactly one placement is current at the handover instant', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-2', JUNE));
    expect(storage.getRelationships(undefined, undefined, undefined, { at: JUNE })).toHaveLength(1);
  });

  test('re-delivering the same row is idempotent', () => {
    for (let i = 0; i < 3; i++) storage.storeRelationship(edge('room-1', MARCH));
    expect(storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true })).toHaveLength(1);
  });

  test('an end-event closes the row it names and opens nothing', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-1', MARCH, JUNE));
    const rows = storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].validTo?.getTime()).toBe(JUNE.getTime());
    expect(storage.getRelationships()).toEqual([]);
  });

  test('endRelationship retires the open interval and keeps the row', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    expect(storage.endRelationship('rel-1', JUNE)?.validTo?.getTime()).toBe(JUNE.getTime());
    expect(storage.getRelationships()).toEqual([]);
    expect(storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true })).toHaveLength(1);
  });

  test('the room index follows the move', () => {
    storage.storeEntity(entity('device-1'));
    storage.storeEntity(entity('room-1', EntityType.ROOM));
    storage.storeEntity(entity('room-2', EntityType.ROOM));
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-2', JUNE));
    expect(storage.getDevicesInRoom('room-1'), 'the device never left the old room').toEqual([]);
    expect(storage.getDevicesInRoom('room-2').map(e => e.id)).toEqual(['device-1']);
  });

  test('statistics count the current graph, not history', () => {
    storage.storeRelationship(edge('room-1', MARCH));
    storage.storeRelationship(edge('room-2', JUNE));
    expect(storage.getStatistics().totalRelationships).toBe(1);
  });
});

describe('sync engine: intervals on the wire', () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => { ctx = makeEngine(); });

  test('the push carries valid_from as the client edit time', async () => {
    const { engine, ops } = ctx;
    await ops.storeEntity(entity('device-1'));
    await ops.storeEntity(entity('room-1', EntityType.ROOM));
    await ops.storeRelationship(edge('room-1', MARCH));
    (engine as any).pendingSyncRelationships.add('rel-1');

    const [change] = await (engine as any).getLocalChanges();
    expect(change.relationships[0].valid_from).toBe(MARCH.toISOString());
    expect(change.relationships[0].valid_to).toBeNull();
  });

  test('an ended edge is still pushed, as an end-event', async () => {
    const { engine, ops } = ctx;
    await ops.storeRelationship(edge('room-1', MARCH));
    await ops.endRelationship('rel-1', JUNE);
    (engine as any).pendingSyncRelationships.add('rel-1');

    const [change] = await (engine as any).getLocalChanges();
    expect(change, 'a retired interval must still reach the wire').toBeDefined();
    expect(change.relationships[0].valid_to).toBe(JUNE.toISOString());
  });

  test('pulled edges are stored with their bounds, including an entity-less change', async () => {
    const { engine, storage } = ctx;
    const applied = await (engine as any).applySingleChange({
      entityId: '', operation: 'update', data: {},
      relationships: [{ id: 'rel-9', from_entity_id: 'device-1', to_entity_id: 'room-1',
        relationship_type: 'located_in', properties: {}, user_id: 'srv',
        valid_from: MARCH.toISOString(), valid_to: JUNE.toISOString() }],
    });
    expect(applied).toBe(true);
    const [row] = storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true });
    expect(row.validFrom?.getTime()).toBe(MARCH.getTime());
    expect(row.validTo?.getTime()).toBe(JUNE.getTime());
    expect(storage.getRelationships(), 'a retired interval must not be live').toEqual([]);
  });

  test('a pending local edge is not overwritten by the pull', async () => {
    const { engine, ops, storage } = ctx;
    await ops.storeRelationship(edge('room-1', MARCH));
    await ops.endRelationship('rel-1', JUNE);       // local delete, unpushed
    (engine as any).pendingSyncRelationships.add('rel-1');

    await (engine as any).applySingleChange({
      entityId: '', operation: 'update', data: {},
      relationships: [{ id: 'rel-1', from_entity_id: 'device-1', to_entity_id: 'room-1',
        relationship_type: 'located_in', properties: {}, user_id: 'srv',
        valid_from: MARCH.toISOString(), valid_to: null }],
    });
    expect(storage.getRelationships(), 'the server must not resurrect a locally ended edge before it is adjudicated').toEqual([]);
  });
});

describe('relationship tools and the as-of surface (issue #85, ADR-004 §3, ADR-015)', () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(async () => {
    ctx = makeEngine();
    await ctx.ops.storeEntity({ ...entity('device-1'), version: `${MARCH.toISOString().replace('Z', '000+00:00')}-000001-t` });
    await ctx.ops.storeEntity({ ...entity('room-1', EntityType.ROOM), version: `${MARCH.toISOString().replace('Z', '000+00:00')}-000002-t` });
    await ctx.ops.storeEntity({ ...entity('room-2', EntityType.ROOM), version: `${MARCH.toISOString().replace('Z', '000+00:00')}-000003-t` });
    await ctx.ops.storeRelationship(edge('room-1', MARCH));
    await ctx.ops.storeRelationship(edge('room-2', JUNE));
  });

  test('list_relationships: current by default, history on request, as of an instant', async () => {
    const now = await ctx.ops.executeTool('list_relationships', { from_entity_id: 'device-1' });
    const all = await ctx.ops.executeTool('list_relationships', { from_entity_id: 'device-1', include_history: true });
    const april = await ctx.ops.executeTool('list_relationships', { from_entity_id: 'device-1', at: APRIL.toISOString() });
    expect(now.result.relationships.map((r: any) => r.to_entity_id)).toEqual(['room-2']);
    expect(all.result.count).toBe(2);
    expect(april.result.relationships.map((r: any) => r.to_entity_id)).toEqual(['room-1']);
  });

  test('get_devices_in_room follows the move when asked as of April', async () => {
    const then = await ctx.ops.executeTool('get_devices_in_room', { room_id: 'room-1', at: APRIL.toISOString() });
    const now = await ctx.ops.executeTool('get_devices_in_room', { room_id: 'room-1' });
    expect(then.result.devices.map((d: any) => d.id)).toEqual(['device-1']);
    expect(now.result.devices).toEqual([]);
  });

  test('get_connected is the generic neighbourhood', async () => {
    const r = await ctx.ops.executeTool('get_connected', { entity_id: 'room-2' });
    expect(r.success).toBe(true);
    expect(r.result.connected[0]).toMatchObject({ direction: 'incoming', entity: { id: 'device-1' } });
  });

  test('end_relationship is the delete and keeps history', async () => {
    const r = await ctx.ops.executeTool('end_relationship', { relationship_id: 'rel-1', reason: 'moved out' });
    expect(r.success).toBe(true);
    expect(r.result.ended_at).toBeTruthy();
    expect(ctx.storage.getRelationships()).toEqual([]);
    expect(ctx.storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true })).toHaveLength(2);
    const again = await ctx.ops.executeTool('end_relationship', { relationship_id: 'rel-1' });
    expect(again.result.already_ended).toBe(true);
  });

  test('get_graph_diff reports the move', async () => {
    const r = await ctx.ops.executeTool('get_graph_diff', { since: '2026-05-01T00:00:00Z', until: '2026-07-01T00:00:00Z' });
    expect(r.result.edges_started.map((e: any) => e.to_entity_id)).toEqual(['room-2']);
    expect(r.result.edges_ended.map((e: any) => e.to_entity_id)).toEqual(['room-1']);
  });

  test('a bad `at` is a tool error, not a crash', async () => {
    const r = await ctx.ops.executeTool('get_devices_in_room', { room_id: 'room-1', at: 'yesterday-ish' }).catch(e => ({ success: false, error: String(e) }));
    expect(r.success).toBe(false);
  });
});

describe('MCP writes reach the server: the client marks them pending', () => {
  // This was missing for every MCP write: an entity created or an edge added
  // through the MCP server lived only in this process and never synced.
  test('create_entity, create_relationship and end_relationship are queued for push', async () => {
    const { KittenKongClient } = await import('../src/client');
    const client = new KittenKongClient({ serverUrl: SERVER, clientId: 'mcp-pending-test', authToken: 'x' });
    // A sync engine exists once the client has an auth token; no network is used.
    (client as any).syncEngine ??= new SyncEngine(SERVER, new AuthManager({ serverUrl: SERVER }), 'c', 'u');
    (client as any).syncEngine.setGraphOperations((client as any).graphOps);

    const home = await client.executeMCPTool('create_entity', { entity_type: 'room', name: 'Hall', content: {} });
    const lamp = await client.executeMCPTool('create_entity', { entity_type: 'device', name: 'Lamp', content: {} });
    expect(home.success && lamp.success).toBe(true);
    const rel = await client.executeMCPTool('create_relationship', {
      from_entity_id: lamp.result.id, to_entity_id: home.result.id, relationship_type: 'located_in',
    });
    expect(rel.success).toBe(true);
    expect(client.pendingChangesCount).toBe(3);

    const ended = await client.executeMCPTool('end_relationship', { relationship_id: rel.result.id });
    expect(ended.success).toBe(true);
    expect((client as any).syncEngine.pendingChangesCount).toBe(3); // same edge, still one mark
  });
});
