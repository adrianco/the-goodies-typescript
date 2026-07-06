/**
 * Version strings (inbetweenies-v2, PROTOCOL.md §2)
 *
 * Format: `{utc-iso8601}-{counter:06d}-{user_id}`, e.g.
 *   2026-06-15T09:41:02.581000+00:00-000417-alice
 * The timestamp is timezone-aware UTC ISO-8601 with a `+00:00` offset and NO
 * trailing `Z`. The counter is a 6-digit monotonic per-process tiebreaker.
 * Versions compare lexically, and because the timestamp prefix is fixed-width
 * UTC, lexical order == chronological order.
 */

let _counter = 0;

/**
 * Generate a canonical version string for `userId`. JS Date only carries
 * millisecond precision, so the microsecond field is right-padded with zeros to
 * keep the fixed width (and the `+00:00` offset) the format requires.
 */
export function createVersion(userId: string): string {
  const iso = new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
  const counter = String(_counter++ % 1_000_000).padStart(6, '0');
  return `${iso}-${counter}-${userId}`;
}

/**
 * Parse the UTC timestamp out of a version string, or null if it can't.
 * Anchors on the UTC offset (`+00:00`) rather than splitting on `-`, so a
 * hyphenated user id parses correctly and a legacy trailing `Z` is tolerated.
 */
export function versionTimestamp(version: string | undefined | null): Date | null {
  if (!version) return null;
  const match = version.match(/^(.*?[+-]\d{2}:\d{2})/);
  if (!match) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}
