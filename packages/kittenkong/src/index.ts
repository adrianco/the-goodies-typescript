/**
 * KittenKong - TypeScript Client for The Goodies
 *
 * Full-featured client library for the FunkyGibbon knowledge graph server.
 * Provides entity management, sync, MCP tools, and offline operation.
 *
 * PORTED FROM: Python blowing-off package
 */

// Main client
export { KittenKongClient, type KittenKongOptions } from './client.js';

// Authentication
export { AuthManager, type AuthManagerOptions } from './auth.js';

// Sync
export { SyncEngine, type SyncObserver } from './sync/engine.js';
export { InbetweeniesProtocol, PROTOCOL_VERSION } from './sync/protocol.js';
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
} from './sync/protocol.js';
export { ConflictResolver } from './sync/conflict-resolver.js';
export type { ConflictData, ResolutionReason } from './sync/conflict-resolver.js';

// Graph
export { LocalGraphStorage } from './graph/local-storage.js';
export type { SearchResult } from './graph/local-storage.js';
export { LocalGraphOperations } from './graph/local-operations.js';
export type { ToolResult, MCPToolName } from './graph/local-operations.js';

// Re-export protocol types
export type * from '@the-goodies/inbetweenies';
