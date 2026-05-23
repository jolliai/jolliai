/**
 * Tests for ConflictResolver — Tier 2 + Tier 3 conflict pyramid.
 *
 * `GitClient` and `ConflictUi` are stubbed; we don't shell out to git.
 * The Tier 2 path exercises the output guards (markers, length, JSON parse,
 * confidence) and the LLM failure → escalation. The Tier 3 path exercises
 * each of the four UI picks plus the viewDiff re-prompt loop.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type AiMergeProvider,
	type AiMergeRequest,
	type AiMergeResponse,
	ConflictResolver,
	type ConflictUi,
	classifyDeleteVsModify,
	emptyAggregateEnvelope,
	isAggregatePath,
	isMemoryBankAppendOnlyPath,
	type Tier3Pick,
	tryAggregateMerge,
	unionMarkdown,
} from "./ConflictResolver.js";
import type { GitClient } from "./GitClient.js";

/** Builds a stubbed GitClient backed by an in-memory map of stages + a writes log. */
interface StubVault {
	client: GitClient;
	stages: Map<string, { 1?: string | null; 2?: string | null; 3?: string | null }>;
	added: string[];
	removed: string[];
	checkoutsOurs: string[];
	checkoutsTheirs: string[];
	continued: number;
	aborted: number;
}

function makeStubVault(initialStages?: StubVault["stages"]): StubVault {
	const stages = initialStages ?? new Map();
	const stub: StubVault = {
		client: {} as GitClient,
		stages,
		added: [],
		removed: [],
		checkoutsOurs: [],
		checkoutsTheirs: [],
		continued: 0,
		aborted: 0,
	};
	const client = {
		readIndexStage: async (path: string, stage: 1 | 2 | 3) => {
			return stub.stages.get(path)?.[stage] ?? null;
		},
		addPath: async (path: string) => {
			stub.added.push(path);
		},
		removePath: async (path: string) => {
			stub.removed.push(path);
		},
		checkoutOurs: async (path: string) => {
			stub.checkoutsOurs.push(path);
		},
		checkoutTheirs: async (path: string) => {
			stub.checkoutsTheirs.push(path);
		},
		rebaseContinue: async () => {
			stub.continued++;
		},
		rebaseAbort: async () => {
			stub.aborted++;
		},
		// Unused methods — present so the GitClient cast holds.
		stageAll: async () => {},
		clone: async () => {},
		fetch: async () => {},
		pullRebase: async () => ({ fastForwarded: false, conflicted: [] }),
		commit: async () => "deadbeef",
		push: async () => ({ ok: true as const, transmitted: true }),
		currentBranch: async () => "main",
		currentHead: async () => "deadbeef",
		hasUnmergedPaths: async () => [],
		checkGitInstalled: async () => ({ ok: true as const, version: "git version stub" }),
	} as unknown as GitClient;
	stub.client = client;
	return stub;
}

function makeStubUi(seq: Tier3Pick[]): { ui: ConflictUi; viewDiffCalls: string[] } {
	const queue = [...seq];
	const viewDiffCalls: string[] = [];
	const ui: ConflictUi = {
		promptBinaryPick: async () => {
			const next = queue.shift();
			if (next === undefined) return "skip";
			return next;
		},
		showDiff: async (path) => {
			viewDiffCalls.push(path);
		},
	};
	return { ui, viewDiffCalls };
}

describe("ConflictResolver — Tier 2 happy path", () => {
	it("AI-merges a path when guards pass", async () => {
		const stub = makeStubVault(
			new Map([["notes/foo.md", { 1: "base", 2: "alpha line\nmore", 3: "alpha line\nedited" }]]),
		);
		const ai: AiMergeProvider = {
			merge: async (req) => ({
				merged: `${req.ours}\nMERGED`,
				confidence: 0.9,
				model: "claude-sonnet-4-6",
			}),
		};
		const writes: { path: string; contents: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai,
			ui: makeStubUi([]).ui,
			writeFile: async (p, c) => {
				writes.push({ path: p, contents: c });
			},
		});

		const report = await resolver.resolveAll(["notes/foo.md"]);
		expect(report.aiMerged).toEqual([{ path: "notes/foo.md", model: "claude-sonnet-4-6" }]);
		expect(report.binaryPicked).toEqual([]);
		expect(report.skipped).toEqual([]);
		expect(report.rebaseAdvanced).toBe(true);
		expect(stub.added).toEqual(["notes/foo.md"]);
		expect(stub.continued).toBe(1);
		expect(writes).toEqual([{ path: "notes/foo.md", contents: "alpha line\nmore\nMERGED" }]);
	});

	it("JSON merges are parsed for validity before commit", async () => {
		const stub = makeStubVault(new Map([["a3f2c1/main/index.json", { 1: "{}", 2: '{"a":1}', 3: '{"b":2}' }]]));
		const ai: AiMergeProvider = {
			merge: async () => ({
				merged: '{"a":1,"b":2}',
				confidence: 0.9,
				model: "m",
			}),
		};
		const resolver = new ConflictResolver({
			client: stub.client,
			ai,
			ui: makeStubUi([]).ui,
			writeFile: async () => {},
		});

		const report = await resolver.resolveAll(["a3f2c1/main/index.json"]);
		expect(report.aiMerged).toHaveLength(1);
	});
});

