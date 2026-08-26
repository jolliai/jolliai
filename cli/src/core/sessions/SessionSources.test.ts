import { describe, expect, it } from "vitest";
import { DAEMON_RESCAN_SOURCES, orFail, SESSION_SOURCES } from "./SessionSources.js";

describe("orFail", () => {
	it("passes a clean scan straight through", () => {
		const sessions = [{ id: "a" }];
		expect(orFail("opencode", sessions, undefined)).toBe(sessions);
	});

	it("passes an empty CLEAN scan through — the store was read and holds nothing", () => {
		// The one case where empty is a positive fact rather than a failure, and the
		// reason `orFail` cannot simply test for emptiness.
		expect(orFail("opencode", [], undefined)).toEqual([]);
	});

	it("THROWS for a scan that found nothing AND reported an error", () => {
		// The only way `scanAllStores` can record the source as ABSENT, which is what
		// keeps its per-repo fallback reachable. Reading `.sessions` alone would spell
		// this as `[]` — "read and holds nothing" — and skip the fallback for the whole
		// run while reporting that nothing as a fact about the agent.
		expect(() => orFail("opencode", [], { kind: "locked", message: "database is locked" })).toThrow(
			/opencode scan failed \(locked\): database is locked/,
		);
	});

	it("KEEPS a partial scan's sessions instead of discarding them", () => {
		// Cline scans each editor flavour independently and Copilot Chat each workspace,
		// so an error beside sessions means "some of it was unreadable", not "this
		// failed". Dropping them would lose data the old per-repo path kept.
		const sessions = [{ id: "a" }];
		expect(orFail("cline", sessions, { kind: "permission", message: "one store unreadable" })).toBe(sessions);
	});
});

describe("SESSION_SOURCES", () => {
	it("registers each source tag exactly once", () => {
		// The registry is keyed by tag downstream (`PreScannedSessions`, the per-source
		// counts, the collector's dedupe), so a duplicate would make one entry
		// unreachable with nothing to say so.
		const tags = SESSION_SOURCES.map((def) => def.source);
		expect(new Set(tags).size).toBe(tags.length);
	});

	it("gives every source a scan and a narrowing half", () => {
		// Miss the scan and the agent is never read; miss the narrowing and its sessions
		// ARE read but can never be attributed to a repo, so they vanish with no error.
		for (const def of SESSION_SOURCES) {
			expect(typeof def.scan, def.source).toBe("function");
			expect(typeof def.forRepo, def.source).toBe("function");
		}
	});

	it("gives every source a per-repo fallback EXCEPT claude", () => {
		// Claude's per-repo route is the hook registry (`sessions.json`), which the
		// collector loads unconditionally for Gemini's sake anyway — so it is the one
		// definition that needs no `scanForRepo`.
		const without = SESSION_SOURCES.filter((def) => def.scanForRepo === undefined).map((def) => def.source);
		expect(without).toEqual(["claude"]);
	});

	it("declares scan-level skipping for exactly the two expensive scanners", () => {
		// Claude parses each whole transcript, Antigravity opens one SQLite per
		// conversation. Everything else reads a few hundred bytes per session or answers
		// the whole store in one query, where the check would cost about what it saves.
		const skipping = SESSION_SOURCES.filter((def) => def.usesAlreadyRecorded).map((def) => def.source);
		expect(skipping).toEqual(["claude", "antigravity"]);
	});

	it("defaults `usesAlreadyRecorded` to a real boolean on every entry", () => {
		// Read off the table by the back-fill; an undefined would be falsy by accident
		// rather than by declaration.
		for (const def of SESSION_SOURCES) expect(typeof def.usesAlreadyRecorded, def.source).toBe("boolean");
	});

	it("opts exactly codex and hermes into the daemon's 30-second re-scan", () => {
		// The sibling flag above is pinned exhaustively and this one was not, which is the
		// asymmetry worth closing: a copy-pasted `daemonRescan: true` on another source would
		// put that agent's whole-transcript parse (Claude) or its per-conversation SQLite
		// open (Antigravity) on a machine-wide 30-second timer, with the full suite green.
		// Nothing else in the product would notice — the flag has no other reader.
		//
		// Both members earned it the same way: an `updatedAt` that moves when a
		// conversation is appended to, plus a measured re-scan cost. Hermes' is one
		// indexed-window query over a small `sessions` table (0.31 ms median).
		const rescanned = SESSION_SOURCES.filter((def) => def.daemonRescan).map((def) => def.source);
		expect(rescanned).toEqual(["codex", "hermes"]);
	});

	it("derives DAEMON_RESCAN_SOURCES from the flag rather than from a second list", () => {
		// The list is a `filter` today; spelled out again it could fall behind the flag, and
		// the failure would be silent in the direction that matters (a source opted in but
		// never ticked).
		expect(DAEMON_RESCAN_SOURCES.map((def) => def.source)).toEqual(
			SESSION_SOURCES.filter((def) => def.daemonRescan).map((def) => def.source),
		);
	});

	it("defaults `daemonRescan` to a real boolean on every entry", () => {
		// Same reason as `usesAlreadyRecorded`: an undefined would be falsy by accident
		// rather than by declaration.
		for (const def of SESSION_SOURCES) expect(typeof def.daemonRescan, def.source).toBe("boolean");
	});
});
