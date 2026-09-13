/**
 * KittenKong - TypeScript Client for The Goodies
 *
 * Full-featured client library for the FunkyGibbon knowledge graph server.
 * Provides entity management, sync, MCP tools, and offline operation.
 *
 * PORTED FROM: Python blowing-off package
 */

// Main client
export { KittenKongClient, type KittenKongOptions } from './client';

// Authentication
export { AuthManager, type AuthManagerOptions } from './auth';

// Sync
export { SyncEngine, type SyncObserver } from './sync/engine';
export { InbetweeniesProtocol, PROTOCOL_VERSION } from './sync/protocol';
export type {
  SyncRequest,
  SyncResponse,
  SyncChange,
  EntityChange,
  RelationshipChange,
  SyncFilters,
  ConflictInfo,
  SyncStats,
  Change,
  Conflict as ProtocolConflict,
} from './sync/protocol';
export { ConflictResolver } from './sync/conflict-resolver';
export type { ConflictData, ResolutionReason } from './sync/conflict-resolver';

// Graph
export { LocalGraphStorage } from './graph/local-storage';
export type { SearchResult } from './graph/local-storage';
export { LocalGraphOperations } from './graph/local-operations';
export type { ToolResult, MCPToolName } from './graph/local-operations';

// Re-export protocol types
export type * from '@the-goodies/inbetweenies';