describe("ConflictResolver — Tier 2 guards", () => {
	const setupGuardScenario = (guardOverride: Partial<AiMergeResponse>, fileKind: "md" | "json" = "md") => {
		const path = fileKind === "json" ? "f.json" : "f.md";
		const stub = makeStubVault(new Map([[path, { 1: "base", 2: "abc", 3: "def" }]]));
		const ui = makeStubUi(["mine"]);
		const ai: AiMergeProvider = {
			merge: async () => ({
				merged: "ok",
				confidence: 0.9,
				model: "m",
				...guardOverride,
			}),
		};
		return new ConflictResolver({
			client: stub.client,
			ai,
			ui: ui.ui,
			writeFile: async () => {},
			minConfidence: 0.6,
			// These guard tests assert "Tier 2 fail → UI gets prompted, user
			// picks mine" — that means the legacy `prompt` policy. The new
			// default `newest` skips the UI entirely; keep the prompt
			// contract for this suite.
			policy: "prompt",
		})
			.resolveAll([path])
			.then((report) => ({ report, stub, ui }));
	};

	it("rejects merge with conflict markers and escalates to Tier 3", async () => {
		const { report, stub } = await setupGuardScenario({ merged: "before\n<<<<<<<\nmid\n=======\n>>>>>>>\nafter" });
		expect(report.aiMerged).toEqual([]);
		expect(report.binaryPicked).toEqual([{ path: "f.md", pick: "mine" }]);
		expect(stub.checkoutsOurs).toEqual(["f.md"]);
	});

	it("rejects merge below confidence threshold", async () => {
		const { report } = await setupGuardScenario({ confidence: 0.3 });
		expect(report.aiMerged).toEqual([]);
		expect(report.binaryPicked).toHaveLength(1);
	});

	it("rejects merge that's too short relative to inputs", async () => {
		// max(|abc|, |def|) = 3, MIN_RATIO = 0.5 → min len = 1.5 → '' should be rejected
		// but '' has length 0 < 1.5. Let's use a single char.
		const { report } = await setupGuardScenario({ merged: "" });
		expect(report.aiMerged).toEqual([]);
	});

	it("rejects merge that's too long relative to inputs", async () => {
		// max=3, MAX_RATIO=4 → max len = 12. Use 30 chars.
		const { report } = await setupGuardScenario({ merged: "x".repeat(30) });
		expect(report.aiMerged).toEqual([]);
	});

	it("rejects JSON merge that doesn't parse", async () => {
		// Length must fall WITHIN the min/max window so the JSON-parse guard
		// (line 230) is actually reached. ours/theirs are 3 chars → window is
		// [1.5, 12]; pick 6 chars of invalid JSON.
		const { report } = await setupGuardScenario({ merged: "{bad-" }, "json");
		expect(report.aiMerged).toEqual([]);
	});

	it("escalates when the LLM throws", async () => {
		const stub = makeStubVault(new Map([["x.md", { 1: "b", 2: "abc", 3: "def" }]]));
		const ui = makeStubUi(["theirs"]);
		const ai: AiMergeProvider = {
			merge: async () => {
				throw new Error("quota");
			},
		};
		const resolver = new ConflictResolver({
			client: stub.client,
			ai,
			ui: ui.ui,
			writeFile: async () => {},
		});
		const report = await resolver.resolveAll(["x.md"]);
		expect(report.aiMerged).toEqual([]);
		expect(report.binaryPicked).toEqual([{ path: "x.md", pick: "theirs" }]);
		expect(stub.checkoutsTheirs).toEqual(["x.md"]);
	});
});

describe("ConflictResolver — Tier 2 skipped when ai is null", () => {
	it("falls straight to Tier 3 when ai === null", async () => {
		const stub = makeStubVault(new Map([["a.md", { 1: "base", 2: "x", 3: "y" }]]));
		const ui = makeStubUi(["mine"]);
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: ui.ui,
		});
		const report = await resolver.resolveAll(["a.md"]);
		expect(report.aiMerged).toEqual([]);
		expect(report.binaryPicked).toEqual([{ path: "a.md", pick: "mine" }]);
	});

	it("does not call AI when ours stage is missing — Tier 2.7 rule 3 (base==null) accepts peer's add", async () => {
		// Stage :2: missing AND base missing = file never existed locally,
		// peer added it. The base-aware Rule 3 accepts the add (no local
		// delete to respect). LLM is bypassed because Tier 2 itself
		// requires both stages present.
		const stub = makeStubVault(new Map([["a.md", { 3: "y" }]]));
		const ui = makeStubUi([]);
		const ai: AiMergeProvider = {
			merge: vi.fn(async () => ({ merged: "x", confidence: 0.9, model: "m" })),
		};
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai,
			ui: ui.ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
			policy: "prompt",
		});
		const report = await resolver.resolveAll(["a.md"]);
		expect(report.resolved).toContain("a.md");
		expect(report.binaryPicked).toEqual([]);
		expect(writes[0]?.merged).toBe("y");
		expect(ai.merge).not.toHaveBeenCalled();
	});
});

