/**
 * Inbetweenies Protocol Types
 *
 * PURPOSE:
 * TypeScript type definitions for The Goodies protocol. Defines entities, relationships,
 * blobs, sync metadata, and all enums used in the knowledge graph system.
 *
 * CORE TYPES:
 * - Entity: Nodes in the knowledge graph (devices, rooms, automations, etc.)
 * - EntityRelationship: Edges connecting entities
 * - Blob: Binary data attachments (photos, PDFs, manuals)
 * - SyncMetadata: Synchronization state tracking
 * - SyncResult: Result of sync operations
 *
 * VERSION HISTORY:
 * - 2025-04-02: Initial TypeScript port from Python inbetweenies/models.py
 *   - Complete enum definitions (EntityType, SourceType, RelationshipType, BlobType, BlobStatus)
 *   - All interface definitions matching Python dataclasses
 *   - Added comprehensive context header
 *
 * PORTED FROM:
 * Python: inbetweenies/models.py
 */

/**
 * Entity types in the knowledge graph.
 *
 * Values are the WIRE FORMAT and are lowercase. They used to be uppercase,
 * which the sync engine papered over by upper-casing everything the server
 * sent. That worked only while the database also held uppercase; once it was
 * normalised (ADR-012 §1) the same push would have written 'DEVICE' alongside
 * 'device' and fragmented the graph.
 */
export enum EntityType {
  HOME = 'home',
  ROOM = 'room',
  DEVICE = 'device',
  ZONE = 'zone',
  DOOR = 'door',
  WINDOW = 'window',
  PROCEDURE = 'procedure',
  /** PDF attachment. Carries a blob via content.blobId. */
  MANUAL = 'manual',
  /** Image attachment. Carries a blob via content.blobId. */
  PHOTO = 'photo',
  NOTE = 'note',
  SCHEDULE = 'schedule',
  AUTOMATION = 'automation',
  APP = 'app'
}

/**
 * How a record reached the graph -- nothing more.
 *
 * Deliberately NOT the system that runs an automation: that stays true however
 * the record arrived and belongs on an `app` entity linked by MANAGES
 * (ADR-013 §4). ZIGBEE, ZWAVE and API were removed -- the server has never
 * accepted them, so an entity defaulted to 'API' was rejected by the
 * vocabulary.
 */
export enum SourceType {
  MANUAL = 'manual',
  HOMEKIT = 'homekit',
  MATTER = 'matter',
  IMPORTED = 'imported',
  GENERATED = 'generated'
}

/** Relationship types between entities */
export enum RelationshipType {
  /** Spatial containment: where a thing IS. */
  LOCATED_IN = 'located_in',
  /** Composition: what a thing is a COMPONENT of. Not containment. */
  PART_OF = 'part_of',
  CONNECTS_TO = 'connects_to',
  CONTROLS = 'controls',
  AUTOMATES = 'automates',
  MONITORS = 'monitors',
  TRIGGERED_BY = 'triggered_by',
  DEPENDS_ON = 'depends_on',
  /** An app manages what it runs. Replaces the deleted CONTROLLED_BY_APP. */
  MANAGES = 'manages',
  /** Attaches a note, a procedure, or a `manual` (PDF). */
  DOCUMENTED_BY = 'documented_by',
  PROCEDURE_FOR = 'procedure_for',
  /** Attaches a `photo`. Replaces the deleted HAS_BLOB. */
  HAS_PHOTO = 'has_photo'
}

/** BLOB types for binary storage */
export enum BlobType {
  PDF = 'pdf',
  JPEG = 'jpeg',
  PNG = 'png',
  ICON = 'icon',
  DOCUMENT = 'document',
  DATA = 'data'
}

/**
 * BLOB sync status.
 *
 * Deliberately UPPERCASE where the other enums are lowercase. These are the
 * only values that are engine state rather than domain vocabulary, and on the
 * Python side the column is still a SQLEnum, which persists member *names*.
 * Lowercasing these would break the one column ADR-012 §1 did not convert.
 */
export enum BlobStatus {
  PENDING_UPLOAD = 'PENDING_UPLOAD',
  UPLOADED = 'UPLOADED',
  PENDING_DOWNLOAD = 'PENDING_DOWNLOAD',
  DOWNLOADED = 'DOWNLOADED',
  SYNC_ERROR = 'SYNC_ERROR'
}

/** Base entity structure */
export interface Entity {
  id: string;
  version: string;
  entityType: EntityType;
  parentVersions?: string[];
  content: Record<string, any>;
  userId: string;
  sourceType: SourceType;
  createdAt: Date;
  lastModified: Date;
  name?: string;  // Often in content, but commonly accessed
}

/** Entity relationship */
export interface EntityRelationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: RelationshipType;
  properties?: Record<string, any>;
  userId: string;
  createdAt: Date;
}

/** Binary large object for files */
export interface Blob {
  id: string;
  entityId: string;
  entityVersion: string;
  name: string;
  blobType: BlobType;
  mimeType: string;
  size: number;
  checksum: string;
  status: BlobStatus;
  data?: Uint8Array;  // Optional, may not be loaded
  blobMetadata?: Record<string, any>;
  createdAt: Date;
  syncedAt?: Date;
}

/** Sync metadata for client state */
export interface SyncMetadata {
  clientId: string;
  serverUrl: string;
  lastSyncTime?: Date;
  lastSuccessTime?: Date;
  totalSyncs: number;
  syncFailures: number;
  totalConflicts: number;
  syncInProgress: boolean;
  lastError?: string;
}

/** Conflict information */
export interface Conflict {
  entityId: string;
  entityType: EntityType;
  localVersion: string;
  remoteVersion: string;
  reason: string;
  resolvedAt?: Date;
}

/** Sync result */
export interface SyncResult {
  syncedEntities: number;
  changesSent: number;
  changesReceived: number;
  conflictsResolved: number;
  conflicts: Conflict[];
  duration: number;  // seconds
}
