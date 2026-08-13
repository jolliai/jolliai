/**
 * How far back a session scan looks, for the one caller that does not want the
 * live 48-hour horizon.
 *
 * Each per-source discoverer keeps its own `SESSION_STALE_MS = 48 h` as the DEFAULT
 * of an optional window parameter. That default is what the sidebar's Active
 * Conversations, `jolli status`, and the post-commit summary generation all get by
 * simply not passing anything — and the last of those is the reason the defaults
 * were never turned into knobs. `QueueWorker` uses that window to decide which
 * conversations belong to the commit it is summarising: widening it there would
 * write week-old unrelated conversations into that commit's stored memory, on the
 * git orphan branch, persistently, with no error printed anywhere. A noisy sidebar
 * is visible; that is not.
 *
 * This constant is the other side of that split, and it lives in its own module so
 * that neither side can be reached by editing the other. It is imported by the
 * dashboard's history back-fill (which passes it to every source) and by
 * `ClaudeSessionDiscoverer` (whose only caller is that back-fill, so it is also its
 * default).
 */

/**
 * The history back-fill's discovery window: 7 days.
 *
 * Chosen against what the 48-hour horizon was actually costing. Measured on a real
 * machine, `sessions.json` held 3 Claude sessions while `~/.claude/projects` held 64
 * transcripts — the other 61 conversations, and every skill and MCP call in them,
 * were invisible to the dashboard because a hook registry that prunes at 48 h was
 * the only route to them.
 */
export const BACKFILL_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
