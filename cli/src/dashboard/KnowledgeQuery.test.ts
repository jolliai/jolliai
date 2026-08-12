import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withIsolatedHome } from "../testUtils/isolatedHome.js";
import {
	buildGraphModel,
	buildKnowledgeModel,
	readGraphJson,
	readWikiBody,
	resolveKbRoot,
	WIKI_FILE_PATTERN,
} from "./KnowledgeQuery.js";

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface RepoSpec {
	readonly dir: string;
	readonly repoName?: string;
	readonly wiki?: Record<string, string>; // file name -> body
	readonly manifestTitles?: Record<string, string>; // wiki path -> title
	readonly graph?: string; // graph.json contents; omit for no graph
}

/** Builds a Memory Bank parent folder with the given repos, plus a config dir pointing at it. */
function scaffold(repos: RepoSpec[]): { configDir: string } {
	const mbRoot = mkTmp("jolli-mb-");
	for (const spec of repos) {
		const kbRoot = join(mbRoot, spec.dir);
		mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
		writeFileSync(
			join(kbRoot, ".jolli", "config.json"),
			JSON.stringify({ version: 1, sortOrder: "date", ...(spec.repoName ? { repoName: spec.repoName } : {}) }),
		);
		if (spec.wiki) {
			mkdirSync(join(kbRoot, "_wiki"), { recursive: true });
			for (const [file, body] of Object.entries(spec.wiki)) writeFileSync(join(kbRoot, "_wiki", file), body);
		}
		if (spec.manifestTitles) {
			const files = Object.entries(spec.manifestTitles).map(([path, title]) => ({
				path,
				fileId: path,
				type: "wiki",
				fingerprint: "x",
				source: {},
				title,
			}));
			writeFileSync(join(kbRoot, ".jolli", "manifest.json"), JSON.stringify({ version: 1, files }));
		}
		if (spec.graph !== undefined) {
			mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
			writeFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), spec.graph);
		}
	}
	const configDir = mkTmp("jolli-cfg-");
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ localFolder: mbRoot }));
	return { configDir };
}

describe("WIKI_FILE_PATTERN", () => {
	it("accepts the two wiki file shapes and nothing else", () => {
		expect(WIKI_FILE_PATTERN.test("_index.md")).toBe(true);
		expect(WIKI_FILE_PATTERN.test("topic--foo-bar.md")).toBe(true);
		expect(WIKI_FILE_PATTERN.test("../secret.md")).toBe(false);
		expect(WIKI_FILE_PATTERN.test("topic--a/b.md")).toBe(false);
		expect(WIKI_FILE_PATTERN.test("summary--x.md")).toBe(false);
		expect(WIKI_FILE_PATTERN.test(".env")).toBe(false);
	});
});

