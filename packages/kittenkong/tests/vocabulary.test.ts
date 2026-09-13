/**
 * The vocabulary is a wire contract, not a local convention.
 *
 * These enum VALUES go on the wire and land in FunkyGibbon's type columns
 * verbatim -- since ADR-012 §1 those columns are plain strings with no
 * translation layer on either side. They were uppercase here while the server
 * spoke lowercase, and the sync engine hid it by upper-casing everything the
 * server sent. That worked only while the database also held uppercase; once
 * it was normalised, the same push would have written 'DEVICE' alongside
 * 'device' and fragmented the graph -- two types that nothing joins, with the
 * damage showing up much later as quietly incomplete query results.
 *
 * If a value here changes, it is a protocol change. Update FunkyGibbon's
 * domain manifest in the same breath.
 */

import { describe, expect, it } from 'vitest';
import {
  BlobStatus,
  BlobType,
  EntityType,
  RelationshipType,
  SourceType,
} from '@the-goodies/inbetweenies';

describe('wire vocabulary', () => {
  it('entity types are the lowercase values the server stores', () => {
    expect(new Set(Object.values(EntityType))).toEqual(
      new Set([
        'home', 'zone', 'room', 'device', 'door', 'window',
        'note', 'photo', 'manual', 'procedure', 'schedule', 'automation', 'app',
      ]),
    );
  });

  it('source types match what the server accepts', () => {
    // ZIGBEE, ZWAVE and API were declared here and never accepted by the
    // server, so an entity defaulted to 'API' was rejected by the vocabulary.
    expect(new Set(Object.values(SourceType))).toEqual(
      new Set(['homekit', 'matter', 'manual', 'imported', 'generated']),
    );
  });

  it('relationship types match the post-ADR-013 vocabulary', () => {
    expect(new Set(Object.values(RelationshipType))).toEqual(
      new Set([
        'located_in', 'part_of', 'connects_to', 'controls', 'automates',
        'monitors', 'triggered_by', 'depends_on', 'manages', 'documented_by',
        'procedure_for', 'has_photo',
      ]),
    );
  });

  it('the retired relationship types are gone', () => {
    const values = Object.values(RelationshipType) as string[];
    // has_blob never pointed at a blob -- it pointed at a note carrying one.
    expect(values).not.toContain('has_blob');
    expect(values).not.toContain('HAS_BLOB');
    // controlled_by_app was the exact inverse of manages; contained_in
    // duplicated located_in and was never creatable.
    expect(values).not.toContain('controlled_by_app');
    expect(values).not.toContain('contained_in');
  });

  it('no domain value is uppercase', () => {
    const domainValues = [
      ...Object.values(EntityType),
      ...Object.values(SourceType),
      ...Object.values(RelationshipType),
      ...Object.values(BlobType),
    ] as string[];
    const uppercase = domainValues.filter((v) => v !== v.toLowerCase());
    expect(uppercase).toEqual([]);
  });

  it('blob sync status stays uppercase, deliberately', () => {
    // The one exception: engine state, not domain vocabulary. On the Python
    // side this column is still a SQLEnum, which persists member NAMES.
    // Lowercasing it would break the column ADR-012 §1 did not convert.
    expect(BlobStatus.UPLOADED).toBe('UPLOADED');
    expect(BlobStatus.PENDING_UPLOAD).toBe('PENDING_UPLOAD');
  });

  it('photo and manual are the attachment types', () => {
    // A blob is carried by an attachment entity via content.blobId, which is
    // the only link to the blobs table. The entity type IS the flag.
    expect(EntityType.PHOTO).toBe('photo');
    expect(EntityType.MANUAL).toBe('manual');
    expect(RelationshipType.HAS_PHOTO).toBe('has_photo');
    expect(RelationshipType.DOCUMENTED_BY).toBe('documented_by');
  });
});
