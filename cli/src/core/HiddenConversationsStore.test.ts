import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hiddenKey,
	hideConversation,
	isHidden,
	isStillHidden,
	loadHiddenConversations,
} from "./HiddenConversationsStore.js";

describe("HiddenConversationsStore", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "hidden-test-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	const hiddenFile = () => join(projectDir, ".jolli", "jollimemory", "hidden-conversations.json");

	function writeRaw(payload: unknown): void {
		mkdirSync(join(projectDir, ".jolli", "jollimemory"), { recursive: true });
		writeFileSync(hiddenFile(), typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
	}

	describe("hiddenKey", () => {
		it("joins source and sessionId with a colon", () => {
			expect(hiddenKey("claude", "abc-123")).toBe("claude:abc-123");
			expect(hiddenKey("copilot-chat", "xyz")).toBe("copilot-chat:xyz");
		});
	});

	describe("loadHiddenConversations", () => {
		it("returns an empty state when the file does not exist", async () => {
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
			expect(state.version).toBe(1);
		});

		it("returns an empty state when the file is malformed JSON", async () => {
			writeRaw("not-json{");
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
		});

		it("returns an empty state when the version is unrecognized", async () => {
			writeRaw({ version: 99, entries: { "claude:x": { hiddenAt: "2026-01-01T00:00:00Z" } } });
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
		});

		it("filters out malformed entries but keeps well-formed ones", async () => {
			writeRaw({
				version: 1,
				entries: {
					"claude:good": { hiddenAt: "2026-05-17T10:00:00Z" },
					"claude:no-timestamp": {},
					"claude:wrong-type": { hiddenAt: 42 },
					"claude:null-entry": null,
				},
			});
			const state = await loadHiddenConversations(projectDir);
			expect(Object.keys(state.entries).sort()).toEqual(["claude:good"]);
		});

		it("reads a valid file round-tripped from hideConversation", async () => {
			await hideConversation(projectDir, "claude", "session-1");
			const state = await loadHiddenConversations(projectDir);
			expect(isHidden(state, "claude", "session-1")).toBe(true);
		});

		// Silent-failure observability: distinguish "entries field absent"
		// from "entries field present but malformed". Both fall back to
		// empty state, but the warn-log branch fires only on the latter.
		it("returns empty state when entries field is missing entirely", async () => {
			writeRaw({ version: 1 });
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
		});

		it("returns empty state when entries field is present but not an object", async () => {
			writeRaw({ version: 1, entries: "not an object" });
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
		});

		it("falls back to empty state when reading a directory in place of the file (non-ENOENT)", async () => {
			// Pre-create the path as a directory so readFile rejects with
			// EISDIR (not ENOENT) — exercises the warn-log branch of the
			// outer catch.
			mkdirSync(hiddenFile(), { recursive: true });
			const state = await loadHiddenConversations(projectDir);
			expect(state.entries).toEqual({});
		});
	});

	describe("isHidden", () => {
		it("returns false for an unknown (source, sessionId)", async () => {
			const state = await loadHiddenConversations(projectDir);
			expect(isHidden(state, "claude", "missing")).toBe(false);
		});

		it("distinguishes sessions by source", async () => {
			await hideConversation(projectDir, "claude", "shared-id");
			const state = await loadHiddenConversations(projectDir);
			expect(isHidden(state, "claude", "shared-id")).toBe(true);
			expect(isHidden(state, "cursor", "shared-id")).toBe(false);
		});

		// Defense against a sessionId crafted to collide with an internal
		// JS property; Object.hasOwn ignores prototype chain.
		it("does not match prototype-chain keys", async () => {
			const state = await loadHiddenConversations(projectDir);
			expect(isHidden(state, "claude", "__proto__")).toBe(false);
			expect(isHidden(state, "claude", "toString")).toBe(false);
		});
	});

	// `isStillHidden` is what the aggregator actually calls — it implements
	// the "hide is per-snapshot dismiss, not permanent block" semantic by
	// comparing each session's updatedAt against its hiddenAt timestamp.
	// A direct unit suite here pins the boundary behavior so a regression
	// can't slip past the higher-level aggregator integration tests.
	describe("isStillHidden", () => {
		it("returns false when the session is not in the hidden set", async () => {
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "absent", "2026-05-15T12:00:00.000Z")).toBe(false);
		});

		it("returns true when updatedAt is older than hiddenAt", async () => {
			writeRaw({
				version: 1,
				entries: { "cursor:s": { hiddenAt: "2026-05-15T12:00:00.000Z" } },
			});
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "s", "2026-05-15T10:00:00.000Z")).toBe(true);
		});

		it("returns true when updatedAt exactly equals hiddenAt (no new activity)", async () => {
			writeRaw({
				version: 1,
				entries: { "cursor:s": { hiddenAt: "2026-05-15T12:00:00.000Z" } },
			});
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "s", "2026-05-15T12:00:00.000Z")).toBe(true);
		});

		it("returns false when updatedAt is newer than hiddenAt (re-surfaces)", async () => {
			writeRaw({
				version: 1,
				entries: { "cursor:s": { hiddenAt: "2026-05-15T12:00:00.000Z" } },
			});
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "s", "2026-05-15T12:00:00.001Z")).toBe(false);
		});

		// A corrupt hiddenAt mustn't auto-unhide the user's dismiss intent —
		// fall back to "still hidden" rather than silently revealing rows
		// the user already chose to suppress. The load path filters out
		// non-string hiddenAt entirely; reaching this branch means the
		// string was present but not parseable (e.g. truncated mid-write).
		it("returns true when hiddenAt is unparseable", async () => {
			writeRaw({
				version: 1,
				entries: { "cursor:s": { hiddenAt: "not-a-date" } },
			});
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "s", "2026-05-15T12:00:00.000Z")).toBe(true);
		});

		// Symmetric case: an unparseable session updatedAt cannot be used as
		// evidence of activity past the hide, so the hide stays in force.
		it("returns true when sessionUpdatedAt is unparseable", async () => {
			writeRaw({
				version: 1,
				entries: { "cursor:s": { hiddenAt: "2026-05-15T12:00:00.000Z" } },
			});
			const state = await loadHiddenConversations(projectDir);
			expect(isStillHidden(state, "cursor", "s", "garbage")).toBe(true);
		});
	});

	describe("hideConversation", () => {
		it("creates the parent directory when it does not exist", async () => {
			await hideConversation(projectDir, "claude", "s1");
			const onDisk = JSON.parse(readFileSync(hiddenFile(), "utf8"));
			expect(onDisk.version).toBe(1);
			expect(onDisk.entries["claude:s1"].hiddenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		it("preserves entries for other sessions", async () => {
			await hideConversation(projectDir, "claude", "first");
			await hideConversation(projectDir, "codex", "second");
			const state = await loadHiddenConversations(projectDir);
			expect(isHidden(state, "claude", "first")).toBe(true);
			expect(isHidden(state, "codex", "second")).toBe(true);
		});

		it("is idempotent — re-hiding refreshes the timestamp", async () => {
			const first = await hideConversation(projectDir, "claude", "s1");
			await new Promise((r) => setTimeout(r, 5));
			const second = await hideConversation(projectDir, "claude", "s1");
			expect(Object.keys(second.entries)).toEqual(["claude:s1"]);
			expect(second.entries["claude:s1"].hiddenAt).not.toBe(first.entries["claude:s1"].hiddenAt);
		});

		// Concurrent hides race on load→modify→write. Pre-lock fix: each
		// caller loads the same baseline ({}) and the last writer wins —
		// at the end only one entry survives, the others silently vanish.
		// Post-lock fix: all callers serialise through the `.lock` sibling
		// so every hide observes the previous state and all keys land.
		it("survives concurrent hide calls without dropping entries", async () => {
			await Promise.all([
				hideConversation(projectDir, "claude", "a"),
				hideConversation(projectDir, "claude", "b"),
				hideConversation(projectDir, "codex", "c"),
				hideConversation(projectDir, "cursor", "d"),
				hideConversation(projectDir, "gemini", "e"),
			]);
			const state = await loadHiddenConversations(projectDir);
			expect(Object.keys(state.entries).sort()).toEqual([
				"claude:a",
				"claude:b",
				"codex:c",
				"cursor:d",
				"gemini:e",
			]);
		});

		// Crash recovery: a stale `.lock` left by a crashed earlier holder
		// must not block new hides forever. Synthesize the stale lock by
		// writing it with an antique mtime and verify the next hide
		// reclaims it instead of giving up.
		it("reclaims a stale lock left by a previous crash", async () => {
			const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
			const dir = join(projectDir, ".jolli", "jollimemory");
			mkdirSync(dir, { recursive: true });
			const lockPath = join(dir, "hidden-conversations.json.lock");
			writeFileSync(lockPath, "99999", "utf8");
			// 60 seconds ago — well past the 10s stale threshold.
			const ancient = new Date(Date.now() - 60_000);
			utimesSync(lockPath, ancient, ancient);

			const state = await hideConversation(projectDir, "claude", "after-stale");
			expect(state.entries["claude:after-stale"]).toBeDefined();
		});
	});
});
