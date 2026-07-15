/**
 * Bounded retention primitives for the Node journal (no background scheduler).
 * Active runs are NEVER pruned; pruning is transactional, reports counts, and
 * advances `earliest_retained_sequence` (retained sequence numbers never change),
 * so truncation stays visible to replay clients.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { JournalError } from './contract.js'

/** Delete TERMINAL run journals older than `olderThanIso` (cascade drops events).
 *  Active (non-terminal) runs are never removed. */
export function pruneTerminalRuns(db: BetterSqlite3.Database, olderThanIso: string): { removed: number } {
  const q = `DELETE FROM runs WHERE terminal_event_recorded = 1 AND terminal_at IS NOT NULL AND terminal_at < ?`
  return { removed: db.transaction(() => db.prepare(q).run(olderThanIso).changes)() }
}

/** Keep only the newest `keepLast` events for a run; advance
 *  `earliest_retained_sequence` to the min remaining sequence (never renumbers). */
export function pruneRunEvents(db: BetterSqlite3.Database, remoteRunId: string, keepLast: number): { removed: number } {
  if (!Number.isInteger(keepLast) || keepLast < 0) throw new JournalError('invalid_record', 'keepLast must be a non-negative integer')
  return {
    removed: db.transaction(() => {
      const boundary = db.prepare('SELECT sequence FROM run_events WHERE remote_run_id = ? ORDER BY sequence DESC LIMIT 1 OFFSET ?').get(remoteRunId, keepLast) as { sequence: number } | undefined
      if (!boundary) return 0
      const removed = db.prepare('DELETE FROM run_events WHERE remote_run_id = ? AND sequence <= ?').run(remoteRunId, boundary.sequence).changes
      const min = db.prepare('SELECT MIN(sequence) AS m FROM run_events WHERE remote_run_id = ?').get(remoteRunId) as { m: number | null }
      if (min.m !== null) db.prepare('UPDATE runs SET earliest_retained_sequence = ? WHERE remote_run_id = ?').run(min.m, remoteRunId)
      return removed
    })(),
  }
}