describe("ConflictResolver — Tier 3 viewDiff loop", () => {
	it("loops on viewDiff and shows the diff, then accepts the next pick", async () => {
		const stub = makeStubVault(new Map([["a.md", { 1: "b", 2: "ours", 3: "theirs" }]]));
		const seq: Tier3Pick[] = ["viewDiff", "viewDiff", "mine"];
		const ui = makeStubUi(seq);
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui: ui.ui });
		const report = await resolver.resolveAll(["a.md"]);
		expect(ui.viewDiffCalls).toEqual(["a.md", "a.md"]);
		expect(report.binaryPicked).toEqual([{ path: "a.md", pick: "mine" }]);
	});

	it("safely skips showDiff when both stages are present but the UI has no showDiff", async () => {
		// Both stages present (so Tier 2.7 delete-vs-modify does NOT fire)
		// and differing content (so identical-after-normalize doesn't fire).
		// User clicks viewDiff first; UI has no showDiff → loop ignores the
		// diff call gracefully and re-prompts. Second click is the real pick.
		const stub = makeStubVault(new Map([["a.md", { 1: "b", 2: "alpha\n", 3: "beta\n" }]]));
		const ui: ConflictUi = {
			promptBinaryPick: vi
				.fn<ConflictUi["promptBinaryPick"]>()
				.mockResolvedValueOnce("viewDiff")
				.mockResolvedValueOnce("mine"),
			// showDiff intentionally absent
		};
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui, policy: "prompt" });
		const report = await resolver.resolveAll(["a.md"]);
		expect(report.binaryPicked).toEqual([{ path: "a.md", pick: "mine" }]);
	});
});

describe("ConflictResolver — skip aborts the rebase", () => {
	it("any skip pick triggers rebase --abort", async () => {
		const stub = makeStubVault(
			new Map([
				["a.md", { 2: "x", 3: "y" }],
				["b.md", { 2: "x", 3: "y" }],
			]),
		);
		const ui = makeStubUi(["mine", "skip"]);
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui: ui.ui });
		const report = await resolver.resolveAll(["a.md", "b.md"]);
		expect(report.skipped).toEqual(["b.md"]);
		expect(report.rebaseAdvanced).toBe(false);
		expect(stub.continued).toBe(0);
		expect(stub.aborted).toBe(1);
	});
});

describe("isAggregatePath", () => {
	it("recognizes the four canonical aggregate files", () => {
		expect(isAggregatePath(".jolli/manifest.json")).toBe(true);
		expect(isAggregatePath(".jolli/index.json")).toBe(true);
		expect(isAggregatePath(".jolli/branches.json")).toBe(true);
		expect(isAggregatePath(".jolli/catalog.json")).toBe(true);
	});

	it("rejects everything else (including .jolli/summaries/*)", () => {
		expect(isAggregatePath(".jolli/summaries/abcdef0.json")).toBe(false);
		expect(isAggregatePath(".jolli/config.json")).toBe(false);
		expect(isAggregatePath("manifest.json")).toBe(false); // missing prefix
		expect(isAggregatePath("notes/foo.md")).toBe(false);
	});

	it("recognizes per-repo aggregate paths under <repoFolder>/.jolli/ (§0.13 layout)", () => {
		// Plan §0.13 placed per-repo content directly under `<repoFolder>/`.
		// The aggregate files moved with it. Pre-fix, exact-string match
		// against `.jolli/manifest.json` missed these paths and the engine
		// fell through to Tier 3 (UI prompt) — caught only by the acceptance
		// suite (test 12).
		expect(isAggregatePath("test-repo/.jolli/manifest.json")).toBe(true);
		expect(isAggregatePath("test-repo/.jolli/index.json")).toBe(true);
		expect(isAggregatePath("test-repo/.jolli/branches.json")).toBe(true);
		expect(isAggregatePath("test-repo/.jolli/catalog.json")).toBe(true);
		// `repos.json` is global (root only), NOT per-repo. The per-repo
		// path form must NOT collide with the global mapping.
		expect(isAggregatePath("test-repo/.jolli/repos.json")).toBe(false);
	});

	it("still recognizes legacy root-level aggregate paths (.jolli/<name>.json)", () => {
		// Older repos on the orphan branch may still carry root-level
		// aggregate files. The basename check covers both layouts.
		expect(isAggregatePath(".jolli/manifest.json")).toBe(true);
	});
});

