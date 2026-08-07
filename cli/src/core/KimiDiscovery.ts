/**
 * KimiDiscovery — hook-free artifact discovery for Moonshot's Kimi Code CLI.
 *
 * Extracts references (Linear / Jira / GitHub / Notion / …) AND skill usage from
 * Kimi transcripts, reusing the SAME `discovery-cursors.json` mechanism as the
 * Claude Stop path and the Codex polling path. Structurally a twin of
 * {@link discoverCodexConversations}.
 *
 * Why not a Kimi hook. Kimi Code CLI exposes no lifecycle hook we can rely on
 * (see {@link discoverKimiSessions}), so — exactly like Codex — sessions are
 * discovered by scanning the filesystem, and their artifacts are extracted at
 * the two driver points below.
 *
 * Drivers (both required — neither alone covers every user):
 *   - VS Code sidebar's 60s Active Conversations tick — sub-minute freshness for
 *     the panel. Fire-and-forget.
 *   - QueueWorker at post-commit — the baseline. Awaited, because the association
 *     step reads `plans.json` rather than extracting. This is the ONLY driver for
 *     a CLI-only Kimi user; without it their references and skills stay empty.
 *
 * Plans are deliberately NOT scanned here: Kimi has no plan-file concept on disk
 * (its transcript carries tool calls and results, not written plan markdown), so
 * there is nothing for `scanPlansFrom` to find. References drive the shared
 * cursor; skills advance their own independent high-water mark.
 *
 * Concurrency: a per-cwd single-flight collapses overlapping calls (the tick, the
 * worker, panel re-open, manual refresh). A re-entrant call marks the in-flight
 * run "dirty" so it runs ONE more pass after the current one, catching rows
 * written after the in-flight run already passed `discoverKimiSessions`. Sessions
 * are processed serially so per-session cursor writes never race within a batch.
 *
 * Contract: `discoverKimiConversations` NEVER rejects — all errors are swallowed
 * and logged, so callers can `void`-call it without an unhandled rejection.
 */

import { createLogger, isManuallyDisabled } from "../Logger.js";
import { discoverKimiSessions, isKimiInstalled } from "./KimiSessionDiscoverer.js";
import { scanReferencesFrom } from "./references/TranscriptReferenceDiscovery.js";
import { loadConfig, loadDiscoveryCursor, migrateDiscoveryCursors, saveDiscoveryCursor } from "./SessionTracker.js";
import { scanSkillsWithCursor } from "./skills/TranscriptSkillDiscovery.js";

const log = createLogger("KimiDiscovery");

interface InFlight {
	promise: Promise<void>;
	dirty: boolean;
}

/** Per-cwd single-flight registry (keyed by the workspace cwd). */
const inFlight = new Map<string, InFlight>();

/**
 * Scan all recent Kimi sessions for this cwd and persist any discovered
 * artifacts (references + skills). Single-flight + dirty-rerun per cwd. Never rejects.
 */
export function discoverKimiConversations(cwd: string): Promise<void> {
	const existing = inFlight.get(cwd);
	if (existing !== undefined) {
		// A run is in progress — request one more pass after it, share its promise.
		existing.dirty = true;
		return existing.promise;
	}
	const state: InFlight = { promise: Promise.resolve(), dirty: false };
	state.promise = runWithRerun(cwd, state).finally(() => {
		inFlight.delete(cwd);
	});
	inFlight.set(cwd, state);
	return state.promise;
}

async function runWithRerun(cwd: string, state: InFlight): Promise<void> {
	do {
		state.dirty = false;
		await runOnce(cwd);
	} while (state.dirty);
}

async function runOnce(cwd: string): Promise<void> {
	try {
		// A discovery pass persists cursors, references and skills into the
		// project's .jolli/jollimemory/ — all disk writes a manually-disabled
		// project must not receive (the sidebar's 60s tick keeps firing even
		// while the disabled panel is shown).
		if (isManuallyDisabled()) return;
		const config = await loadConfig();
		if (config.kimiEnabled === false) return;
		if (!(await isKimiInstalled())) return;

		await migrateDiscoveryCursors(cwd);
		const sessions = await discoverKimiSessions(cwd);
		let advanced = 0;
		for (const session of sessions) {
			// Per-session try/catch: one bad transcript (read error, parse failure)
			// must not abort the rest of the batch or block cursor advances.
			try {
				const fromLine = (await loadDiscoveryCursor(session.transcriptPath, cwd))?.lineNumber ?? 0;

				// Reference scan drives the shared cursor. Its returned safe cursor
				// (refLine) decides how far this pass advances — held at the current
				// mark on a throw so the next pass re-reads the same window.
				let refLine = fromLine;
				let refDone = false;
				try {
					refLine = await scanReferencesFrom(session.transcriptPath, fromLine, cwd, "kimi");
					refDone = true;
				} catch (err) {
					log.warn("Kimi reference discovery failed for %s: %s", session.sessionId, (err as Error).message);
				}

				// Skills scan on their OWN high-water mark, independently of the
				// reference window above — the skills extractor has its own cursor, so
				// it neither constrains nor is constrained by how far the shared cursor
				// advances this pass.
				await scanSkillsWithCursor(session.transcriptPath, cwd, "kimi");

				// Advance the shared cursor only when the reference scan completed and
				// the safe cursor moved — a throw holds this window so the next pass
				// re-scans it (re-scan is idempotent via dedupe + upsert-by-key).
				if (refDone && refLine > fromLine) {
					await saveDiscoveryCursor(
						{
							transcriptPath: session.transcriptPath,
							lineNumber: refLine,
							updatedAt: new Date().toISOString(),
						},
						cwd,
					);
					advanced++;
				}
			} catch (err) {
				log.warn("Kimi discovery failed for %s: %s", session.sessionId, (err as Error).message);
			}
		}
		// Summary line so the otherwise-silent 60s tick is observable in debug.log.
		// Logged only when there are sessions to scan (no noise on idle ticks).
		if (sessions.length > 0) {
			log.info("Kimi discovery pass: %d session(s) scanned, %d advanced", sessions.length, advanced);
		}
	} catch (err) {
		// Top-level guard: loadConfig / discoverKimiSessions / migrate can throw.
		// Swallow so the public contract ("never rejects") holds.
		log.warn("Kimi discovery pass failed: %s", (err as Error).message);
	}
}
