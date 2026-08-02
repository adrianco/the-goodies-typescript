/**
 * Pull-guard and relationship-push regression tests.
 *
 * Two defects from issue #3, both silent:
 *
 * 1. PULL OVERWRITES UNPUSHED LOCAL EDITS. A sync cycle pulls before it
 *    pushes, and applySingleChange stored the server's entity over local
 *    storage with no pending-edit check. A concurrent server change therefore
 *    replaced the local edit BEFORE the push phase ran; the push then read
 *    storage and sent the server's own version back, which the server acked
 *    idempotently, clearing the pending mark. The local edit was destroyed
 *    without the server ever seeing it and with no conflict recorded. Same
 *    defect as adrianco/the-goodies#69 in the Python client.
 *
 * 2. RELATIONSHIPS NEVER PUSHED. syncPush hardcoded `relationships: []` and
 *    nothing tracked pending edges, so locally-created relationships existed
 *    only on the client and `applied_relationships` always had nothing to ack.
 *
 * These test the units directly (engine + protocol) rather than through a
 * live server: the invariants are client-side ordering and payload
 * construction, which a server round-trip would obscure rather than sharpen.
 * End-to-end coverage against a real server lives in sync-integration.test.ts.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SyncEngine } from '../src/sync/engine';
import { AuthManager } from '../src/auth';
import { LocalGraphStorage } from '../src/graph/local-storage';
import { LocalGraphOperations } from '../src/graph/local-operations';
import { EntityType, SourceType, RelationshipType, type Entity } from '@the-goodies/inbetweenies';

const SERVER = 'http://127.0.0.1:1';   // never contacted in these tests

function makeEngine() {
  const storage = new LocalGraphStorage();
  const ops = new LocalGraphOperations(storage);
  const engine = new SyncEngine(SERVER, new AuthManager({ serverUrl: SERVER }), 'test-client', 'tester');
  engine.setGraphOperations(ops);
  return { engine, ops, storage };
}

function entity(id: string, name: string, version: string): Entity {
  return {
    id,
    version,
    entityType: EntityType.DEVICE,
    name,
    content: {},
    userId: 'tester',
    sourceType: SourceType.MANUAL,
    parentVersions: [],
    createdAt: new Date(),
    lastModified: new Date(),
  };
}

describe('pull-guard: a pending local edit is never overwritten by pull', () => {
  let ctx: ReturnType<typeof makeEngine>;

  beforeEach(() => { ctx = makeEngine(); });

  test('server change for a pending entity is not applied', async () => {
    const { engine, ops, storage } = ctx;

    // Local offline edit, queued for push.
    await ops.storeEntity(entity('e1', 'LOCAL EDIT', 'v-local'));
    engine.markEntityForSync('e1');

    // A concurrent server change for the same id arrives on pull.
    const applied = await (engine as any).applySingleChange({
      entityId: 'e1',
      operation: 'update',
      data: { entityType: 'DEVICE', name: 'SERVER VERSION', content: {}, userId: 'other' },
      version: 'v-server',
    });

    expect(applied, 'pull must skip an entity with an unpushed local edit').toBe(false);

    const stored = await ops.getEntity('e1');
    expect(stored?.name, 'the local edit must survive the pull').toBe('LOCAL EDIT');
    expect(stored?.version).toBe('v-local');
    expect(engine.isPending('e1'), 'the mark must remain so the push still happens').toBe(true);
    expect(storage.getEntityVersions('e1')).toHaveLength(1);
  });

  test('the local version is what the push carries, not the server version', async () => {
    const { engine, ops } = ctx;
    await ops.storeEntity(entity('e2', 'LOCAL EDIT', 'v-local'));
    engine.markEntityForSync('e2');

    await (engine as any).applySingleChange({
      entityId: 'e2',
      operation: 'update',
      data: { entityType: 'DEVICE', name: 'SERVER VERSION', content: {}, userId: 'other' },
      version: 'v-server',
    });

    const changes = await (engine as any).getLocalChanges();
    const pushed = changes.find((c: any) => c.entityId === 'e2');
    expect(pushed, 'the pending entity must be in the push payload').toBeDefined();
    expect(pushed.data.name, 'the SERVER must adjudicate the local edit').toBe('LOCAL EDIT');
    expect(pushed.version).toBe('v-local');
  });

  test('a non-pending entity is still applied normally', async () => {
    const { engine, ops } = ctx;
    await ops.storeEntity(entity('e3', 'OLD', 'v-1'));

    const applied = await (engine as any).applySingleChange({
      entityId: 'e3',
      operation: 'update',
      data: { entityType: 'DEVICE', name: 'NEW FROM SERVER', content: {}, userId: 'other' },
      version: 'v-2',
    });

    expect(applied).toBe(true);
    expect((await ops.getEntity('e3'))?.name).toBe('NEW FROM SERVER');
  });
});

describe('relationship push', () => {
  let ctx: ReturnType<typeof makeEngine>;

  beforeEach(() => { ctx = makeEngine(); });

  test('a pending edge rides on its from-entity change', async () => {
    const { engine, ops } = ctx;
    await ops.storeEntity(entity('dev', 'Lamp', 'v-1'));
    await ops.storeEntity(entity('room', 'Living Room', 'v-1'));
    const rel = await ops.storeRelationship({
      id: 'rel-1',
      fromEntityId: 'dev',
      toEntityId: 'room',
      relationshipType: RelationshipType.LOCATED_IN,
      properties: {},
      userId: 'tester',
      createdAt: new Date(),
    });
    engine.markRelationshipForSync(rel.id, rel.fromEntityId);

    const changes = await (engine as any).getLocalChanges();
    const devChange = changes.find((c: any) => c.entityId === 'dev');

    expect(devChange, 'marking an edge must also queue its from-entity').toBeDefined();
    expect(devChange.relationships, 'the edge must ride on the wire').toHaveLength(1);
    expect(devChange.relationships[0]).toMatchObject({
      id: 'rel-1',
      from_entity_id: 'dev',
      to_entity_id: 'room',
      relationship_type: RelationshipType.LOCATED_IN,
    });
  });

  test('an edge whose from-entity is already synced rides on an entity-less change', async () => {
    const { engine, ops } = ctx;
    await ops.storeEntity(entity('dev2', 'Lamp', 'v-1'));
    await ops.storeEntity(entity('room2', 'Kitchen', 'v-1'));
    await ops.storeRelationship({
      id: 'rel-2',
      fromEntityId: 'dev2',
      toEntityId: 'room2',
      relationshipType: RelationshipType.LOCATED_IN,
      properties: {},
      userId: 'tester',
      createdAt: new Date(),
    });
    // Mark ONLY the edge — the entity is already in sync.
    (engine as any).pendingSyncRelationships.add('rel-2');

    const changes = await (engine as any).getLocalChanges();
    const edgeOnly = changes.find((c: any) => !c.entityId);

    expect(edgeOnly, 'a relationships-only change must be emitted').toBeDefined();
    expect(edgeOnly.relationships[0].id).toBe('rel-2');
  });

  test('pendingChangesCount counts edges as well as entities', async () => {
    const { engine } = ctx;
    engine.markEntityForSync('a');
    engine.markRelationshipForSync('r1', 'a');
    // 'a' marked once (Set), plus one relationship.
    expect(engine.pendingChangesCount).toBe(2);
  });
});
