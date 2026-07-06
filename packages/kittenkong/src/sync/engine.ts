/**
 * Sync Engine - Bidirectional synchronization orchestrator
 *
 * Coordinates pull/push sync cycles with the FunkyGibbon server,
 * manages pending changes, background sync, and conflict resolution.
 */

import type { Entity, EntityRelationship, SyncMetadata, SyncResult, Conflict } from '@the-goodies/inbetweenies';
import type { AuthManager } from '../auth';
import { InbetweeniesProtocol, type Change } from './protocol';
import { ConflictResolver } from './conflict-resolver';
import { createVersion } from './version';
import { LocalGraphOperations } from '../graph/local-operations';

export type SyncObserver = (event: string, data: any) => void | Promise<void>;

export class SyncEngine {
  private protocol: InbetweeniesProtocol;
  private graphOps: LocalGraphOperations | null = null;
  private pendingSyncEntities: Set<string> = new Set();
  private metadata: SyncMetadata;
  private observers: SyncObserver[] = [];
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: number = 0;

  constructor(
    serverUrl: string,
    authManager: AuthManager,
    clientId: string,
    userId: string = 'system'
  ) {
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

  get pendingChangesCount(): number {
    return this.pendingSyncEntities.size;
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
            entityType: 'NOTE' as any, // Will be resolved by actual entity lookup
            localVersion: conflict.localVersion,
            remoteVersion: conflict.remoteVersion,
            reason: conflict.resolutionStrategy,
            resolvedAt: new Date(),
          });
        }
      }

      // Step 4: Push local changes
      let changesSent = 0;
      if (this.pendingSyncEntities.size > 0 && this.graphOps) {
        const localChanges = await this.getLocalChanges();
        if (localChanges.length > 0) {
          const pushResponse = await this.protocol.syncPush(localChanges);
          const { appliedIds, conflicts: pushConflicts } =
            this.protocol.parseSyncResult(pushResponse);
          changesSent = appliedIds.length;

          // Clear synced entities from pending
          for (const id of appliedIds) {
            this.pendingSyncEntities.delete(id);
          }

          // Handle push conflicts
          for (const conflict of pushConflicts) {
            allConflicts.push({
              entityId: conflict.entityId,
              entityType: 'NOTE' as any,
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
        });
      }
    }
    return changes;
  }

  private async applySingleChange(change: Change): Promise<boolean> {
    if (!this.graphOps || !change.data) return false;

    try {
      const entity: Entity = {
        id: change.entityId,
        version: change.version || createVersion(change.data.userId || 'system'),
        entityType: (change.data.entityType || 'NOTE').toUpperCase() as any,
        name: change.data.name || '',
        content: change.data.content || {},
        userId: change.data.userId || 'system',
        sourceType: (change.data.sourceType || 'API').toUpperCase() as any,
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
