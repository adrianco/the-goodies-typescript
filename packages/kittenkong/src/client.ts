/**
 * KittenKong Client - TypeScript Client for The Goodies
 *
 * Full-featured client for the FunkyGibbon knowledge graph server.
 * Provides real-time sync, local MCP tool execution, offline operation,
 * and entity-relationship graph management.
 *
 * PORTED FROM: Python blowing-off/blowingoff/client.py
 */

import type { Entity, SyncResult } from '@the-goodies/inbetweenies';
import { EntityType, RelationshipType } from '@the-goodies/inbetweenies';
import { AuthManager } from './auth.js';
import { SyncEngine, type SyncObserver } from './sync/engine.js';
import { LocalGraphStorage } from './graph/local-storage.js';
import { LocalGraphOperations, type ToolResult } from './graph/local-operations.js';

export interface KittenKongOptions {
  serverUrl: string;
  authToken?: string;
  dbPath?: string;
  clientId?: string;
}

/**
 * Main client for interacting with FunkyGibbon server.
 *
 * Supports three authentication methods:
 * - Direct auth token (passed in options)
 * - Admin password (via loginAdmin)
 * - Guest QR code (via auth manager)
 *
 * All 12 MCP tools work locally on cached data, enabling offline operation.
 */
/**
 * Tools the server answers, not the local cache.
 *
 * Attaching a photo means getting bytes into the server's blob store, and the
 * local replica has no blob store to put them in. Inventing a local one is the
 * habit that produced inline base64 in entity content (ADR-013 §3), so these
 * go to the authority instead and arrive back on the next sync.
 *
 * get_entity_versions and get_statistics are here because the local cache
 * holds only current rows -- it cannot answer a question about history.
 */
const SERVER_BACKED_TOOLS = new Set([
  'attach_photo',
  'attach_document',
  'get_blob',
  'get_entity_versions',
  'tombstone_entity',
  'get_statistics',
]);

/** Of those, the ones that change server state and so need a sync afterwards. */
const MUTATING_SERVER_TOOLS = new Set([
  'attach_photo',
  'attach_document',
  'tombstone_entity',
]);

export class KittenKongClient {
  public readonly serverUrl: string;
  public readonly clientId: string;
  private authManager: AuthManager;
  private syncEngine: SyncEngine | null = null;
  private storage: LocalGraphStorage;
  private graphOps: LocalGraphOperations;
  private connected: boolean = false;
  private _isOffline: boolean = false;

  constructor(options: KittenKongOptions) {
    this.serverUrl = options.serverUrl;
    this.clientId = options.clientId || `kittenkong-${Date.now()}`;

    this.authManager = new AuthManager({ serverUrl: options.serverUrl });
    if (options.authToken) {
      this.authManager.token = options.authToken;
      this.authManager.role = 'admin';
      this.authManager.permissions = ['read', 'write', 'delete', 'configure'];
      this.authManager.tokenExpires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    }

    this.storage = new LocalGraphStorage();
    this.graphOps = new LocalGraphOperations(this.storage);
  }

  /**
   * Connect to the FunkyGibbon server and initialize sync
   */
  async connect(password?: string, qrData?: string): Promise<void> {
    // Authenticate if credentials provided
    if (password) {
      const success = await this.authManager.loginAdmin(password);
      if (!success) throw new Error('Admin authentication failed');
    } else if (qrData) {
      const success = await this.authManager.loginGuest(qrData);
      if (!success) throw new Error('Guest authentication failed');
    } else {
      // Try loading saved token
      await this.authManager.loadToken();
    }

    // Initialize sync engine
    this.syncEngine = new SyncEngine(
      this.serverUrl,
      this.authManager,
      this.clientId
    );
    this.syncEngine.setGraphOperations(this.graphOps);

    // Check server connectivity
    const serverUp = await this.checkServerConnectivity();
    this._isOffline = !serverUp;

    this.connected = true;

    // Initial sync if server is reachable
    if (serverUp) {
      await this.syncEngine.sync();
    }
  }

  /**
   * Authenticate with admin password
   */
  async loginAdmin(password: string): Promise<boolean> {
    const success = await this.authManager.loginAdmin(password);
    if (success && !this.connected) {
      await this.connect();
    }
    return success;
  }

