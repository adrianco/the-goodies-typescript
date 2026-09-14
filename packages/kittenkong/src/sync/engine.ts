/**
 * Sync Engine - Bidirectional synchronization orchestrator
 *
 * Coordinates pull/push sync cycles with the FunkyGibbon server,
 * manages pending changes, background sync, and conflict resolution.
 */

import type { Entity, EntityRelationship, SyncMetadata, SyncResult, Conflict, RelationshipType } from '@the-goodies/inbetweenies';
import { EntityType, SourceType } from '@the-goodies/inbetweenies';
import type { AuthManager } from '../auth.js';
import { InbetweeniesProtocol, type Change, type RelationshipChange } from './protocol.js';
import { ConflictResolver } from './conflict-resolver.js';
import { createVersion } from './version.js';
import { LocalGraphOperations } from '../graph/local-operations.js';

export type SyncObserver = (event: string, data: any) => void | Promise<void>;

export class SyncEngine {
  private protocol: InbetweeniesProtocol;

  /** Call a tool on the server's MCP endpoint. See InbetweeniesProtocol.callServerTool. */
  async callServerTool(toolName: string, args: Record<string, any>): Promise<any> {
    return this.protocol.callServerTool(toolName, args);
  }

  private graphOps: LocalGraphOperations | null = null;
  private pendingSyncEntities: Set<string> = new Set();
  private pendingSyncRelationships: Set<string> = new Set();
  private metadata: SyncMetadata;
  private observers: SyncObserver[] = [];
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: number = 0;
  private readonly userId: string;

  constructor(
    serverUrl: string,
    authManager: AuthManager,
    clientId: string,
    userId: string = 'system'
  ) {
    this.userId = userId;
    this.protocol = new InbetweeniesProtocol(serverUrl, authManager, clientId, userId);
    this.metadata = {
      clientId,
      serverUrl,
      totalSyncs: 0,
      syncFailures: 0,
      totalConflicts: 0,
      syncInProgress: false,
    };
  }

  setGraphOperations(graphOps: LocalGraphOperations): void {
    this.graphOps = graphOps;
  }

  addObserver(callback: SyncObserver): void {
    this.observers.push(callback);
  }

  removeObserver(callback: SyncObserver): void {
    const idx = this.observers.indexOf(callback);
    if (idx >= 0) this.observers.splice(idx, 1);
  }

  /**
   * Mark an entity as needing sync to server
   */
  markEntityForSync(entityId: string): void {
    this.pendingSyncEntities.add(entityId);
  }

  /**
   * Mark a relationship as needing sync to server.
   *
   * Edges ride on the change for their originating (from) entity, so the
   * entity is marked too — the server applies entities before relationships
   * (PROTOCOL.md §5) and the edge's FK needs its endpoint present.
   */
  markRelationshipForSync(relationshipId: string, fromEntityId?: string): void {
    this.pendingSyncRelationships.add(relationshipId);
    if (fromEntityId) this.pendingSyncEntities.add(fromEntityId);
  }

  /** Is this entity carrying an unpushed local edit? */
  isPending(entityId: string): boolean {
    return this.pendingSyncEntities.has(entityId);
  }

  get pendingChangesCount(): number {
    return this.pendingSyncEntities.size + this.pendingSyncRelationships.size;
  }

  getSyncStatus(): Record<string, any> {
    return {
      lastSync: this.metadata.lastSyncTime?.toISOString() || null,
      lastSuccess: this.metadata.lastSuccessTime?.toISOString() || null,
      totalSyncs: this.metadata.totalSyncs,
      syncFailures: this.metadata.syncFailures,
      totalConflicts: this.metadata.totalConflicts,
      syncInProgress: this.metadata.syncInProgress,
      lastError: this.metadata.lastError || null,
      pendingChanges: this.pendingSyncEntities.size,
    };
  }

