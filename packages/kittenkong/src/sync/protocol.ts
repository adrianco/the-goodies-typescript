/**
 * Inbetweenies Wire Protocol - Communication with FunkyGibbon Server
 *
 * Implements the inbetweenies-v2 sync protocol for bidirectional
 * entity synchronization between client and server.
 */

import type { AuthManager } from '../auth';
import { createVersion, versionTimestamp } from './version';
import { EntityType, SourceType } from '@the-goodies/inbetweenies';

export interface SyncChange {
  change_type: 'create' | 'update' | 'delete';
  entity?: EntityChange | null;
  relationships?: RelationshipChange[];
}

export interface EntityChange {
  id: string;
  version: string;
  entity_type: string;
  name: string;
  content: Record<string, any>;
  source_type: string;
  user_id: string;
  parent_versions?: string[];
  checksum?: string;
}

export interface RelationshipChange {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  properties?: Record<string, any>;
  user_id: string;
}

export interface VectorClock {
  clocks: Record<string, string>;
}

export interface SyncFilters {
  since?: string;
  entity_types?: string[];
}

export interface SyncRequest {
  protocol_version: string;
  device_id: string;
  user_id: string;
  sync_type: 'full' | 'delta';
  vector_clock: VectorClock;
  changes: SyncChange[];
  cursor?: string;
  filters?: SyncFilters;
}

export interface ConflictInfo {
  entity_id: string;
  local_version: string;
  remote_version: string;
  resolution_strategy: string;
  resolved_version?: string;
}

export interface SyncStats {
  entities_synced: number;
  relationships_synced: number;
  conflicts_resolved: number;
  duration_ms: number;
}

export interface SyncResponse {
  protocol_version: string;
  sync_type: string;
  changes: SyncChange[];
  conflicts: ConflictInfo[];
  vector_clock: VectorClock;
  cursor?: string;
  sync_stats: SyncStats;
  /**
   * UTC ISO-8601 server clock at response time. The client persists this and
   * sends it back as filters.since on the next delta sync (PROTOCOL.md §4).
   */
  server_time?: string;
  /**
   * Per-id acknowledgement of the changes this client pushed in the request
   * (FunkyGibbon v0.3.0+). A client cannot safely drop a local change until
   * the server confirms it by id: the server omits anything that lost conflict
   * resolution or was skipped for a dangling endpoint, so absent ids must stay
   * pending and retry. Optional because a pre-v0.3.0 server omits them.
   */
  applied?: string[];
  applied_relationships?: string[];
}

export interface Change {
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  data: Record<string, any>;
  version?: string;
  timestamp?: string;
  /**
   * Relationships travelling with this entity change, in wire form. The
   * protocol bundles edges onto the change for their originating entity, and
   * the server applies them only after every entity in the batch has landed
   * (PROTOCOL.md §5: entities before relationships) because the edge FK
   * references its endpoints. Empty for an entity-only change.
   */
  relationships?: RelationshipChange[];
}

export interface Conflict {
  entityId: string;
  localVersion: string;
  remoteVersion: string;
  resolutionStrategy: string;
  localData?: Record<string, any>;
  remoteData?: Record<string, any>;
}

export class InbetweeniesProtocol {
  private serverUrl: string;
  private authManager: AuthManager;
  private deviceId: string;
  private userId: string;
  private vectorClock: VectorClock;

  constructor(serverUrl: string, authManager: AuthManager, deviceId: string, userId: string = 'system') {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.authManager = authManager;
    this.deviceId = deviceId;
    this.userId = userId;
    this.vectorClock = { clocks: {} };
  }