describe("tryAggregateMerge", () => {
	it("merges manifest.json envelopes via mergeManifest", () => {
		const ours = JSON.stringify({
			version: 1,
			files: [
				{
					path: "a.md",
					fileId: "a",
					type: "commit",
					fingerprint: "fp",
					title: "A",
					source: { commitHash: "c", branch: "main", generatedAt: "2026-05-01T00:00:00Z" },
				},
			],
		});
		const theirs = JSON.stringify({
			version: 1,
			files: [
				{
					path: "b.md",
					fileId: "b",
					type: "commit",
					fingerprint: "fp",
					title: "B",
					source: { commitHash: "c", branch: "main", generatedAt: "2026-05-01T00:00:00Z" },
				},
			],
		});
		const out = tryAggregateMerge(".jolli/manifest.json", ours, theirs);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out as string);
		expect(parsed.version).toBe(1);
		expect(parsed.files.map((f: { fileId: string }) => f.fileId).sort()).toEqual(["a", "b"]);
	});

	it("merges index.json envelopes via mergeIndex", () => {
		const ours = JSON.stringify({ version: 3, entries: [] });
		const theirs = JSON.stringify({
			version: 3,
			entries: [
				{
					commitHash: "c1",
					parentCommitHash: null,
					treeHash: "t",
					commitType: "commit",
					commitMessage: "m",
					commitDate: "2026-05-01T00:00:00Z",
					branch: "main",
					generatedAt: "2026-05-01T00:00:00Z",
				},
			],
		});
		const out = tryAggregateMerge(".jolli/index.json", ours, theirs);
		const parsed = JSON.parse(out as string);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].commitHash).toBe("c1");
	});

	it("merges branches.json envelopes via mergeBranches", () => {
		const ours = JSON.stringify({
			version: 1,
			mappings: [{ folder: "main", branch: "main", createdAt: "2026-05-01T00:00:00Z" }],
		});
		const theirs = JSON.stringify({
			version: 1,
			mappings: [{ folder: "feat-x", branch: "feat/x", createdAt: "2026-05-01T00:00:00Z" }],
		});
		const out = tryAggregateMerge(".jolli/branches.json", ours, theirs);
		const parsed = JSON.parse(out as string);
		expect(parsed.mappings).toHaveLength(2);
	});

	it("merges catalog.json envelopes via mergeCatalog", () => {
		const ours = JSON.stringify({
			version: 1,
			entries: [{ commitHash: "c1", recap: "r", ticketId: "T", topics: [] }],
		});
		const theirs = JSON.stringify({
			version: 1,
			entries: [{ commitHash: "c2", recap: "r2", ticketId: "T", topics: [] }],
		});
		const out = tryAggregateMerge(".jolli/catalog.json", ours, theirs);
		const parsed = JSON.parse(out as string);
		expect(parsed.entries.map((e: { commitHash: string }) => e.commitHash).sort()).toEqual(["c1", "c2"]);
	});

	it("returns null when either side is not valid JSON (falls back to Tier 2/3)", () => {
		expect(tryAggregateMerge(".jolli/manifest.json", "not json", "{}")).toBeNull();
		expect(tryAggregateMerge(".jolli/manifest.json", "{}", "broken")).toBeNull();
	});

	it("returns null when the envelope shape doesn't have the expected array", () => {
		const validShape = '{"version":1,"files":[]}';
		const wrongShape = '{"version":1,"items":[]}'; // wrong key
		expect(tryAggregateMerge(".jolli/manifest.json", validShape, wrongShape)).toBeNull();
	});

	it("emits canonical 2-space-indented JSON ending with newline", () => {
		const empty = '{"version":1,"files":[]}';
		const out = tryAggregateMerge(".jolli/manifest.json", empty, empty);
		expect(out).toBe('{\n  "version": 1,\n  "files": []\n}\n');
	});

	it("merges .jolli/repos.json via mergeRepoMappingDoc (REPO_MAPPING_PATH branch)", () => {
		const ours = JSON.stringify({
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/x/a", folder: "a" }],
		});
		const theirs = JSON.stringify({
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/x/b", folder: "b" }],
		});
		const out = tryAggregateMerge(".jolli/repos.json", ours, theirs);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out as string);
		expect(parsed.version).toBe(1);
		expect(parsed.mappings.map((m: { folder: string }) => m.folder).sort()).toEqual(["a", "b"]);
	});

	it("returns null when .jolli/repos.json side fails to parse as a RepoMapping envelope", () => {
		// Both sides are valid JSON but one has a wrong shape — mergeRepoMappingDoc
		// must reject so the caller falls back to Tier 2/3 rather than corrupt
		// the mapping file.
		const valid = JSON.stringify({ version: 1, mappings: [] });
		const wrongShape = JSON.stringify({ version: 1, items: [] });
		expect(tryAggregateMerge(".jolli/repos.json", valid, wrongShape)).toBeNull();
		expect(tryAggregateMerge(".jolli/repos.json", wrongShape, valid)).toBeNull();
	});
});

