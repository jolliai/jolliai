import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import {
	type AiRelevanceEntry,
	type CommitExclusions,
	clearAiSelection,
	conversationKey,
	deleteSelectionFile,
	dismissAiExclusion,
	isEffectivelyExcluded,
	readAiSelection,
	readExclusions,
	setAllExcluded,
	setExcluded,
	writeAiSelection,
} from "./CommitSelectionStore.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdir(join(tmpdir(), `commit-sel-${Date.now()}-${Math.random()}`), {
		recursive: true,
	}).then((p) => p ?? "");
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function filePath(): string {
	return join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR, "commit-selection.json");
}

describe("CommitSelectionStore", () => {
	it("returns empty exclusions when the file is missing", async () => {
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(ex.plans.size).toBe(0);
		expect(ex.notes.size).toBe(0);
		expect(ex.references.size).toBe(0);
	});

	it("returns empty exclusions when the file is malformed", async () => {
		await writeFile(filePath(), "not json", "utf8");
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("setExcluded adds a conversation key and is readable", async () => {
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), true);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "abc"))).toBe(true);
	});

	it("setExcluded(false) removes an existing key", async () => {
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), true);
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), false);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "abc"))).toBe(false);
	});

	it("setAllExcluded bulk-adds the given keys for a kind", async () => {
		await setAllExcluded(cwd, "plans", ["p1", "p2", "p3"], true);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual(["p1", "p2", "p3"]);
	});

	it("setAllExcluded bulk-removes the given keys for a kind", async () => {
		await setAllExcluded(cwd, "plans", ["p1", "p2", "p3"], true);
		await setAllExcluded(cwd, "plans", ["p1", "p3"], false);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual(["p2"]);
	});

	it("conversationKey joins source and sessionId with a colon", () => {
		expect(conversationKey("claude", "abc")).toBe("claude:abc");
	});

	it("readExclusions rejects an unknown version", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 99, conversations: ["x"] }), "utf8");
		const ex: CommitExclusions = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(ex.references.size).toBe(0);
	});

	it("readExclusions transparently migrates a legacy v1 file (no entities field)", async () => {
		// v1 files predate the entities panel-level exclusion. They must read
		// back cleanly with an empty entities set so existing users don't lose
		// their plan/note/conversation exclusions on first upgrade.
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 1,
				conversations: ["claude:c1"],
				plans: ["p1"],
				notes: ["n1"],
			}),
			"utf8",
		);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has("claude:c1")).toBe(true);
		expect(ex.plans.has("p1")).toBe(true);
		expect(ex.notes.has("n1")).toBe(true);
		expect(ex.references.size).toBe(0);
	});

	it("setExcluded upgrades a v1 file to v2 on next write (entities round-trip)", async () => {
		// Plant a v1 file, then add a single entity exclusion. The next read
		// must surface entities and the on-disk version must be 2.
		await writeFile(
			filePath(),
			JSON.stringify({ version: 1, conversations: [], plans: ["p1"], notes: [] }),
			"utf8",
		);
		await setExcluded(cwd, "references", "jira:PROJ-1", true);
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("p1")).toBe(true);
		expect(ex.references.has("jira:PROJ-1")).toBe(true);
		const raw = JSON.parse(await (await import("node:fs/promises")).readFile(filePath(), "utf8"));
		expect(raw.version).toBe(2);
	});

	it("setExcluded round-trips entities independently of plans/notes/conversations", async () => {
		await setExcluded(cwd, "references", "jira:PROJ-1", true);
		await setExcluded(cwd, "references", "github:owner/repo#42", true);
		await setExcluded(cwd, "plans", "p1", true);
		const ex = await readExclusions(cwd);
		expect([...ex.references].sort()).toEqual(["github:owner/repo#42", "jira:PROJ-1"]);
		expect(ex.plans.has("p1")).toBe(true);
		expect(ex.notes.size).toBe(0);
	});

	it("setExcluded(false) removes an entity key", async () => {
		await setExcluded(cwd, "references", "linear:LIN-1", true);
		await setExcluded(cwd, "references", "linear:LIN-1", false);
		const ex = await readExclusions(cwd);
		expect(ex.references.has("linear:LIN-1")).toBe(false);
	});

	it("setAllExcluded bulk-adds entity keys", async () => {
		await setAllExcluded(cwd, "references", ["linear:A", "jira:B", "github:C", "notion:D"], true);
		const ex = await readExclusions(cwd);
		expect([...ex.references].sort()).toEqual(["github:C", "jira:B", "linear:A", "notion:D"]);
	});

	it("readExclusions coerces non-array fields to empty sets and filters out non-string entries", async () => {
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 2,
				conversations: "not-an-array",
				plans: [42, "p1", null, "p2"],
				notes: null,
				references: [7, "jira:X", false, "github:Y"],
			}),
			"utf8",
		);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(ex.notes.size).toBe(0);
		expect([...ex.plans].sort()).toEqual(["p1", "p2"]);
		expect([...ex.references].sort()).toEqual(["github:Y", "jira:X"]);
	});

	it("tolerates a stale conversation key that no longer exists", async () => {
		await setExcluded(cwd, "conversations", conversationKey("codex", "ghost"), true);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("codex", "ghost"))).toBe(true);
	});

	it("notes round-trip independently of plans", async () => {
		await setExcluded(cwd, "plans", "p1", true);
		await setExcluded(cwd, "notes", "n1", true);
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("p1")).toBe(true);
		expect(ex.notes.has("n1")).toBe(true);
		expect(ex.plans.has("n1")).toBe(false);
	});

	it("readExclusions returns empty and warns on non-ENOENT read failures", async () => {
		// Make the selection path itself a directory so readFile yields EISDIR
		// (a real non-ENOENT failure path) instead of "file missing".
		await mkdir(filePath(), { recursive: true });
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(ex.plans.size).toBe(0);
		expect(ex.notes.size).toBe(0);
	});

	it("deleteSelectionFile removes an existing file", async () => {
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), true);
		await deleteSelectionFile(cwd);
		// Re-reading should fall through the missing-file branch and yield empty.
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("deleteSelectionFile is a no-op when the file does not exist (ENOENT)", async () => {
		await expect(deleteSelectionFile(cwd)).resolves.toBeUndefined();
	});

	it("deleteSelectionFile swallows non-ENOENT unlink errors", async () => {
		// Make the selection path a directory so unlink yields EISDIR/EPERM —
		// the function should warn and resolve, not throw.
		await mkdir(filePath(), { recursive: true });
		await expect(deleteSelectionFile(cwd)).resolves.toBeUndefined();
	});

	it("concurrent setExcluded calls do not lose updates", async () => {
		// Fire ten setExcluded calls in parallel for distinct keys. With an
		// unlocked read-modify-write each call would race: later writes would
		// overwrite earlier ones and the persisted file would end up missing
		// some keys. After serialization all ten must survive.
		const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
		await Promise.all(keys.map((k) => setExcluded(cwd, "conversations", k, true)));
		const ex = await readExclusions(cwd);
		expect([...ex.conversations].sort()).toEqual(keys.sort());
	});

	it("concurrent setExcluded and setAllExcluded interleave safely", async () => {
		// Mix a bulk write with single-key writes. All keys must survive.
		const singles = ["s1", "s2", "s3"];
		const bulk = ["b1", "b2", "b3", "b4"];
		await Promise.all([
			...singles.map((k) => setExcluded(cwd, "plans", k, true)),
			setAllExcluded(cwd, "plans", bulk, true),
		]);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual([...singles, ...bulk].sort());
	});

	it("serialization chain recovers after a failed write", async () => {
		// A projectDir containing a NUL byte makes writeFile reject with
		// ERR_INVALID_ARG_VALUE — the failure must not poison subsequent
		// writes on a healthy projectDir. The chain swallows the error in
		// its bookkeeping so the next caller starts cleanly.
		const broken = `${cwd}/\0bad`;
		await expect(setExcluded(broken, "conversations", "x", true)).rejects.toThrow();
		await setExcluded(cwd, "conversations", "y", true);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has("y")).toBe(true);
	});

	it("cleans up the .tmp file when rename fails so the directory does not accumulate orphans", async () => {
		// Trigger a real rename failure by pre-creating the destination as a
		// directory — `rename(file, existing-dir)` fails with EISDIR on POSIX
		// and EPERM on Windows. The writeFile lands the .tmp on disk; the
		// rename throws; the production code's tmp-cleanup branch must unlink
		// it so the next retry doesn't leave a sibling Date.now()-suffixed
		// orphan behind.
		const dir = join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR);
		await mkdir(filePath(), { recursive: true }); // selection path = a directory

		await expect(setExcluded(cwd, "plans", "x", true)).rejects.toThrow();

		const orphans = (await readdir(dir)).filter((n) => n.startsWith("commit-selection.json.tmp"));
		expect(orphans).toEqual([]);
	});
});