  /**
   * Call a tool on the server's MCP endpoint.
   *
   * Some tools cannot be served from the local cache: attaching a photo means
   * getting bytes into the server's blob store, and the local replica has no
   * blob store to put them in. Rather than invent a local one -- the exact
   * habit that produced inline base64 in entity content (ADR-013 §3) -- these
   * go straight to the authority, and the attachment arrives back on the next
   * sync like any other entity.
   */
  async callServerTool(toolName: string, args: Record<string, any>): Promise<any> {
    const response = await fetch(`${this.serverUrl}/api/v1/mcp/tools/${toolName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authManager.getHeaders(),
      },
      body: JSON.stringify({ arguments: args }),
      // Blob uploads are larger than a sync delta, so the 5s sync timeout is
      // too tight; a few MB over a home LAN needs more room than that.
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`MCP tool ${toolName} failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as { success?: boolean; result?: any; error?: string };
    if (body.error) {
      throw new Error(body.error);
    }
    return body.result ?? body;
  }

  /**
   * Request changes from server (pull)
   */
  async syncRequest(lastSync: Date | null, entityTypes?: string[]): Promise<SyncResponse> {
    const syncType = lastSync ? 'delta' : 'full';
    const filters: SyncFilters | undefined = lastSync || entityTypes
      ? {
          since: lastSync?.toISOString(),
          entity_types: entityTypes,
        }
      : undefined;

    const request: SyncRequest = {
      protocol_version: 'inbetweenies-v2',
      device_id: this.deviceId,
      user_id: this.userId,
      sync_type: syncType,
      vector_clock: this.vectorClock,
      changes: [],
      filters,
    };

    const response = await fetch(`${this.serverUrl}/api/v1/sync/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authManager.getHeaders(),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Sync request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as SyncResponse;

    // Update vector clock from server
    if (data.vector_clock) {
      this.vectorClock = data.vector_clock;
    }

    return data;
  }

  /**
   * Push local changes to server
   */
  async syncPush(changes: Change[]): Promise<SyncResponse> {
    const syncChanges: SyncChange[] = changes.map(change => ({
      change_type: change.operation,
      entity: change.data ? {
        id: change.entityId,
        version: change.version || createVersion(change.data.userId || change.data.user_id || this.userId),
        entity_type: change.data.entityType || change.data.entity_type || EntityType.NOTE,
        name: change.data.name || '',
        content: change.data.content || {},
        source_type: change.data.sourceType || change.data.source_type || SourceType.MANUAL,
        user_id: change.data.userId || change.data.user_id || this.userId,
        parent_versions: change.data.parentVersions || [],
      } : null,
      // Was hardcoded [] — relationships created locally were silently never
      // pushed, so `applied_relationships` always had nothing to acknowledge.
      relationships: change.relationships ?? [],
    }));

    const request: SyncRequest = {
      protocol_version: 'inbetweenies-v2',
      device_id: this.deviceId,
      user_id: this.userId,
      sync_type: 'delta',
      vector_clock: this.vectorClock,
      changes: syncChanges,
    };

    const response = await fetch(`${this.serverUrl}/api/v1/sync/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authManager.getHeaders(),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Sync push failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as SyncResponse;

    if (data.vector_clock) {
      this.vectorClock = data.vector_clock;
    }

    return data;
  }

  /**
   * Parse sync response into changes and conflicts
   */
  parseSyncDelta(response: SyncResponse): { changes: Change[]; conflicts: Conflict[] } {
    const changes: Change[] = response.changes.map(sc => ({
      entityId: sc.entity?.id || '',
      operation: sc.change_type,
      data: sc.entity ? {
        id: sc.entity.id,
        version: sc.entity.version,
        entityType: sc.entity.entity_type,
        name: sc.entity.name,
        content: sc.entity.content,
        sourceType: sc.entity.source_type,
        userId: sc.entity.user_id,
        parentVersions: sc.entity.parent_versions || [],
      } : {},
      version: sc.entity?.version,
      // Derive the modification time from the version (the wire EntityChange has
      // no updated_at; the version encodes the UTC edit time), NOT the local clock.
      timestamp: (versionTimestamp(sc.entity?.version) ?? new Date()).toISOString(),
    }));

    const conflicts: Conflict[] = response.conflicts.map(ci => ({
      entityId: ci.entity_id,
      localVersion: ci.local_version,
      remoteVersion: ci.remote_version,
      resolutionStrategy: ci.resolution_strategy,
    }));

    return { changes, conflicts };
  }

  /**
   * Parse push result into applied IDs and conflicts.
   *
   * `applied` / `applied_relationships` are the server's per-id acknowledgement
   * of what this client just pushed (FunkyGibbon v0.3.0+). They are the only
   * safe basis for clearing a pending mark.
   *
   * Legacy fallback: a pre-v0.3.0 server omits `applied` entirely, so we fall
   * back to inferring from `response.changes`. That inference is unsafe — it
   * reads the server→client pull payload as if it were an ack, so an entity
   * that LOST conflict resolution comes back as the server's winning version
   * and looks "applied", silently dropping the local edit. It is retained only
   * so an older server keeps converging rather than retrying forever. Presence
   * of the field (even as an empty array) selects the correct path.
   */
  parseSyncResult(response: SyncResponse): {
    appliedIds: string[];
    appliedRelationshipIds: string[];
    conflicts: Conflict[];
  } {
    const appliedIds = response.applied !== undefined
      ? response.applied
      : response.changes.filter(sc => sc.entity).map(sc => sc.entity!.id);

    const appliedRelationshipIds = response.applied_relationships ?? [];

    const conflicts: Conflict[] = response.conflicts.map(ci => ({
      entityId: ci.entity_id,
      localVersion: ci.local_version,
      remoteVersion: ci.remote_version,
      resolutionStrategy: ci.resolution_strategy,
    }));

    return { appliedIds, appliedRelationshipIds, conflicts };
  }
}