describe("emptyAggregateEnvelope", () => {
	// Tier 1.5 uses these stand-ins when one side of the conflict deleted the
	// file. Each envelope's shape must satisfy the corresponding merger's
	// `Array.isArray(...)` check so the deterministic merge proceeds instead
	// of dropping to Tier 3.
	it("returns the repos.json empty envelope", () => {
		expect(emptyAggregateEnvelope(".jolli/repos.json")).toBe('{"version":1,"mappings":[]}');
	});

	it("returns the manifest empty envelope", () => {
		expect(emptyAggregateEnvelope("repo-a/.jolli/manifest.json")).toBe('{"version":1,"files":[]}');
	});

	it("returns the index empty envelope", () => {
		expect(emptyAggregateEnvelope("repo-a/.jolli/index.json")).toBe('{"version":3,"entries":[]}');
	});

	it("returns the branches empty envelope", () => {
		expect(emptyAggregateEnvelope("repo-a/.jolli/branches.json")).toBe('{"version":1,"mappings":[]}');
	});

	it("returns the catalog empty envelope", () => {
		expect(emptyAggregateEnvelope("repo-a/.jolli/catalog.json")).toBe('{"version":1,"entries":[]}');
	});
});

describe("ConflictResolver — Tier 1.5 aggregate auto-merge", () => {
	it("auto-merges .jolli/manifest.json without invoking Tier 2 or Tier 3", async () => {
		const ours = JSON.stringify({
			version: 1,
			files: [
				{
					path: "a.md",
					fileId: "a",
					type: "commit",
					fingerprint: "fp",
					title: "A",
					source: { commitHash: "c", branch: "main", generatedAt: "2026-05-01T00:00:00Z" },
				},
			],
		});
		const theirs = JSON.stringify({
			version: 1,
			files: [
				{
					path: "b.md",
					fileId: "b",
					type: "commit",
					fingerprint: "fp",
					title: "B",
					source: { commitHash: "c", branch: "main", generatedAt: "2026-05-01T00:00:00Z" },
				},
			],
		});
		const stub = makeStubVault(new Map([[".jolli/manifest.json", { 1: null, 2: ours, 3: theirs }]]));
		const aiMerge = vi.fn(async () => ({ merged: "", confidence: 1, model: "m" }));
		const ui: ConflictUi = { promptBinaryPick: vi.fn(async () => "skip" as Tier3Pick) };

		const writes: { path: string; content: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: { merge: aiMerge },
			ui,
			writeFile: async (path, content) => {
				writes.push({ path, content });
			},
		});

		const report = await resolver.resolveAll([".jolli/manifest.json"]);
		expect(report.rebaseAdvanced).toBe(true);
		expect(report.aggregateMerged).toEqual([".jolli/manifest.json"]);
		expect(report.aiMerged).toHaveLength(0);
		expect(report.binaryPicked).toHaveLength(0);
		expect(report.skipped).toHaveLength(0);
		expect(aiMerge).not.toHaveBeenCalled();
		expect(ui.promptBinaryPick).not.toHaveBeenCalled();

		// Merged content must contain both file ids.
		expect(writes).toHaveLength(1);
		const parsed = JSON.parse(writes[0]?.content as string);
		expect(parsed.files.map((f: { fileId: string }) => f.fileId).sort()).toEqual(["a", "b"]);
		expect(stub.added).toEqual([".jolli/manifest.json"]);
		expect(stub.continued).toBe(1);
	});

	it("mixes Tier 1.5 (aggregate) and Tier 2 (regular file) cleanly", async () => {
		const oursManifest = '{"version":1,"files":[]}';
		const theirsManifest = '{"version":1,"files":[]}';
		const stub = makeStubVault(
			new Map([
				[".jolli/manifest.json", { 1: null, 2: oursManifest, 3: theirsManifest }],
				["notes/foo.md", { 1: "base", 2: "ours-md", 3: "theirs-md" }],
			]),
		);
		const aiMerge = vi.fn(
			async (req: AiMergeRequest): Promise<AiMergeResponse> => ({
				merged: `${req.ours}\n${req.theirs}\n`,
				confidence: 1,
				model: "test-model",
			}),
		);
		const ui: ConflictUi = { promptBinaryPick: vi.fn(async () => "skip" as Tier3Pick) };

		const resolver = new ConflictResolver({
			client: stub.client,
			ai: { merge: aiMerge },
			ui,
			writeFile: async () => {},
		});

		const report = await resolver.resolveAll([".jolli/manifest.json", "notes/foo.md"]);
		expect(report.aggregateMerged).toEqual([".jolli/manifest.json"]);
		expect(report.aiMerged.map((m) => m.path)).toEqual(["notes/foo.md"]);
		expect(report.rebaseAdvanced).toBe(true);
		// Only the markdown conflict went through Tier 2 — aggregate skipped it.
		expect(aiMerge).toHaveBeenCalledTimes(1);
	});

	it("falls through to Tier 2/3 when aggregate JSON fails to parse", async () => {
		const stub = makeStubVault(
			new Map([[".jolli/manifest.json", { 1: null, 2: "{bad json", 3: '{"version":1,"files":[]}' }]]),
		);
		const ui: ConflictUi = { promptBinaryPick: vi.fn(async () => "skip" as Tier3Pick) };
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui,
			writeFile: async () => {},
		});
		const report = await resolver.resolveAll([".jolli/manifest.json"]);
		// Tier 1.5 declined; ai is null → straight to Tier 3 → "skip" → rebase aborted.
		expect(report.aggregateMerged).toHaveLength(0);
		expect(report.skipped).toEqual([".jolli/manifest.json"]);
		expect(report.rebaseAdvanced).toBe(false);
		expect(ui.promptBinaryPick).toHaveBeenCalledTimes(1);
	});

	it("auto-merges add/delete on an aggregate file (theirs deleted) — resurrects content via empty envelope", async () => {
		// Realistic case: rebase-time conflict where one device kept the
		// file and the other deleted it. ours has content, theirs is null.
		// Pre-fix: this fell through to Tier 3 prompt (the screenshot bug).
		// Post-fix: empty envelope on the null side → merge keeps ours.
		const oursManifest = JSON.stringify({
			version: 1,
			files: [
				{
					path: "a.md",
					fileId: "a",
					type: "commit",
					fingerprint: "fp",
					title: "A",
					source: { commitHash: "c", branch: "main", generatedAt: "2026-05-01T00:00:00Z" },
				},
			],
		});
		const stub = makeStubVault(new Map([["repo-x/.jolli/manifest.json", { 1: null, 2: oursManifest, 3: null }]]));
		const ui: ConflictUi = {
			promptBinaryPick: vi.fn(async () => {
				throw new Error("Tier 3 should NOT run for aggregate add/delete");
			}),
		};
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui, writeFile: async () => {} });

		const report = await resolver.resolveAll(["repo-x/.jolli/manifest.json"]);
		expect(report.rebaseAdvanced).toBe(true);
		expect(report.aggregateMerged).toEqual(["repo-x/.jolli/manifest.json"]);
		expect(report.skipped).toHaveLength(0);
		expect(ui.promptBinaryPick).not.toHaveBeenCalled();
	});

	it("auto-merges add/delete on .jolli/index.json (ours deleted) — keeps theirs", async () => {
		const theirsIndex = JSON.stringify({
			version: 3,
			entries: [
				{
					commitHash: "c1",
					parentCommitHash: null,
					treeHash: "t",
					commitType: "commit",
					commitMessage: "m",
					commitDate: "2026-05-01T00:00:00Z",
					branch: "main",
					generatedAt: "2026-05-01T00:00:00Z",
				},
			],
		});
		const stub = makeStubVault(new Map([["jolliai/.jolli/index.json", { 1: null, 2: null, 3: theirsIndex }]]));
		const ui: ConflictUi = {
			promptBinaryPick: vi.fn(async () => {
				throw new Error("Tier 3 should NOT run");
			}),
		};
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui, writeFile: async () => {} });

		const report = await resolver.resolveAll(["jolliai/.jolli/index.json"]);
		expect(report.rebaseAdvanced).toBe(true);
		expect(report.aggregateMerged).toEqual(["jolliai/.jolli/index.json"]);
		expect(ui.promptBinaryPick).not.toHaveBeenCalled();
	});
});

