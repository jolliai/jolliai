import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { FolderStorageMock, MetadataManagerMock } = vi.hoisted(() => ({
	FolderStorageMock: vi.fn(),
	MetadataManagerMock: vi.fn(),
}));
vi.mock("../../../cli/src/core/FolderStorage.js", () => ({ FolderStorage: FolderStorageMock }));
vi.mock("../../../cli/src/core/MetadataManager.js", () => ({ MetadataManager: MetadataManagerMock }));

import type * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { SharedBranchExport } from "./JolliShareService.js";
import { importSharedBranchForDisplay } from "./SharedBranchImporter.js";

interface FakeStorage {
	writeFiles: ReturnType<typeof vi.fn>;
	listFiles: ReturnType<typeof vi.fn>;
	readFile: ReturnType<typeof vi.fn>;
}

function makeStorage(existingPaths: string[] = [], localSummaries: Record<string, string> = {}): FakeStorage {
	return {
		writeFiles: vi.fn().mockResolvedValue(undefined),
		listFiles: vi.fn().mockImplementation((prefix: string) =>
			Promise.resolve(existingPaths.filter(p => p.startsWith(`${prefix}/`))),
		),
		readFile: vi.fn().mockImplementation((path: string) => Promise.resolve(localSummaries[path] ?? null)),
	};
}

/** The resolved shape of createReadStorageForCurrentRepo — folder storage + identity. */
function currentRepo(storage: FakeStorage, over: { repoName?: string; remoteUrl?: string | null } = {}) {
	return {
		storage,
		kbRoot: "/kb/widgets",
		repoName: over.repoName ?? "acme/widgets",
		remoteUrl: over.remoteUrl === undefined ? "https://github.com/acme/widgets" : over.remoteUrl,
	};
}

/** A summary.json string with the given hash + optional plan/note refs. */
function summaryJson(over: Record<string, unknown>): string {
	return JSON.stringify({ version: 4, commitHash: "h1", commitMessage: "m", branch: "feature/x", ...over });
}

function makeExport(over: Partial<SharedBranchExport> = {}): SharedBranchExport {
	return {
		branch: "feature/x",
		repoName: "acme/widgets",
		repoUrl: "https://github.com/acme/widgets",
		kind: "branch",
		headCommitHash: "h1",
		commits: [{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] }],
		...over,
	};
}

