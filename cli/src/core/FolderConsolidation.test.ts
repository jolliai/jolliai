import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setManuallyDisabled } from "../Logger.js";
import type { FileWrite, SummaryIndex } from "../Types.js";
import {
	__setSotResolverForTests,
	ConsolidationDisabledError,
	type ConsolidationPlan,
	ConsolidationStalePlanError,
	classifyDuplicateFolders,
	executeConsolidation,
	revalidateConsolidationPlan,
} from "./FolderConsolidation.js";
import { __setSshRunnerForTests } from "./SshAliasResolver.js";
import type { StorageProvider } from "./StorageProvider.js";

// Keep visible-markdown generation trivial so the orphan-superset rebuild does
// not depend on the full CommitSummary rendering surface.
vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: vi.fn().mockReturnValue("# Mock Markdown\n\nBody"),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

/** In-memory StorageProvider standing in for the orphan branch. */
class InMemoryStorage implements StorageProvider {
	private files = new Map<string, string>();
	private present: boolean;
	constructor(present = true) {
		this.present = present;
	}
	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeFiles(files: FileWrite[], _msg: string): Promise<void> {
		for (const f of files) {
			if (f.delete) this.files.delete(f.path);
			else this.files.set(f.path, f.content);
		}
	}
	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
	}
	async exists(): Promise<boolean> {
		return this.present;
	}
	async ensure(): Promise<void> {}
}

