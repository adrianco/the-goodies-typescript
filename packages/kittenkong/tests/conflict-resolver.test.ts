import { describe, it, expect } from 'vitest';
import { ConflictResolver, type ConflictData } from '../src/sync/conflict-resolver';

describe('ConflictResolver (canonical, inbetweenies-v2 §7)', () => {
  it('last-write-wins on the newer modification time', () => {
    const local: ConflictData = { id: 'x', lastModified: '2026-06-15T10:00:00+00:00', version: 'a' };
    const remote: ConflictData = { id: 'x', lastModified: '2026-06-15T10:00:05+00:00', version: 'b' };
    const r = ConflictResolver.resolveConflict(local, remote);
    expect(r.winner).toBe(remote);
    expect(r.reason).toBe('newer_remote');
  });

  it('within 1s, the lexically greater VERSION wins — not sync_id', () => {
    const base = '2026-06-15T10:00:00+00:00';
    // local has the greater syncId but the LESSER version; remote must win.
    const local: ConflictData = { id: 'x', lastModified: base, version: `${base}-000001-alice`, syncId: 'zzz' };
    const remote: ConflictData = { id: 'x', lastModified: base, version: `${base}-000002-alice`, syncId: 'aaa' };
    const r = ConflictResolver.resolveConflict(local, remote);
    expect(r.winner).toBe(remote);
    expect(r.reason).toBe('version_tiebreak_remote');
  });

  it('tombstones compete by the normal rule (no unconditional delete precedence)', () => {
    // remote is a tombstone but OLDER; the newer active local edit wins.
    const local: ConflictData = { id: 'x', lastModified: '2026-06-15T10:00:10+00:00', version: '2026-06-15T10:00:10+00:00-000001-a' };
    const remote: ConflictData = { id: 'x', lastModified: '2026-06-15T10:00:00+00:00', version: '2026-06-15T10:00:00+00:00-000001-a', deleted: true };
    const r = ConflictResolver.resolveConflict(local, remote);
    expect(r.winner).toBe(local);
    expect(r.reason).toBe('newer_local');
  });
});
