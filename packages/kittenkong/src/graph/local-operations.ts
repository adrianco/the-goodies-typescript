/**
 * Local Graph Operations - MCP tools and graph CRUD
 *
 * Implements all 12 MCP tools that work locally on cached graph data,
 * plus entity/relationship CRUD operations for the knowledge graph.
 */

import {
  EntityType,
  SourceType,
  RelationshipType,
  parseAt,
  versionKeyAt,
  type Entity,
  type EntityRelationship,
} from '@the-goodies/inbetweenies';
import { LocalGraphStorage, type SearchResult } from './local-storage';

export interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

const MCP_TOOLS = [
  'get_devices_in_room',
  'find_device_controls',
  'get_room_connections',
  'search_entities',
  'create_entity',
  'create_relationship',
  'find_path',
  'get_entity_details',
  'find_similar_entities',
  'get_procedures_for_device',
  'get_automations_in_room',
  'update_entity',
  // Issue #85 / ADR-004 §3 -- relationship parity and the as-of surface.
  'list_relationships',
  'get_connected',
  'end_relationship',
  'get_graph_diff',
  'list_entities',
] as const;

export type MCPToolName = typeof MCP_TOOLS[number];

export class LocalGraphOperations {
  private storage: LocalGraphStorage;

  constructor(storage: LocalGraphStorage) {
    this.storage = storage;
  }

  getAvailableTools(): string[] {
    return [...MCP_TOOLS];
  }

  /**
   * Execute an MCP tool by name
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    switch (toolName) {
      case 'get_devices_in_room':
        return this.getDevicesInRoom(args.room_id || args.roomId, this.at(args));
      case 'find_device_controls':
        return this.findDeviceControls(args.device_id || args.deviceId, this.at(args));
      case 'get_room_connections':
        return this.getRoomConnections(args.room_id || args.roomId, this.at(args));
      case 'search_entities':
        return this.searchEntitiesTool(args.query, args.entity_types || args.entityTypes, args.limit);
      case 'create_entity':
        return this.createEntityTool(
          args.entity_type || args.entityType,
          args.name,
          args.content,
          args.user_id || args.userId
        );
      case 'create_relationship':
        return this.createRelationshipTool(
          args.from_entity_id || args.fromEntityId,
          args.to_entity_id || args.toEntityId,
          args.relationship_type || args.relationshipType,
          args.properties,
          args.user_id || args.userId
        );
      case 'find_path':
        return this.findPathTool(
          args.from_entity_id || args.fromEntityId,
          args.to_entity_id || args.toEntityId,
          args.max_depth || args.maxDepth,
          this.at(args)
        );
      case 'get_entity_details':
        return this.getEntityDetailsTool(args.entity_id || args.entityId, this.at(args));
      case 'find_similar_entities':
        return this.findSimilarEntitiesTool(
          args.entity_id || args.entityId,
          args.threshold,
          args.limit
        );
      case 'get_procedures_for_device':
        return this.getProceduresForDevice(args.device_id || args.deviceId, this.at(args));
      case 'get_automations_in_room':
        return this.getAutomationsInRoom(args.room_id || args.roomId, this.at(args));
      case 'list_relationships':
        return this.listRelationshipsTool(
          args.from_entity_id || args.fromEntityId,
          args.to_entity_id || args.toEntityId,
          args.relationship_type || args.relationshipType,
          !!(args.include_history ?? args.includeHistory),
          this.at(args)
        );
      case 'get_connected':
        return this.getConnectedTool(
          args.entity_id || args.entityId,
          args.relationship_type || args.relationshipType,
          args.direction || 'both',
          this.at(args)
        );
      case 'end_relationship':
        return this.endRelationshipTool(
          args.relationship_id || args.relationshipId,
          args.reason,
          args.user_id || args.userId,
          this.at(args)
        );
      case 'get_graph_diff':
        return this.getGraphDiffTool(args.since, args.until);
      case 'list_entities':
        return this.listEntitiesTool(
          args.entity_type || args.entityType, args.limit ?? 100, args.offset ?? 0, this.at(args)
        );
      case 'update_entity':
        return this.updateEntityTool(
          args.entity_id || args.entityId,
          args.changes,
          args.user_id || args.userId
        );
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
          result: { available_tools: this.getAvailableTools() },
        };
    }
  }

  /** The as-of argument every graph read accepts (ADR-004 §3). Bad input throws;
   *  executeTool's callers surface that as a ToolResult error. */
  private at(args: Record<string, any>): Date | undefined {
    return parseAt(args.at);
  }