  /**
   * Perform a full sync cycle: pull server changes, push local changes
   */
  async sync(): Promise<SyncResult> {
    if (this.metadata.syncInProgress) {
      return {
        syncedEntities: 0,
        changesSent: 0,
        changesReceived: 0,
        conflictsResolved: 0,
        conflicts: [],
        duration: 0,
      };
    }

    this.metadata.syncInProgress = true;
    this.metadata.totalSyncs++;
    const startTime = Date.now();
    const allConflicts: Conflict[] = [];

    try {
      // Step 1: Pull server changes
      const serverResponse = await this.protocol.syncRequest(
        this.metadata.lastSyncTime || null
      );
      const { changes: serverChanges, conflicts: pullConflicts } =
        this.protocol.parseSyncDelta(serverResponse);

      // Step 2: Apply server changes locally
      let changesReceived = 0;
      if (this.graphOps) {
        for (const change of serverChanges) {
          const applied = await this.applySingleChange(change);
          if (applied) changesReceived++;
        }
      }

      // Step 3: Resolve pull conflicts
      for (const conflict of pullConflicts) {
        const resolved = await this.resolveConflict(conflict);
        if (resolved) {
          allConflicts.push({
            entityId: conflict.entityId,
            entityType: EntityType.NOTE as any, // Will be resolved by actual entity lookup
            localVersion: conflict.localVersion,
            remoteVersion: conflict.remoteVersion,
            reason: conflict.resolutionStrategy,
            resolvedAt: new Date(),
          });
        }
      }

      // Step 4: Push local changes
      let changesSent = 0;
      if ((this.pendingSyncEntities.size > 0 || this.pendingSyncRelationships.size > 0) && this.graphOps) {
        const localChanges = await this.getLocalChanges();
        if (localChanges.length > 0) {
          const pushResponse = await this.protocol.syncPush(localChanges);
          const { appliedIds, appliedRelationshipIds, conflicts: pushConflicts } =
            this.protocol.parseSyncResult(pushResponse);
          changesSent = appliedIds.length;

          // Clear synced entities from pending
          for (const id of appliedIds) {
            this.pendingSyncEntities.delete(id);
          }
          // Same per-id rule for edges: only an acknowledged edge is dropped.
          // Anything the server omitted (endpoint missing, lost resolution)
          // stays pending and retries on the next sync.
          for (const id of appliedRelationshipIds) {
            this.pendingSyncRelationships.delete(id);
          }

          // Handle push conflicts
          for (const conflict of pushConflicts) {
            allConflicts.push({
              entityId: conflict.entityId,
              entityType: EntityType.NOTE as any,
              localVersion: conflict.localVersion,
              remoteVersion: conflict.remoteVersion,
              reason: conflict.resolutionStrategy,
              resolvedAt: new Date(),
            });
          }
        }
      }

      // Update metadata. The delta watermark is the SERVER's clock from the
      // response (server_time), NOT the client's local time — we replay it as
      // filters.since next sync (PROTOCOL.md §4). Fall back to local time only
      // if an older server omits server_time.
      const duration = (Date.now() - startTime) / 1000;
      this.metadata.lastSyncTime = serverResponse.server_time
        ? new Date(serverResponse.server_time)
        : new Date();
      this.metadata.lastSuccessTime = new Date();
      this.metadata.totalConflicts += allConflicts.length;
      this.metadata.lastError = undefined;
      this.consecutiveFailures = 0;

      const result: SyncResult = {
        syncedEntities: changesReceived + changesSent,
        changesSent,
        changesReceived,
        conflictsResolved: allConflicts.length,
        conflicts: allConflicts,
        duration,
      };

      await this.notifyObservers('sync_complete', result);
      return result;

    } catch (error: any) {
      this.metadata.syncFailures++;
      this.metadata.lastError = error.message;
      this.consecutiveFailures++;

      await this.notifyObservers('sync_disconnected', { error: error.message });

      return {
        syncedEntities: 0,
        changesSent: 0,
        changesReceived: 0,
        conflictsResolved: 0,
        conflicts: allConflicts,
        duration: (Date.now() - startTime) / 1000,
      };

    } finally {
      this.metadata.syncInProgress = false;
    }
  }

  /**
   * Start automatic background sync
   */
  startBackgroundSync(intervalMs: number = 30000): void {
    this.stopBackgroundSync();

    const runSync = async () => {
      try {
        await this.sync();
      } catch {
        // Background sync failures are tracked in metadata
      }

      // Exponential backoff on consecutive failures (max 5 min)
      const backoffInterval = this.consecutiveFailures >= 3
        ? Math.min(intervalMs * Math.pow(2, this.consecutiveFailures - 2), 300000)
        : intervalMs;

      this.backgroundSyncTimer = setTimeout(runSync, backoffInterval);
    };

    this.backgroundSyncTimer = setTimeout(runSync, intervalMs);
  }