describe("isMemoryBankAppendOnlyPath", () => {
	it("matches a per-commit summary path", () => {
		expect(isMemoryBankAppendOnlyPath("jolliai/main/foo-abc12345.md")).toBe(true);
	});

	it("matches a plan path", () => {
		expect(isMemoryBankAppendOnlyPath("jolliai/feat-branch/plan--something-deadbeef.md")).toBe(true);
	});

	it("rejects root-level markdown", () => {
		expect(isMemoryBankAppendOnlyPath("notes.md")).toBe(false);
	});

	it("rejects 2-segment markdown (not nested deep enough)", () => {
		expect(isMemoryBankAppendOnlyPath("jolliai/foo.md")).toBe(false);
	});

	it("rejects paths under .jolli/ (engine aggregates, handled by Tier 1.5)", () => {
		expect(isMemoryBankAppendOnlyPath("jolliai/.jolli/manifest.json")).toBe(false);
		expect(isMemoryBankAppendOnlyPath("jolliai/main/.jolli/foo.md")).toBe(false);
	});

	it("rejects non-markdown files", () => {
		expect(isMemoryBankAppendOnlyPath("jolliai/main/foo.json")).toBe(false);
	});
});

describe("classifyDeleteVsModify", () => {
	it("base matches present → respect delete (returns kind=delete)", () => {
		const result = classifyDeleteVsModify("shared\n", "shared\n", "mine-deleted");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("delete");
	});

	it("base matches present after CRLF/trailing-newline normalize → respect delete", () => {
		const result = classifyDeleteVsModify("shared\r\n", "shared\n\n", "theirs-deleted");
		expect(result?.kind).toBe("delete");
	});

	it("base==null → accept add (returns kind=merged with present)", () => {
		const result = classifyDeleteVsModify(null, "new\n", "mine-deleted");
		expect(result?.kind).toBe("merged");
		if (result?.kind === "merged") expect(result.merged).toBe("new\n");
	});

	it("base differs from present → null (genuine conflict, defer to Tier 3)", () => {
		const result = classifyDeleteVsModify("v1\n", "v2\n", "mine-deleted");
		expect(result).toBeNull();
	});

	it("tag flows into the `via` for log clarity", () => {
		expect(classifyDeleteVsModify("x", "x", "mine-deleted")?.via).toBe("respect-mine-deleted");
		expect(classifyDeleteVsModify("x", "x", "theirs-deleted")?.via).toBe("respect-theirs-deleted");
		expect(classifyDeleteVsModify(null, "x", "mine-deleted")?.via).toBe("accept-add-when-mine-deleted");
	});
});

