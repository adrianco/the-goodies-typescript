#!/usr/bin/env node
/**
 * KittenKong MCP Server
 *
 * Stdio MCP server that exposes all 12 knowledge graph tools via the
 * KittenKongClient. Data is synced from FunkyGibbon into local memory on
 * startup, then kept fresh via background sync.
 *
 * Usage (via Claude Code mcpServers config):
 *   command: npx tsx
 *   args: [/path/to/src/mcp-server.ts]
 *   env: { FUNKYGIBBON_URL, FUNKYGIBBON_TOKEN or FUNKYGIBBON_PASSWORD, SYNC_INTERVAL_SECONDS }
 *
 * FUNKYGIBBON_TOKEN (a long-lived client token minted via
 * `python -m funkygibbon.setup_auth --client-token-only`) takes precedence
 * over FUNKYGIBBON_PASSWORD when both are set — prefer it when the server's
 * admin password isn't known/stable (e.g. hash set directly in a launchd
 * start script rather than .env).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { KittenKongClient } from './client.js';

const FUNKYGIBBON_URL = process.env.FUNKYGIBBON_URL ?? 'http://localhost:8000';
const FUNKYGIBBON_TOKEN = process.env.FUNKYGIBBON_TOKEN ?? '';
const FUNKYGIBBON_PASSWORD = process.env.FUNKYGIBBON_PASSWORD ?? 'admin';
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL_SECONDS ?? '60');

const TOOLS: Tool[] = [
  {
    name: 'search_entities',
    description: 'Search for entities in the home knowledge graph by name or content',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        entity_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter by type: home, room, device, zone, door, window, procedure, manual, photo, note, schedule, automation, app',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity_details',
    description: 'Get full details for a specific entity by ID, including all relationships',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'create_entity',
    description: 'Create a new entity in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          description: 'Type: home, room, device, zone, door, window, procedure, manual, note, schedule, automation',
        },
        name: { type: 'string', description: 'Entity name' },
        content: { type: 'object', description: 'Entity properties (arbitrary JSON)' },
        user_id: { type: 'string', description: 'User ID (optional, defaults to mcp-user)' },
      },
      required: ['entity_type', 'name', 'content'],
    },
  },
  {
    name: 'update_entity',
    description: 'Update an existing entity — creates a new immutable version',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID to update' },
        changes: { type: 'object', description: 'Fields to update in content' },
        user_id: { type: 'string', description: 'User ID (optional)' },
      },
      required: ['entity_id', 'changes'],
    },
  },
  {
    name: 'create_relationship',
    description: 'Create a directed relationship between two entities',
    inputSchema: {
      type: 'object',
      properties: {
        from_entity_id: { type: 'string', description: 'Source entity ID' },
        to_entity_id: { type: 'string', description: 'Target entity ID' },
        relationship_type: {
          type: 'string',
          description: 'Relationship type (e.g. located_in, controls, documented_by, connected_to)',
        },
        properties: { type: 'object', description: 'Optional relationship properties' },
        user_id: { type: 'string', description: 'User ID (optional)' },
      },
      required: ['from_entity_id', 'to_entity_id', 'relationship_type'],
    },
  },
  {
    name: 'get_devices_in_room',
    description: 'Get all devices located in a specific room',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'Room entity ID' },
      },
      required: ['room_id'],
    },
  },
  {
    name: 'find_device_controls',
    description: 'Get available controls, automations, and procedures for a device',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', description: 'Device entity ID' },
      },
      required: ['device_id'],
    },
  },
  {
    name: 'get_room_connections',
    description: 'Find doors, windows, and passages connecting a room to adjacent spaces',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'Room entity ID' },
      },
      required: ['room_id'],
    },
  },
  {
    name: 'find_path',
    description: 'Find the relationship path between two entities in the graph',
    inputSchema: {
      type: 'object',
      properties: {
        from_entity_id: { type: 'string', description: 'Starting entity ID' },
        to_entity_id: { type: 'string', description: 'Target entity ID' },
        max_depth: { type: 'number', description: 'Maximum path depth (default 5)' },
      },
      required: ['from_entity_id', 'to_entity_id'],
    },
  },
  {
    name: 'find_similar_entities',
    description: 'Find entities similar to a given entity based on type and content',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Reference entity ID' },
        threshold: { type: 'number', description: 'Similarity threshold 0–1 (default 0.5)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'get_procedures_for_device',
    description: 'Get all procedures, manuals, and instructions for a device',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', description: 'Device entity ID' },
      },
      required: ['device_id'],
    },
  },
  {
    name: 'get_automations_in_room',
    description: 'Get all automation rules and schedules associated with a room',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'Room entity ID' },
      },
      required: ['room_id'],
    },
  },
  // --- Attachments ------------------------------------------------------
  // These exist because their absence was filled by invention: with no way to
  // attach a photo, callers built an entity_type=note holding inline base64,
  // linked by a has_blob edge that pointed at the note rather than the blob.
  // That shape spread across two installs and took a migration to undo
  // (ADR-013 §3). Served by the server, which owns the blob store.
  {
    name: 'attach_photo',
    description:
      'Attach a photo to an entity. Creates a photo entity carrying the image, ' +
      'stores the bytes server-side, and links it with has_photo. Use this ' +
      'rather than creating a note with inline data.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_entity_id: { type: 'string', description: 'The entity the photo is of' },
        filename: { type: 'string', description: 'Original filename; becomes the photo name' },
        data_b64: { type: 'string', description: 'Base64-encoded image bytes' },
        mime_type: { type: 'string', description: 'e.g. image/jpeg (default)' },
        description: { type: 'string', description: 'What the photo shows' },
        user_id: { type: 'string', description: 'Who attached it' },
      },
      required: ['parent_entity_id', 'filename', 'data_b64'],
    },
  },
  {
    name: 'attach_document',
    description:
      'Attach a PDF or document to an entity. Creates a manual entity and links ' +
      'it with documented_by. A PDF is a manual, not a photo.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_entity_id: { type: 'string', description: 'The entity the document describes' },
        filename: { type: 'string', description: 'Original filename' },
        data_b64: { type: 'string', description: 'Base64-encoded file bytes' },
        mime_type: { type: 'string', description: 'e.g. application/pdf (default)' },
        description: { type: 'string', description: 'What the document covers' },
        user_id: { type: 'string', description: 'Who attached it' },
      },
      required: ['parent_entity_id', 'filename', 'data_b64'],
    },
  },
  {
    name: 'get_blob',
    description:
      'Fetch a stored blob by id. Metadata always; bytes only when include_data ' +
      'is true, since blobs are large.',
    inputSchema: {
      type: 'object',
      properties: {
        blob_id: { type: 'string', description: "From an attachment entity's content.blob_id" },
        include_data: { type: 'boolean', description: 'Include base64 bytes. Default false.' },
      },
      required: ['blob_id'],
    },
  },
  // --- History and retraction -------------------------------------------
  // The store is append-only. There is deliberately no delete tool: the graph
  // API has never had a DELETE endpoint, and removal is a tombstone version.
  {
    name: 'get_entity_versions',
    description:
      'Full version history of an entity, newest first. Entities are immutable: ' +
      'every edit appends a version and nothing is overwritten.',
    inputSchema: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: 'The entity to get history for' } },
      required: ['entity_id'],
    },
  },
  {
    name: 'tombstone_entity',
    description:
      'Retract an entity by appending a tombstone version. Use for something ' +
      'that is gone, or to mark a record as an error. Nothing is deleted: ' +
      'earlier versions stay readable and the reason is recorded. This is the ' +
      'only way to remove something.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity to retract' },
        reason: { type: 'string', description: 'Why -- recorded on the tombstone' },
        is_error: {
          type: 'boolean',
          description: 'True if the record was wrong, as opposed to the thing no longer existing.',
        },
        user_id: { type: 'string', description: 'Who retracted it' },
      },
      required: ['entity_id', 'reason'],
    },
  },
  {
    name: 'get_statistics',
    description: 'Counts of entities and relationships by type, for the whole graph.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function main(): Promise<void> {
  const client = new KittenKongClient({
    serverUrl: FUNKYGIBBON_URL,
    clientId: 'kittenkong-mcp-server',
    authToken: FUNKYGIBBON_TOKEN || undefined,
  });

  // Connect to FunkyGibbon and do an initial sync into local cache.
  // A pre-set authToken (above) short-circuits the password login.
  if (!FUNKYGIBBON_TOKEN) {
    await client.connect(FUNKYGIBBON_PASSWORD);
  } else {
    await client.connect();
  }

  // Keep local cache fresh with background sync
  await client.startBackgroundSync(SYNC_INTERVAL);

  const server = new Server(
    { name: 'kittenkong', version: '0.5.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await client.executeMCPTool(name, args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            result.success ? result.result : { error: result.error },
            null,
            2,
          ),
        },
      ],
      isError: !result.success,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`kittenkong MCP server fatal error: ${err}\n`);
  process.exit(1);
});
