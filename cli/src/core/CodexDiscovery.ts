/**
 * CodexDiscovery — hook-free artifact discovery for Codex.
 *
 * Extracts Linear / Jira / GitHub / Notion references AND markdown plans
 * (apply_patch writes) from Codex transcripts, reusing the SAME
 * `discovery-cursors.json` mechanism as the Claude Stop path; both share the one
 * per-session cursor (the module was named generically so plans could join without
 * another rename).
 *
 * Why not a Codex hook. Codex DOES expose a `Stop` event equivalent to Claude's, and
 * its hook input carries everything needed (`session_id`, `cwd`, `transcript_path`).
 * It is unusable as a *baseline* anyway: Codex skips plugin-bundled hooks until the
 * user reviews and trusts the current hook definition, re-prompts when that
 * definition changes, and offers no programmatic way to pre-trust — so a hook-driven
 * path would silently do nothing for an unknown share of users. Codex also runs hook
 * commands with the session cwd, which is what broke an earlier repo-local-hook
 * spike under git worktrees. A Stop hook may still be added later as a *freshness*
 * enhancement on top of the drivers below.
 *
 * Drivers (both required — neither alone covers every user):
 *   - VS Code sidebar's 60s Active Conversations tick — sub-minute freshness for the
 *     panel. Fire-and-forget.
 *   - QueueWorker at post-commit — the baseline. Awaited, because the association
 *     step reads `plans.json` rather than extracting. This is the ONLY driver for a
 *     CLI-only or Codex-plugin user; without it their `plans.json` stays empty and
 *     every commit is associated with no plans and no references.
 *
 * Concurrency: a per-cwd single-flight collapses overlapping calls (the tick, panel
 * re-open, manual refresh, detail-panel save, and the worker all call this). A
 * re-entrant call marks the in-flight run "dirty" so it runs ONE more pass after the
 * current one — without this, a naive single-flight would miss rows written after the
 * in-flight run already passed `discoverCodexSessions`, deferring them a full minute.
 * Sessions are processed serially so multiple per-session cursor writes never race
 * each other within a batch.
 *
 * Contract: `discoverCodexConversations` NEVER rejects — all errors are swallowed
 * and logged, so callers can `void`-call it without an unhandled rejection.
 */

import { createLogger, isManuallyDisabled } from "../Logger.js";
import { discoverCodexSessions, isCodexInstalled } from "./CodexSessionDiscoverer.js";
import { scanPlansFrom } from "./plans/TranscriptPlanDiscovery.js";
import { scanReferencesFrom } from "./references/TranscriptReferenceDiscovery.js";
import { loadConfig, loadDiscoveryCursor, migrateDiscoveryCursors, saveDiscoveryCursor } from "./SessionTracker.js";
import { scanSkillsWithCursor } from "./skills/TranscriptSkillDiscovery.js";

const log = createLogger("CodexDiscovery");

interface InFlight {
	promise: Promise<void>;
	dirty: boolean;
}

/** Per-cwd single-flight registry (keyed by the workspace cwd). */
const inFlight = new Map<string, InFlight>();

/**
 * Scan all recent Codex sessions for this cwd and persist any discovered
 * artifacts (references + plans). Single-flight + dirty-rerun per cwd. Never rejects.
 */
export function discoverCodexConversations(cwd: string): Promise<void> {
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
		// A discovery pass persists cursors, plans and references into the
		// project's .jolli/jollimemory/ — all disk writes a manually-disabled
		// project must not receive (the sidebar's 60s tick keeps firing even
		// while the disabled panel is shown).
		if (isManuallyDisabled()) return;
		const config = await loadConfig();
		if (config.codexEnabled === false) return;
		if (!(await isCodexInstalled())) return;

		await migrateDiscoveryCursors(cwd);
		const sessions = await discoverCodexSessions(cwd);
		let advanced = 0;
		for (const session of sessions) {
			// Per-session try/catch: one bad transcript (read error, parse failure)
			// must not abort the rest of the batch or block cursor advances.
			try {
				const fromLine = (await loadDiscoveryCursor(session.transcriptPath, cwd))?.lineNumber ?? 0;

				// Reference scans FIRST: its safe cursor (refLine) decides how far this
				// pass advances the shared cursor, AND it caps plan scanning. A plan
				// must never be processed past refLine — those lines get re-read next
				// pass, which would re-upsert and churn plans.json.
				let refLine = fromLine;
				let refDone = false;
				try {
					refLine = await scanReferencesFrom(session.transcriptPath, fromLine, cwd, "codex");
					refDone = true;
				} catch (err) {
					log.warn("Codex reference discovery failed for %s: %s", session.sessionId, (err as Error).message);
				}

				// Plan scans only (fromLine, refLine] — aligned with the cursor we will
				// save, never overlapping. If ref threw, refLine === fromLine → plan
				// scans 0 lines and retries next pass alongside the held cursor.
				let planDone = false;
				try {
					await scanPlansFrom(session.transcriptPath, fromLine, cwd, "codex", refLine);
					planDone = true;
				} catch (err) {
					log.warn("Codex plan discovery failed for %s: %s", session.sessionId, (err as Error).message);
				}

				// Skills scan on their OWN high-water mark, independently of the
				// reference/plan window above. They can: the skills extractor has its own
				// cursor, so it neither constrains nor is constrained by how far the
				// shared cursor advances this pass. Capture from Codex is heuristic
				// (a shell read of a SKILL.md), so a re-scan is idempotent by name.
				await scanSkillsWithCursor(session.transcriptPath, cwd, "codex");

				// Advance only when BOTH completed and the safe cursor moved — any
				// throw holds this window so the next pass re-scans it (re-scan is
				// idempotent via dedupe + upsert-by-key).
				if (refDone && planDone && refLine > fromLine) {
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
				log.warn("Codex discovery failed for %s: %s", session.sessionId, (err as Error).message);
			}
		}
		// Summary line so the otherwise-silent 60s tick is observable in debug.log.
		// Logged only when there are sessions to scan (no noise on idle ticks).
		if (sessions.length > 0) {
			log.info("Codex discovery pass: %d session(s) scanned, %d advanced", sessions.length, advanced);
		}
	} catch (err) {
		// Top-level guard: loadConfig / discoverCodexSessions / migrate can throw.
		// Swallow so the public contract ("never rejects") holds.
		log.warn("Codex discovery pass failed: %s", (err as Error).message);
	}
}
