/**
 * DiscoveryCatchUp — re-runs incremental plan + reference discovery for the
 * agent-hook-recorded sessions in `sessions.json`.
 *
 * Scope: this helper only enumerates sessions recorded in `sessions.json`.
 * In current production paths, that registry is populated by the Claude hooks
 * (StopHook and PluginBootstrapHook) and GeminiAfterAgentHook. Cursor, OpenCode,
 * Devin, Copilot, Cline, Antigravity, and Codex sessions are discovered on
 * demand and are not persisted there, so this helper does not enumerate them.
 * Codex has a separate cursor-based recovery path in the sidebar discovery tick
 * and is skipped defensively below.
 *
 * Why this exists: while a project is manually disabled, the agent hooks are
 * uninstalled and the VS Code-side write gates are active, so neither the
 * StopHook transcript scan nor the plans-dir watcher (`registerNewPlan`) can
 * register plans/references produced during that window. The StopHook path is
 * cursor-driven (`discovery-cursors.json`), and the cursor freezes while
 * disabled — so a future turn in the same transcript would eventually re-scan
 * the disabled window. But a session that sees no further turns after re-enable
 * would never be re-scanned, silently dropping any plan/reference authored
 * during the disabled window.
 *
 * The enable command calls this once after releasing the flag to determinist-
 * ically drain that backlog: for each eligible file-backed session in
 * `sessions.json` it scans from the frozen cursor forward and advances the
 * shared cursor. Idempotent — already-scanned lines are never re-processed, so
 * a no-backlog catch-up performs no writes.
 *
 * Codex sessions are intentionally skipped: they are driven by the sidebar's
 * 60s Active Conversations tick (`CodexDiscovery`), whose cursor also froze
 * while disabled, so they self-recover on the next tick after re-enable.
 */

import { existsSync } from "node:fs";
import { createLogger, isManuallyDisabled } from "../Logger.js";
import { scanPlansFrom } from "./plans/TranscriptPlanDiscovery.js";
import { scanReferencesFrom } from "./references/TranscriptReferenceDiscovery.js";
import {
	loadAllSessions,
	loadDiscoveryCursor,
	migrateDiscoveryCursors,
	saveDiscoveryCursor,
} from "./SessionTracker.js";

const log = createLogger("DiscoveryCatchUp");

/**
 * Re-runs the StopHook-style incremental discovery for all of the project's
 * known session transcripts. Returns the number of transcripts whose cursor
 * actually advanced (i.e. that had unscanned lines). Never rejects.
 */
export async function catchUpTranscriptDiscovery(cwd: string): Promise<{ scanned: number }> {
	// Defensive: callers must release the flag before invoking this, but if it
	// is somehow reached while disabled the scans below would write plans.json —
	// honor the zero-write contract regardless.
	if (isManuallyDisabled()) return { scanned: 0 };

	let sessions: ReadonlyArray<{ transcriptPath: string; source?: string }>;
	try {
		sessions = await loadAllSessions(cwd);
	} catch (err) {
		log.warn("Failed to load sessions for catch-up: %s", (err as Error).message);
		return { scanned: 0 };
	}

	await migrateDiscoveryCursors(cwd); // idempotent fold of legacy plan:/linear: cursors

	let scanned = 0;
	for (const session of sessions) {
		const transcriptPath = session.transcriptPath;
		// Codex rides the sidebar tick's own cursor-based recovery — skip here so
		// we don't duplicate that work or mis-order its references-first scan.
		if ((session.source ?? "claude") === "codex") continue;
		if (!transcriptPath || !existsSync(transcriptPath)) continue;

		try {
			const fromLine = (await loadDiscoveryCursor(transcriptPath, cwd))?.lineNumber ?? 0;
			const source = session.source === "gemini" ? "gemini" : "claude";

			// Plan-first, then references — mirrors StopHook.discoverFromTranscript:
			// both scan to EOF; the reference scan returns the authoritative cursor
			// target, and the cursor advances only when the plan scan also completed
			// so a throwing plan scan retries its window next time.
			let planScanCompleted = false;
			let referenceLine = fromLine;
			try {
				await scanPlansFrom(transcriptPath, fromLine, cwd, source);
				planScanCompleted = true;
			} catch (err) {
				log.warn("Plan catch-up failed for %s: %s", session.transcriptPath, (err as Error).message);
			}
			try {
				referenceLine = await scanReferencesFrom(transcriptPath, fromLine, cwd, source);
			} catch (err) {
				log.warn("Reference catch-up failed for %s: %s", session.transcriptPath, (err as Error).message);
			}

			if (planScanCompleted && referenceLine > fromLine) {
				await saveDiscoveryCursor(
					{ transcriptPath, lineNumber: referenceLine, updatedAt: new Date().toISOString() },
					cwd,
				);
				scanned++;
			}
		} catch (err) {
			log.warn("Discovery catch-up failed for %s: %s", session.transcriptPath, (err as Error).message);
		}
	}

	if (scanned > 0) log.info("Discovery catch-up advanced %d transcript cursor(s)", scanned);
	return { scanned };
}
