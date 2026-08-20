/**
 * CursorDiscovery — hook-free skill discovery for both Cursor surfaces.
 *
 * Structurally a twin of {@link discoverKimiConversations} / `CodexDiscovery`, with
 * two deliberate narrowings.
 *
 * ## Why it exists: the dashboard is not the only consumer
 *
 * Registering a scanner in `SkillTranscriptScanner`'s table reaches the DASHBOARD for
 * free — `SessionSignals`' skill extractor asks that table per session. It reaches the
 * `plans.json` skill registry, and therefore the SKILLS panel, NOT AT ALL: that path
 * runs through `scanSkillsWithCursor`, which has one call site per source and no
 * generic driver. `DiscoveryCatchUp` is not it either — it narrows every session to
 * `"claude"` or `"gemini"` before calling.
 *
 * Without this file, Cursor skills would read as N in the dashboard and 0 in the
 * SKILLS panel, which is precisely the Codex Desktop asymmetry AGENTS.md records as a
 * known, accepted defect. Adding one more instance of it silently is not the same
 * thing as accepting the documented one.
 *
 * ## Two sources, one pass
 *
 * `cursor` (the IDE's Agents Window, discovered through `state.vscdb`) and
 * `cursor-cli` (`cursor-agent`, discovered through `~/.cursor/chats`) are separate
 * transcript sources with disjoint discovery indexes, but they write the SAME
 * `agent-transcripts` JSONL and share one user-facing toggle. Both are scanned here so
 * a user who works in both does not get half a picture. The IDE additionally has a
 * `stop` hook, but only in the IDE — measured: `stop` never fires under
 * `cursor-agent -p`, so a headless CLI run has no event-driven route at all and this
 * scan is its only one.
 *
 * ## References are deliberately NOT scanned
 *
 * Not an oversight and not cheap to add. The reference matcher resolves an MCP call by
 * its NAME (`mcp__<server>__<tool>`), and Cursor does not name calls that way: every
 * MCP invocation is a generic `CallMcpTool` whose server lives in `input` (see
 * `classifyCursorToolName`). So `scanReferencesFrom` would walk every transcript and
 * match nothing — spending the I/O to produce a confident empty result. Covering it
 * needs a Cursor envelope parser pinned to a real capture of an MCP call that carries
 * a reference, which is its own change. Skills therefore drive their own high-water
 * mark here and no shared `discovery-cursors.json` entry is touched.
 *
 * Contract: never rejects — every error is swallowed and logged, so callers may
 * `void`-call it without risking an unhandled rejection.
 */

import { createLogger, isManuallyDisabled } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";
import { discoverCursorCliSessions, isCursorCliInstalled } from "./CursorCliSessionDiscoverer.js";
import { isCursorInstalled } from "./CursorDetector.js";
import { discoverCursorSessions } from "./CursorSessionDiscoverer.js";
import { loadConfig, migrateDiscoveryCursors } from "./SessionTracker.js";
import { scanSkillsWithCursor } from "./skills/TranscriptSkillDiscovery.js";

const log = createLogger("CursorDiscovery");

interface InFlight {
	promise: Promise<void>;
	dirty: boolean;
}

/** Per-cwd single-flight registry (keyed by the workspace cwd). */
const inFlight = new Map<string, InFlight>();

/**
 * Scan all recent Cursor conversations for this cwd and persist discovered skills.
 * Single-flight + dirty-rerun per cwd. Never rejects.
 */
export function discoverCursorConversations(cwd: string): Promise<void> {
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
		// A discovery pass persists cursors and skills into the project's
		// .jolli/jollimemory/ — all disk writes a manually-disabled project must not
		// receive (the sidebar's 60s tick keeps firing while the disabled panel shows).
		if (isManuallyDisabled()) return;
		const config = await loadConfig();
		// ONE toggle for both sources, matching how they are presented everywhere else
		// (`isSourceEnabled`, the Settings row, the status tree).
		if (config.cursorEnabled === false) return;

		await migrateDiscoveryCursors(cwd);

		let scanned = 0;
		// Each source is gated on its own presence and collected independently: a
		// machine with the IDE but no CLI (or the reverse) is the common case, and a
		// failure in one must not cost the other its scan.
		if (await isCursorInstalled()) {
			scanned += await scanSource(cwd, "cursor", await discoverCursorSessions(cwd));
		}
		if (await isCursorCliInstalled()) {
			scanned += await scanSource(cwd, "cursor-cli", await discoverCursorCliSessions(cwd));
		}

		// Logged only when there was something to scan, so an idle 60s tick stays silent.
		if (scanned > 0) log.info("Cursor discovery pass: %d conversation(s) scanned", scanned);
	} catch (err) {
		// Top-level guard: loadConfig / the discoverers / migrate can all throw.
		log.warn("Cursor discovery pass failed for %s: %s", cwd, (err as Error).message);
	}
}

/**
 * Scans one source's sessions, returning how many were attempted.
 *
 * Per-session try/catch: one unreadable transcript must not abort the rest of the
 * batch. `scanSkillsWithCursor` owns its own high-water mark and never throws, so the
 * guard here is for the surrounding bookkeeping rather than for it.
 */
async function scanSource(
	cwd: string,
	source: TranscriptSource,
	sessions: ReadonlyArray<{ readonly sessionId: string; readonly transcriptPath: string }>,
): Promise<number> {
	let count = 0;
	for (const session of sessions) {
		// A composer with no `agent-transcripts` JSONL still carries the synthetic
		// `<db>#<composerId>` handle. The skill envelope lives only in the JSONL, and a
		// line-oriented scanner cannot read a SQLite handle, so skipping it here is the
		// difference between "no skills found" and a per-session read error every pass.
		if (!session.transcriptPath.endsWith(".jsonl")) continue;
		try {
			await scanSkillsWithCursor(session.transcriptPath, cwd, source);
			count++;
		} catch (err) {
			log.warn("Cursor skill discovery failed for %s/%s: %s", source, session.sessionId, (err as Error).message);
		}
	}
	return count;
}
