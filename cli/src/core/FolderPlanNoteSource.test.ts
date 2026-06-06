import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	listFolderPlanNoteRefs,
	loadFolderPlanNoteContent,
	loadFolderPlanNoteHeadline,
} from "./FolderPlanNoteSource.js";
import { MetadataManager } from "./MetadataManager.js";

function makeKb(): string {
	const root = join(tmpdir(), `fpns-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".jolli", "plans"), { recursive: true });
	mkdirSync(join(root, ".jolli", "notes"), { recursive: true });
	const manifest = {
		version: 1,
		files: [
			{
				path: "feature-x/plan--p1.md",
				fileId: "plan:p1",
				type: "plan",
				fingerprint: "f1",
				source: { branch: "feature/x" },
				title: "Plan One",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
			// no updatedAt -> mtime fallback; no source.branch -> path-segment fallback
			{
				path: "main/note--n1.md",
				fileId: "note:n1",
				type: "note",
				fingerprint: "f2",
				source: {},
				title: "Note One",
			},
			{ path: "main/topic--t.md", fileId: "wiki-topic-t", type: "wiki", fingerprint: "f3", source: {} },
		],
	};
	writeFileSync(join(root, ".jolli", "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(root, ".jolli", "plans", "p1.md"), "---\ntype: plan\nslug: p1\n---\n\nplan body");
	writeFileSync(join(root, ".jolli", "notes", "n1.md"), "---\ntype: note\nid: n1\n---\n\nnote body");
	return root;
}

let roots: string[] = [];
afterEach(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
	roots = [];
});

describe("FolderPlanNoteSource", () => {
	it("enumerates plan + note refs (not wiki), prefers manifest updatedAt, mtime fallback", async () => {
		const root = makeKb();
		roots.push(root);
		const refs = await listFolderPlanNoteRefs(root);
		expect(refs.map((r) => r.type).sort()).toEqual(["note", "plan"]);
		expect(refs.find((r) => r.id === "p1")?.timestamp).toBe("2026-06-01T00:00:00.000Z");
		const note = refs.find((r) => r.id === "n1");
		expect(Number.isNaN(Date.parse(note?.timestamp ?? "x"))).toBe(false);
		// refs carry the branch so the topic page's relatedBranches can be authoritative:
		// plan from source.branch, note from the path-segment fallback.
		expect(refs.find((r) => r.id === "p1")?.branch).toBe("feature/x");
		expect(note?.branch).toBe("main");
	});

	it("loads plan/note content from hidden md, null when missing", async () => {
		const root = makeKb();
		roots.push(root);
		expect(await loadFolderPlanNoteContent(root, { type: "plan", id: "p1", timestamp: "" })).toContain("plan body");
		expect(await loadFolderPlanNoteContent(root, { type: "note", id: "n1", timestamp: "" })).toContain("note body");
		expect(await loadFolderPlanNoteContent(root, { type: "plan", id: "missing", timestamp: "" })).toBeNull();
		expect(await loadFolderPlanNoteContent(root, { type: "summary", id: "x", timestamp: "" })).toBeNull();
	});

	it("headline carries type, branch (from source.branch), title", async () => {
		const root = makeKb();
		roots.push(root);
		const h = await loadFolderPlanNoteHeadline(root, {
			type: "plan",
			id: "p1",
			timestamp: "2026-06-01T00:00:00.000Z",
		});
		expect(h).toContain("plan");
		expect(h).toContain("feature/x");
		expect(h).toContain("Plan One");
	});

	it("missing manifest -> empty refs (WARN, no throw)", async () => {
		const root = join(tmpdir(), `fpns-empty-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".jolli"), { recursive: true });
		roots.push(root);
		expect(await listFolderPlanNoteRefs(root)).toEqual([]);
	});

	it("readManifest throwing -> empty refs (catch logs, no throw)", async () => {
		const root = join(tmpdir(), `fpns-throw-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".jolli"), { recursive: true });
		roots.push(root);
		const spy = vi.spyOn(MetadataManager.prototype, "readManifest").mockImplementation(() => {
			throw new Error("disk gone");
		});
		try {
			expect(await listFolderPlanNoteRefs(root)).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it("resolves branch from branches.json mapping when source.branch absent", async () => {
		const root = join(tmpdir(), `fpns-map-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".jolli", "notes"), { recursive: true });
		roots.push(root);
		const manifest = {
			version: 1,
			files: [
				// no source.branch -> branchFromPath; folder "feat-x" maps to "feature/x"
				{
					path: "feat-x/note--n9.md",
					fileId: "note:n9",
					type: "note",
					fingerprint: "f9",
					source: {},
					title: "Mapped Note",
					updatedAt: "2026-06-02T00:00:00.000Z",
				},
			],
		};
		writeFileSync(join(root, ".jolli", "manifest.json"), JSON.stringify(manifest));
		const branches = {
			version: 1,
			mappings: [{ folder: "feat-x", branch: "feature/x", createdAt: "2026-06-01T00:00:00.000Z" }],
		};
		writeFileSync(join(root, ".jolli", "branches.json"), JSON.stringify(branches));
		writeFileSync(join(root, ".jolli", "notes", "n9.md"), "note nine body");
		const refs = await listFolderPlanNoteRefs(root);
		expect(refs.find((r) => r.id === "n9")?.branch).toBe("feature/x");
	});

	it("falls back to title=id and mtime='' when manifest entry lacks title/updatedAt and hidden md missing", async () => {
		const root = join(tmpdir(), `fpns-fallback-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".jolli"), { recursive: true });
		roots.push(root);
		const manifest = {
			version: 1,
			files: [
				// fileId without a colon -> idFromFileId returns it verbatim; no title -> title=id;
				// no updatedAt + hidden md does not exist -> mtimeOrEmpty catch -> "".
				{ path: "main/note--bare.md", fileId: "bare", type: "note", fingerprint: "fb", source: {} },
			],
		};
		writeFileSync(join(root, ".jolli", "manifest.json"), JSON.stringify(manifest));
		const refs = await listFolderPlanNoteRefs(root);
		const bare = refs.find((r) => r.id === "bare");
		expect(bare).toBeDefined();
		expect(bare?.timestamp).toBe("");
		expect(bare?.branch).toBe("main");
		const h = await loadFolderPlanNoteHeadline(root, { type: "note", id: "bare", timestamp: "" });
		// title?? id fallback -> id "bare" appears as the headline title.
		expect(h).toContain("bare");
	});

	it("memoizes readMeta by manifest mtime and re-reads after the manifest changes", async () => {
		const root = makeKb();
		roots.push(root);
		const first = await listFolderPlanNoteRefs(root); // populates the memo
		const second = await listFolderPlanNoteRefs(root); // mtime unchanged -> cache hit
		expect(second).toEqual(first);
		expect(second.map((r) => r.id).sort()).toEqual(["n1", "p1"]);

		// Rewrite the manifest and force a distinct mtime so the change is observed
		// even where the filesystem's mtime resolution is coarse.
		const manifestPath = join(root, ".jolli", "manifest.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				files: [
					{
						path: "main/plan--p2.md",
						fileId: "plan:p2",
						type: "plan",
						fingerprint: "fx",
						source: { branch: "main" },
						title: "Plan Two",
						updatedAt: "2030-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const future = new Date("2030-01-01T00:00:00.000Z");
		utimesSync(manifestPath, future, future);
		const third = await listFolderPlanNoteRefs(root);
		expect(third.map((r) => r.id)).toEqual(["p2"]);
	});

	it("headline uses ?/ref.id fallback when no manifest entry matches the ref", async () => {
		const root = makeKb();
		roots.push(root);
		const h = await loadFolderPlanNoteHeadline(root, {
			type: "plan",
			id: "ghost",
			timestamp: "2026-06-03T00:00:00.000Z",
		});
		// no meta match -> branch "?" and title falls back to ref.id.
		expect(h).toContain("?");
		expect(h).toContain("ghost");
	});
});