  /**
   * Check if the server is reachable
   */
  async checkServerConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      this._isOffline = !response.ok;
      return response.ok;
    } catch {
      this._isOffline = true;
      return false;
    }
  }

  /**
   * Whether the client is in offline/disconnected mode
   */
  get isOffline(): boolean {
    return this._isOffline;
  }

  /**
   * Number of changes waiting to sync
   */
  get pendingChangesCount(): number {
    return this.syncEngine?.pendingChangesCount || 0;
  }

  // --- Sync Operations ---

  /**
   * Sync with server (pull + push)
   */
  async sync(): Promise<SyncResult> {
    if (!this.syncEngine) {
      this.ensureConnected();
      // If ensureConnected didn't throw, create engine on the fly
      this.syncEngine = new SyncEngine(this.serverUrl, this.authManager, this.clientId);
      this.syncEngine.setGraphOperations(this.graphOps);
    }

    const serverUp = await this.checkServerConnectivity();
    if (!serverUp) {
      return {
        syncedEntities: 0,
        changesSent: 0,
        changesReceived: 0,
        conflictsResolved: 0,
        conflicts: [],
        duration: 0,
      };
    }

    return this.syncEngine.sync();
  }

  /**
   * Start automatic background sync
   */
  async startBackgroundSync(intervalSeconds: number = 30): Promise<void> {
    if (!this.syncEngine) {
      this.syncEngine = new SyncEngine(this.serverUrl, this.authManager, this.clientId);
      this.syncEngine.setGraphOperations(this.graphOps);
    }
    this.syncEngine.startBackgroundSync(intervalSeconds * 1000);
  }

  /**
   * Get sync status and statistics
   */
  async getSyncStatus(): Promise<Record<string, any>> {
    return this.syncEngine?.getSyncStatus() || {
      lastSync: null,
      lastSuccess: null,
      totalSyncs: 0,
      syncFailures: 0,
      totalConflicts: 0,
      syncInProgress: false,
      lastError: null,
      pendingChanges: 0,
    };
  }

  // --- Observer Pattern ---

  addObserver(callback: SyncObserver): void {
    this.syncEngine?.addObserver(callback);
  }

  removeObserver(callback: SyncObserver): void {
    this.syncEngine?.removeObserver(callback);
  }

  // --- Entity Operations ---

  /**
   * Create a new entity
   */
  async createEntity(entity: Partial<Entity>): Promise<Entity> {
    const stored = await this.graphOps.storeEntity(entity as Entity);
    this.syncEngine?.markEntityForSync(stored.id);
    return stored;
  }

  /**
   * Get an entity by ID
   */
  async getEntity(entityId: string): Promise<Entity | null> {
    return this.graphOps.getEntity(entityId);
  }

  /**
   * Get all entities of a given type
   */
  async getEntitiesByType(entityType: EntityType): Promise<Entity[]> {
    return this.graphOps.getEntitiesByType(entityType);
  }

  /**
   * Update an existing entity
   */
  async updateEntity(entityId: string, changes: Record<string, any>, userId?: string): Promise<Entity | null> {
    const updated = await this.graphOps.updateEntity(entityId, changes, userId);
    if (updated) {
      this.syncEngine?.markEntityForSync(updated.id);
    }
    return updated;
  }

  /**
   * Search entities by query
   */
  async searchEntities(query: string, entityTypes?: EntityType[], limit?: number): Promise<Entity[]> {
    const results = await this.graphOps.searchEntities(query, entityTypes, limit);
    return results.map(r => r.entity);
  }

  /**
   * Get version history for an entity
   */
  async getEntityVersions(entityId: string): Promise<Entity[]> {
    return this.graphOps.getEntityVersions(entityId);
  }

  // --- Relationship Operations ---

  /**
   * Create a relationship between entities
   */
  async createRelationship(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties?: Record<string, any>,
    userId?: string
  ): Promise<any> {
    const stored = await this.graphOps.storeRelationship({
      id: '',
      fromEntityId,
      toEntityId,
      relationshipType: relationshipType as any,
      properties,
      userId: userId || 'system',
      createdAt: new Date(),
    });
    // Queue the edge for push. Without this the relationship existed only
    // locally: getLocalChanges built entity-only changes, so no edge ever
    // reached the server and `applied_relationships` had nothing to ack.
    this.syncEngine?.markRelationshipForSync(stored.id, stored.fromEntityId);
    return stored;
  }

  /**
   * Get relationships with optional filters
   */
  async getRelationships(fromId?: string, toId?: string, relType?: string): Promise<any[]> {
    return this.graphOps.getRelationships(fromId, toId, relType as any);
  }

  // --- MCP Tool Execution ---

  /**
   * Execute an MCP tool locally
   */
  async executeMCPTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    if (SERVER_BACKED_TOOLS.has(toolName)) {
      if (!this.syncEngine) {
        return { success: false, error: `${toolName} needs a server connection; call connect() first` };
      }
      try {
        const result = await this.syncEngine.callServerTool(toolName, args);
        // Attachments and tombstones create or change entities server-side.
        // Pull them into the local cache now rather than leaving the caller to
        // read stale data until the next background tick.
        if (MUTATING_SERVER_TOOLS.has(toolName)) {
          await this.sync().catch(() => undefined);
        }
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const result = await this.graphOps.executeTool(toolName, args);

    // A tool that changes the local graph is a local edit, and a local edit
    // must be pushed. This used to be missing for every MCP write: an entity
    // created or an edge added through the MCP server lived only in this
    // process and never reached FunkyGibbon, because nothing marked it
    // pending. Ending an edge is the same -- it travels as an end-event.
    if (result.success && this.syncEngine) {
      const r = result.result ?? {};
      switch (toolName) {
        case 'create_entity':
        case 'update_entity':
          if (r.id) this.syncEngine.markEntityForSync(r.id);
          break;
        case 'create_relationship':
          if (r.id) this.syncEngine.markRelationshipForSync(r.id, r.from);
          break;
        case 'end_relationship':
          if (r.relationship_id && !r.already_ended) this.syncEngine.markRelationshipForSync(r.relationship_id);
          break;
      }
    }
    return result;
  }

  /**
   * Get list of available MCP tools
   */
  getAvailableMCPTools(): string[] {
    return this.graphOps.getAvailableTools();
  }

  // --- Graph Operations ---

  /**
   * Find path between two entities
   */
  async findPath(fromId: string, toId: string, maxDepth?: number): Promise<Entity[]> {
    return this.graphOps.findPath(fromId, toId, maxDepth);
  }

  /**
   * Find entities similar to a given entity
   */
  async findSimilarEntities(entityId: string, limit?: number): Promise<any[]> {
    return this.graphOps.findSimilarEntities(entityId, limit);
  }

  /**
   * Get graph statistics
   */
  getGraphStatistics(): Record<string, any> {
    return this.storage.getStatistics();
  }

  // --- Permissions ---

  /**
   * Check if user has write permission
   */
  checkWritePermission(): boolean {
    return this.authManager.hasPermission('write');
  }

  /**
   * Check if user is admin
   */
  checkAdminPermission(): boolean {
    return this.authManager.role === 'admin';
  }

  // --- Data Management ---

  /**
   * Clear all local graph data
   */
  clearGraphData(): void {
    this.storage.clear();
  }

  /**
   * Get the auth manager for direct access
   */
  getAuthManager(): AuthManager {
    return this.authManager;
  }

  // --- Lifecycle ---

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    this.syncEngine?.stopBackgroundSync();
    this.syncEngine = null;
    this.connected = false;
  }

  private ensureConnected(): void {
    // Allow operations even when not explicitly connected
    // (offline mode supports local-only operations)
  }

  // --- Demo ---

  /**
   * Demonstrate MCP functionality with sample data
   */
  async demoMCPFunctionality(): Promise<void> {
    // Create a home
    const home = await this.createEntity({
      entityType: EntityType.HOME,
      name: 'Demo Home',
      content: { address: '123 Demo St' },
    });

    // Create rooms
    const livingRoom = await this.createEntity({
      entityType: EntityType.ROOM,
      name: 'Living Room',
      content: { floor: 1 },
    });

    const kitchen = await this.createEntity({
      entityType: EntityType.ROOM,
      name: 'Kitchen',
      content: { floor: 1 },
    });

    // Create devices
    const lightSwitch = await this.createEntity({
      entityType: EntityType.DEVICE,
      name: 'Smart Light',
      content: { type: 'light', brand: 'Philips Hue' },
    });

    const thermostat = await this.createEntity({
      entityType: EntityType.DEVICE,
      name: 'Thermostat',
      content: { type: 'thermostat', brand: 'Ecobee' },
    });

    // Create relationships
    await this.createRelationship(livingRoom.id, home.id, RelationshipType.LOCATED_IN);
    await this.createRelationship(kitchen.id, home.id, RelationshipType.LOCATED_IN);
    await this.createRelationship(lightSwitch.id, livingRoom.id, RelationshipType.LOCATED_IN);
    await this.createRelationship(thermostat.id, kitchen.id, RelationshipType.LOCATED_IN);
    await this.createRelationship(livingRoom.id, kitchen.id, RelationshipType.CONNECTS_TO);

    // Test MCP tools
    const devicesResult = await this.executeMCPTool('get_devices_in_room', { room_id: livingRoom.id });
    console.log('Devices in Living Room:', devicesResult.result);

    const searchResult = await this.executeMCPTool('search_entities', { query: 'Smart' });
    console.log('Search for "Smart":', searchResult.result);
  }
}