describe("importSharedBranchForDisplay", () => {
	let bridge: {
		createStorageForRepo: ReturnType<typeof vi.fn>;
		createReadStorageForCurrentRepo: ReturnType<typeof vi.fn>;
		storeSummary: ReturnType<typeof vi.fn>;
	};
	const context = { globalStorageUri: { fsPath: "/gs" } } as unknown as vscode.ExtensionContext;

	beforeEach(() => {
		// Both repo lookups default to "not found"; each test wires the one it exercises.
		bridge = {
			createStorageForRepo: vi.fn().mockResolvedValue(null),
			createReadStorageForCurrentRepo: vi.fn().mockResolvedValue(null),
			storeSummary: vi.fn().mockResolvedValue(undefined),
		};
		FolderStorageMock.mockReset();
		// Default sandbox storage so the fallback path has a working target.
		// biome-ignore lint/complexity/useArrowFunction: `new`-ed by the importer — arrows aren't constructible.
		FolderStorageMock.mockImplementation(function () {
			return makeStorage();
		});
		MetadataManagerMock.mockReset();
	});

	function run(data: SharedBranchExport) {
		return importSharedBranchForDisplay(data, bridge as unknown as JolliMemoryBridge, context);
	}

	it("returns null when no commit carries a usable summary.json", async () => {
		bridge.createStorageForRepo.mockResolvedValue({ storage: makeStorage(), kbRoot: "/kb" });
		const res = await run(makeExport({ commits: [{ commitHash: "h1", summaryJson: null, attachments: [] }] }));
		expect(res).toBeNull();
	});

	// ── Mode 1: currently-open repo → real ingest so recall/search find it ──────────

	describe("current repo (ingest via storeSummary)", () => {
		it("ingests every shared commit via storeSummary(force=false) and reports ingestedLocally", async () => {
			const storage = makeStorage();
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(storage));
			const res = await run(
				makeExport({
					headCommitHash: "h2",
					commits: [
						{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
						{ commitHash: "h2", summaryJson: summaryJson({ commitHash: "h2" }), attachments: [] },
					],
				}),
			);
			expect(res?.ingestedLocally).toBe(true);
			expect(res?.storage).toBe(storage as never);
			expect(bridge.storeSummary).toHaveBeenCalledTimes(2);
			// force=false: the commitHash duplicate guard keeps the recipient's own copy.
			expect(bridge.storeSummary.mock.calls.every(c => c[1] === false)).toBe(true);
			expect(FolderStorageMock).not.toHaveBeenCalled();
		});

		it("injects a zero diffStats when the shared summary lacks it (keeps storeSummary git-free)", async () => {
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(makeStorage()));
			await run(makeExport());
			expect(bridge.storeSummary.mock.calls[0][0].diffStats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		});

		it("preserves an existing diffStats on the shared summary", async () => {
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(makeStorage()));
			const stats = { filesChanged: 3, insertions: 10, deletions: 2 };
			await run(makeExport({ commits: [{ commitHash: "h1", summaryJson: summaryJson({ diffStats: stats }), attachments: [] }] }));
			expect(bridge.storeSummary.mock.calls[0][0].diffStats).toEqual(stats);
		});

		it("fills plan/note fold bodies into the repo folder (gaps only), never summary files", async () => {
			const storage = makeStorage(["plans/plan-a.md"]);
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(storage));
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({
								commitHash: "h1",
								plans: [{ slug: "plan-a", title: "Plan A" }],
								notes: [{ id: "n1", title: "Note 1", format: "markdown" }],
							}),
							attachments: [
								{ title: "Plan A", body: "SHARE PLAN BODY" },
								{ title: "Note 1", body: "NOTE BODY" },
							],
						},
					],
				}),
			);
			const files = storage.writeFiles.mock.calls[0][0] as Array<{ path: string }>;
			// plan-a already local → skipped; only the missing note is written; no summaries/*.
			expect(files.map(f => f.path)).toEqual(["notes/n1.md"]);
		});

		it("does not touch writeFiles when the repo already has every plan/note", async () => {
			const storage = makeStorage(["plans/plan-a.md"]);
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(storage));
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({ commitHash: "h1", plans: [{ slug: "plan-a", title: "Plan A" }] }),
							attachments: [{ title: "Plan A", body: "SHARE PLAN BODY" }],
						},
					],
				}),
			);
			expect(storage.writeFiles).not.toHaveBeenCalled();
			expect(bridge.storeSummary).toHaveBeenCalledTimes(1); // ingest still ran
		});

		it("prefers the repo's authoritative head summary for display when it pre-exists", async () => {
			const local = JSON.stringify({ version: 4, commitHash: "h1", commitMessage: "the full local version", branch: "feature/x" });
			const storage = makeStorage([], { "summaries/h1.json": local });
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(storage));
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(true);
			expect(res?.head.commitMessage).toBe("the full local version");
		});

		it("ingests a public-tier share of the current repo by reconstructing owner/repo from the local remote", async () => {
			// Public tier withholds repoUrl, but the recipient still knows its OWN remote. Real
			// fixture forms pin the production contract: the backend stored repoName as
			// sanitize("acme/widgets")="acmewidgets" (slash gone) while the local bank keeps the
			// bare basename "widgets" — a naive repoName===data.repoName would MISS (this is the
			// bug the reconstruction fixes). We rebuild "acme/widgets"→"acmewidgets" from the
			// local remote and match.
			const storage = makeStorage();
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(storage, { repoName: "widgets", remoteUrl: "https://github.com/acme/widgets.git" }),
			);
			const res = await run(makeExport({ repoName: "acmewidgets", repoUrl: null }));
			expect(res?.ingestedLocally).toBe(true);
			expect(bridge.storeSummary).toHaveBeenCalled();
		});

		it("routes a public-tier share to the sandbox when the basename matches but the owner differs", async () => {
			// Owner dimension is preserved: a public share of acme/widgets must NOT land in a
			// local OTHER/widgets repo just because the basename collides. Reconstructed
			// "OTHERwidgets" != stored "acmewidgets" → read-only sandbox, not a wrong-repo write.
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(makeStorage(), { repoName: "widgets", remoteUrl: "https://github.com/OTHER/widgets.git" }),
			);
			const res = await run(makeExport({ repoName: "acmewidgets", repoUrl: null }));
			expect(res?.ingestedLocally).toBe(false);
			expect(bridge.storeSummary).not.toHaveBeenCalled();
		});

		it("falls back to a bare-name match when neither side has a remote (local-only repo)", async () => {
			// No remote on either side → the backend stored a basename, not owner/repo, so the
			// bare-name compare is the last-ditch identity for this case.
			const storage = makeStorage();
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(storage, { repoName: "widgets", remoteUrl: null }),
			);
			const res = await run(makeExport({ repoName: "widgets", repoUrl: null }));
			expect(res?.ingestedLocally).toBe(true);
			expect(bridge.storeSummary).toHaveBeenCalled();
		});

		it("adopts the current repo on a remote-URL match even when the display names differ", async () => {
			// A folder rename changes repoName but not the remote — URL identity wins.
			const storage = makeStorage();
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(storage, { repoName: "widgets-2" }));
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(true);
		});

		it("matches when the local raw remote differs only by canonicalization from the export URL", async () => {
			// Real-world regression: the bank keeps the raw git remote (`.git` suffix) while
			// the backend export returns the normalized form. A strict === missed this and
			// misrouted a current-repo share into the read-only sandbox.
			const storage = makeStorage();
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(storage, { repoName: "jolliai", remoteUrl: "https://github.com/jolliai/jolliai.git" }),
			);
			const res = await run(
				makeExport({ repoName: "jolliaijolliai", repoUrl: "https://github.com/jolliai/jolliai" }),
			);
			expect(res?.ingestedLocally).toBe(true); // URL canonicalizes equal despite .git + repoName mismatch
			expect(bridge.storeSummary).toHaveBeenCalled();
		});

		it("rejects a same-name current repo whose remote URL differs (identity collision) → sandbox", async () => {
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(makeStorage(), { remoteUrl: "https://github.com/OTHER/widgets" }),
			);
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(false);
			expect(bridge.storeSummary).not.toHaveBeenCalled();
			expect(FolderStorageMock).toHaveBeenCalledWith("/gs/shared-imports/acme-widgets", expect.anything());
		});

		it("rejects a current repo that is a different repo entirely → sandbox", async () => {
			bridge.createReadStorageForCurrentRepo.mockResolvedValue(
				currentRepo(makeStorage(), { repoName: "acme/unrelated", remoteUrl: null }),
			);
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(false);
			expect(bridge.storeSummary).not.toHaveBeenCalled();
		});
	});

	// ── Mode 2: foreign local repo (discovered, not open) → display-only ────────────

	describe("foreign local repo (display-only, no ingest)", () => {
		it("returns the foreign bank storage and never ingests", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					headCommitHash: "h2",
					commits: [
						{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
						{ commitHash: "h2", summaryJson: summaryJson({ commitHash: "h2" }), attachments: [] },
					],
				}),
			);
			expect(res?.ingestedLocally).toBe(false);
			expect(res?.storage).toBe(storage as never);
			expect(res?.head.commitHash).toBe("h2");
			expect(res?.commitCount).toBe(2);
			expect(bridge.storeSummary).not.toHaveBeenCalled();
			expect(FolderStorageMock).not.toHaveBeenCalled();
		});

		it("writes plan + note bodies matched by title (snippet note uses inline content), no summaries", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({
								commitHash: "h1",
								plans: [{ slug: "plan-a", title: "Plan A" }],
								notes: [
									{ id: "n1", title: "Note 1", format: "markdown" },
									{ id: "n2", title: "Snippet", format: "snippet", content: "inline body" },
								],
							}),
							attachments: [
								{ title: "Plan A", body: "PLAN BODY" },
								{ title: "Note 1", body: "NOTE BODY" },
							],
						},
					],
				}),
			);
			const files = storage.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
			expect(files).toContainEqual({ path: "plans/plan-a.md", content: "# Plan A\n\nPLAN BODY", branch: "feature/x" });
			expect(files).toContainEqual({ path: "notes/n1.md", content: "# Note 1\n\nNOTE BODY", branch: "feature/x" });
			expect(files).toContainEqual({ path: "notes/n2.md", content: "# Snippet\n\ninline body", branch: "feature/x" });
			expect(files.every(f => !f.path.startsWith("summaries/"))).toBe(true);
		});

		it("never overwrites a file the foreign bank already has — fills gaps only", async () => {
			const storage = makeStorage(["plans/plan-a.md"]);
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({
								commitHash: "h1",
								plans: [{ slug: "plan-a", title: "Plan A" }],
								notes: [{ id: "n1", title: "Note 1", format: "markdown" }],
							}),
							attachments: [
								{ title: "Plan A", body: "SHARE PLAN BODY" },
								{ title: "Note 1", body: "NOTE BODY" },
							],
						},
					],
				}),
			);
			const files = storage.writeFiles.mock.calls[0][0] as Array<{ path: string }>;
			expect(files.map(f => f.path)).toEqual(["notes/n1.md"]);
		});

		it("prefers the foreign bank's authoritative head over the lossy import", async () => {
			const local = JSON.stringify({ version: 4, commitHash: "h1", commitMessage: "authoritative", branch: "feature/x" });
			const storage = makeStorage([], { "summaries/h1.json": local });
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(false);
			expect(res?.head.commitMessage).toBe("authoritative");
		});

		it("falls back to the imported head when the foreign bank's copy is unparseable", async () => {
			const storage = makeStorage([], { "summaries/h1.json": "{not json" });
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(makeExport());
			expect(res?.head.commitHash).toBe("h1");
		});

		it("does not call writeFiles when there are no attachment bodies to write", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(makeExport());
			expect(storage.writeFiles).not.toHaveBeenCalled();
		});

		it("prefers the head commit's body when several commits carry the same plan slug", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const planCommit = (hash: string, body: string) => ({
				commitHash: hash,
				summaryJson: summaryJson({ commitHash: hash, plans: [{ slug: "plan-a", title: "Plan A" }] }),
				attachments: [{ title: "Plan A", body }],
			});
			// Head listed FIRST to prove priority comes from headCommitHash, not array order.
			await run(makeExport({ headCommitHash: "h2", commits: [planCommit("h2", "HEAD BODY"), planCommit("h1", "OLD BODY")] }));
			const files = storage.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
			expect(files).toEqual([{ path: "plans/plan-a.md", content: "# Plan A\n\nHEAD BODY", branch: "feature/x" }]);
		});

		it("skips an unparseable summary.json but still imports the valid commits", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					headCommitHash: "bad",
					commits: [
						{ commitHash: "bad", summaryJson: "{not json", attachments: [] },
						{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
					],
				}),
			);
			expect(res?.commitCount).toBe(1);
			expect(res?.head.commitHash).toBe("h1");
		});

		it("skips a summary.json whose commitHash is missing (parses but no identity)", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					headCommitHash: "h1",
					commits: [
						{ commitHash: "empty", summaryJson: "{}", attachments: [] },
						{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
					],
				}),
			);
			// The `{}` body has no commitHash → rejected; only the well-formed commit survives.
			expect(res?.commitCount).toBe(1);
			expect(res?.head.commitHash).toBe("h1");
		});

		it("skips a summary.json whose commitHash disagrees with the envelope (misrouted payload)", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					commits: [{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "OTHER" }), attachments: [] }],
				}),
			);
			expect(res).toBeNull(); // the only commit was rejected → no usable summary
		});

		it("skips a summary.json that parses to a non-object (array / primitive)", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({ commits: [{ commitHash: "h1", summaryJson: "[1,2,3]", attachments: [] }] }),
			);
			expect(res).toBeNull();
		});
	});

	it("does not ingest a mismatched summary into the current repo (validation precedes storeSummary)", async () => {
		bridge.createReadStorageForCurrentRepo.mockResolvedValue(currentRepo(makeStorage()));
		const res = await run(
			makeExport({
				commits: [{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "OTHER" }), attachments: [] }],
			}),
		);
		expect(res).toBeNull();
		expect(bridge.storeSummary).not.toHaveBeenCalled();
	});

	// ── Mode 3: no local repo (pure external) → sandbox display, self-contained ─────

	describe("pure external (sandbox import dir)", () => {
		it("falls back to a per-repo import dir under global storage and does not ingest", async () => {
			const res = await run(makeExport());
			expect(res?.ingestedLocally).toBe(false);
			expect(res?.head.commitHash).toBe("h1");
			expect(bridge.storeSummary).not.toHaveBeenCalled();
			expect(FolderStorageMock).toHaveBeenCalledWith("/gs/shared-imports/acme-widgets", expect.anything());
		});

		it("persists each commit's raw summary JSON so the sandbox is a self-contained copy", async () => {
			const sandbox = makeStorage();
			// biome-ignore lint/complexity/useArrowFunction: `new`-ed by the importer — arrows aren't constructible.
			FolderStorageMock.mockImplementation(function () {
				return sandbox;
			});
			await run(makeExport());
			const files = sandbox.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
			expect(files).toContainEqual({
				path: "summaries/h1.json",
				content: summaryJson({ commitHash: "h1" }),
				branch: "feature/x",
			});
		});

		it("refreshes the sandbox on re-visit — overwrites freely, no existence probe", async () => {
			const sandbox = makeStorage(["plans/plan-a.md"]);
			// biome-ignore lint/complexity/useArrowFunction: `new`-ed by the importer — arrows aren't constructible.
			FolderStorageMock.mockImplementation(function () {
				return sandbox;
			});
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({ commitHash: "h1", plans: [{ slug: "plan-a", title: "Plan A" }] }),
							attachments: [{ title: "Plan A", body: "UPDATED SHARE BODY" }],
						},
					],
				}),
			);
			expect(sandbox.listFiles).not.toHaveBeenCalled();
			const files = sandbox.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
			expect(files).toContainEqual({ path: "plans/plan-a.md", content: "# Plan A\n\nUPDATED SHARE BODY", branch: "feature/x" });
			expect(files).toContainEqual({
				path: "summaries/h1.json",
				content: summaryJson({ commitHash: "h1", plans: [{ slug: "plan-a", title: "Plan A" }] }),
				branch: "feature/x",
			});
		});

		it("slugs an all-punctuation repo name to 'repo' for the import dir", async () => {
			await run(makeExport({ repoName: "///" }));
			expect(FolderStorageMock).toHaveBeenCalledWith("/gs/shared-imports/repo", expect.anything());
		});

		it("neutralizes a '.'/'..' repo name so the import dir can't escape shared-imports/", async () => {
			// A crafted repoName of "." or ".." would otherwise survive as a path segment and
			// join() would resolve OUT of the per-repo sandbox (".." → the parent dir).
			await run(makeExport({ repoName: ".." }));
			expect(FolderStorageMock).toHaveBeenCalledWith("/gs/shared-imports/repo", expect.anything());
			FolderStorageMock.mockClear();
			await run(makeExport({ repoName: "." }));
			expect(FolderStorageMock).toHaveBeenCalledWith("/gs/shared-imports/repo", expect.anything());
		});
	});

	it("writes distinct bodies when a commit carries two docs sharing a title", async () => {
		// bodies keyed by title are consumed as an in-order queue, so two same-titled plans
		// don't collapse to one (last-write-wins) body.
		const storage = makeStorage();
		bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
		await run(
			makeExport({
				commits: [
					{
						commitHash: "h1",
						summaryJson: summaryJson({
							commitHash: "h1",
							plans: [
								{ slug: "plan-a", title: "Notes" },
								{ slug: "plan-b", title: "Notes" },
							],
						}),
						attachments: [
							{ title: "Notes", body: "FIRST" },
							{ title: "Notes", body: "SECOND" },
						],
					},
				],
			}),
		);
		const files = storage.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
		expect(files).toContainEqual({ path: "plans/plan-a.md", content: "# Notes\n\nFIRST", branch: "feature/x" });
		expect(files).toContainEqual({ path: "plans/plan-b.md", content: "# Notes\n\nSECOND", branch: "feature/x" });
	});

	// ── Untrusted path-segment hardening (slug / id / commitHash traversal) ─────────
	describe("rejects unsafe path segments from the /export payload", () => {
		/** Grab the paths handed to writeFiles across all calls (empty if none). */
		function writtenPaths(storage: FakeStorage): string[] {
			return storage.writeFiles.mock.calls.flatMap(call => (call[0] as Array<{ path: string }>).map(f => f.path));
		}

		it("drops a plan whose slug would traverse out of the per-repo bank", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({
								commitHash: "h1",
								plans: [
									{ slug: "../../../otherRepo/.jolli/plans/pwn", title: "Evil" },
									{ slug: "plan-a", title: "Good" },
								],
							}),
							attachments: [
								{ title: "Evil", body: "EVIL" },
								{ title: "Good", body: "GOOD" },
							],
						},
					],
				}),
			);
			const paths = writtenPaths(storage);
			expect(paths).toContain("plans/plan-a.md");
			expect(paths.some(p => p.includes(".."))).toBe(false);
		});

		it("drops a note whose id would traverse, keeps the safe note", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: summaryJson({
								commitHash: "h1",
								notes: [
									{ id: "../../evil", title: "Evil", format: "markdown" },
									{ id: "n1", title: "Note 1", format: "markdown" },
								],
							}),
							attachments: [
								{ title: "Evil", body: "EVIL" },
								{ title: "Note 1", body: "OK" },
							],
						},
					],
				}),
			);
			const paths = writtenPaths(storage);
			expect(paths).toContain("notes/n1.md");
			expect(paths.some(p => p.includes(".."))).toBe(false);
		});

		it("rejects a commit whose envelope commitHash is unsafe (would traverse the sandbox summaries path)", async () => {
			const res = await run(
				makeExport({
					headCommitHash: "h1",
					commits: [
						{ commitHash: "../../../etc/pwn", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
						{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
					],
				}),
			);
			expect(res?.commitCount).toBe(1);
			expect(res?.head.commitHash).toBe("h1");
		});

		it("does not throw when a commit element is missing its commitHash entirely", async () => {
			// A truncated /export element with no commitHash reached `commitHash.slice(…)` before.
			const commits = [
				{ summaryJson: "{not json", attachments: [] },
				{ commitHash: "h1", summaryJson: summaryJson({ commitHash: "h1" }), attachments: [] },
			] as unknown as SharedBranchExport["commits"];
			const res = await run(makeExport({ headCommitHash: "h1", commits }));
			expect(res?.commitCount).toBe(1);
		});

		it("skips null / non-object plan and note entries without throwing", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: JSON.stringify({
								version: 4,
								commitHash: "h1",
								commitMessage: "m",
								branch: "feature/x",
								plans: [null, "loose-string", { slug: "plan-a", title: "Good" }],
								notes: [null, 42],
							}),
							attachments: [{ title: "Good", body: "GOOD" }],
						},
					],
				}),
			);
			expect(res?.commitCount).toBe(1);
			const paths = writtenPaths(storage);
			expect(paths).toEqual(["plans/plan-a.md"]);
		});

		it("skips a valid-id note that has no resolvable body", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							// note id is safe, but no attachment matches its title and it carries no inline content
							summaryJson: summaryJson({ commitHash: "h1", notes: [{ id: "n1", title: "Orphan", format: "markdown" }] }),
							attachments: [],
						},
					],
				}),
			);
			expect(storage.writeFiles).not.toHaveBeenCalled();
		});

		it("tolerates a non-array plans/notes value instead of throwing on for..of", async () => {
			const storage = makeStorage();
			bridge.createStorageForRepo.mockResolvedValue({ storage, kbRoot: "/kb" });
			const res = await run(
				makeExport({
					commits: [
						{
							commitHash: "h1",
							summaryJson: JSON.stringify({
								version: 4,
								commitHash: "h1",
								commitMessage: "m",
								branch: "feature/x",
								plans: 123,
								notes: "oops",
							}),
							attachments: [],
						},
					],
				}),
			);
			expect(res?.commitCount).toBe(1);
			expect(storage.writeFiles).not.toHaveBeenCalled();
		});
	});
});
