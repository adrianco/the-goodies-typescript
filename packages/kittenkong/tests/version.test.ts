import { describe, it, expect } from 'vitest';
import { createVersion, versionTimestamp } from '../src/sync/version';

describe('version strings (inbetweenies-v2 §2)', () => {
  it('createVersion is canonical: +00:00 offset, no doubled Z, 6-digit counter', () => {
    const v = createVersion('alice');
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00-\d{6}-alice$/);
    expect(v).not.toContain('Z');
  });

  it('createVersion is monotonic (later call sorts lexically greater)', () => {
    const a = createVersion('alice');
    const b = createVersion('alice');
    expect(b > a).toBe(true);
  });

  it('versionTimestamp parses canonical, legacy doubled-Z, and hyphenated user ids', () => {
    expect(versionTimestamp('2026-06-15T09:41:02.581234+00:00-000417-alice')?.toISOString())
      .toBe('2026-06-15T09:41:02.581Z');
    // legacy doubled-Z must still parse (back-compat)
    expect(versionTimestamp('2026-05-08T07:57:54.734914+00:00Z-000000-agent')?.toISOString())
      .toBe('2026-05-08T07:57:54.734Z');
    // user id may contain hyphens — do not split on '-'
    expect(versionTimestamp('2026-06-15T09:41:02.581234+00:00-000417-local-client')?.toISOString())
      .toBe('2026-06-15T09:41:02.581Z');
    expect(versionTimestamp(undefined)).toBeNull();
  });

  it('lexical order equals chronological + counter order', () => {
    const input = [
      '2026-06-15T09:41:03.000000+00:00-000001-bob',
      '2026-06-15T09:41:02.581234+00:00-000418-alice',
      '2026-06-15T09:41:02.581234+00:00-000417-alice',
    ];
    expect([...input].sort()).toEqual([
      '2026-06-15T09:41:02.581234+00:00-000417-alice',
      '2026-06-15T09:41:02.581234+00:00-000418-alice',
      '2026-06-15T09:41:03.000000+00:00-000001-bob',
    ]);
  });
});
