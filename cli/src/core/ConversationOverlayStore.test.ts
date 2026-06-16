import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../Types.js";
import {
	applyDeletes,
	applyOverlay,
	applyOverlaysToSessions,
	type ConversationOverlay,
	hasOverlayChanges,
	loadOverlay,
	mergeOverlay,
	type OverlayableSession,
	overlayPath,
	pruneConsumedOverlayRules,
	saveOverlay,
} from "./ConversationOverlayStore.js";

describe("ConversationOverlayStore", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "overlay-test-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	const overlayDir = () => join(projectDir, ".jolli", "jollimemory", "conversation-edits");

	function writeRaw(filename: string, payload: unknown): void {
		mkdirSync(overlayDir(), { recursive: true });
		writeFileSync(
			join(overlayDir(), filename),
			typeof payload === "string" ? payload : JSON.stringify(payload),
			"utf8",
		);
	}

	describe("hasOverlayChanges", () => {
		const base = {
			version: 2 as const,
			source: "claude" as const,
			sessionId: "s",
			updatedAt: "2026-05-17T00:00:00Z",
		};

		it("returns false for a null overlay", () => {
			expect(hasOverlayChanges(null)).toBe(false);
		});

		it("returns false for an undefined overlay", () => {
			expect(hasOverlayChanges(undefined)).toBe(false);
		});

		it("returns true when deletes is non-empty", () => {
			const overlay: ConversationOverlay = {
				...base,
				deletes: [{ role: "human", content: "x" }],
				edits: [],
			};
			expect(hasOverlayChanges(overlay)).toBe(true);
		});

		it("returns true when edits is non-empty while deletes is empty", () => {
			const overlay: ConversationOverlay = {
				...base,
				deletes: [],
				edits: [{ role: "assistant", content: "y", newContent: "z" }],
			};
			expect(hasOverlayChanges(overlay)).toBe(true);
		});

		it("returns false when both deletes and edits are empty", () => {
			const overlay: ConversationOverlay = { ...base, deletes: [], edits: [] };
			expect(hasOverlayChanges(overlay)).toBe(false);
		});
	});

	describe("overlayPath", () => {
		it("returns <projectDir>/.jolli/jollimemory/conversation-edits/<source>--<sessionId>.json", () => {
			const p = overlayPath({ projectDir, source: "claude", sessionId: "abc123" });
			expect(p).toBe(join(overlayDir(), "claude--abc123.json"));
		});

		it("sanitizes path separators and unusual chars in sessionId", () => {
			const p = overlayPath({
				projectDir,
				source: "claude",
				sessionId: "weird/id:with\\colons",
			});
			expect(p.endsWith("claude--weird_id_with_colons.json")).toBe(true);
		});

		it("falls back to _ for an empty sessionId", () => {
			const p = overlayPath({ projectDir, source: "claude", sessionId: "" });
			expect(p.endsWith("claude--_.json")).toBe(true);
		});

		it("sanitizes a path-traversal source so the overlay cannot escape the conversation-edits subdir", () => {
			// The source field is statically typed `TranscriptSource` but
			// arrives from the webview message bus at runtime; a crafted
			// payload with "../../foo" must not be able to write outside
			// the overlay subdir. We resolve the returned path and verify it
			// stays inside the overlay directory — `..` characters inside a
			// single path segment are harmless because they are not preceded
			// or followed by a separator, but only `resolve()` proves that
			// definitively across darwin/linux/win32 normalization rules.
			const p = overlayPath({
				projectDir,
				source: "../../foo" as unknown as Parameters<typeof overlayPath>[0]["source"],
				sessionId: "s1",
			});
			const resolved = resolve(p);
			expect(resolved.startsWith(resolve(overlayDir()) + sep)).toBe(true);
			// Path separators in the input must be sanitized to underscores
			// so the filename stays a single segment. Dots are allowed by the
			// allow-list (POSIX filenames legally contain `..`); the safety
			// guarantee is the resolve() check above, not character stripping.
			expect(p.endsWith(".._.._foo--s1.json")).toBe(true);
		});
	});

	describe("loadOverlay", () => {
		it("returns null and logs at warn level when the overlay path is a directory (non-ENOENT)", async () => {
			// Pre-create the would-be overlay path AS a directory so readFile
			// rejects with EISDIR — exercises the warn-log branch in the
			// outer catch (Critical #5 observability).
			const expectedFile = overlayPath({ projectDir, source: "claude", sessionId: "blocked" });
			mkdirSync(expectedFile, { recursive: true });
			const loaded = await loadOverlay({ projectDir, source: "claude", sessionId: "blocked" });
			expect(loaded).toBeNull();
		});

		it("returns null when the overlay file does not exist", async () => {
			const overlay = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "missing",
			});
			expect(overlay).toBeNull();
		});

		it("returns null when the file is unparseable JSON", async () => {
			writeRaw("claude--bad-json.json", "{not json");
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "bad-json" })).toBeNull();
		});

		it("returns null when version does not match", async () => {
			writeRaw("claude--wrong-v.json", {
				version: 1,
				source: "claude",
				sessionId: "wrong-v",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [],
			});
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "wrong-v" })).toBeNull();
		});

		it("returns null when source/sessionId inside the file disagree with the key", async () => {
			writeRaw("claude--real-id.json", {
				version: 2,
				source: "codex",
				sessionId: "other-id",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [],
			});
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "real-id" })).toBeNull();
		});

		it("returns null when deletes/edits aren't arrays", async () => {
			writeRaw("claude--shape.json", {
				version: 2,
				source: "claude",
				sessionId: "shape",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: "nope",
				edits: [],
			});
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "shape" })).toBeNull();
		});

		// parseOverlay's top-level type guards each have their own branch.
		// Existing tests cover JSON.parse failure, version mismatch, and
		// deletes/edits-not-array; the remaining ones are pinned below.
		it("returns null when the JSON document is a primitive (not an object)", async () => {
			writeRaw("claude--prim.json", "42");
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "prim" })).toBeNull();
		});

		it("returns null when the JSON document is null", async () => {
			writeRaw("claude--null.json", "null");
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "null" })).toBeNull();
		});

		it("returns null when the source field is not a string", async () => {
			writeRaw("claude--bad-source.json", {
				version: 2,
				source: 42,
				sessionId: "bad-source",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [],
			});
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "bad-source" })).toBeNull();
		});

		it("returns null when the source string is not in the TRANSCRIPT_SOURCES allowlist", async () => {
			// Defense-in-depth: even if a forged or migrated overlay file
			// agrees with the lookup key on a non-allowlist source string
			// (e.g. "windsurf"), the parser must reject it so downstream
			// `parsed.source as TranscriptSource` cast can never observe an
			// invalid value. Without the runtime guard the key-match check
			// at L111-122 would accept this pair.
			writeRaw("windsurf--x.json", {
				version: 2,
				source: "windsurf",
				sessionId: "x",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [],
			});
			const overlay = await loadOverlay({
				projectDir,
				// Cast bypasses the static TranscriptSource type — the runtime
				// allowlist must do the actual rejection.
				source: "windsurf" as unknown as Parameters<typeof loadOverlay>[0]["source"],
				sessionId: "x",
			});
			expect(overlay).toBeNull();
		});

		it("returns null when the updatedAt field is not a string", async () => {
			writeRaw("claude--bad-updated.json", {
				version: 2,
				source: "claude",
				sessionId: "bad-updated",
				updatedAt: 1234567890,
				deletes: [],
				edits: [],
			});
			expect(await loadOverlay({ projectDir, source: "claude", sessionId: "bad-updated" })).toBeNull();
		});

		it("drops edit rules whose identity is malformed (parseIdentity returns null)", async () => {
			writeRaw("claude--bad-edit-id.json", {
				version: 2,
				source: "claude",
				sessionId: "bad-edit-id",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [
					// role = unknown → parseIdentity rejects, continue
					{ role: "narrator", content: "x", newContent: "y" },
					// content not string → parseIdentity rejects, continue
					{ role: "human", content: 0, newContent: "y" },
					// valid identity but newContent OK
					{ role: "human", content: "ok", newContent: "fine" },
				],
			});
			const overlay = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "bad-edit-id",
			});
			expect(overlay?.edits).toEqual([{ role: "human", content: "ok", newContent: "fine" }]);
		});

		it("drops malformed delete entries and edit rules during parse", async () => {
			writeRaw("claude--filtering.json", {
				version: 2,
				source: "claude",
				sessionId: "filtering",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [
					{ role: "human", content: "ok" },
					{ role: "wat", content: "skip" },
					{ role: "assistant", content: 42 },
					"not an object",
				],
				edits: [
					{ role: "human", content: "ok", newContent: "x" },
					{ role: "assistant", content: "missing-newContent" },
					{ role: "human", content: "newContent-not-string", newContent: 7 },
				],
			});
			const overlay = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "filtering",
			});
			expect(overlay?.deletes).toEqual([{ role: "human", content: "ok" }]);
			expect(overlay?.edits).toEqual([{ role: "human", content: "ok", newContent: "x" }]);
		});

		it("preserves timestamp when present and omits when absent", async () => {
			writeRaw("claude--ts.json", {
				version: 2,
				source: "claude",
				sessionId: "ts",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "with-ts", timestamp: "2026-05-17T01:00:00Z" }],
				edits: [],
			});
			const overlay = await loadOverlay({ projectDir, source: "claude", sessionId: "ts" });
			expect(overlay?.deletes[0]).toEqual({
				role: "human",
				content: "with-ts",
				timestamp: "2026-05-17T01:00:00Z",
			});
		});
	});

	describe("saveOverlay", () => {
		it("creates the overlay subdir, writes the file, and round-trips", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: "s1" },
				{
					deletes: [{ role: "human", content: "hi" }],
					edits: [{ role: "assistant", content: "hello", newContent: "Hello there" }],
				},
			);
			const onDisk = JSON.parse(readFileSync(join(overlayDir(), "claude--s1.json"), "utf8"));
			expect(onDisk.version).toBe(2);
			const loaded = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "s1",
			});
			expect(loaded?.deletes).toEqual([{ role: "human", content: "hi" }]);
			expect(loaded?.edits).toEqual([{ role: "assistant", content: "hello", newContent: "Hello there" }]);
		});

		it("cleans up the .tmp file when rename fails so the overlay subdir does not accumulate orphans", async () => {
			// Trigger a real rename failure by pre-creating the destination
			// as a directory (POSIX rename "file → existing dir" fails with
			// EISDIR / EPERM depending on platform). writeFile succeeds so
			// the .tmp file lands on disk; the rename throws, and the
			// production code's tmp-cleanup branch must unlink it.
			const dir = overlayDir();
			mkdirSync(dir, { recursive: true });
			const finalPath = join(dir, "claude--orphan.json");
			mkdirSync(finalPath); // finalPath = directory, not file
			const tmpPath = `${finalPath}.tmp`;

			await expect(
				saveOverlay(
					{ projectDir, source: "claude", sessionId: "orphan" },
					{ deletes: [{ role: "human", content: "x" }], edits: [] },
				),
			).rejects.toThrow();

			expect(existsSync(tmpPath)).toBe(false);
		});

		it("dedupes identical delete rules and keeps last-wins for duplicate edits", async () => {
			const saved = await saveOverlay(
				{ projectDir, source: "claude", sessionId: "dedupe" },
				{
					deletes: [
						{ role: "human", content: "x" },
						{ role: "human", content: "x" },
					],
					edits: [
						{ role: "human", content: "y", newContent: "first" },
						{ role: "human", content: "y", newContent: "second" },
					],
				},
			);
			expect(saved.deletes).toEqual([{ role: "human", content: "x" }]);
			expect(saved.edits).toEqual([{ role: "human", content: "y", newContent: "second" }]);
		});
	});

	describe("applyOverlay", () => {
		const entries: ReadonlyArray<TranscriptEntry> = [
			{ role: "human", content: "hi", timestamp: "t0" },
			{ role: "assistant", content: "hello", timestamp: "t1" },
			{ role: "human", content: "how are you", timestamp: "t2" },
			{ role: "assistant", content: "fine", timestamp: "t3" },
		];

		it("returns entries unchanged when overlay is null", () => {
			const result = applyOverlay(entries, null);
			expect(result).toEqual(entries);
		});

		it("drops entries whose identity matches a delete rule", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "assistant", content: "hello", timestamp: "t1" }],
				edits: [],
			};
			const result = applyOverlay(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["hi", "how are you", "fine"]);
		});

		it("replaces content for entries matching an edit rule", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [
					{
						role: "assistant",
						content: "hello",
						timestamp: "t1",
						newContent: "edited!",
					},
				],
			};
			const result = applyOverlay(entries, overlay);
			expect(result[1].content).toBe("edited!");
			expect(result[1].role).toBe("assistant");
			expect(result[1].timestamp).toBe("t1");
		});

		it("delete wins over edit at the same identity", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "hi", timestamp: "t0" }],
				edits: [{ role: "human", content: "hi", timestamp: "t0", newContent: "edited" }],
			};
			const result = applyOverlay(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["hello", "how are you", "fine"]);
		});

		it("matches entries even when the rule lacks a timestamp (one-sided lenient match)", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "hi" }],
				edits: [],
			};
			const result = applyOverlay(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["hello", "how are you", "fine"]);
		});

		it("does not match an entry with a different role", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				// Wrong role — should not match the human entry
				deletes: [{ role: "assistant", content: "hi", timestamp: "t0" }],
				edits: [],
			};
			const result = applyOverlay(entries, overlay);
			expect(result.length).toBe(4);
		});

		it("does not match when both sides have timestamps that differ", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "hi", timestamp: "DIFFERENT" }],
				edits: [],
			};
			const result = applyOverlay(entries, overlay);
			expect(result.length).toBe(4);
		});
	});

	describe("mergeOverlay", () => {
		const baseOverlay: ConversationOverlay = {
			version: 2,
			source: "claude",
			sessionId: "s",
			updatedAt: "2026-05-17T00:00:00Z",
			deletes: [{ role: "human", content: "delete-me", timestamp: "t1" }],
			edits: [{ role: "assistant", content: "edit-me", timestamp: "t2", newContent: "v1" }],
		};

		it("adds new deletes and edits without affecting existing ones", () => {
			const merged = mergeOverlay(baseOverlay, {
				deletes: [{ role: "human", content: "new-delete" }],
				edits: [{ role: "assistant", content: "new-edit", newContent: "fresh" }],
			});
			expect(merged.deletes.length).toBe(2);
			expect(merged.edits.length).toBe(2);
		});

		it("skips a new delete identical to an existing one (idempotent)", () => {
			const merged = mergeOverlay(baseOverlay, {
				deletes: [{ role: "human", content: "delete-me", timestamp: "t1" }],
				edits: [],
			});
			expect(merged.deletes.length).toBe(1);
		});

		it("replaces an existing edit with a new edit for the same identity", () => {
			const merged = mergeOverlay(baseOverlay, {
				deletes: [],
				edits: [{ role: "assistant", content: "edit-me", timestamp: "t2", newContent: "v2" }],
			});
			expect(merged.edits).toEqual([
				{ role: "assistant", content: "edit-me", timestamp: "t2", newContent: "v2" },
			]);
		});

		it("drops an existing edit when the same identity is being deleted now", () => {
			const merged = mergeOverlay(baseOverlay, {
				deletes: [{ role: "assistant", content: "edit-me", timestamp: "t2" }],
				edits: [],
			});
			expect(merged.edits.length).toBe(0);
			expect(merged.deletes.length).toBe(2);
		});

		it("drops a new edit if the same identity is also marked for deletion in this batch", () => {
			const merged = mergeOverlay(null, {
				deletes: [{ role: "human", content: "doomed" }],
				edits: [
					{ role: "human", content: "doomed", newContent: "ignored" },
					{ role: "assistant", content: "kept", newContent: "ok" },
				],
			});
			expect(merged.edits).toEqual([{ role: "assistant", content: "kept", newContent: "ok" }]);
		});

		it("starts from empty when existing overlay is null", () => {
			const merged = mergeOverlay(null, {
				deletes: [{ role: "human", content: "x" }],
				edits: [{ role: "assistant", content: "y", newContent: "z" }],
			});
			expect(merged.deletes.length).toBe(1);
			expect(merged.edits.length).toBe(1);
		});
	});

	describe("applyOverlaysToSessions", () => {
		it("applies the per-session overlay to each session, leaving overlay-less sessions untouched", async () => {
			// Session A has an overlay deleting one entry; session B has no overlay.
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: "sess-A" },
				{
					deletes: [{ role: "human", content: "drop me", timestamp: "t0" }],
					edits: [],
				},
			);
			const sessions = [
				{
					sessionId: "sess-A",
					source: "claude" as const,
					entries: [
						{ role: "human" as const, content: "drop me", timestamp: "t0" },
						{ role: "assistant" as const, content: "keep", timestamp: "t1" },
					],
				},
				{
					sessionId: "sess-B",
					source: "claude" as const,
					entries: [{ role: "human" as const, content: "untouched", timestamp: "t0" }],
				},
			];
			const result = await applyOverlaysToSessions(sessions, projectDir);
			expect(result[0].entries.map((e) => e.content)).toEqual(["keep"]);
			expect(result[1].entries.map((e) => e.content)).toEqual(["untouched"]);
		});

		it("defaults source to 'claude' when the session shape omits it", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: "no-source" },
				{
					deletes: [{ role: "human", content: "gone" }],
					edits: [],
				},
			);
			const sessions = [
				{
					sessionId: "no-source",
					// no source field
					entries: [
						{ role: "human" as const, content: "gone" },
						{ role: "assistant" as const, content: "stays" },
					],
				},
			];
			const result = await applyOverlaysToSessions(sessions, projectDir);
			expect(result[0].entries.map((e) => e.content)).toEqual(["stays"]);
		});

		it("preserves non-entry fields on the session object", async () => {
			const sessions = [
				{
					sessionId: "extra-fields",
					source: "claude" as const,
					transcriptPath: "/abs/path/x.jsonl",
					entries: [{ role: "human" as const, content: "hi" }],
				},
			];
			const result = await applyOverlaysToSessions(sessions, projectDir);
			expect(result[0].transcriptPath).toBe("/abs/path/x.jsonl");
		});
	});

	// ─── applyDeletes ──────────────────────────────────────────────────────
	// Added with the chained-edit fix: handleSaveOverrides derives identities
	// from the *raw* (deletes-applied, edits-untouched) view so a new edit's
	// identity stays anchored to the original source content.
	describe("applyDeletes", () => {
		const entries: ReadonlyArray<TranscriptEntry> = [
			{ role: "human", content: "hi", timestamp: "t0" },
			{ role: "assistant", content: "hello", timestamp: "t1" },
			{ role: "human", content: "how are you", timestamp: "t2" },
		];

		it("returns entries unchanged when overlay is null", () => {
			expect(applyDeletes(entries, null)).toEqual(entries);
		});

		it("drops entries matching a delete rule but does NOT apply edits", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "hi", timestamp: "t0" }],
				// This edit must NOT change the surviving entry's content here
				// — that's the whole point of applyDeletes.
				edits: [
					{
						role: "assistant",
						content: "hello",
						timestamp: "t1",
						newContent: "EDITED",
					},
				],
			};
			const result = applyDeletes(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["hello", "how are you"]);
			// Edited entry keeps its RAW content — proves identities derived
			// from applyDeletes anchor to the unchanged source value.
			expect(result[0].content).toBe("hello");
		});

		it("preserves positional alignment with applyOverlay (same length and order)", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "s",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "how are you", timestamp: "t2" }],
				edits: [
					{
						role: "human",
						content: "hi",
						timestamp: "t0",
						newContent: "HEY",
					},
				],
			};
			const displayed = applyOverlay(entries, overlay);
			const rawByIndex = applyDeletes(entries, overlay);
			expect(displayed.length).toBe(rawByIndex.length);
			// Same role+timestamp tuple at every index — the only difference
			// is `displayed[i].content` may carry the edit's newContent.
			for (let i = 0; i < displayed.length; i++) {
				expect(displayed[i].role).toBe(rawByIndex[i].role);
				expect(displayed[i].timestamp).toBe(rawByIndex[i].timestamp);
			}
		});
	});

	// ─── Chained edits round-trip (Critical fix verification) ─────────────
	// The "second edit silently no-ops" bug: a save-edit, reload, save-edit
	// sequence on the same source entry was producing two side-by-side
	// edit rules anchored to different contents; applyOverlay would always
	// match the first rule and the user's most recent edit would never
	// render. Identities now derive from raw source content (applyDeletes
	// view) and mergeOverlay treats the new rule as a replacement.
	describe("chained edits", () => {
		const raw: ReadonlyArray<TranscriptEntry> = [
			{ role: "human", content: "X", timestamp: "t0" },
			{ role: "assistant", content: "Y-source", timestamp: "t1" },
		];

		it("second edit on the same entry replaces the first, not stacked", async () => {
			// First save: edit assistant "Y-source" → "v1"
			const firstSaved = mergeOverlay(null, {
				deletes: [],
				edits: [
					{
						role: "assistant",
						content: "Y-source",
						timestamp: "t1",
						newContent: "v1",
					},
				],
			});
			await saveOverlay({ projectDir, source: "claude", sessionId: "chain" }, firstSaved);
			let stored = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "chain",
			});
			// After-reload displayed view: shows v1
			expect(applyOverlay(raw, stored).map((e) => e.content)).toEqual(["X", "v1"]);

			// User edits again. handleSaveOverrides now derives identity from
			// applyDeletes(raw, stored) — the *raw* entry at the same display
			// index, NOT the edited view's "v1".
			const rawByIndex = applyDeletes(raw, stored);
			const targetEntry = rawByIndex[1]; // assistant Y-source @ t1
			expect(targetEntry.content).toBe("Y-source");

			const secondSaved = mergeOverlay(stored, {
				deletes: [],
				edits: [
					{
						role: targetEntry.role,
						content: targetEntry.content,
						timestamp: targetEntry.timestamp,
						newContent: "v2",
					},
				],
			});
			await saveOverlay({ projectDir, source: "claude", sessionId: "chain" }, secondSaved);
			stored = await loadOverlay({
				projectDir,
				source: "claude",
				sessionId: "chain",
			});
			// Bug repro: if mergeOverlay had kept both rules, applyOverlay
			// would return "v1" because the first rule wins. Fixed: stored
			// has exactly ONE edit for this identity and it carries "v2".
			expect(stored?.edits.length).toBe(1);
			expect(applyOverlay(raw, stored).map((e) => e.content)).toEqual(["X", "v2"]);
		});
	});

	// ─── Identity collision diagnostics (Important #7) ────────────────────
	// Two physically distinct entries sharing the same (role, content, ts)
	// — most commonly a retried prompt within the timestamp's resolution.
	// `findMatchingEdit` returns the first match deterministically; the
	// remaining matches become inert. We don't assert on log output here
	// (would couple the test to the logger), but we do pin that the
	// behavior is "first edit wins" so a future refactor that changes the
	// resolution strategy trips this test.
	describe("identity collision", () => {
		// Same collision case as the next test but where the colliding rules
		// lack a timestamp — exercises the `first.timestamp ?? "no-ts"`
		// nullish-coalescing default in the warn log.
		it("collision warn handles rules that lack a timestamp", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "collision-no-ts",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [
					{ role: "human", content: "ping", newContent: "first" },
					{ role: "human", content: "ping", newContent: "second" },
				],
			};
			const entries: ReadonlyArray<TranscriptEntry> = [
				{ role: "human", content: "ping" },
				{ role: "human", content: "ping" },
			];
			const result = applyOverlay(entries, overlay);
			// First-wins semantics still hold; the log line's "no-ts"
			// placeholder is exercised on the fired warn.
			expect(result.map((e) => e.content)).toEqual(["first", "first"]);
		});

		it("applies the first matching edit when multiple identical edits target the same identity", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "collision",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [],
				edits: [
					{ role: "human", content: "ping", timestamp: "t0", newContent: "first" },
					{ role: "human", content: "ping", timestamp: "t0", newContent: "second" },
				],
			};
			const entries: ReadonlyArray<TranscriptEntry> = [
				{ role: "human", content: "ping", timestamp: "t0" },
				{ role: "human", content: "ping", timestamp: "t0" },
			];
			const result = applyOverlay(entries, overlay);
			// First-wins: both physical entries get "first", second rule inert.
			expect(result.map((e) => e.content)).toEqual(["first", "first"]);
		});

		// Regression for the Copilot Chat patch-log timestamp fix: once entries
		// carry per-request timestamps, two physically distinct turns whose
		// (role, content) collide are still isolated — sameIdentity falls into
		// the strict timestamp-equality branch and a delete/edit rule keyed by
		// one timestamp matches only that one entry, not all role+content
		// duplicates.
		it("delete rule with timestamp only affects the matching turn, not other duplicates", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "copilot-chat",
				sessionId: "ts-isolated",
				updatedAt: "2026-05-18T00:00:00Z",
				deletes: [{ role: "human", content: "continue", timestamp: "2026-05-18T09:01:00.000Z" }],
				edits: [],
			};
			const entries: ReadonlyArray<TranscriptEntry> = [
				{ role: "human", content: "continue", timestamp: "2026-05-18T09:00:00.000Z" },
				{ role: "assistant", content: "ok 1", timestamp: "2026-05-18T09:00:00.000Z" },
				{ role: "human", content: "continue", timestamp: "2026-05-18T09:01:00.000Z" },
				{ role: "assistant", content: "ok 2", timestamp: "2026-05-18T09:01:00.000Z" },
			];
			const result = applyOverlay(entries, overlay);
			// Only the second "continue" turn is deleted; the first survives.
			expect(result).toEqual([
				{ role: "human", content: "continue", timestamp: "2026-05-18T09:00:00.000Z" },
				{ role: "assistant", content: "ok 1", timestamp: "2026-05-18T09:00:00.000Z" },
				{ role: "assistant", content: "ok 2", timestamp: "2026-05-18T09:01:00.000Z" },
			]);
		});

		it("edit rule with timestamp only rewrites the matching turn, not other duplicates", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "copilot-chat",
				sessionId: "ts-edit-isolated",
				updatedAt: "2026-05-18T00:00:00Z",
				deletes: [],
				edits: [
					{
						role: "assistant",
						content: "same reply",
						timestamp: "2026-05-18T09:01:00.000Z",
						newContent: "edited reply",
					},
				],
			};
			const entries: ReadonlyArray<TranscriptEntry> = [
				{ role: "assistant", content: "same reply", timestamp: "2026-05-18T09:00:00.000Z" },
				{ role: "assistant", content: "same reply", timestamp: "2026-05-18T09:01:00.000Z" },
			];
			const result = applyOverlay(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["same reply", "edited reply"]);
		});

		it("delete rule against duplicated identity drops every match", () => {
			const overlay: ConversationOverlay = {
				version: 2,
				source: "claude",
				sessionId: "dupdrop",
				updatedAt: "2026-05-17T00:00:00Z",
				deletes: [{ role: "human", content: "ping", timestamp: "t0" }],
				edits: [],
			};
			const entries: ReadonlyArray<TranscriptEntry> = [
				{ role: "human", content: "ping", timestamp: "t0" },
				{ role: "assistant", content: "pong", timestamp: "t1" },
				{ role: "human", content: "ping", timestamp: "t0" },
			];
			const result = applyOverlay(entries, overlay);
			expect(result.map((e) => e.content)).toEqual(["pong"]);
		});
	});

	describe("pruneConsumedOverlayRules", () => {
		const sid = "session-prune";
		const overlayFile = () => overlayPath({ projectDir, source: "claude", sessionId: sid });

		it("removes rules whose identity matches an entry in the consumed slice", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [
						{ role: "human", content: "ask-A", timestamp: "t1" },
						{ role: "human", content: "ask-B", timestamp: "t2" },
					],
					edits: [{ role: "assistant", content: "raw-C", timestamp: "t3", newContent: "edited-C" }],
				},
			);

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [
					// matches the first delete rule by identity
					{ role: "human", content: "ask-A", timestamp: "t1" },
					// matches the edit rule by raw identity (NOT by newContent)
					{ role: "assistant", content: "raw-C", timestamp: "t3" },
					// ask-B is NOT in the slice → that delete rule must survive
				],
			};

			await pruneConsumedOverlayRules([session], projectDir);

			const remaining = await loadOverlay({ projectDir, source: "claude", sessionId: sid });
			expect(remaining?.deletes).toEqual([{ role: "human", content: "ask-B", timestamp: "t2" }]);
			expect(remaining?.edits).toEqual([]);
		});

		it("unlinks the overlay file when all rules are consumed", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [{ role: "human", content: "only", timestamp: "t1" }],
					edits: [],
				},
			);
			expect(existsSync(overlayFile())).toBe(true);

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [{ role: "human", content: "only", timestamp: "t1" }],
			};

			await pruneConsumedOverlayRules([session], projectDir);

			expect(existsSync(overlayFile())).toBe(false);
		});

		it("defaults source to 'claude' when the session shape omits it", async () => {
			// Overlay is saved under the 'claude' source; the session below has
			// no `source` field, so pruneOneSession must fall back to "claude"
			// (line 347 `s.source ?? "claude"`) to locate and prune it.
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{ deletes: [{ role: "human", content: "drop", timestamp: "t1" }], edits: [] },
			);
			expect(existsSync(overlayFile())).toBe(true);

			const session: OverlayableSession = {
				sessionId: sid,
				// no source field — must default to "claude"
				entries: [{ role: "human", content: "drop", timestamp: "t1" }],
			};
			await pruneConsumedOverlayRules([session], projectDir);

			// All rules consumed → file unlinked, proving the fallback found it.
			expect(existsSync(overlayFile())).toBe(false);
		});

		it("is a no-op when the overlay file does not exist", async () => {
			const session: OverlayableSession = {
				sessionId: "never-saved",
				source: "claude",
				entries: [{ role: "human", content: "x", timestamp: "t" }],
			};
			await expect(pruneConsumedOverlayRules([session], projectDir)).resolves.toBeUndefined();
		});

		it("does not re-write the file when nothing matched (idempotent, mtime stable)", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [{ role: "human", content: "ask-X", timestamp: "tX" }],
					edits: [],
				},
			);
			const path = overlayFile();
			const mtimeBefore = statSync(path).mtimeMs;

			// Wait long enough that a rewrite would change mtime measurably on
			// macOS/Linux (filesystem timestamp granularity is ms or coarser).
			await new Promise((r) => setTimeout(r, 20));

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [{ role: "human", content: "unrelated", timestamp: "tY" }],
			};
			await pruneConsumedOverlayRules([session], projectDir);

			expect(statSync(path).mtimeMs).toBe(mtimeBefore);
		});

		it("isolates per-session errors so one bad overlay does not abort the sweep", async () => {
			// Good overlay for s1 — should be pruned and the file unlinked.
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: "s1" },
				{ deletes: [{ role: "human", content: "ask", timestamp: "t1" }], edits: [] },
			);
			// Corrupt overlay for s2 — loadOverlay returns null, prune skips it.
			const s2Path = overlayPath({ projectDir, source: "claude", sessionId: "s2" });
			mkdirSync(dirname(s2Path), { recursive: true });
			writeFileSync(s2Path, "not json", "utf8");

			const sessions: ReadonlyArray<OverlayableSession> = [
				{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "ask", timestamp: "t1" }] },
				{ sessionId: "s2", source: "claude", entries: [] },
			];

			await pruneConsumedOverlayRules(sessions, projectDir);

			expect(existsSync(overlayPath({ projectDir, source: "claude", sessionId: "s1" }))).toBe(false);
			// Corrupt file is left alone — operator can inspect, and prune treats it
			// like "no overlay" (loadOverlay returned null).
			expect(existsSync(s2Path)).toBe(true);
		});
	});
});