  // --- Entity CRUD ---

  async storeEntity(entity: Entity): Promise<Entity> {
    if (!entity.id) {
      entity = { ...entity, id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    }
    if (!entity.version) {
      entity = { ...entity, version: `v-${Date.now()}` };
    }
    if (!entity.userId) {
      entity = { ...entity, userId: 'system' };
    }
    if (!entity.createdAt) {
      entity = { ...entity, createdAt: new Date() };
    }
    if (!entity.lastModified) {
      entity = { ...entity, lastModified: new Date() };
    }
    return this.storage.storeEntity(entity);
  }

  async getEntity(entityId: string, version?: string): Promise<Entity | null> {
    return this.storage.getEntity(entityId, version);
  }

  async getEntitiesByType(entityType: EntityType): Promise<Entity[]> {
    return this.storage.getEntitiesByType(entityType);
  }

  async storeRelationship(relationship: EntityRelationship): Promise<EntityRelationship> {
    if (!relationship.id) {
      relationship = {
        ...relationship,
        id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    }
    if (!relationship.createdAt) {
      relationship = { ...relationship, createdAt: new Date() };
    }
    // ADR-004 §2: a local write is dated when it was made. validFrom is the
    // as-of axis and travels to the server verbatim.
    if (!relationship.validFrom) {
      relationship = { ...relationship, validFrom: relationship.createdAt };
    }
    return this.storage.storeRelationship(relationship);
  }

  /**
   * End an edge (ADR-004 §1): the interval closes, the row stays. This is the
   * client's delete/move primitive; the sync push carries it as an end-event.
   */
  async endRelationship(relationshipId: string, at: Date = new Date()): Promise<EntityRelationship | null> {
    return this.storage.endRelationship(relationshipId, at);
  }

  async getRelationships(
    fromId?: string,
    toId?: string,
    relType?: RelationshipType,
    includeAllVersions = false
  ): Promise<EntityRelationship[]> {
    return this.storage.getRelationships(fromId, toId, relType, { includeAllVersions });
  }

  /**
   * Look up the NEWEST interval of one edge, current or not -- for the sync
   * push path, which is the one caller that must see a retired interval: an
   * edge the user just ended is pending precisely because it ended, and a
   * current-only lookup would find nothing and drop the change forever.
   */
  async getRelationshipById(relationshipId: string): Promise<EntityRelationship | null> {
    const rows = this.storage
      .getRelationships(undefined, undefined, undefined, { includeAllVersions: true })
      .filter(r => r.id === relationshipId);
    if (rows.length === 0) return null;
    return rows.reduce((newest, r) =>
      (r.validFrom?.getTime() ?? 0) > (newest.validFrom?.getTime() ?? 0) ? r : newest
    );
  }

  async searchEntities(
    query: string,
    entityTypes?: EntityType[],
    limit: number = 10
  ): Promise<SearchResult[]> {
    const entities = this.storage.searchEntities(query, entityTypes);
    return this.filterAndRankResults(entities, query, limit);
  }

  async getEntityVersions(entityId: string): Promise<Entity[]> {
    return this.storage.getEntityVersions(entityId);
  }

  async updateEntity(entityId: string, changes: Record<string, any>, userId: string = 'system'): Promise<Entity | null> {
    const existing = this.storage.getEntity(entityId);
    if (!existing) return null;

    const updated: Entity = {
      ...existing,
      ...changes,
      id: existing.id,
      createdAt: existing.createdAt,
      version: `v-${Date.now()}`,
      lastModified: new Date(),
      userId,
      content: changes.content
        ? { ...existing.content, ...changes.content }
        : existing.content,
    };

    return this.storage.storeEntity(updated);
  }

  // --- MCP Tool Implementations ---

  private async getDevicesInRoom(roomId: string, at?: Date): Promise<ToolResult> {
    if (!roomId) return { success: false, error: 'room_id is required' };

    const devices = this.storage.getDevicesInRoom(roomId, at);

    // Also check LOCATED_IN relationships directly for broader coverage
    const rels = this.storage.getRelationships(undefined,  roomId,  RelationshipType.LOCATED_IN, { at });
    const relDeviceIds = new Set(rels.map(r => r.fromEntityId));
    for (const id of relDeviceIds) {
      if (!devices.find(d => d.id === id)) {
        const entity = this.storage.getEntity(id, undefined, at);
        if (entity) devices.push(entity);
      }
    }

    return {
      success: true,
      result: {
        room_id: roomId,
        devices: devices.map(d => ({
          id: d.id,
          name: d.name,
          type: d.entityType,
          content: d.content,
        })),
        count: devices.length,
      },
    };
  }

  private async findDeviceControls(deviceId: string, at?: Date): Promise<ToolResult> {
    if (!deviceId) return { success: false, error: 'device_id is required' };

    const device = this.storage.getEntity(deviceId, undefined, at);
    if (!device) return { success: false, error: `Device ${deviceId} not found` };

    // Find what this device controls
    const controlsRels = this.storage.getRelationships(deviceId,  undefined,  RelationshipType.CONTROLS, { at });
    const controlledDevices: any[] = [];
    for (const rel of controlsRels) {
      const target = this.storage.getEntity(rel.toEntityId, undefined, at);
      if (target) {
        controlledDevices.push({
          id: target.id,
          name: target.name,
          type: target.entityType,
          properties: rel.properties,
        });
      }
    }

    // Find what controls this device
    const controlledByRels = this.storage.getRelationships(undefined,  deviceId,  RelationshipType.CONTROLS, { at });
    const controlledBy: any[] = [];
    for (const rel of controlledByRels) {
      const source = this.storage.getEntity(rel.fromEntityId, undefined, at);
      if (source) {
        controlledBy.push({
          id: source.id,
          name: source.name,
          type: source.entityType,
        });
      }
    }

    return {
      success: true,
      result: {
        device: { id: device.id, name: device.name, type: device.entityType, content: device.content },
        controls: controlledDevices,
        controlled_by: controlledBy,
      },
    };
  }

  private async getRoomConnections(roomId: string, at?: Date): Promise<ToolResult> {
    if (!roomId) return { success: false, error: 'room_id is required' };

    // Find rooms connected via CONNECTS_TO (bidirectional)
    const outgoing = this.storage.getRelationships(roomId,  undefined,  RelationshipType.CONNECTS_TO, { at });
    const incoming = this.storage.getRelationships(undefined,  roomId,  RelationshipType.CONNECTS_TO, { at });

    const connectedRooms: any[] = [];
    const seen = new Set<string>();

    for (const rel of outgoing) {
      if (!seen.has(rel.toEntityId)) {
        seen.add(rel.toEntityId);
        const room = this.storage.getEntity(rel.toEntityId, undefined, at);
        if (room) {
          connectedRooms.push({ id: room.id, name: room.name, properties: rel.properties });
        }
      }
    }

    for (const rel of incoming) {
      if (!seen.has(rel.fromEntityId)) {
        seen.add(rel.fromEntityId);
        const room = this.storage.getEntity(rel.fromEntityId, undefined, at);
        if (room) {
          connectedRooms.push({ id: room.id, name: room.name, properties: rel.properties });
        }
      }
    }

    return {
      success: true,
      result: {
        room_id: roomId,
        connected_rooms: connectedRooms,
        count: connectedRooms.length,
      },
    };
  }

  private async searchEntitiesTool(
    query: string,
    entityTypes?: string[],
    limit: number = 10
  ): Promise<ToolResult> {
    if (!query) return { success: false, error: 'query is required' };

    const types = entityTypes?.map(t => t as EntityType);
    const results = await this.searchEntities(query, types, limit);

    return {
      success: true,
      result: {
        query,
        results: results.map(r => ({
          id: r.entity.id,
          name: r.entity.name,
          type: r.entity.entityType,
          score: r.score,
          content: r.entity.content,
        })),
        count: results.length,
      },
    };
  }

  private async createEntityTool(
    entityType: string,
    name: string,
    content?: Record<string, any>,
    userId: string = 'system'
  ): Promise<ToolResult> {
    if (!entityType || !name) {
      return { success: false, error: 'entity_type and name are required' };
    }

    const entity = await this.storeEntity({
      id: '',
      version: '',
      entityType: entityType as EntityType,
      name,
      content: content || {},
      userId,
      sourceType: SourceType.MANUAL,
      createdAt: new Date(),
      lastModified: new Date(),
    });

    return {
      success: true,
      result: {
        id: entity.id,
        name: entity.name,
        type: entity.entityType,
        version: entity.version,
      },
    };
  }

  private async createRelationshipTool(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties?: Record<string, any>,
    userId: string = 'system'
  ): Promise<ToolResult> {
    if (!fromEntityId || !toEntityId || !relationshipType) {
      return { success: false, error: 'from_entity_id, to_entity_id, and relationship_type are required' };
    }

    // Verify both entities exist
    const fromEntity = this.storage.getEntity(fromEntityId);
    const toEntity = this.storage.getEntity(toEntityId);
    if (!fromEntity) return { success: false, error: `Entity ${fromEntityId} not found` };
    if (!toEntity) return { success: false, error: `Entity ${toEntityId} not found` };

    const relationship = await this.storeRelationship({
      id: '',
      fromEntityId,
      toEntityId,
      relationshipType: relationshipType as RelationshipType,
      properties: properties || {},
      userId,
      createdAt: new Date(),
    });

    return {
      success: true,
      result: {
        id: relationship.id,
        from: fromEntityId,
        to: toEntityId,
        type: relationship.relationshipType,
      },
    };
  }

  private async findPathTool(
    fromEntityId: string,
    toEntityId: string,
    maxDepth: number = 10,
    at?: Date
  ): Promise<ToolResult> {
    if (!fromEntityId || !toEntityId) {
      return { success: false, error: 'from_entity_id and to_entity_id are required' };
    }

    const path = await this.findPath(fromEntityId, toEntityId, maxDepth, at);

    if (path.length === 0) {
      return {
        success: true,
        result: { path: [], found: false, message: 'No path found between entities' },
      };
    }

    return {
      success: true,
      result: {
        path: path.map(e => ({ id: e.id, name: e.name, type: e.entityType })),
        found: true,
        length: path.length,
      },
    };
  }

  private async getEntityDetailsTool(entityId: string, at?: Date): Promise<ToolResult> {
    if (!entityId) return { success: false, error: 'entity_id is required' };

    const entity = this.storage.getEntity(entityId, undefined, at);
    if (!entity) return { success: false, error: `Entity ${entityId} not found` };

    const outgoing = this.storage.getRelationships(entityId, undefined, undefined, { at });
    const incoming = this.storage.getRelationships(undefined,  entityId, undefined, { at });

    return {
      success: true,
      result: {
        entity: {
          id: entity.id,
          name: entity.name,
          type: entity.entityType,
          version: entity.version,
          content: entity.content,
          sourceType: entity.sourceType,
          createdAt: entity.createdAt,
          lastModified: entity.lastModified,
        },
        relationships: {
          outgoing: outgoing.map(r => ({
            id: r.id,
            to: r.toEntityId,
            type: r.relationshipType,
            properties: r.properties,
          })),
          incoming: incoming.map(r => ({
            id: r.id,
            from: r.fromEntityId,
            type: r.relationshipType,
            properties: r.properties,
          })),
          total: outgoing.length + incoming.length,
        },
      },
    };
  }

  private async findSimilarEntitiesTool(
    entityId: string,
    _threshold: number = 0.5,
    limit: number = 5
  ): Promise<ToolResult> {
    if (!entityId) return { success: false, error: 'entity_id is required' };

    const entity = this.storage.getEntity(entityId);
    if (!entity) return { success: false, error: `Entity ${entityId} not found` };

    const similar = await this.findSimilarEntities(entityId, limit);

    return {
      success: true,
      result: {
        entity: { id: entity.id, name: entity.name, type: entity.entityType },
        similar: similar.map(r => ({
          id: r.entity.id,
          name: r.entity.name,
          type: r.entity.entityType,
          similarity: r.score,
        })),
        count: similar.length,
      },
    };
  }

  private async getProceduresForDevice(deviceId: string, at?: Date): Promise<ToolResult> {
    if (!deviceId) return { success: false, error: 'device_id is required' };

    const rels = this.storage.getRelationships(undefined,  deviceId,  RelationshipType.PROCEDURE_FOR, { at });
    const procedures: any[] = [];

    for (const rel of rels) {
      const entity = this.storage.getEntity(rel.fromEntityId, undefined, at);
      if (entity && entity.entityType === EntityType.PROCEDURE) {
        procedures.push({
          id: entity.id,
          name: entity.name,
          content: entity.content,
        });
      }
    }

    return {
      success: true,
      result: {
        device_id: deviceId,
        procedures,
        count: procedures.length,
      },
    };
  }

  private async getAutomationsInRoom(roomId: string, at?: Date): Promise<ToolResult> {
    if (!roomId) return { success: false, error: 'room_id is required' };

    // Find automations that AUTOMATES relationships to entities in this room
    const roomDeviceRels = this.storage.getRelationships(undefined,  roomId,  RelationshipType.LOCATED_IN, { at });
    const roomEntityIds = new Set([roomId, ...roomDeviceRels.map(r => r.fromEntityId)]);

    const automations: any[] = [];
    const seen = new Set<string>();

    // Check TRIGGERED_BY relationships from room entities
    for (const entityId of roomEntityIds) {
      const triggerRels = this.storage.getRelationships(undefined,  entityId,  RelationshipType.TRIGGERED_BY, { at });
      for (const rel of triggerRels) {
        if (seen.has(rel.fromEntityId)) continue;
        seen.add(rel.fromEntityId);
        const entity = this.storage.getEntity(rel.fromEntityId, undefined, at);
        if (entity && entity.entityType === EntityType.AUTOMATION) {
          automations.push({
            id: entity.id,
            name: entity.name,
            content: entity.content,
          });
        }
      }
    }

    // Also check direct LOCATED_IN automations
    const allAutomations = this.storage.getEntitiesByType(EntityType.AUTOMATION);
    for (const auto of allAutomations) {
      if (seen.has(auto.id)) continue;
      const locRels = this.storage.getRelationships(auto.id,  roomId,  RelationshipType.LOCATED_IN, { at });
      if (locRels.length > 0) {
        seen.add(auto.id);
        automations.push({
          id: auto.id,
          name: auto.name,
          content: auto.content,
        });
      }
    }

    return {
      success: true,
      result: {
        room_id: roomId,
        automations,
        count: automations.length,
      },
    };
  }

  private async updateEntityTool(
    entityId: string,
    changes: Record<string, any>,
    userId: string = 'system'
  ): Promise<ToolResult> {
    if (!entityId || !changes) {
      return { success: false, error: 'entity_id and changes are required' };
    }

    const updated = await this.updateEntity(entityId, changes, userId);
    if (!updated) return { success: false, error: `Entity ${entityId} not found` };

    return {
      success: true,
      result: {
        id: updated.id,
        name: updated.name,
        type: updated.entityType,
        version: updated.version,
      },
    };
  }


  // --- Relationship parity (issue #85) and the as-of surface (ADR-004 §3) ---
  //
  // MCP is the client interface (ADR-015): everything a client does to the
  // graph has to be a tool. These are the three edge operations that were
  // not, plus the temporal queries the interval model exists to answer.

  private relDict(r: EntityRelationship) {
    return {
      id: r.id, from_entity_id: r.fromEntityId, to_entity_id: r.toEntityId,
      type: r.relationshipType, properties: r.properties || {}, user_id: r.userId,
      valid_from: r.validFrom ? r.validFrom.toISOString() : null,
      valid_to: r.validTo ? r.validTo.toISOString() : null,
    };
  }

  private async listRelationshipsTool(
    fromEntityId?: string, toEntityId?: string, relationshipType?: string,
    includeHistory = false, at?: Date
  ): Promise<ToolResult> {
    const rows = this.storage.getRelationships(
      fromEntityId, toEntityId, relationshipType as RelationshipType | undefined,
      { includeAllVersions: includeHistory, at }
    );
    return {
      success: true,
      result: {
        relationships: rows.map(r => this.relDict(r)),
        count: rows.length,
        as_of: at ? at.toISOString() : null,
        include_history: includeHistory,
      },
    };
  }

  private async getConnectedTool(
    entityId: string, relationshipType?: string, direction = 'both', at?: Date
  ): Promise<ToolResult> {
    if (!entityId) return { success: false, error: 'entity_id is required' };
    if (!['outgoing', 'incoming', 'both'].includes(direction)) {
      return { success: false, error: 'direction must be outgoing, incoming or both' };
    }
    const entity = this.storage.getEntity(entityId, undefined, at);
    if (!entity) return { success: false, error: `Entity ${entityId} not found` };
    const type = relationshipType as RelationshipType | undefined;
    const connected: any[] = [];
    if (direction !== 'incoming') {
      for (const rel of this.storage.getRelationships(entityId, undefined, type, { at })) {
        const target = this.storage.getEntity(rel.toEntityId, undefined, at);
        if (target) connected.push({ entity: this.entityDict(target), relationship: this.relDict(rel), direction: 'outgoing' });
      }
    }
    if (direction !== 'outgoing') {
      for (const rel of this.storage.getRelationships(undefined, entityId, type, { at })) {
        const source = this.storage.getEntity(rel.fromEntityId, undefined, at);
        if (source) connected.push({ entity: this.entityDict(source), relationship: this.relDict(rel), direction: 'incoming' });
      }
    }
    return {
      success: true,
      result: {
        entity: { id: entity.id, name: entity.name, type: entity.entityType },
        connected, count: connected.length, as_of: at ? at.toISOString() : null,
      },
    };
  }

  private entityDict(e: Entity) {
    return { id: e.id, name: e.name, type: e.entityType, version: e.version, content: e.content };
  }

  /**
   * End an edge -- the delete (ADR-004 §1). The row is kept as history. The
   * client marks the edge pending so it travels as an end-event on the next
   * push; this class only stores.
   */
  private async endRelationshipTool(
    relationshipId: string, reason?: string, userId?: string, at?: Date
  ): Promise<ToolResult> {
    if (!relationshipId) return { success: false, error: 'relationship_id is required' };
    const ended = this.storage.endRelationship(relationshipId, at);
    if (!ended) return { success: true, result: { relationship_id: relationshipId, already_ended: true } };
    return {
      success: true,
      result: {
        relationship_id: relationshipId,
        ended_at: ended.validTo ? ended.validTo.toISOString() : null,
        reason: reason ?? null, user_id: userId ?? null,
        relationship: this.relDict(ended),
      },
    };
  }

  /** Enumerate entities, optionally by type, paged, as of `at` (the last read that was REST-only). */
  private async listEntitiesTool(entityType?: string, limit = 100, offset = 0, at?: Date): Promise<ToolResult> {
    let all = this.storage.getAllEntities(!!at);
    if (entityType) all = all.filter(e => e.entityType === entityType);
    const found = at
      ? all.map(e => this.storage.getEntity(e.id, undefined, at)).filter((e): e is Entity => !!e)
      : all;
    found.sort((a, b) => `${a.entityType}|${a.name ?? ''}|${a.id}`.localeCompare(`${b.entityType}|${b.name ?? ''}|${b.id}`));
    const page = found.slice(offset, offset + limit);
    return {
      success: true,
      result: {
        entities: page.map(e => this.entityDict(e)), count: page.length, total: found.length,
        limit, offset, as_of: at ? at.toISOString() : null,
      },
    };
  }

  /** What changed in (since, until]: ADR-004 §3's Diff operator, on the replica. */
  private async getGraphDiffTool(since?: string, until?: string): Promise<ToolResult> {
    const t1 = parseAt(since);
    if (!t1) return { success: false, error: 'since is required' };
    const t2 = parseAt(until) ?? new Date();
    const inWindow = (d?: Date | null) => !!d && d.getTime() > t1.getTime() && d.getTime() <= t2.getTime();

    const edges = this.storage.getRelationships(undefined, undefined, undefined, { includeAllVersions: true });
    const started = edges.filter(r => inWindow(r.validFrom)).map(r => this.relDict(r));
    const ended = edges.filter(r => inWindow(r.validTo ?? null)).map(r => this.relDict(r));

    const lo = versionKeyAt(t1), hi = versionKeyAt(t2);
    const changed: any[] = [];
    for (const current of this.storage.getAllEntities(true)) {
      const hits = this.storage.getEntityVersions(current.id).filter(v => v.version > lo && v.version <= hi);
      if (hits.length === 0) continue;
      const newest = hits.reduce((a, b) => (b.version > a.version ? b : a));
      changed.push({
        id: current.id, name: newest.name, type: newest.entityType,
        versions_in_window: hits.length, latest_version_in_window: newest.version,
        tombstoned: (newest.content as any)?.deleted === true,
      });
    }
    return {
      success: true,
      result: {
        since: t1.toISOString(), until: t2.toISOString(),
        entities_changed: changed, edges_started: started, edges_ended: ended,
        counts: { entities: changed.length, edges_started: started.length, edges_ended: ended.length },
      },
    };
  }

  // --- Graph Algorithms ---

  /**
   * BFS path finding between entities
   */
  async findPath(fromId: string, toId: string, maxDepth: number = 10, at?: Date): Promise<Entity[]> {
    const startEntity = this.storage.getEntity(fromId, undefined, at);
    if (!startEntity) return [];

    if (fromId === toId) return [startEntity];

    const visited = new Set<string>();
    const parentMap = new Map<string, string>();
    const queue: { id: string; depth: number }[] = [{ id: fromId, depth: 0 }];
    visited.add(fromId);

    let nodesTraversed = 0;
    const maxNodes = 1000;

    while (queue.length > 0 && nodesTraversed < maxNodes) {
      const current = queue.shift()!;
      nodesTraversed++;

      if (current.depth >= maxDepth) continue;

      // Get all neighbors (both directions)
      const outgoing = this.storage.getRelationships(current.id, undefined, undefined, { at });
      const incoming = this.storage.getRelationships(undefined, current.id, undefined, { at });

      const neighborIds = [
        ...outgoing.map(r => r.toEntityId),
        ...incoming.map(r => r.fromEntityId),
      ];

      for (const neighborId of neighborIds) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        parentMap.set(neighborId, current.id);

        if (neighborId === toId) {
          // Reconstruct path
          const path: Entity[] = [];
          let currentId: string | undefined = toId;
          while (currentId) {
            const entity = this.storage.getEntity(currentId, undefined, at);
            if (entity) path.unshift(entity);
            currentId = parentMap.get(currentId);
          }
          return path;
        }

        queue.push({ id: neighborId, depth: current.depth + 1 });
      }
    }

    return [];
  }

  /**
   * Find entities similar to the given entity (same type, name similarity)
   */
  async findSimilarEntities(entityId: string, limit: number = 5): Promise<SearchResult[]> {
    const entity = this.storage.getEntity(entityId);
    if (!entity) return [];

    const sameType = this.storage.getEntitiesByType(entity.entityType);
    const results: SearchResult[] = [];

    for (const candidate of sameType) {
      if (candidate.id === entityId) continue;

      const score = this.nameSimilarity(entity.name || '', candidate.name || '');
      if (score > 0) {
        results.push({ entity: candidate, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private filterAndRankResults(entities: Entity[], query: string, limit: number): SearchResult[] {
    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = entities.map(entity => {
      let score = 0;
      const name = (entity.name || '').toLowerCase();

      if (name === lowerQuery) score = 1.0;
      else if (name.startsWith(lowerQuery)) score = 0.8;
      else if (name.includes(lowerQuery)) score = 0.6;
      else score = 0.3; // content match

      return { entity, score };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private nameSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la === lb) return 1.0;

    // Simple token overlap similarity
    const tokensA = new Set(la.split(/\s+/));
    const tokensB = new Set(lb.split(/\s+/));
    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    return union > 0 ? overlap / union : 0;
  }
}