  /**
   * Stop background sync
   */
  stopBackgroundSync(): void {
    if (this.backgroundSyncTimer) {
      clearTimeout(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }
  }

  private async getLocalChanges(): Promise<Change[]> {
    if (!this.graphOps) return [];

    // Pending edges, grouped by the entity whose change they ride on.
    const edgesByFrom = new Map<string, RelationshipChange[]>();
    for (const relId of this.pendingSyncRelationships) {
      const rel = await this.graphOps.getRelationshipById(relId);
      if (!rel) continue;
      const wire: RelationshipChange = {
        id: rel.id,
        from_entity_id: rel.fromEntityId,
        to_entity_id: rel.toEntityId,
        relationship_type: rel.relationshipType,
        properties: rel.properties || {},
        user_id: rel.userId || this.userId,
        // ADR-004 §2/§6: the interval IS the payload. valid_from is this
        // client's edit time -- the as-of axis -- and a set valid_to is how an
        // edge is ended (deleted or moved). Omit them and the server stamps
        // its own clock and cannot tell an end-event from an unchanged re-push.
        valid_from: (rel.validFrom ?? rel.createdAt ?? new Date()).toISOString(),
        valid_to: rel.validTo ? rel.validTo.toISOString() : null,
      };
      const bucket = edgesByFrom.get(rel.fromEntityId) || [];
      bucket.push(wire);
      edgesByFrom.set(rel.fromEntityId, bucket);
    }

    const changes: Change[] = [];
    for (const entityId of this.pendingSyncEntities) {
      const entity = await this.graphOps.getEntity(entityId);
      if (entity) {
        changes.push({
          entityId: entity.id,
          operation: 'update', // Could be refined with tracking
          data: {
            entityType: entity.entityType,
            name: entity.name,
            content: entity.content,
            sourceType: entity.sourceType,
            userId: entity.userId,
            parentVersions: entity.parentVersions,
          },
          version: entity.version,
          timestamp: entity.lastModified instanceof Date
            ? entity.lastModified.toISOString()
            : String(entity.lastModified),
          relationships: edgesByFrom.get(entityId) ?? [],
        });
        edgesByFrom.delete(entityId);
      }
    }

    // Edges whose `from` entity is already in sync ride on their own
    // entity-less change — the server treats a change with no entity as
    // relationships-only, which is exactly this case.
    for (const [, edges] of edgesByFrom) {
      changes.push({
        entityId: '',
        operation: 'update',
        data: {},
        relationships: edges,
      });
    }

    return changes;
  }

  private async applySingleChange(change: Change): Promise<boolean> {
    if (!this.graphOps || !change.data) return false;

    let applied = false;
    if (change.entityId) {
      applied = await this.applyPulledEntity(change);
    }
    // v3: edges ride on the change (PROTOCOL.md §3.1/§5 -- entities before
    // relationships, which is why they are applied after the entity above).
    // A change with no entityId carries only edges and must still apply.
    const edgesApplied = await this.applyPulledRelationships(change);
    return applied || edgesApplied;
  }

  /**
   * Store the edge intervals riding on a pulled change (ADR-005 §3).
   *
   * A pending local edit for the same edge id wins, exactly as it does for
   * entities: an edge the user just ended offline is pending precisely
   * because it changed, and the server's older interval must not overwrite
   * it before the push has been adjudicated.
   */
  private async applyPulledRelationships(change: Change): Promise<boolean> {
    if (!this.graphOps || !change.relationships?.length) return false;
    let applied = false;
    for (const wire of change.relationships) {
      if (this.pendingSyncRelationships.has(wire.id)) continue;
      const validFrom = wire.valid_from ? new Date(wire.valid_from) : new Date();
      const rel: EntityRelationship = {
        id: wire.id,
        fromEntityId: wire.from_entity_id,
        toEntityId: wire.to_entity_id,
        relationshipType: wire.relationship_type as RelationshipType,
        properties: wire.properties || {},
        userId: wire.user_id || 'system',
        createdAt: validFrom,
        validFrom,
        validTo: wire.valid_to ? new Date(wire.valid_to) : null,
      };
      try {
        // storeRelationship is the plain store, not a local write: it does not
        // mark the edge pending, so the server's own row is never pushed back.
        await this.graphOps.storeRelationship(rel);
        applied = true;
      } catch {
        // one bad edge must not abort the batch
      }
    }
    return applied;
  }

  private async applyPulledEntity(change: Change): Promise<boolean> {
    if (!this.graphOps) return false;

    // PULL-GUARD: never overwrite an entity carrying an unpushed local edit.
    //
    // Pull runs before push in a sync cycle. Without this check, a concurrent
    // server change would replace the local edit in storage, the push would
    // then read storage and send the SERVER's own version back, the server
    // would idempotently ack it, and the pending mark would clear — destroying
    // the local edit without the server ever seeing it and with no conflict
    // recorded. Skipping here lets the push carry the local version with its
    // original parentVersions, so the SERVER adjudicates (fast-forward or
    // conflict resolution) as the protocol intends. The server's version is
    // not lost: it is re-sent on the next delta once this id is no longer
    // pending. Same defect as adrianco/the-goodies#69 in the Python client.
    if (change.entityId && this.pendingSyncEntities.has(change.entityId)) {
      return false;
    }

    try {
      const entity: Entity = {
        id: change.entityId,
        version: change.version || createVersion(change.data.userId || 'system'),
        entityType: (change.data.entityType || EntityType.NOTE) as any,
        name: change.data.name || '',
        content: change.data.content || {},
        userId: change.data.userId || 'system',
        sourceType: (change.data.sourceType || SourceType.IMPORTED) as any,
        parentVersions: change.data.parentVersions || [],
        createdAt: change.data.createdAt ? new Date(change.data.createdAt) : new Date(),
        lastModified: change.timestamp ? new Date(change.timestamp) : new Date(),
      };

      await this.graphOps.storeEntity(entity);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveConflict(conflict: any): Promise<boolean> {
    // For now, last-write-wins (accept remote)
    return true;
  }

  private async notifyObservers(event: string, data: any): Promise<void> {
    for (const observer of this.observers) {
      try {
        const result = observer(event, data);
        if (result instanceof Promise) await result;
      } catch {
        // Observer errors should not break sync
      }
    }
  }
}
