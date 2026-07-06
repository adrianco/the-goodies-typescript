/**
 * Local Graph Storage - In-memory entity and relationship storage
 *
 * Provides fast in-memory storage with indexes for entity type lookups,
 * room-device relationships, and full-text search across the graph.
 */

import type { Entity, EntityRelationship, EntityType, RelationshipType } from '@the-goodies/inbetweenies';

export interface SearchResult {
  entity: Entity;
  score: number;
}

export class LocalGraphStorage {
  // Entity storage: id -> version[] (latest last)
  private entities: Map<string, Entity[]> = new Map();

  // Relationship storage
  private relationships: EntityRelationship[] = [];

  // Indexes
  private typeIndex: Map<string, Set<string>> = new Map(); // entityType -> Set<entityId>
  private roomIndex: Map<string, Set<string>> = new Map(); // roomId -> Set<deviceId>

  /**
   * Store an entity (creates or updates)
   */
  storeEntity(entity: Entity): Entity {
    const versions = this.entities.get(entity.id) || [];

    // Replace existing version if exact match, else append
    const existingIdx = versions.findIndex(v => v.version === entity.version);
    if (existingIdx >= 0) {
      versions[existingIdx] = entity;
    } else {
      versions.push(entity);
    }

    this.entities.set(entity.id, versions);
    this.updateTypeIndex(entity);

    return entity;
  }

  /**
   * Get an entity by ID (latest version by default)
   */
  getEntity(entityId: string, version?: string): Entity | null {
    const versions = this.entities.get(entityId);
    if (!versions || versions.length === 0) return null;

    if (version) {
      return versions.find(v => v.version === version) || null;
    }

    return versions[versions.length - 1];
  }

  /**
   * Is this the live (non-tombstoned) form of an entity? A delete is a version
   * with content.deleted=true (PROTOCOL.md §8); such entities are excluded from
   * active-view results but their rows are retained for sync.
   */
  private isActive(entity: Entity | null): boolean {
    const content = entity?.content as Record<string, any> | undefined;
    return !!entity && content?.deleted !== true;
  }

  /**
   * Get all entities of a given type (latest, non-tombstoned versions)
   */
  getEntitiesByType(entityType: EntityType): Entity[] {
    const ids = this.typeIndex.get(entityType);
    if (!ids) return [];

    const results: Entity[] = [];
    for (const id of ids) {
      const entity = this.getEntity(id);
      if (this.isActive(entity)) results.push(entity!);
    }
    return results;
  }

  /**
   * Get all version history for an entity
   */
  getEntityVersions(entityId: string): Entity[] {
    return this.entities.get(entityId) || [];
  }

  /**
   * Store a relationship
   */
  storeRelationship(relationship: EntityRelationship): EntityRelationship {
    // Avoid duplicates
    const exists = this.relationships.find(r => r.id === relationship.id);
    if (!exists) {
      this.relationships.push(relationship);
      this.updateRoomIndex(relationship);
    }
    return relationship;
  }

  /**
   * Get relationships with optional filters
   */
  getRelationships(
    fromId?: string,
    toId?: string,
    relType?: RelationshipType
  ): EntityRelationship[] {
    return this.relationships.filter(r => {
      if (fromId && r.fromEntityId !== fromId) return false;
      if (toId && r.toEntityId !== toId) return false;
      if (relType && r.relationshipType !== relType) return false;
      return true;
    });
  }

  /**
   * Get devices in a room using the room index
   */
  getDevicesInRoom(roomId: string): Entity[] {
    const deviceIds = this.roomIndex.get(roomId);
    if (!deviceIds) return [];

    const results: Entity[] = [];
    for (const id of deviceIds) {
      const entity = this.getEntity(id);
      if (this.isActive(entity)) results.push(entity!);
    }
    return results;
  }

