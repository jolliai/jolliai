import { describe, expect, it } from "vitest";
import type { StoredSession, StoredTranscript, TranscriptEntry } from "../Types.js";
import { archivedSessionKey, groupArchivedSessions, sliceStartTime } from "./ArchivedConversations.js";

function entry(role: "human" | "assistant", content: string, timestamp?: string): TranscriptEntry {
	return { role, content, timestamp };
}

function session(overrides: Partial<StoredSession> & Pick<StoredSession, "sessionId">): StoredSession {
	return { entries: [], ...overrides };
}

function transcript(sessions: StoredSession[]): StoredTranscript {
	return { sessions };
}

describe("sliceStartTime", () => {
	it("returns the epoch ms of the first parseable timestamp", () => {
		const entries = [
			entry("human", "hi", "2026-08-19T10:00:00.000Z"),
			entry("assistant", "yo", "2026-08-19T10:05:00.000Z"),
		];
		expect(sliceStartTime(entries)).toBe(Date.parse("2026-08-19T10:00:00.000Z"));
	});

	it("skips entries with no timestamp and uses the next parseable one", () => {
		const entries = [entry("human", "hi"), entry("assistant", "yo", "2026-08-19T10:05:00.000Z")];
		expect(sliceStartTime(entries)).toBe(Date.parse("2026-08-19T10:05:00.000Z"));
	});

	it("skips an unparseable timestamp and falls through to undefined", () => {
		expect(sliceStartTime([entry("human", "hi", "not-a-date")])).toBeUndefined();
	});

	it("returns undefined for an empty slice", () => {
		expect(sliceStartTime([])).toBeUndefined();
	});
});

describe("archivedSessionKey", () => {
	it("joins source and sessionId", () => {
		expect(archivedSessionKey({ sessionId: "abc", source: "codex" })).toBe("codex:abc");
	});

	it("defaults a source-less session to 'claude'", () => {
		expect(archivedSessionKey({ sessionId: "abc", source: undefined })).toBe("claude:abc");
	});
});

describe("groupArchivedSessions", () => {
	it("collapses one session in one commit into a single row", () => {
		const t = transcript([
			session({ sessionId: "s1", source: "claude", entries: [entry("human", "hi", "2026-08-19T10:00:00.000Z")] }),
		]);
		const result = groupArchivedSessions([["c1", t]]);
		expect(result.order).toEqual(["claude:s1"]);
		const g = result.grouped.get("claude:s1");
		expect(g?.hash).toBe("c1");
		expect(g?.entries).toHaveLength(1);
	});

	it("merges a session split across commits and orders slices by first timestamp", () => {
		// Later commit carries the EARLIER slice — sorting must reorder them.
		const early = session({
			sessionId: "s1",
			source: "claude",
			entries: [entry("human", "first", "2026-08-19T09:00:00.000Z")],
		});
		const late = session({
			sessionId: "s1",
			source: "claude",
			entries: [entry("assistant", "second", "2026-08-19T11:00:00.000Z")],
		});
		// First-seen commit "c1" carries the LATE slice, "c2" carries the early one.
		const result = groupArchivedSessions([
			["c1", transcript([late])],
			["c2", transcript([early])],
		]);
		const g = result.grouped.get("claude:s1");
		// First-seen hash is preserved (c1), but entries are chronological.
		expect(g?.hash).toBe("c1");
		expect(g?.entries.map((e) => e.content)).toEqual(["first", "second"]);
	});

	it("keeps first-seen slice order when a slice has no parseable timestamp", () => {
		const withTime = session({
			sessionId: "s1",
			source: "claude",
			entries: [entry("human", "timed", "2026-08-19T10:00:00.000Z")],
		});
		const noTime = session({ sessionId: "s1", source: "claude", entries: [entry("assistant", "untimed")] });
		const result = groupArchivedSessions([
			["c1", transcript([withTime])],
			["c2", transcript([noTime])],
		]);
		// Comparator returns 0 (tb undefined), so first-seen order holds.
		expect(result.grouped.get("claude:s1")?.entries.map((e) => e.content)).toEqual(["timed", "untimed"]);
	});

	it("hides a usage-only carrier (empty entries + recorded usage)", () => {
		const carrier = session({
			sessionId: "s1",
			source: "claude",
			entries: [],
			usage: { input: 100, output: 50, cached: 0 },
		});
		const result = groupArchivedSessions([["c1", transcript([carrier])]]);
		expect(result.order).toEqual([]);
		expect(result.grouped.has("claude:s1")).toBe(false);
	});

	it("drops an overlay-emptied shell (empty entries, no usage)", () => {
		// A "Mark All as Deleted" overlay empties a session's entries after it was
		// read, leaving a zero-turn shell with no usage. It would render as a
		// `0 msgs` noise row, so the display rule hides it uniformly alongside the
		// usage-only carrier above.
		const empty = session({ sessionId: "s1", source: "claude", entries: [] });
		const result = groupArchivedSessions([["c1", transcript([empty])]]);
		expect(result.order).toEqual([]);
		expect(result.grouped.has("claude:s1")).toBe(false);
	});

	it("shows a conversation entry-less in one commit but real in another, even with usage", () => {
		const carrierSlice = session({
			sessionId: "s1",
			source: "claude",
			entries: [],
			usage: { input: 10, output: 5, cached: 0 },
		});
		const realSlice = session({
			sessionId: "s1",
			source: "claude",
			entries: [entry("human", "real", "2026-08-19T10:00:00.000Z")],
		});
		const result = groupArchivedSessions([
			["c1", transcript([carrierSlice])],
			["c2", transcript([realSlice])],
		]);
		// Merged entries are non-empty, so the carrier predicate does not fire.
		expect(result.grouped.get("claude:s1")?.entries.map((e) => e.content)).toEqual(["real"]);
	});

	it("treats an absent entries field as an empty slice and drops it", () => {
		// Legacy/malformed stored session with `entries` omitted (cast around the
		// required field to mimic on-disk data the reader tolerates). It coalesces to
		// an empty slice, so it is a zero-turn conversation and hidden like any other.
		const legacy = { sessionId: "s1", source: "claude" } as unknown as StoredSession;
		const result = groupArchivedSessions([["c1", transcript([legacy])]]);
		expect(result.order).toEqual([]);
		expect(result.grouped.has("claude:s1")).toBe(false);
	});
});
