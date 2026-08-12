/**
 * KnowledgeQuery — the Knowledge and Graph pages' data, read straight off the
 * Memory Bank folder on disk (NOT the dashboard SQLite, which carries no wiki).
 *
 * Repos are enumerated with `KBRepoDiscoverer.discoverRepos` under the user's
 * `localFolder`; each repo's browsable wiki is `<kbRoot>/_wiki/*.md`. Like
 * `RepositoriesQuery`, these are async file reads the model builder does BEFORE
 * the synchronous `buildDashboardModel`, and the result is threaded in via
 * `QueryOptions`.
 *
 * Two things this module is deliberate about:
 *
 *   - **`kb` is `DiscoveredRepo.dirName`, not a dashboard `repoIdentity`.** The
 *     Knowledge/Graph pages browse the Memory Bank *folder*, a different identity
 *     space from `dashboard-repos.json`. The `/wiki-viewer` and `/graph-viewer`
 *     routes resolve a `kb` back to a `kbRoot` through {@link resolveKbRoot} —
 *     which matches against `discoverRepos` output and NEVER joins caller input
 *     into a path, so a `../` `kb` cannot escape the Memory Bank root.
 *
 *   - **Every disk read is independently guarded.** `_wiki` is wiped and
 *     rewritten wholesale on each `jolli compile` (see `FolderStorage`), so an
 *     enumeration or a title read can hit a half-written tree. A failure yields a
 *     partial result (that repo/file dropped) rather than a 500 for the page.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRepos } from "../core/KBRepoDiscoverer.js";
import type { Manifest } from "../core/KBTypes.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import type { GraphModel, GraphRepo, KnowledgeFile, KnowledgeModel, KnowledgeRepo } from "./DashboardModel.js";

/** The visible wiki subfolder under a repo's `kbRoot`. */
const WIKI_DIR = "_wiki";

/**
 * The only file names the wiki layer produces, and the only ones the viewer will
 * open. A strict allowlist (not a `.md` glob) is the path-traversal guard for the
 * `file` route param — `..`, nested paths and dotfiles all fail it.
 */
export const WIKI_FILE_PATTERN = /^(_index\.md|topic--[\w.-]+\.md)$/;

/** Resolve the configured Memory Bank parent folder, if any. */
async function readLocalFolder(configDir?: string): Promise<string | undefined> {
	const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
	return config.localFolder;
}

/** True when the repo has a compiled graph the `/graph-viewer` can inline. */
function hasGraph(kbRoot: string): boolean {
	return existsSync(join(kbRoot, ".jolli", "graph", "graph.json"));
}

/**
 * A `_wiki` file name → manifest title map for one repo. Titles are per-FILE
 * (`ManifestEntry.path` + `.title`), not a single top-level name — keyed by
 * basename so it works whether the manifest stores `_wiki/x.md` or a bare name.
 * A missing/unreadable manifest yields an empty map (callers fall back to H1).
 */
function readTitleMap(kbRoot: string): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const manifest = JSON.parse(readFileSync(join(kbRoot, ".jolli", "manifest.json"), "utf8")) as Manifest;
		for (const entry of manifest.files ?? []) {
			if (entry.type !== "wiki" || !entry.title) continue;
			const base = entry.path.split(/[\\/]/).pop();
			if (base) map.set(base, entry.title);
		}
	} catch {
		// No manifest yet, or a wipe window (or a malformed entry — a non-string
		// `path`/`title` throws in here). The H1/file-name fallback covers it.
	}
	return map;
}

/** First `# ` heading of a wiki file, or undefined if unreadable / none. */
function readH1(kbRoot: string, file: string): string | undefined {
	try {
		const text = readFileSync(join(kbRoot, WIKI_DIR, file), "utf8");
		for (const line of text.split("\n")) {
			const m = line.match(/^#\s+(.+?)\s*$/);
			if (m) return m[1];
		}
	} catch {
		// Unreadable (wipe window) — caller falls back to the file name.
	}
	return undefined;
}

/**
 * The browsable wiki TOPICS of one repo, by title. The auto-generated
 * `_index.md` (a table of contents) is excluded — the page browses topics, not
 * the index. An unreadable `_wiki/` (absent, or mid-wipe) yields an empty list
 * rather than throwing — the page shows that repo with no files instead of erroring.
 */
function listWikiFiles(kbRoot: string): KnowledgeFile[] {
	let names: string[];
	try {
		names = readdirSync(join(kbRoot, WIKI_DIR));
	} catch {
		return [];
	}
	const titles = readTitleMap(kbRoot);
	const files: KnowledgeFile[] = [];
	for (const file of names) {
		if (file === "_index.md" || !WIKI_FILE_PATTERN.test(file)) continue;
		files.push({ file, title: titles.get(file) ?? readH1(kbRoot, file) ?? file });
	}
	files.sort((a, b) => a.title.localeCompare(b.title));
	return files;
}

/** Knowledge page: every Memory Bank repo's `_wiki` file list. */
export async function buildKnowledgeModel(configDir?: string): Promise<KnowledgeModel> {
	const localFolder = await readLocalFolder(configDir);
	const repos = discoverRepos(null, null, localFolder).map(
		(r): KnowledgeRepo => ({
			kb: r.dirName,
			repoName: r.repoName,
			graphAvailable: hasGraph(r.kbRoot),
			files: listWikiFiles(r.kbRoot),
		}),
	);
	return { repos };
}

/** Graph page: the repo picker's list (which repos have a compiled graph). */
export async function buildGraphModel(configDir?: string): Promise<GraphModel> {
	const localFolder = await readLocalFolder(configDir);
	const repos = discoverRepos(null, null, localFolder).map(
		(r): GraphRepo => ({ kb: r.dirName, repoName: r.repoName, graphAvailable: hasGraph(r.kbRoot) }),
	);
	return { repos };
}

/**
 * Resolve a `kb` route param to its `kbRoot`, or undefined when no Memory Bank
 * repo has that directory name. Matches against `discoverRepos` output rather
 * than joining `kb` into a path — the path-traversal guard for both viewer routes.
 */
export async function resolveKbRoot(configDir: string | undefined, kb: string): Promise<string | undefined> {
	const localFolder = await readLocalFolder(configDir);
	return discoverRepos(null, null, localFolder).find((r) => r.dirName === kb)?.kbRoot;
}

/**
 * One wiki file's markdown, or undefined for a bad name or an unreadable file.
 * The name is re-validated here (defence in depth) so this can never read outside
 * `_wiki/` even if a caller forgets the check.
 */
export function readWikiBody(kbRoot: string, file: string): string | undefined {
	if (!WIKI_FILE_PATTERN.test(file)) return undefined;
	try {
		return readFileSync(join(kbRoot, WIKI_DIR, file), "utf8");
	} catch {
		return undefined;
	}
}

/** One repo's `graph.json` text, or undefined when absent/unreadable. */
export function readGraphJson(kbRoot: string): string | undefined {
	try {
		return readFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), "utf8");
	} catch {
		return undefined;
	}
}