  /**
   * Search entities by query string across name and content
   */
  searchEntities(query: string, entityTypes?: EntityType[]): Entity[] {
    if (query === '*') {
      const all = this.getAllEntities();
      if (entityTypes) {
        return all.filter(e => entityTypes.includes(e.entityType));
      }
      return all;
    }

    const lowerQuery = query.toLowerCase();
    const results: Entity[] = [];

    for (const [_id, versions] of this.entities) {
      const entity = versions[versions.length - 1];
      if (!this.isActive(entity)) continue;

      if (entityTypes && !entityTypes.includes(entity.entityType)) continue;

      const nameMatch = entity.name?.toLowerCase().includes(lowerQuery);
      const contentMatch = JSON.stringify(entity.content).toLowerCase().includes(lowerQuery);

      if (nameMatch || contentMatch) {
        results.push(entity);
      }
    }

    return results;
  }

  /**
   * Get all entities (latest versions)
   */
  getAllEntities(): Entity[] {
    const results: Entity[] = [];
    for (const versions of this.entities.values()) {
      const entity = versions[versions.length - 1];
      if (this.isActive(entity)) {
        results.push(entity);
      }
    }
    return results;
  }

  /**
   * Sync from server data - replace local data
   */
  syncFromServer(entities: Entity[], relationships: EntityRelationship[]): void {
    // Update entities (merge, don't destroy local-only data)
    for (const entity of entities) {
      this.storeEntity(entity);
    }

    // Update relationships
    for (const rel of relationships) {
      const existingIdx = this.relationships.findIndex(r => r.id === rel.id);
      if (existingIdx >= 0) {
        this.relationships[existingIdx] = rel;
      } else {
        this.relationships.push(rel);
      }
      this.updateRoomIndex(rel);
    }
  }

  /**
   * Get storage statistics
   */
  getStatistics(): Record<string, any> {
    const entityCountByType: Record<string, number> = {};
    for (const [type, ids] of this.typeIndex) {
      entityCountByType[type] = ids.size;
    }

    const relationshipCountByType: Record<string, number> = {};
    for (const rel of this.relationships) {
      const type = rel.relationshipType;
      relationshipCountByType[type] = (relationshipCountByType[type] || 0) + 1;
    }

    // Calculate average degree
    const entityCount = this.entities.size;
    const totalDegree = this.relationships.length * 2; // each rel connects 2 nodes
    const avgDegree = entityCount > 0 ? totalDegree / entityCount : 0;

    // Find isolated entities (no relationships)
    const connectedIds = new Set<string>();
    for (const rel of this.relationships) {
      connectedIds.add(rel.fromEntityId);
      connectedIds.add(rel.toEntityId);
    }
    const isolatedCount = entityCount - connectedIds.size;

    return {
      totalEntities: entityCount,
      totalRelationships: this.relationships.length,
      entityCountByType,
      relationshipCountByType,
      averageDegree: Math.round(avgDegree * 100) / 100,
      isolatedEntities: Math.max(0, isolatedCount),
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.entities.clear();
    this.relationships = [];
    this.typeIndex.clear();
    this.roomIndex.clear();
  }

  /**
   * Delete a specific entity and its relationships
   */
  deleteEntity(entityId: string): boolean {
    if (!this.entities.has(entityId)) return false;

    const entity = this.getEntity(entityId);
    this.entities.delete(entityId);

    // Remove from type index
    if (entity) {
      const typeIds = this.typeIndex.get(entity.entityType);
      if (typeIds) typeIds.delete(entityId);
    }

    // Remove relationships involving this entity
    this.relationships = this.relationships.filter(
      r => r.fromEntityId !== entityId && r.toEntityId !== entityId
    );

    // Remove from room index
    for (const [_roomId, deviceIds] of this.roomIndex) {
      deviceIds.delete(entityId);
    }

    return true;
  }

  private updateTypeIndex(entity: Entity): void {
    const type = entity.entityType;
    if (!this.typeIndex.has(type)) {
      this.typeIndex.set(type, new Set());
    }
    this.typeIndex.get(type)!.add(entity.id);
  }

  private updateRoomIndex(relationship: EntityRelationship): void {
    if (relationship.relationshipType === 'LOCATED_IN') {
      const roomId = relationship.toEntityId;
      const deviceId = relationship.fromEntityId;
      if (!this.roomIndex.has(roomId)) {
        this.roomIndex.set(roomId, new Set());
      }
      this.roomIndex.get(roomId)!.add(deviceId);
    }
  }
}