function makeTmpParent(): string {
	const dir = join(tmpdir(), `kb-consol-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function summaryJson(hash: string): string {
	return JSON.stringify({
		version: 3,
		commitHash: hash,
		commitMessage: "Test commit",
		commitAuthor: "Alice",
		commitDate: "2026-01-15T10:00:00Z",
		branch: "main",
		generatedAt: "2026-01-15T10:00:00Z",
		topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
		stats: { filesChanged: 1, insertions: 1, deletions: 0 },
	});
}

function indexJson(hashes: string[]): string {
	const index: SummaryIndex = {
		version: 3,
		entries: hashes.map((h) => ({
			commitHash: h,
			parentCommitHash: null,
			commitMessage: "Test",
			commitDate: "2026-01-15T10:00:00Z",
			branch: "main",
			generatedAt: "2026-01-15T10:00:00Z",
		})),
	};
	return JSON.stringify(index);
}

/** Creates `<parent>/<name>/.jolli/{config,index,summaries}` for a repo. */
function makeKbFolder(
	parent: string,
	name: string,
	opts: { remoteUrl: string; repoName: string; hashes: string[] },
): string {
	const root = join(parent, name);
	const jolli = join(root, ".jolli");
	mkdirSync(join(jolli, "summaries"), { recursive: true });
	writeFileSync(
		join(jolli, "config.json"),
		JSON.stringify({ version: 1, sortOrder: "date", remoteUrl: opts.remoteUrl, repoName: opts.repoName }),
	);
	for (const h of opts.hashes) writeFileSync(join(jolli, "summaries", `${h}.json`), summaryJson(h));
	writeFileSync(join(jolli, "index.json"), indexJson(opts.hashes));
	return root;
}

function summaryHashesOnDisk(root: string): string[] {
	try {
		return readdirSync(join(root, ".jolli", "summaries"))
			.filter((n) => n.endsWith(".json"))
			.map((n) => n.slice(0, -5))
			.sort();
	} catch {
		return [];
	}
}

const REMOTE = "git@github.com:acme/app.git";

function assertPlan(plan: ConsolidationPlan | null): asserts plan is ConsolidationPlan {
	expect(plan).not.toBeNull();
	if (!plan) throw new Error("expected a consolidation plan");
}

describe("FolderConsolidation", () => {
	let parent: string;

	beforeEach(() => {
		parent = makeTmpParent();
		// Default: orphan branch empty (present but no summaries) → union-largest path.
		__setSotResolverForTests(async () => new InMemoryStorage(true));
	});

	afterEach(() => {
		__setSotResolverForTests(null);
		__setSshRunnerForTests(null);
		setManuallyDisabled(false);
		try {
			rmSync(parent, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	describe("classifyDuplicateFolders", () => {
		it("returns null when fewer than two folders exist for the repo", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			expect(await classifyDuplicateFolders("/cwd", "app", REMOTE, parent)).toBeNull();
		});

		it("classifies identical folders and keeps the shortest name as survivor", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("identical");
			expect(plan?.survivor).toBe(join(parent, "app"));
			expect(plan?.archived).toEqual([join(parent, "app-2")]);
			expect(plan?.counts.added).toBe(0);
		});

		it("classifies union-largest when a folder holds summaries beyond the orphan branch", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2", "a3"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("union-largest");
			expect(plan?.survivor).toBe(join(parent, "app")); // 3 > 2
			expect(plan?.counts.union).toBe(4);
			expect(plan?.counts.survivor).toBe(3);
			expect(plan?.counts.added).toBe(1);
		});

		it("classifies orphan-superset when the orphan branch already covers every folder", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			const sot = new InMemoryStorage(true);
			await sot.writeFiles(
				[
					{ path: "index.json", content: indexJson(["a1", "a2", "a3"]) },
					{ path: "summaries/a1.json", content: summaryJson("a1") },
					{ path: "summaries/a2.json", content: summaryJson("a2") },
					{ path: "summaries/a3.json", content: summaryJson("a3") },
				],
				"seed",
			);
			__setSotResolverForTests(async () => sot);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("orphan-superset");
			expect(plan?.survivor).toBe(join(parent, "app")); // canonical base slot
			expect(plan?.archived).toEqual([join(parent, "app"), join(parent, "app-2")]);
		});

		it("groups folders split only by an ssh host alias", async () => {
			makeKbFolder(parent, "app", {
				remoteUrl: "git@github-alias:acme/app.git",
				repoName: "app",
				hashes: ["a1", "a2", "a3"],
			});
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1"] });
			__setSshRunnerForTests((host) =>
				host === "github-alias" ? "hostname github.com\n" : `hostname ${host}\n`,
			);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan).not.toBeNull();
			expect(plan?.folders).toEqual([join(parent, "app"), join(parent, "app-2")]);
			expect(plan?.kind).toBe("union-largest");
		});
	});

	describe("executeConsolidation", () => {
		it("identical: archives the loser, survivor unchanged", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			const result = await executeConsolidation(plan, "/cwd", REMOTE, parent);
			expect(result.kind).toBe("identical");
			expect(summaryHashesOnDisk(join(parent, "app"))).toEqual(["a1", "a2"]);
			expect(existsSync(join(parent, "app-2"))).toBe(false);
			expect(existsSync(join(parent, ".jolli", "archive"))).toBe(true);
		});

		it("union-largest: folds the smaller folder into the largest and archives it", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2", "a3"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			const result = await executeConsolidation(plan, "/cwd", REMOTE, parent);

			expect(result.kind).toBe("union-largest");
			expect(result.survivor).toBe(join(parent, "app"));
			expect(result.summariesAfter).toBe(4);
			// Survivor gained z9 from app-2.
			expect(summaryHashesOnDisk(join(parent, "app"))).toEqual(["a1", "a2", "a3", "z9"]);
			// Merged index.json contains the union.
			const idx = JSON.parse(readFileSync(join(parent, "app", ".jolli", "index.json"), "utf-8")) as SummaryIndex;
			expect(idx.entries.map((e) => e.commitHash).sort()).toEqual(["a1", "a2", "a3", "z9"]);
			// Loser archived.
			expect(existsSync(join(parent, "app-2"))).toBe(false);
			const archived = readdirSync(join(parent, ".jolli", "archive"));
			expect(archived.some((n) => n.startsWith("app-2-"))).toBe(true);
		});

		it("union-largest: does not overwrite a summary the survivor already has", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1"] });
			// Give the survivor's a1 a distinctive content; app-2's a1 must not clobber it.
			writeFileSync(join(parent, "app", ".jolli", "summaries", "a1.json"), '{"marker":"survivor"}');
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			await executeConsolidation(plan, "/cwd", REMOTE, parent);
			expect(readFileSync(join(parent, "app", ".jolli", "summaries", "a1.json"), "utf-8")).toBe(
				'{"marker":"survivor"}',
			);
		});

		it("orphan-superset: rebuilds the base folder from the orphan branch and archives the pile", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			const sot = new InMemoryStorage(true);
			await sot.writeFiles(
				[
					{ path: "index.json", content: indexJson(["a1", "a2", "a3"]) },
					{ path: "summaries/a1.json", content: summaryJson("a1") },
					{ path: "summaries/a2.json", content: summaryJson("a2") },
					{ path: "summaries/a3.json", content: summaryJson("a3") },
				],
				"seed",
			);
			__setSotResolverForTests(async () => sot);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			const result = await executeConsolidation(plan, "/cwd", REMOTE, parent);

			expect(result.kind).toBe("orphan-superset");
			expect(result.survivor).toBe(join(parent, "app"));
			expect(summaryHashesOnDisk(join(parent, "app"))).toEqual(["a1", "a2", "a3"]);
			// Both original folders were archived (base then recreated by the rebuild).
			const archived = readdirSync(join(parent, ".jolli", "archive"));
			expect(archived.some((n) => n.startsWith("app-2-"))).toBe(true);
			expect(archived.some((n) => /^app-\d/.test(n))).toBe(true);
		});

		it("orphan-superset falls back to a folder merge if the source of truth is gone at execute time", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			const sot = new InMemoryStorage(true);
			await sot.writeFiles(
				[
					{ path: "index.json", content: indexJson(["a1", "a2", "a3"]) },
					{ path: "summaries/a1.json", content: summaryJson("a1") },
					{ path: "summaries/a2.json", content: summaryJson("a2") },
					{ path: "summaries/a3.json", content: summaryJson("a3") },
				],
				"seed",
			);
			__setSotResolverForTests(async () => sot);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			expect(plan.kind).toBe("orphan-superset");
			// Source of truth vanishes before execution → must not archive everything
			// and rebuild nothing; falls back to a lossless folder union instead.
			__setSotResolverForTests(async () => new InMemoryStorage(false));
			const result = await executeConsolidation(plan, "/cwd", REMOTE, parent);
			expect(result.kind).toBe("union-largest");
			expect(summaryHashesOnDisk(join(parent, "app"))).toEqual(["a1", "a2", "a3"]);
			expect(existsSync(join(parent, "app-2"))).toBe(false);
		});

		it("copies a survivor-absent visible file too, not just hidden .jolli data", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1"] });
			// A visible branch-folder markdown only app-2 has.
			mkdirSync(join(parent, "app-2", "main"), { recursive: true });
			writeFileSync(join(parent, "app-2", "main", "note-abc.md"), "# hi");
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			await executeConsolidation(plan, "/cwd", REMOTE, parent);
			expect(existsSync(join(parent, "app", "main", "note-abc.md"))).toBe(true);
		});
	});

	describe("classification edge cases", () => {
		it("treats an unreadable source of truth as empty → union-largest", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			__setSotResolverForTests(async () => {
				throw new Error("boom");
			});
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("union-largest");
		});

		it("breaks a size tie toward the shortest folder name", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("union-largest");
			expect(plan?.survivor).toBe(join(parent, "app")); // 2 == 2 → shortest name wins
		});

		it("unions manifest and branches across folders, deduping by id/branch", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2", "a3"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			// Survivor (app) and loser (app-2) each carry manifest + branches, with one
			// overlapping fileId ("a1") and one overlapping branch ("main").
			writeFileSync(
				join(parent, "app", ".jolli", "manifest.json"),
				JSON.stringify({
					version: 1,
					files: [{ path: "main/a1.md", fileId: "a1", type: "commit", fingerprint: "x", source: {} }],
				}),
			);
			writeFileSync(
				join(parent, "app-2", ".jolli", "manifest.json"),
				JSON.stringify({
					version: 1,
					files: [
						{ path: "main/a1.md", fileId: "a1", type: "commit", fingerprint: "y", source: {} },
						{ path: "main/z9.md", fileId: "z9", type: "commit", fingerprint: "z", source: {} },
					],
				}),
			);
			writeFileSync(
				join(parent, "app", ".jolli", "branches.json"),
				JSON.stringify({ version: 1, mappings: [{ folder: "main", branch: "main", createdAt: "t" }] }),
			);
			writeFileSync(
				join(parent, "app-2", ".jolli", "branches.json"),
				JSON.stringify({
					version: 1,
					mappings: [
						{ folder: "main", branch: "main", createdAt: "t2" },
						{ folder: "feat", branch: "feat", createdAt: "t3" },
					],
				}),
			);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			await executeConsolidation(plan, "/cwd", REMOTE, parent);

			const manifest = JSON.parse(readFileSync(join(parent, "app", ".jolli", "manifest.json"), "utf-8"));
			// Union by fileId: a1 (survivor's, kept) + z9 (from loser).
			expect(manifest.files.map((f: { fileId: string }) => f.fileId).sort()).toEqual(["a1", "z9"]);
			expect(manifest.files.find((f: { fileId: string }) => f.fileId === "a1").fingerprint).toBe("x");
			const branches = JSON.parse(readFileSync(join(parent, "app", ".jolli", "branches.json"), "utf-8"));
			expect(branches.mappings.map((m: { branch: string }) => m.branch).sort()).toEqual(["feat", "main"]);
		});

		it("tolerates a duplicate folder with no summaries directory", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			// A same-repo folder that has config/index but no summaries/ dir at all.
			mkdirSync(join(parent, "app-2", ".jolli"), { recursive: true });
			writeFileSync(
				join(parent, "app-2", ".jolli", "config.json"),
				JSON.stringify({ version: 1, sortOrder: "date", remoteUrl: REMOTE, repoName: "app" }),
			);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			expect(plan?.kind).toBe("union-largest");
			expect(plan?.counts.perFolder[join(parent, "app-2")]).toBe(0);
			expect(plan?.survivor).toBe(join(parent, "app"));
		});

		it("orphan-superset: never lands on a base slot another repo owns", async () => {
			// The base `<parent>/app` belongs to a DIFFERENT repo that happens to share
			// the basename — which is the very reason this repo ended up on suffixed
			// slots. `findRepoFolders` correctly leaves it out of the pile, so it is
			// never archived; claiming it anyway rewrote its identity and migrated this
			// repo's memories into another repo's folder.
			const foreignRemote = "git@github.com:other/app.git";
			const foreign = makeKbFolder(parent, "app", {
				remoteUrl: foreignRemote,
				repoName: "app",
				hashes: ["f1"],
			});
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1"] });
			makeKbFolder(parent, "app-3", { remoteUrl: REMOTE, repoName: "app", hashes: ["a2"] });
			const sot = new InMemoryStorage(true);
			await sot.writeFiles(
				[
					{ path: "index.json", content: indexJson(["a1", "a2"]) },
					{ path: "summaries/a1.json", content: summaryJson("a1") },
					{ path: "summaries/a2.json", content: summaryJson("a2") },
				],
				"seed",
			);
			__setSotResolverForTests(async () => sot);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			expect(plan.kind).toBe("orphan-superset");

			const result = await executeConsolidation(plan, "/cwd", REMOTE, parent);

			expect(result.survivor).not.toBe(foreign);
			// The other repo's folder is untouched: same identity, same contents.
			const config = JSON.parse(readFileSync(join(foreign, ".jolli", "config.json"), "utf-8")) as {
				remoteUrl: string;
			};
			expect(config.remoteUrl).toBe(foreignRemote);
			expect(summaryHashesOnDisk(foreign)).toEqual(["f1"]);
			// This repo's memories still landed somewhere, rebuilt from the orphan branch.
			expect(summaryHashesOnDisk(result.survivor)).toEqual(["a1", "a2"]);
		});

		it("re-validation reports DISABLED rather than a stale plan", async () => {
			// `classifyDuplicateFolders` declines while disabled, so a null answer from it
			// is ambiguous — reporting "the folders changed" would send the user back to
			// Refresh forever instead of telling them the project is off.
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);

			setManuallyDisabled(true);
			await expect(revalidateConsolidationPlan(plan, "/cwd", REMOTE, parent)).rejects.toBeInstanceOf(
				ConsolidationDisabledError,
			);
		});

		it("re-validation refuses a plan whose folder set moved on", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);

			// A third folder appears (another clone's first write) — the survivor choice
			// and the merge description are both different now.
			makeKbFolder(parent, "app-3", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2", "a4", "a5"] });
			await expect(revalidateConsolidationPlan(plan, "/cwd", REMOTE, parent)).rejects.toBeInstanceOf(
				ConsolidationStalePlanError,
			);
		});

		it("re-validation returns the freshly-computed plan when nothing moved", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			const fresh = await revalidateConsolidationPlan(plan, "/cwd", REMOTE, parent);
			expect(fresh.kind).toBe(plan.kind);
			expect(fresh.survivor).toBe(plan.survivor);
			expect(fresh.folders).toEqual(plan.folders);
		});

		it("refuses to run while the project is manually disabled", async () => {
			// Every write the rebuild depends on (`FolderStorage.ensure`,
			// `MigrationEngine.runMigration`) no-ops while disabled, so archiving the
			// pile first would leave every memory in the archive with nothing rebuilt —
			// and report success with "(0 memories)".
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a3"] });
			const sot = new InMemoryStorage(true);
			await sot.writeFiles(
				[
					{ path: "index.json", content: indexJson(["a1", "a2", "a3"]) },
					{ path: "summaries/a1.json", content: summaryJson("a1") },
					{ path: "summaries/a2.json", content: summaryJson("a2") },
					{ path: "summaries/a3.json", content: summaryJson("a3") },
				],
				"seed",
			);
			__setSotResolverForTests(async () => sot);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);

			setManuallyDisabled(true);
			await expect(executeConsolidation(plan, "/cwd", REMOTE, parent)).rejects.toBeInstanceOf(
				ConsolidationDisabledError,
			);
			// Nothing archived, nothing moved.
			expect(existsSync(join(parent, ".jolli", "archive"))).toBe(false);
			expect(summaryHashesOnDisk(join(parent, "app"))).toEqual(["a1", "a2"]);
		});

		it("merges commitAliases across folders", async () => {
			makeKbFolder(parent, "app", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "a2", "a3"] });
			makeKbFolder(parent, "app-2", { remoteUrl: REMOTE, repoName: "app", hashes: ["a1", "z9"] });
			writeFileSync(
				join(parent, "app-2", ".jolli", "index.json"),
				JSON.stringify({
					version: 3,
					entries: [
						{ commitHash: "a1", parentCommitHash: null },
						{ commitHash: "z9", parentCommitHash: null },
					],
					commitAliases: { unknownhash: "z9" },
				}),
			);
			const plan = await classifyDuplicateFolders("/cwd", "app", REMOTE, parent);
			assertPlan(plan);
			await executeConsolidation(plan, "/cwd", REMOTE, parent);
			const idx = JSON.parse(readFileSync(join(parent, "app", ".jolli", "index.json"), "utf-8")) as SummaryIndex;
			expect(idx.commitAliases).toMatchObject({ unknownhash: "z9" });
		});
	});
});