describe("buildKnowledgeModel", () => {
	it("lists a repo's wiki TOPICS by title, excluding the _index and non-wiki files", async () => {
		const { configDir } = scaffold([
			{
				dir: "jolliai",
				repoName: "jolliai",
				wiki: {
					"_index.md": "# jolliai Knowledge Wiki\n",
					"topic--zebra.md": "# Zebra\n",
					"topic--alpha.md": "# Alpha\n",
					"ignore.txt": "not wiki",
				},
			},
		]);
		const model = await buildKnowledgeModel(configDir);
		expect(model.repos).toHaveLength(1);
		expect(model.repos[0].repoName).toBe("jolliai");
		// `_index.md` (the auto-generated table of contents) and `ignore.txt` are dropped.
		expect(model.repos[0].files.map((f) => f.file)).toEqual(["topic--alpha.md", "topic--zebra.md"]);
		expect(model.repos[0].graphAvailable).toBe(false);
	});

	it("prefers manifest titles, falls back to H1, then to the file name", async () => {
		const { configDir } = scaffold([
			{
				dir: "repo",
				repoName: "repo",
				wiki: {
					"topic--a.md": "# H1 Title A\nbody",
					"topic--b.md": "no heading here",
					"topic--c.md": "# Ignored H1\n",
				},
				manifestTitles: { "_wiki/topic--c.md": "Manifest Title C" },
			},
		]);
		const model = await buildKnowledgeModel(configDir);
		const byFile = new Map(model.repos[0].files.map((f) => [f.file, f.title]));
		expect(byFile.get("topic--a.md")).toBe("H1 Title A");
		expect(byFile.get("topic--b.md")).toBe("topic--b.md");
		expect(byFile.get("topic--c.md")).toBe("Manifest Title C");
	});

	it("marks graphAvailable when graph.json exists, and handles a repo with no _wiki", async () => {
		const { configDir } = scaffold([
			{ dir: "withgraph", repoName: "withgraph", wiki: { "_index.md": "# x\n" }, graph: '{"nodes":[]}' },
			{ dir: "nowiki", repoName: "nowiki" },
		]);
		const model = await buildKnowledgeModel(configDir);
		const byName = new Map(model.repos.map((r) => [r.repoName, r]));
		expect(byName.get("withgraph")?.graphAvailable).toBe(true);
		expect(byName.get("nowiki")?.files).toEqual([]);
		expect(byName.get("nowiki")?.graphAvailable).toBe(false);
	});

	it("returns no repos when localFolder points at an empty directory", async () => {
		const { configDir } = scaffold([]);
		const model = await buildKnowledgeModel(configDir);
		expect(model.repos).toEqual([]);
	});

	it("ignores non-wiki and title-less manifest entries, and a manifest with no files", async () => {
		const mbRoot = mkTmp("jolli-mb-");
		const kbRoot = join(mbRoot, "repo");
		mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
		writeFileSync(
			join(kbRoot, ".jolli", "config.json"),
			JSON.stringify({ version: 1, sortOrder: "date", repoName: "repo" }),
		);
		mkdirSync(join(kbRoot, "_wiki"), { recursive: true });
		writeFileSync(join(kbRoot, "_wiki", "topic--a.md"), "# H1 A\n");
		// A non-wiki entry and a wiki entry with no title must both be skipped, so
		// topic--a.md falls through to its H1 rather than picking up a wrong title.
		writeFileSync(
			join(kbRoot, ".jolli", "manifest.json"),
			JSON.stringify({
				version: 1,
				files: [
					{ path: "_wiki/topic--a.md", fileId: "1", type: "commit", fingerprint: "x", source: {} },
					{ path: "_wiki/topic--a.md", fileId: "2", type: "wiki", fingerprint: "x", source: {} },
					// A wiki entry whose path has no basename must be skipped, not crash.
					{ path: "", fileId: "3", type: "wiki", fingerprint: "x", source: {}, title: "Ghost" },
				],
			}),
		);
		const configDir = mkTmp("jolli-cfg-");
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ localFolder: mbRoot }));
		const model = await buildKnowledgeModel(configDir);
		expect(model.repos[0].files[0].title).toBe("H1 A");

		// A manifest object missing `files` entirely must not throw.
		writeFileSync(join(kbRoot, ".jolli", "manifest.json"), JSON.stringify({ version: 1 }));
		const model2 = await buildKnowledgeModel(configDir);
		expect(model2.repos[0].files[0].title).toBe("H1 A");
	});

	it("falls back to the global config dir when none is passed", async () => {
		const home = mkTmp("jolli-home-");
		// No global config under the isolated home → no localFolder → default parent
		// (also absent) → an empty repo list, without touching the real machine.
		const model = await withIsolatedHome(home, () => buildKnowledgeModel());
		expect(model.repos).toEqual([]);
	});
});

describe("buildGraphModel", () => {
	it("reports each repo and whether it has a compiled graph", async () => {
		const { configDir } = scaffold([
			{ dir: "a", repoName: "a", graph: "{}" },
			{ dir: "b", repoName: "b" },
		]);
		const model = await buildGraphModel(configDir);
		const byName = new Map(model.repos.map((r) => [r.repoName, r.graphAvailable]));
		expect(byName.get("a")).toBe(true);
		expect(byName.get("b")).toBe(false);
	});
});

describe("resolveKbRoot", () => {
	it("resolves a kb dir name to its kbRoot and rejects unknown / traversal keys", async () => {
		const { configDir } = scaffold([{ dir: "jolliai", repoName: "jolliai" }]);
		const root = await resolveKbRoot(configDir, "jolliai");
		expect(root?.endsWith("jolliai")).toBe(true);
		expect(await resolveKbRoot(configDir, "nope")).toBeUndefined();
		expect(await resolveKbRoot(configDir, "..")).toBeUndefined();
	});
});

describe("readWikiBody", () => {
	it("reads a valid wiki file and rejects bad names / missing files", async () => {
		const { configDir } = scaffold([{ dir: "r", repoName: "r", wiki: { "topic--a.md": "# Hello\nbody" } }]);
		const kbRoot = (await resolveKbRoot(configDir, "r")) as string;
		expect(readWikiBody(kbRoot, "topic--a.md")).toContain("Hello");
		expect(readWikiBody(kbRoot, "../../etc/passwd")).toBeUndefined();
		expect(readWikiBody(kbRoot, "topic--missing.md")).toBeUndefined();
	});
});

describe("readGraphJson", () => {
	it("returns graph.json when present and undefined otherwise", async () => {
		const { configDir } = scaffold([
			{ dir: "g", repoName: "g", graph: '{"ok":true}' },
			{ dir: "n", repoName: "n" },
		]);
		const g = (await resolveKbRoot(configDir, "g")) as string;
		const n = (await resolveKbRoot(configDir, "n")) as string;
		expect(readGraphJson(g)).toBe('{"ok":true}');
		expect(readGraphJson(n)).toBeUndefined();
	});
});
