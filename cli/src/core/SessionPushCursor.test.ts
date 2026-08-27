/**
 * The channel state file's parse rules.
 *
 * The cases that matter are the ones where a wrong reading loses data quietly:
 * an unreadable cursor that resolves to "deliver everything" or to "already
 * delivered", and the number-to-keyset upgrade, which has to mean exactly what
 * the number meant or a machine either re-pushes its history or skips a range.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	completeReplayForScope,
	cursorsFor,
	getSessionPushChannelPath,
	isChannelSilenced,
	loadChannelForRun,
	prepareReplayForScope,
	readSessionPushChannel,
	replayForScope,
	toCursors,
	toTableCursor,
	withCursors,
	withReplayCursors,
	withSilence,
	writeSessionPushChannel,
} from "./SessionPushCursor.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-pushcursor-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("toTableCursor", () => {
	it("reads a bare number as the START of that millisecond", () => {
		// An empty key sorts at or before every text key, so `(stamp, "")` selects
		// the whole millisecond — exactly what a bare `stamp >= N` selects. Anything
		// else would either skip rows already in that millisecond or re-push from
		// further back.
		expect(toTableCursor(4_242)).toEqual({ stamp: 4_242, key: [] });
	});

	it("reads this build's shape verbatim", () => {
		expect(toTableCursor({ stamp: 7, key: ["a", "b"] })).toEqual({ stamp: 7, key: ["a", "b"] });
	});

	it("answers undefined for junk rather than a zero cursor", () => {
		// `undefined` means "first run", which applies the 90-day window.
		// `{stamp: 0}` means "deliver everything ever recorded". Guessing the second
		// from a corrupt file would push a machine's entire history.
		for (const junk of [undefined, null, "1000", {}, { stamp: "1000" }, { key: ["a"] }, [], Number.NaN, Infinity]) {
			expect(toTableCursor(junk)).toBeUndefined();
		}
	});

	it("drops non-string key entries instead of carrying them into a query", () => {
		expect(toTableCursor({ stamp: 1, key: ["a", 5, null, "b"] })).toEqual({ stamp: 1, key: ["a", "b"] });
		expect(toTableCursor({ stamp: 1, key: "not-an-array" })).toEqual({ stamp: 1, key: [] });
	});
});

describe("toCursors", () => {
	it("keeps readable tables and drops unreadable ones", () => {
		// Per table, not all-or-nothing: one corrupt entry must not reset the
		// progress of every other table on that backend.
		expect(toCursors({ sessions: 10, recall_receipts: { stamp: 2, key: ["r"] }, bogus: "x" })).toEqual({
			sessions: { stamp: 10, key: [] },
			recall_receipts: { stamp: 2, key: ["r"] },
		});
	});

	it("answers an empty map for a non-object", () => {
		expect(toCursors(null)).toEqual({});
		expect(toCursors("nope")).toEqual({});
	});
});

describe("readSessionPushChannel", () => {
	it("migrates a file written with bare-number cursors", () => {
		// What every machine that ran an earlier build has on disk.
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 1, clientId: "c1", byOrigin: { "https://jolli.ai": { sessions: 999 } } }),
		);
		expect(readSessionPushChannel(dir).byOrigin["https://jolli.ai"]).toEqual({ sessions: { stamp: 999, key: [] } });
	});

	it("treats an unreadable file as absent rather than throwing", () => {
		// It is read from a git hook; a bookkeeping file must never take one down.
		// Losing the cursor costs a re-send the server upserts away.
		writeFileSync(getSessionPushChannelPath(dir), "{ truncated");
		const state = readSessionPushChannel(dir);
		expect(state.byOrigin).toEqual({});
		expect(state.clientId).not.toBe("");
	});

	it("reads a file written by a build with another version as absent", () => {
		// The version is what says "this file means what this build thinks it
		// means". Reading a foreign one field-by-field would hand the runner a
		// cursor whose stamp is on a scale nothing here defines — and the two ways
		// that lands are re-pushing a machine's whole history or skipping a range.
		// Starting over costs one re-send the server upserts away.
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 2, clientId: "c1", byOrigin: { "https://jolli.ai": { sessions: 999 } } }),
		);
		const state = readSessionPushChannel(dir);
		expect(state.byOrigin).toEqual({});
		expect(state.clientId).not.toBe("c1");
	});

	it("reads a state carrying no clientId as absent, rather than running without one", () => {
		// The server keys ITS cursor on `clientId`, so an empty one is not a
		// cosmetic gap: every run would look like a different machine.
		writeFileSync(getSessionPushChannelPath(dir), JSON.stringify({ version: 1, clientId: "" }));
		expect(readSessionPushChannel(dir).clientId).not.toBe("");
	});

	it("reads a state with no byOrigin at all as no progress, not as a missing field", () => {
		// What a state written before the first successful run looks like. `{}` is
		// "first run for every table", which applies the 90-day window — the reading
		// that under-delivers rather than over-delivers.
		writeFileSync(getSessionPushChannelPath(dir), JSON.stringify({ version: 1, clientId: "c1" }));
		const state = readSessionPushChannel(dir);
		expect(state.clientId).toBe("c1");
		expect(state.byOrigin).toEqual({});
	});

	it("round-trips the payload version while ignoring a malformed one", () => {
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 1, clientId: "c1", payloadVersion: 3, byOrigin: {} }),
		);
		expect(readSessionPushChannel(dir).payloadVersion).toBe(3);
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 1, clientId: "c1", payloadVersion: "3", byOrigin: {} }),
		);
		expect(readSessionPushChannel(dir).payloadVersion).toBeUndefined();
	});

	it("treats a path that is not a file at all as absent, and still does not throw", () => {
		// ENOENT is the ordinary case and is silent; anything else (a directory in
		// the way, a permission problem) is worth a line in the log — but it is
		// still only bookkeeping, and it runs from a git hook.
		mkdirSync(getSessionPushChannelPath(dir));
		const state = readSessionPushChannel(dir);
		expect(state.byOrigin).toEqual({});
		expect(state.clientId).not.toBe("");
	});

	it("does not write on read", () => {
		// Callers on the decide-whether-to-run path must be able to ask without
		// touching the disk.
		readSessionPushChannel(dir);
		expect(() => readSessionPushChannel(dir)).not.toThrow();
		expect(readSessionPushChannel(dir).clientId).not.toBe(readSessionPushChannel(dir).clientId);
	});
});

describe("loadChannelForRun", () => {
	it("persists a generated clientId before the run, not after it succeeds", () => {
		// The server keys its own cursor on `clientId`. A client that minted a new
		// one on every failed attempt would look like a new machine each time and be
		// handed an empty cursor for ever.
		const first = loadChannelForRun(dir);
		expect(loadChannelForRun(dir).clientId).toBe(first.clientId);
	});
});

describe("cursor bookkeeping", () => {
	it("starts every affected table at zero for an existing scope without changing normal cursors", () => {
		const initial = withCursors(loadChannelForRun(dir), "https://a", {
			sessions: { stamp: 50, key: ["s1"] },
			session_tool_use: { stamp: 60, key: ["s1", "Read", "builtin"] },
			memory_lookups: { stamp: 70, key: ["r1"] },
		});
		const prepared = prepareReplayForScope(initial, "https://a", undefined, "skills-v1", [
			"sessions",
			"session_tool_use",
			"skill_invocations",
		]);
		expect(replayForScope(prepared, "https://a", "skills-v1")).toEqual({
			generation: "skills-v1",
			completed: false,
			completedTables: [],
			cursors: {
				sessions: { stamp: 0, key: [] },
				session_tool_use: { stamp: 0, key: [] },
				skill_invocations: { stamp: 0, key: [] },
			},
		});
		expect(cursorsFor(prepared, "https://a")).toEqual({
			sessions: { stamp: 50, key: ["s1"] },
			session_tool_use: { stamp: 60, key: ["s1", "Read", "builtin"] },
			memory_lookups: { stamp: 70, key: ["r1"] },
		});
	});

	it("marks a genuinely new scope complete so it keeps the 90-day first-run window", () => {
		const prepared = prepareReplayForScope(loadChannelForRun(dir), "https://new", undefined, "skills-v1", [
			"sessions",
			"session_tool_use",
			"skill_invocations",
		]);
		expect(replayForScope(prepared, "https://new", "skills-v1")).toEqual({
			generation: "skills-v1",
			completed: true,
			completedTables: ["sessions", "session_tool_use", "skill_invocations"],
			cursors: {},
		});
		expect(cursorsFor(prepared, "https://new")).toEqual({});
	});

	it("recognises legacy bare-origin progress but records replay state on the tenant scope", () => {
		const initial = withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 9, key: [] } });
		const prepared = prepareReplayForScope(initial, "https://a/tenant", "https://a", "skills-v1", ["sessions"]);
		expect(replayForScope(prepared, "https://a/tenant", "skills-v1")?.completed).toBe(false);
		expect(replayForScope(prepared, "https://a", "skills-v1")).toBeUndefined();
	});

	it("persists replay progress and completion independently for each scope", () => {
		let state = prepareReplayForScope(
			withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 9, key: [] } }),
			"https://a",
			undefined,
			"skills-v1",
			["sessions"],
		);
		state = withReplayCursors(state, "https://a", "skills-v1", { sessions: { stamp: 5, key: ["e5"] } });
		state = completeReplayForScope(state, "https://a", "skills-v1", { sessions: { stamp: 8, key: ["e8"] } }, [
			"sessions",
		]);
		state = prepareReplayForScope(state, "https://b", undefined, "skills-v1", ["sessions"]);
		writeSessionPushChannel(state, dir);
		const stored = readSessionPushChannel(dir);
		expect(replayForScope(stored, "https://a", "skills-v1")).toMatchObject({
			completed: true,
			cursors: { sessions: { stamp: 8, key: ["e8"] } },
		});
		expect(replayForScope(stored, "https://b", "skills-v1")?.completed).toBe(true);
	});

	it("ignores a completed marker for an older replay generation", () => {
		const initial = withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 9, key: [] } });
		const old = completeReplayForScope(initial, "https://a", "old", { sessions: { stamp: 9, key: [] } }, [
			"sessions",
		]);
		const prepared = prepareReplayForScope(old, "https://a", undefined, "new", ["sessions"]);
		expect(replayForScope(prepared, "https://a", "new")).toEqual({
			generation: "new",
			completed: false,
			completedTables: [],
			cursors: { sessions: { stamp: 0, key: [] } },
		});
	});

	it("keeps the legacy payload-version parser compatible without using it as replay state", () => {
		const state = readSessionPushChannel(dir);
		expect(state.payloadVersion).toBeUndefined();
		expect(state.replayByScope).toEqual({});
	});

	it("replaces one origin and leaves the others alone", () => {
		const state = withCursors(
			withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 1, key: [] } }),
			"https://b",
			{ sessions: { stamp: 2, key: [] } },
		);
		expect(cursorsFor(state, "https://a")).toEqual({ sessions: { stamp: 1, key: [] } });
		expect(cursorsFor(state, "https://b")).toEqual({ sessions: { stamp: 2, key: [] } });
		expect(cursorsFor(state, "https://never-seen")).toEqual({});
	});

	it("round-trips through the file", () => {
		const state = withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 5, key: ["e1"] } });
		writeSessionPushChannel(state, dir);
		expect(cursorsFor(readSessionPushChannel(dir), "https://a")).toEqual({ sessions: { stamp: 5, key: ["e1"] } });
	});

	it("falls back to a legacy bare-origin key, so an upgrade keeps its place", () => {
		// Progress written before the key carried a tenant. Losing it would re-send
		// from the 90-day window on the first run of every upgraded machine.
		const state = withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 9, key: [] } });
		expect(cursorsFor(state, "https://a/tenant", "https://a")).toEqual({ sessions: { stamp: 9, key: [] } });
	});

	it("prefers the scoped key over the legacy one once it exists", () => {
		const state = withCursors(
			withCursors(loadChannelForRun(dir), "https://a", { sessions: { stamp: 9, key: [] } }),
			"https://a/tenant",
			{ sessions: { stamp: 20, key: [] } },
		);
		expect(cursorsFor(state, "https://a/tenant", "https://a")).toEqual({ sessions: { stamp: 20, key: [] } });
	});

	it("keeps two tenants on one origin apart", () => {
		// The reason the scope is not just the origin: a cursor means nothing across
		// tenants, and a refusal from one says nothing about the other.
		const state = withCursors(
			withCursors(loadChannelForRun(dir), "https://a/one", { sessions: { stamp: 1, key: [] } }),
			"https://a/two",
			{ sessions: { stamp: 2, key: [] } },
		);
		expect(cursorsFor(state, "https://a/one")).toEqual({ sessions: { stamp: 1, key: [] } });
		expect(cursorsFor(state, "https://a/two")).toEqual({ sessions: { stamp: 2, key: [] } });
	});
});

describe("silence bookkeeping", () => {
	const base = { version: 1, clientId: "c", byOrigin: {} } as const;

	it("reports a silence only while it is still in effect", () => {
		const state = { ...base, silencedByScope: { "https://a": 100 } };
		expect(isChannelSilenced(state, 99, "https://a")).toBe(true);
		expect(isChannelSilenced(state, 100, "https://a")).toBe(false);
		expect(isChannelSilenced({ ...base, silencedByScope: {} }, 100, "https://a")).toBe(false);
	});

	it("silences one scope without touching another", () => {
		// The whole point of the field: one backend's 403 must not stop the others.
		const state = withSilence({ ...base, silencedByScope: {} }, "https://a", 500, 0);
		expect(isChannelSilenced(state, 100, "https://a")).toBe(true);
		expect(isChannelSilenced(state, 100, "https://b")).toBe(false);
	});

	it("prunes expired scopes as it writes, so the map cannot grow forever", () => {
		const state = withSilence({ ...base, silencedByScope: { "https://old": 50 } }, "https://a", 500, 100);
		expect(state.silencedByScope).toEqual({ "https://a": 500 });
	});

	it("keeps another scope's live silence when writing one", () => {
		const state = withSilence({ ...base, silencedByScope: { "https://b": 900 } }, "https://a", 500, 100);
		expect(state.silencedByScope).toEqual({ "https://b": 900, "https://a": 500 });
	});

	it("round-trips through the file", () => {
		writeSessionPushChannel(withSilence({ ...base, silencedByScope: {} }, "https://a", 500, 0), dir);
		expect(readSessionPushChannel(dir).silencedByScope).toEqual({ "https://a": 500 });
	});

	it("DROPS a legacy machine-wide mark instead of folding it onto every scope", () => {
		// Folding it in would carry the very outage this change fixes across the
		// upgrade that fixes it: the whole machine stayed silent for 24h even after
		// the key was re-pointed at a working backend.
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 1, clientId: "c", silencedUntilMs: 9_999_999, byOrigin: {} }),
		);
		const state = readSessionPushChannel(dir);
		expect(state.silencedByScope).toEqual({});
		expect(isChannelSilenced(state, 0, "https://a")).toBe(false);
	});

	it("ignores a non-numeric stored entry rather than refusing to run", () => {
		writeFileSync(
			getSessionPushChannelPath(dir),
			JSON.stringify({ version: 1, clientId: "c", silencedByScope: { "https://a": "soon" }, byOrigin: {} }),
		);
		expect(readSessionPushChannel(dir).silencedByScope).toEqual({});
	});
});
