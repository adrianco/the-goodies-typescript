/**
 * Attachments end to end, against a real FunkyGibbon.
 *
 * PURPOSE:
 * Prove that attaching a photo through the MCP surface produces the shape the
 * vocabulary actually permits — a `photo` entity carrying `content.blob_id`,
 * linked `device --has_photo--> photo`, with the bytes in the blobs table.
 *
 * WHY THIS EXISTS:
 * There was no first-class way to attach a photo, so callers invented one: an
 * `entity_type=note` holding inline base64, linked by a `has_blob` edge that
 * pointed at the note rather than the blob. That invention became the de-facto
 * schema across two installs and took a migration to undo (ADR-013 §3). A unit
 * test on the tool list would not have caught it; only writing to a real
 * server and reading back what landed does.
 *
 * SKIPPING:
 * Skips with an explicit reason when the harness did not start. Never silently
 * passes.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readHandshake, type ServerHandle } from './helpers/funkygibbon-server';

let server: ServerHandle | null = null;

beforeAll(async () => {
  server = await readHandshake();
});

const guard = (fn: (s: ServerHandle) => Promise<void>) => async () => {
  if (!server) {
    console.warn('[skip] FunkyGibbon harness unavailable — set FUNKYGIBBON_REPO');
    return;
  }
  await fn(server);
};

/** A one-pixel-ish payload; the bytes only need to round-trip, not decode. */
const JPEG_B64 = Buffer.from('\xff\xd8\xff\xe0JFIF-test-bytes', 'binary').toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.4 test-bytes', 'binary').toString('base64');

const callTool = (s: ServerHandle, name: string, args: Record<string, unknown>) =>
  fetch(`${s.baseUrl}/api/v1/mcp/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ arguments: args }),
  });

const getJson = (s: ServerHandle, path: string) =>
  fetch(`${s.baseUrl}${path}`, { headers: { Authorization: `Bearer ${s.token}` } })
    .then(r => r.json());

/** Any device from the seeded graph, to hang attachments off. */
async function someDeviceId(s: ServerHandle): Promise<string> {
  // ADR-015: the graph REST routes are gone; the tools are the interface.
  const body = await (await callTool(s, 'list_entities', { entity_type: 'device', limit: 1 })).json();
  const list = body.result?.entities ?? [];
  const first = Array.isArray(list) ? list[0] : list?.[0];
  expect(first, 'seeded graph must contain a device').toBeTruthy();
  return first.id;
}

describe('the MCP surface exposes attachments', () => {
  test(
    'the server advertises the attachment and retraction tools',
    guard(async s => {
      const body = await getJson(s, '/api/v1/mcp/tools');
      const names = (body.tools ?? body).map((t: any) => t.name);

      for (const tool of ['attach_photo', 'attach_document', 'get_blob',
                          'get_entity_versions', 'tombstone_entity', 'get_statistics']) {
        expect(names).toContain(tool);
      }
    })
  );

  test(
    'the surface has no delete tool — the store is append-only',
    guard(async s => {
      const body = await getJson(s, '/api/v1/mcp/tools');
      const names: string[] = (body.tools ?? body).map((t: any) => t.name);

      expect(names.filter(n => /delete|remove/.test(n))).toEqual([]);
    })
  );
});

describe('attach_photo', () => {
  test(
    'produces a photo entity, not a note with inline data',
    guard(async s => {
      const deviceId = await someDeviceId(s);
      const res = await callTool(s, 'attach_photo', {
        parent_entity_id: deviceId,
        filename: 'keypad.jpg',
        data_b64: JPEG_B64,
        mime_type: 'image/jpeg',
        description: '8-button keypad by the workshop door',
      });
      expect(res.status).toBe(200);
      const { result } = await res.json();

      expect(result.entity_type).toBe('photo');
      expect(result.relationship_type).toBe('has_photo');
      expect(result.linked_from).toBe(deviceId);

      // content.blob_id is the ONE link to the blobs table, and none of the
      // six retired conventions may come back.
      const entity = (await (await callTool(s, 'get_entity_details', { entity_id: result.attachment_id })).json()).result;
      const content = entity.content ?? entity.entity?.content;
      expect(content.blob_id).toBe(result.blob_id);
      for (const retired of ['is_blob', 'has_blob', 'data_b64',
                             'blob_reference', 'blob_references', 'screenshot_blob_ids']) {
        expect(content).not.toHaveProperty(retired);
      }
    })
  );

  test(
    'the bytes are retrievable and unchanged',
    guard(async s => {
      const deviceId = await someDeviceId(s);
      const res = await callTool(s, 'attach_photo', {
        parent_entity_id: deviceId, filename: 'roundtrip.jpg',
        data_b64: JPEG_B64, mime_type: 'image/jpeg',
      });
      const { result } = await res.json();

      const got = await callTool(s, 'get_blob', { blob_id: result.blob_id, include_data: true });
      const blob = (await got.json()).result;
      expect(blob.data).toBe(JPEG_B64);
      expect(blob.blob_type).toBe('jpeg');
    })
  );

  test(
    'the same bytes twice is one blob — a retry must not double the store',
    guard(async s => {
      const deviceId = await someDeviceId(s);
      const once = await (await callTool(s, 'attach_photo', {
        parent_entity_id: deviceId, filename: 'dupe.jpg', data_b64: JPEG_B64,
      })).json();
      const twice = await (await callTool(s, 'attach_photo', {
        parent_entity_id: deviceId, filename: 'dupe-again.jpg', data_b64: JPEG_B64,
      })).json();

      expect(once.result.blob_id).toBe(twice.result.blob_id);
      expect(once.result.attachment_id).not.toBe(twice.result.attachment_id);
    })
  );
});

describe('attach_document', () => {
  test(
    'a PDF becomes a manual reached by documented_by, not a photo',
    guard(async s => {
      const deviceId = await someDeviceId(s);
      const res = await callTool(s, 'attach_document', {
        parent_entity_id: deviceId, filename: 'manual.pdf', data_b64: PDF_B64,
      });
      const { result } = await res.json();

      // Routing a PDF to has_photo produced `room --has_photo--> manual` in the
      // Corfe install, which the vocabulary rejects.
      expect(result.entity_type).toBe('manual');
      expect(result.relationship_type).toBe('documented_by');
    })
  );
});

describe('append-only retraction', () => {
  test(
    'tombstone appends a version and keeps the earlier one readable',
    guard(async s => {
      const deviceId = await someDeviceId(s);
      const created = await (await callTool(s, 'attach_photo', {
        parent_entity_id: deviceId, filename: 'to-retract.jpg', data_b64: JPEG_B64,
      })).json();
      const photoId = created.result.attachment_id;

      const before = await (await callTool(s, 'get_entity_versions', { entity_id: photoId })).json();
      const res = await callTool(s, 'tombstone_entity', {
        entity_id: photoId, reason: 'wrong room', is_error: true, user_id: 'test',
      });
      expect(res.status).toBe(200);
      const after = await (await callTool(s, 'get_entity_versions', { entity_id: photoId })).json();

      expect(after.result.version_count).toBeGreaterThan(before.result.version_count);
      expect(after.result.versions.some((v: any) => v.deleted)).toBe(true);
    })
  );
});