describe("CommitSelectionStore — AI relevance layer", () => {
	const entry = (over: Partial<AiRelevanceEntry> = {}): AiRelevanceEntry => ({
		kind: "plans",
		key: "p1",
		tier: "low",
		reason: "unrelated",
		excluded: true,
		...over,
	});

	it("readAiSelection returns an empty layer when the file is missing", async () => {
		const ai = await readAiSelection(cwd);
		expect(ai.aiRelevance).toEqual([]);
		expect(ai.changeFingerprint).toBeUndefined();
	});

	it("writeAiSelection persists the full ranking + fingerprint, readable via readAiSelection", async () => {
		const entries = [
			entry({ kind: "plans", key: "p1", tier: "high", reason: "plan lists changed files", excluded: false }),
			entry({
				kind: "references",
				key: "linear:X-1",
				tier: "low",
				reason: "different subsystem",
				excluded: true,
			}),
		];
		await writeAiSelection(cwd, entries, "fp-abc");
		const ai = await readAiSelection(cwd);
		expect(ai.aiRelevance).toEqual(entries);
		expect(ai.changeFingerprint).toBe("fp-abc");
	});

	it("writeAiSelection does not disturb the user manual exclude set", async () => {
		await setExcluded(cwd, "plans", "manual", true);
		await writeAiSelection(cwd, [entry({ kind: "notes", key: "n1" })], "fp");
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("manual")).toBe(true);
		expect((await readAiSelection(cwd)).aiRelevance).toHaveLength(1);
	});

	it("dismissAiExclusion sets the dismissed flag IN PLACE — the AI's verdict survives", async () => {
		await writeAiSelection(
			cwd,
			[entry({ kind: "references", key: "linear:X-1" }), entry({ kind: "plans", key: "p1" })],
			"fp-1",
		);
		await dismissAiExclusion(cwd, "references", "linear:X-1");
		const ai = await readAiSelection(cwd);
		// The entry is still there with its original tier + reason + excluded
		// judgment; only the user's veto was added. The other entry + the
		// fingerprint are untouched.
		expect(ai.aiRelevance).toEqual([
			entry({ kind: "references", key: "linear:X-1", dismissed: true }),
			entry({ kind: "plans", key: "p1" }),
		]);
		expect(ai.changeFingerprint).toBe("fp-1");
		expect(isEffectivelyExcluded(ai.aiRelevance[0])).toBe(false);
		expect(isEffectivelyExcluded(ai.aiRelevance[1])).toBe(true);
	});

	it("dismissAiExclusion is idempotent and a harmless no-op for unknown keys / empty layer", async () => {
		await setExcluded(cwd, "plans", "manual", true);
		await dismissAiExclusion(cwd, "plans", "ghost");
		expect((await readAiSelection(cwd)).aiRelevance).toEqual([]);
		await writeAiSelection(cwd, [entry()], "fp");
		await dismissAiExclusion(cwd, "plans", "p1");
		await dismissAiExclusion(cwd, "plans", "p1");
		expect((await readAiSelection(cwd)).aiRelevance).toEqual([entry({ dismissed: true })]);
		expect((await readExclusions(cwd)).plans.has("manual")).toBe(true);
	});

	it("clearAiSelection wipes the AI layer but keeps the user manual excludes", async () => {
		await setExcluded(cwd, "plans", "kept-exclude", true);
		await writeAiSelection(cwd, [entry()], "fp-1");
		await clearAiSelection(cwd);
		const ai = await readAiSelection(cwd);
		expect(ai.aiRelevance).toEqual([]);
		expect(ai.changeFingerprint).toBeUndefined();
		const raw = JSON.parse(await readFile(filePath(), "utf8"));
		expect(raw.aiRelevance).toBeUndefined();
		// The user's manual exclude survives — clearAiSelection only touches the AI layer.
		expect((await readExclusions(cwd)).plans.has("kept-exclude")).toBe(true);
	});

	it("keeps the file shape unchanged (no new keys) when no AI data is written", async () => {
		await setExcluded(cwd, "plans", "p1", true);
		const raw = JSON.parse(await readFile(filePath(), "utf8"));
		expect(raw.version).toBe(2);
		expect(Object.keys(raw).sort()).toEqual(["conversations", "notes", "plans", "references", "version"]);
	});

	it("writeAiSelection without a fingerprint clears any previously stored one", async () => {
		await writeAiSelection(cwd, [entry()], "fp-old");
		await writeAiSelection(cwd, [entry()]);
		expect((await readAiSelection(cwd)).changeFingerprint).toBeUndefined();
	});

	it("coerces a non-array aiRelevance to empty on read", async () => {
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 2,
				conversations: [],
				plans: [],
				notes: [],
				references: [],
				aiRelevance: "garbage",
			}),
			"utf8",
		);
		expect((await readAiSelection(cwd)).aiRelevance).toEqual([]);
	});

	it("drops malformed aiRelevance entries on read (bad kind / tier / missing fields); a stray dismissed value coerces to absent", async () => {
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 2,
				conversations: [],
				plans: [],
				notes: [],
				references: [],
				aiRelevance: [
					{ kind: "plans", key: "ok", tier: "high", reason: "r", excluded: false },
					{ kind: "plans", key: "ok2", tier: "low", reason: "r", excluded: true, dismissed: true },
					{ kind: "plans", key: "ok3", tier: "low", reason: "r", excluded: true, dismissed: "yes" },
					{ kind: "bogus", key: "x", tier: "high", reason: "r", excluded: true },
					{ kind: "notes", key: "n", tier: "extreme", reason: "r", excluded: true },
					{ kind: "notes", key: "n2", tier: "low", reason: "r" },
					"garbage",
					null,
				],
			}),
			"utf8",
		);
		expect((await readAiSelection(cwd)).aiRelevance).toEqual([
			{ kind: "plans", key: "ok", tier: "high", reason: "r", excluded: false },
			{ kind: "plans", key: "ok2", tier: "low", reason: "r", excluded: true, dismissed: true },
			{ kind: "plans", key: "ok3", tier: "low", reason: "r", excluded: true },
		]);
	});

	it("forward-compat: legacy userIncluded / aiSuggestedExclude / aiRelevanceResults keys are ignored", async () => {
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 2,
				conversations: ["c1"],
				plans: ["p1"],
				notes: [],
				references: [],
				userIncluded: { plans: ["kept"] },
				aiSuggestedExclude: [{ kind: "plans", key: "p1", reason: "x" }],
				aiRelevanceResults: [{ kind: "plans", key: "p1", tier: "low", reason: "x" }],
				changeFingerprint: "fp",
			}),
			"utf8",
		);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has("c1")).toBe(true);
		expect(ex.plans.has("p1")).toBe(true);
		// The legacy two-list keys are dropped from the model — the AI layer reads
		// empty (one fallback re-rank), while the fingerprint passes through.
		const ai = await readAiSelection(cwd);
		expect(ai.aiRelevance).toEqual([]);
		expect(ai.changeFingerprint).toBe("fp");
	});
});
