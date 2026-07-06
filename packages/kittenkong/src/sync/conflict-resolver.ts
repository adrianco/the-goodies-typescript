/**
 * Conflict Resolver - Deterministic conflict resolution for sync
 *
 * Implements last-write-wins with tiebreaking, merge strategies,
 * and retry logic for sync conflicts.
 */

export interface ConflictData {
  id: string;
  version?: string;
  lastModified?: string;
  syncId?: string;
  deleted?: boolean;
  [key: string]: any;
}

export type ResolutionReason =
  | 'newer_local'
  | 'newer_remote'
  | 'version_tiebreak_local'
  | 'version_tiebreak_remote';

export class ConflictResolver {
  /**
   * Resolve a conflict between local and remote versions — the single canonical
   * algorithm (inbetweenies-v2, PROTOCOL.md §7):
   *   1. Last-write-wins on the modification time (UTC).
   *   2. If the two times are within 1000 ms, tiebreak on the **version** string:
   *      the lexically greater version wins. The version encodes UTC time + a
   *      monotonic counter + user id, so it is a stable, wire-visible tiebreaker
   *      — NOT `sync_id`, which is not part of the wire model.
   * Tombstones (deleted=true) are ordinary versions that win/lose by this rule
   * (§8); there is no special deletion precedence.
   */
  static resolveConflict(
    local: ConflictData,
    remote: ConflictData
  ): { winner: ConflictData; reason: ResolutionReason } {
    const localTime = local.lastModified ? new Date(local.lastModified).getTime() : 0;
    const remoteTime = remote.lastModified ? new Date(remote.lastModified).getTime() : 0;

    // Within 1 second (or no usable times): tiebreak on the version string.
    const timeDiff = Math.abs(localTime - remoteTime);
    if (!local.lastModified || !remote.lastModified || timeDiff < 1000) {
      const localVersion = local.version || '';
      const remoteVersion = remote.version || '';
      if (localVersion >= remoteVersion) {
        return { winner: local, reason: 'version_tiebreak_local' };
      }
      return { winner: remote, reason: 'version_tiebreak_remote' };
    }

    // Clear winner: newer timestamp wins.
    if (localTime > remoteTime) {
      return { winner: local, reason: 'newer_local' };
    }
    return { winner: remote, reason: 'newer_remote' };
  }

  /**
   * Merge changes into a base object, skipping protected fields.
   */
  static mergeChanges(base: Record<string, any>, changes: Record<string, any>): Record<string, any> {
    const result = { ...base };
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'id' || key === 'createdAt' || key === 'created_at') {
        continue;
      }
      result[key] = value;
    }
    return result;
  }

  /**
   * Determine if a sync should be retried based on conflict reason.
   */
  static shouldRetrySync(reason: string): boolean {
    const retryableReasons = ['network_error', 'timeout', 'server_error'];
    return retryableReasons.includes(reason);
  }
}