describe("unionMarkdown", () => {
	it("concatenates with a synced-from-peer separator", () => {
		const merged = unionMarkdown("# Mine\n\nBody A", "# Theirs\n\nBody B");
		expect(merged).toContain("# Mine");
		expect(merged).toContain("Body A");
		expect(merged).toContain("Synced from another device");
		expect(merged).toContain("# Theirs");
		expect(merged).toContain("Body B");
	});

	it("is idempotent — re-unioning theirs onto an already-merged ours does NOT duplicate", () => {
		const first = unionMarkdown("# Mine\n\nBody A", "# Theirs\n\nBody B");
		const again = unionMarkdown(first, "# Theirs\n\nBody B");
		expect(again).toBe(first);
	});

	it("returns ours unchanged when theirs is already a substring", () => {
		expect(unionMarkdown("a\n\nb", "a")).toBe("a\n\nb");
	});
});

describe("ConflictResolver — Tier 2.7 safe heuristics", () => {
	it("rule 1 (empty mine): peer content wins when ours is whitespace-only", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: null, 2: "   \n", 3: "real peer content\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		const report = await resolver.resolveAll(["foo.md"]);
		expect(report.resolved).toContain("foo.md");
		expect(writes[0]?.merged).toBe("real peer content\n");
	});

	it("rule 1 (empty theirs): local content wins when theirs is whitespace-only", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: null, 2: "real mine\n", 3: "\n\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes[0]?.merged).toBe("real mine\n");
	});

	it("rule 2: identical after normalize (CRLF vs LF, trailing newline) takes ours", async () => {
		const stub = makeStubVault(
			new Map([
				[
					"foo.md",
					{
						1: null,
						2: "line one\nline two\n",
						3: "line one\r\nline two\r\n\r\n",
					},
				],
			]),
		);
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes[0]?.merged).toBe("line one\nline two\n");
	});

	it("rule 3 base-aware: base==theirs → respect mine's delete (removePath, not write)", async () => {
		// User deleted on local side; peer side is unchanged from base.
		// The new rule respects the delete instead of "modification wins"
		// (which would have undeleted the file — a known prior bug).
		const stub = makeStubVault(new Map([["foo.md", { 1: "shared\n", 2: null, 3: "shared\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes).toEqual([]); // never written
		expect(stub.removed).toEqual(["foo.md"]); // git rm called
	});

	it("rule 3 base-aware: base==ours → respect theirs's delete (removePath, not write)", async () => {
		// Mirror of the previous test: peer deleted, local is unchanged.
		const stub = makeStubVault(new Map([["foo.md", { 1: "shared\n", 2: "shared\n", 3: null }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes).toEqual([]);
		expect(stub.removed).toEqual(["foo.md"]);
	});

	it("rule 3 base-aware: base==null + theirs present → accept peer's add (no delete to respect)", async () => {
		// File is brand-new on peer side; local side never had it. No
		// delete intent on local — accept the add.
		const stub = makeStubVault(new Map([["foo.md", { 2: null, 3: "new content\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes[0]?.merged).toBe("new content\n");
		expect(stub.removed).toEqual([]);
	});

	it("rule 3 base-aware: base==null + ours present → accept local's add", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 2: "new local\n", 3: null }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes[0]?.merged).toBe("new local\n");
	});

	it("rule 3 base-aware: base differs from both → genuine conflict, falls to Tier 3", async () => {
		// Base existed; one side deleted, other side MODIFIED (not just kept
		// at base). Real intent conflict — Tier 3 takes over. With `policy:
		// "prompt"` and an empty UI queue, the stub falls back to skip.
		const stub = makeStubVault(new Map([["foo.md", { 1: "v1 base\n", 2: null, 3: "v2 modified\n" }]]));
		const ui = makeStubUi([]); // empty queue → defaults to "skip"
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: ui.ui,
			policy: "prompt",
		});
		const report = await resolver.resolveAll(["foo.md"]);
		expect(report.skipped).toEqual(["foo.md"]);
		expect(stub.removed).toEqual([]);
	});

	it("rule 4: Memory Bank append-only path → markdown union, both sides present in output", async () => {
		const stub = makeStubVault(
			new Map([
				["jolliai/main/foo-abc12345.md", { 1: null, 2: "# Summary A\n\nBody A", 3: "# Summary B\n\nBody B" }],
			]),
		);
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["jolliai/main/foo-abc12345.md"]);
		expect(writes[0]?.merged).toContain("Body A");
		expect(writes[0]?.merged).toContain("Body B");
	});

	it("does NOT trigger union for non-append-only paths (root-level markdown)", async () => {
		// `notes.md` at root is user-authored, not append-only — must NOT
		// silently concatenate. Falls through to Tier 3 (default policy
		// here is "prompt"; stub UI's empty queue returns "skip").
		const stub = makeStubVault(new Map([["notes.md", { 1: "b", 2: "Mine\n", 3: "Theirs\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		const report = await resolver.resolveAll(["notes.md"]);
		expect(writes).toEqual([]); // Tier 2.7 didn't fire
		expect(report.skipped).toContain("notes.md"); // prompt fallback → stub UI defaults to skip
	});
});

describe("ConflictResolver — Tier 3 policy", () => {
	it("policy=mine unconditionally picks mine without touching the UI", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: "b", 2: "p", 3: "m" }]]));
		const uiCalls: string[] = [];
		const ui: ConflictUi = {
			promptBinaryPick: async (path) => {
				uiCalls.push(path);
				return "skip";
			},
		};
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui, policy: "mine" });
		const report = await resolver.resolveAll(["foo.md"]);
		expect(report.binaryPicked).toEqual([{ path: "foo.md", pick: "mine" }]);
		expect(uiCalls).toEqual([]); // UI never called
	});

	it("policy=theirs unconditionally picks theirs", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: "b", 2: "p", 3: "m" }]]));
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			policy: "theirs",
		});
		const report = await resolver.resolveAll(["foo.md"]);
		expect(report.binaryPicked).toEqual([{ path: "foo.md", pick: "theirs" }]);
	});

	it("policy=prompt still calls the UI (existing behavior preserved)", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: "b", 2: "p", 3: "m" }]]));
		const calls: string[] = [];
		const ui: ConflictUi = {
			promptBinaryPick: async (path) => {
				calls.push(path);
				return "mine";
			},
		};
		const resolver = new ConflictResolver({ client: stub.client, ai: null, ui, policy: "prompt" });
		const report = await resolver.resolveAll(["foo.md"]);
		expect(calls).toEqual(["foo.md"]);
		expect(report.binaryPicked).toEqual([{ path: "foo.md", pick: "mine" }]);
	});

	it("Tier 2.7 wins over policy — empty-side rule fires even when policy=mine would pick mine", async () => {
		// Establishes the invariant: lossless heuristics always have priority.
		// policy=mine would normally take an empty `:2:`, losing peer's
		// real content. Tier 2.7 saves us from that footgun.
		const stub = makeStubVault(new Map([["foo.md", { 1: null, 2: "   \n", 3: "peer real\n" }]]));
		const writes: { path: string; merged: string }[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai: null,
			ui: makeStubUi([]).ui,
			policy: "mine",
			writeFile: async (p, m) => {
				writes.push({ path: p, merged: m });
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes[0]?.merged).toBe("peer real\n");
		// Did NOT take the empty mine via policy.
		expect(stub.checkoutsOurs).toEqual([]);
	});
});

describe("ConflictResolver — resolveVaultPath", () => {
	it("rewrites paths via resolveVaultPath before writing", async () => {
		const stub = makeStubVault(new Map([["foo.md", { 1: "b", 2: "ours", 3: "theirs" }]]));
		const ai: AiMergeProvider = {
			merge: async (req: AiMergeRequest) => ({
				merged: req.ours,
				confidence: 0.9,
				model: "m",
			}),
		};
		const writes: string[] = [];
		const resolver = new ConflictResolver({
			client: stub.client,
			ai,
			ui: makeStubUi([]).ui,
			resolveVaultPath: (p) => `/vault/${p}`,
			writeFile: async (p) => {
				writes.push(p);
			},
		});
		await resolver.resolveAll(["foo.md"]);
		expect(writes).toEqual(["/vault/foo.md"]);
	});
});
