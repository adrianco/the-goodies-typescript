/**
 * Local Graph Storage - In-memory entity and relationship storage
 *
 * Provides fast in-memory storage with indexes for entity type lookups,
 * room-device relationships, and full-text search across the graph.
 */

import type { Entity, EntityRelationship, EntityType } from '@the-goodies/inbetweenies';
import { RelationshipType, isCurrentAt, sameInstant, versionKeyAt } from '@the-goodies/inbetweenies';

/** Read options for interval-aware relationship queries (ADR-004). */
export interface RelationshipQuery {
  /** Return retired intervals too -- history, not state. The sync push path needs this. */
  includeAllVersions?: boolean;
  /** The instant to answer for; omitted = now. */
  at?: Date;
}

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
  getEntity(entityId: string, version?: string, at?: Date): Entity | null {
    const versions = this.entities.get(entityId);
    if (!versions || versions.length === 0) return null;

    if (version) {
      return versions.find(v => v.version === version) || null;
    }

    if (at) {
      // ADR-004 §3.2 / ADR-009: the replica answers as-of locally. The
      // greatest version stamped at or before `at`; none means the entity did
      // not exist then, and a tombstone current then means the same.
      const key = versionKeyAt(at);
      const eligible = versions.filter(v => v.version <= key);
      if (eligible.length === 0) return null;
      const found = eligible.reduce((a, b) => (b.version > a.version ? b : a));
      return (found.content as any)?.deleted === true ? null : found;
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
   * Store a relationship interval -- end-and-insert, never mutate (ADR-004 §1).
   *
   * `id` is the logical edge; `(id, validFrom)` is the row. This used to
   * "avoid duplicates" by id, which silently dropped every successive interval
   * of an edge: a device moved from the kitchen to the hall kept its kitchen
   * row forever and never gained the hall one. Now:
   *   - the same (id, validFrom) row re-delivered is idempotent; only its end
   *     can move (an end-event for a row we hold);
   *   - a new open interval for an id with an open row ends the predecessor at
   *     the successor's start, so the half-open intervals tile without gap or
   *     overlap;
   *   - a closed interval for an unknown row is stored as history.
   */
  storeRelationship(relationship: EntityRelationship): EntityRelationship {
    const incoming: EntityRelationship = {
      ...relationship,
      validFrom: relationship.validFrom ?? relationship.createdAt ?? new Date(),
      validTo: relationship.validTo ?? null,
    };

    const sameRow = this.relationships.find(
      r => r.id === incoming.id && sameInstant(r.validFrom, incoming.validFrom)
    );
    if (sameRow) {
      if (!sameRow.validTo && incoming.validTo) sameRow.validTo = incoming.validTo;
      this.rebuildRoomIndex();
      return sameRow;
    }

    const openRow = this.relationships.find(r => r.id === incoming.id && !r.validTo);
    if (openRow && !incoming.validTo) {
      if (this.sameContent(openRow, incoming)) {
        // Unchanged re-push: writing nothing keeps one continuous fact from
        // being shredded into adjacent slivers.
        return openRow;
      }
      openRow.validTo = incoming.validFrom!;
    } else if (openRow && incoming.validTo) {
      // An end-event naming a start we do not hold: end our open row at the
      // requested instant rather than adding a second, overlapping row.
      openRow.validTo = incoming.validTo;
      this.rebuildRoomIndex();
      return openRow;
    }

    this.relationships.push(incoming);
    this.rebuildRoomIndex();
    return incoming;
  }

  /**
   * End an edge's open interval at `at` (default now). Ending is not deleting:
   * the row stays, and every question about the period it covered still
   * answers correctly. Returns the ended row, or null if there was no open one.
   */
  endRelationship(relationshipId: string, at: Date = new Date()): EntityRelationship | null {
    const openRow = this.relationships.find(r => r.id === relationshipId && !r.validTo);
    if (!openRow) return null;
    const start = openRow.validFrom?.getTime() ?? 0;
    openRow.validTo = at.getTime() < start ? new Date(start) : at;
    this.rebuildRoomIndex();
    return openRow;
  }

  private sameContent(a: EntityRelationship, b: EntityRelationship): boolean {
    return (
      a.fromEntityId === b.fromEntityId &&
      a.toEntityId === b.toEntityId &&
      a.relationshipType === b.relationshipType &&
      JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {})
    );
  }

  /**
   * Get relationships with optional filters. Current-only by default: a
   * retired interval is history, never state, and returning both leaves a
   * moved device in two rooms at once.
   */
  getRelationships(
    fromId?: string,
    toId?: string,
    relType?: RelationshipType,
    query: RelationshipQuery = {}
  ): EntityRelationship[] {
    const at = query.at ?? new Date();
    return this.relationships.filter(r => {
      if (fromId && r.fromEntityId !== fromId) return false;
      if (toId && r.toEntityId !== toId) return false;
      if (relType && r.relationshipType !== relType) return false;
      if (!query.includeAllVersions && !isCurrentAt(r, at)) return false;
      return true;
    });
  }

  /**
   * Get devices in a room using the room index
   */
  getDevicesInRoom(roomId: string, at?: Date): Entity[] {
    // The room index caches `at = now`; an as-of question walks the intervals.
    const deviceIds = at
      ? new Set(this.getRelationships(undefined, roomId, RelationshipType.LOCATED_IN, { at }).map(r => r.fromEntityId))
      : this.roomIndex.get(roomId);
    if (!deviceIds) return [];

    const results: Entity[] = [];
    for (const id of deviceIds) {
      const entity = this.getEntity(id, undefined, at);
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
  getAllEntities(includeDeleted = false): Entity[] {
    const results: Entity[] = [];
    for (const versions of this.entities.values()) {
      const entity = versions[versions.length - 1];
      if (includeDeleted || this.isActive(entity)) {
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

    // Update relationships -- through the interval-aware store, so a pulled
    // successor ends its predecessor instead of overwriting it.
    for (const rel of relationships) {
      this.storeRelationship(rel);
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

    // Statistics describe the CURRENT graph; retired intervals are history.
    const current = this.getRelationships();
    const relationshipCountByType: Record<string, number> = {};
    for (const rel of current) {
      const type = rel.relationshipType;
      relationshipCountByType[type] = (relationshipCountByType[type] || 0) + 1;
    }

    // Calculate average degree
    const entityCount = this.entities.size;
    const totalDegree = current.length * 2; // each rel connects 2 nodes
    const avgDegree = entityCount > 0 ? totalDegree / entityCount : 0;

    // Find isolated entities (no relationships)
    const connectedIds = new Set<string>();
    for (const rel of current) {
      connectedIds.add(rel.fromEntityId);
      connectedIds.add(rel.toEntityId);
    }
    const isolatedCount = entityCount - connectedIds.size;

    return {
      totalEntities: entityCount,
      totalRelationships: current.length,
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

  /**
   * Rebuild the room index from CURRENT located_in edges only.
   *
   * It was append-only with no removal path, so a device that moved rooms
   * stayed listed in its old room permanently. Recomputing from the interval
   * rows is O(edges) on a house-scale graph and cannot drift.
   */
  private rebuildRoomIndex(): void {
    this.roomIndex.clear();
    for (const rel of this.getRelationships(undefined, undefined, RelationshipType.LOCATED_IN)) {
      if (!this.roomIndex.has(rel.toEntityId)) this.roomIndex.set(rel.toEntityId, new Set());
      this.roomIndex.get(rel.toEntityId)!.add(rel.fromEntityId);
    }
  }
}
