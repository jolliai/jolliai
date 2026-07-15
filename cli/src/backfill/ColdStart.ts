/**
 * Cold-start scope constants — the single source of truth for "which historical
 * commits does the cold-start back-fill offer".
 *
 * Shared by every surface that computes cold-start signals or renders the offer:
 * the CLI guided front door (`BackfillFrontDoorStep`), the VS Code sidebar card,
 * and the Settings panel all import these so the window + cap can never drift
 * between them. Lives in `cli/src/backfill/` (not the VS Code layer) because the
 * CLI front door is now a first-class consumer; the VS Code `BackfillListRenderer`
 * re-exports them for its existing importers.
 */

/**
 * Time window (ms) for the cold-start offer: only own commits authored within this
 * span of the newest own commit are offered. 30 days — recent enough that the user
 * still remembers the work, short enough to keep the list and the LLM cost bounded.
 */
export const COLD_START_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Max commits the cold-start offer lists. A larger local backlog is not shown in
 * the guided front door / sidebar card — the surplus is reached via `jolli backfill`
 * (CLI) or the Settings "manage all" link (VS Code).
 */
export const COLD_START_CAP = 10;
