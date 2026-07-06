import { join } from "node:path";
import type * as vscode from "vscode";
import type { CommitSummary, FileWrite } from "../../../cli/src/Types.js";
import { FolderStorage } from "../../../cli/src/core/FolderStorage.js";
import { MetadataManager } from "../../../cli/src/core/MetadataManager.js";
import type { StorageProvider } from "../../../cli/src/core/StorageProvider.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { sharedRepoIdentityMatches } from "../util/GitRemoteUtils.js";
import { log } from "../util/Logger.js";
import type { SharedBranchExport, SharedCommitExport } from "./JolliShareService.js";

/** The materialized shared branch, ready to hand to a {@link SummaryWebviewPanel}. */
export interface ImportedSharedBranch {
	/** Storage the panel reads plan/note/transcript fold bodies from. */
	readonly storage: StorageProvider;
	/** The head commit's summary — what the panel renders. */
	readonly head: CommitSummary;
	/** How many commits carried a usable structured summary. */
	readonly commitCount: number;
	/**
	 * True when the share was ingested into the CURRENTLY-OPEN repo's memory (via
	 * `storeSummary` — index.json + catalog + orphan branch), so `recall`/`search`
	 * for the shared branch now surface it, and `head` is a first-class local summary.
	 * The caller renders a normal writable local panel instead of the read-only shared
	 * view. False for the pure-external sandbox case (display-only, not recallable).
	 */
	readonly ingestedLocally: boolean;
}

/**
 * Whether an untrusted `/export` field is safe to interpolate into a write path — i.e. a
 * single filesystem segment: a non-empty `[A-Za-z0-9._-]` string that is neither `.` nor
 * `..` (both would otherwise pass the char class). This is the SharedBranchImporter twin of
 * {@link KbFoldersService.validateRelPath}: the backend that produces `slug` / `note.id` /
 * `commitHash` lives in a separate repo, so plugin-side validation is the trust boundary
 * that keeps a hostile value like `../../otherRepo/.jolli/plans/pwn` out of the write path.
 *
 * The `FolderStorage` symlink guard does NOT backstop this: its containment check is anchored
 * at `<localFolder>` (`dirname` of the per-repo root), so a `..` that stays inside the Memory
 * Bank folder but escapes the current repo sails through and can clobber a SIBLING repo's bank.
 * `generatePlanMarkdown` re-derives the slug from the write path, so validating here also
 * covers the visible `<branch>/plan--<slug>.md` layer, not just the hidden `plans/<slug>.md`.
 */
function isSafeSegment(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Read `field` off an untrusted object and return it only when it is a safe path segment. */
function safeSegmentField(obj: unknown, field: "slug" | "id"): string | null {
	if (typeof obj !== "object" || obj === null) return null;
	const value = (obj as Record<string, unknown>)[field];
	return isSafeSegment(value) ? value : null;
}

/** Sanitize a repo name into a filesystem-safe directory segment for the fallback import dir. */
function slugForDir(repoName: string): string {
	const slug = repoName
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		// Strip leading/trailing dots too, so a name of "." / ".." can't survive as a
		// path segment that escapes the import root (join(root, "..") → the parent dir).
		.replace(/^[.-]+|[.-]+$/g, "")
		.toLowerCase();
	return slug || "repo";
}

/**
 * Parse + validate one commit's sanitized summary.json. Returns null (and logs) when the
 * envelope `commitHash` is missing/unsafe, or when the body is absent, unparseable, not an
 * object, or its `commitHash` is missing / unsafe / disagrees with the envelope's. `/export`
 * only guarantees `commits` is an array — a truncated or misrouted payload can carry an
 * element with no `commitHash` (so `commitHash.slice(…)` would throw a raw TypeError) or a
 * body like `"{}"` that parses fine but has no `commitHash`. Since the ingest path keys the
 * index by `commitHash` (`storeSummary`), the panel keys its map the same way, and the
 * sandbox path writes `summaries/<commitHash>.json`, the hash must be both present and a safe
 * path segment: an unvalidated cast would index/render under `undefined` or let a hostile hash
 * traverse the write path. Requiring the inner hash to equal the (validated) envelope hash the
 * backend routed by rejects the mismatch cases too.
 */
function parseCommitSummary(commit: SharedCommitExport): CommitSummary | null {
	if (!isSafeSegment(commit.commitHash)) {
		log.warn("SharedBranchImporter", `skipping commit — missing or unsafe commitHash (${String(commit.commitHash)})`);
		return null;
	}
	if (!commit.summaryJson) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(commit.summaryJson);
	} catch {
		log.warn("SharedBranchImporter", `skipping commit ${commit.commitHash.slice(0, 8)} — unparseable summary.json`);
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		log.warn("SharedBranchImporter", `skipping commit ${commit.commitHash.slice(0, 8)} — summary.json is not an object`);
		return null;
	}
	const summary = parsed as CommitSummary;
	if (summary.commitHash !== commit.commitHash) {
		log.warn(
			"SharedBranchImporter",
			`skipping commit ${commit.commitHash.slice(0, 8)} — summary.json commitHash mismatch (${String(summary.commitHash)})`,
		);
		return null;
	}
	return summary;
}

/**
 * Reconstruct plan/note body files for one commit so the panel's folds resolve. The
 * export ships attachment bodies keyed by title (the doc's first heading); the structured
 * summary carries the plan slugs / note ids. Match by title (they share the same source
 * heading) and write `plans/<slug>.md` / `notes/<id>.md` in the doc's original shape.
 * Snippet notes carry their body inline (`NoteReference.content`) and need no file.
 *
 * `plans` / `notes` are treated as untrusted: a non-array value is coerced to empty (a raw
 * `for..of` over `123` would throw), and each `slug` / `id` must be a safe path segment
 * ({@link isSafeSegment}) before it reaches the write path — a hostile `slug` could otherwise
 * traverse out of the per-repo bank (see the isSafeSegment docstring for why the vault guard
 * doesn't catch it).
 *
 * Files land in a path-keyed map: a slug referenced by several commits resolves to one
 * entry, and the caller feeds the head commit last so its body wins the duplicate.
 */
function collectAttachmentFiles(
	commit: SharedCommitExport,
	summary: CommitSummary,
	branch: string,
	files: Map<string, FileWrite>,
): void {
	// Bodies are keyed by title (the doc's first heading), but a commit can carry two
	// docs sharing a title — so consume them as an in-order queue per title instead of a
	// last-write-wins Map, or the second same-titled doc would steal the first's body.
	const bodiesByTitle = new Map<string, string[]>();
	for (const a of commit.attachments) {
		const queue = bodiesByTitle.get(a.title);
		if (queue) queue.push(a.body);
		else bodiesByTitle.set(a.title, [a.body]);
	}
	const takeBody = (title: string): string | undefined => bodiesByTitle.get(title)?.shift();
	for (const plan of Array.isArray(summary.plans) ? summary.plans : []) {
		const slug = safeSegmentField(plan, "slug");
		if (slug === null) {
			log.warn("SharedBranchImporter", `skipping plan with missing or unsafe slug (${String(plan?.slug)})`);
			continue;
		}
		const body = takeBody(plan.title);
		if (body !== undefined) {
			const path = `plans/${slug}.md`;
			files.set(path, { path, content: `# ${plan.title}\n\n${body}`, branch });
		}
	}
	for (const note of Array.isArray(summary.notes) ? summary.notes : []) {
		const id = safeSegmentField(note, "id");
		if (id === null) {
			log.warn("SharedBranchImporter", `skipping note with missing or unsafe id (${String(note?.id)})`);
			continue;
		}
		const body = note.content ?? takeBody(note.title);
		if (body !== undefined) {
			const path = `notes/${id}.md`;
			files.set(path, { path, content: `# ${note.title}\n\n${body}`, branch });
		}
	}
}

/** Zero-fill a missing root `diffStats` so `storeSummary`'s `flattenSummaryTree` skips the
 * `getDiffStats` (`git diff <hash>^..<hash>`) fallback on a commit the recipient's checkout
 * may not even have. `flattenSummaryTree` still calls `getTreeHash` per node unconditionally,
 * but that degrades gracefully (returns null for a commit not in the object store → the index
 * entry is simply written without a `treeHash`); it is the `git diff` that this guards. */
function ensureDiffStats(summary: CommitSummary): CommitSummary {
	if (summary.diffStats) return summary;
	return { ...summary, diffStats: { filesChanged: 0, insertions: 0, deletions: 0 } };
}

/** Read + parse a summary JSON from a storage; null (and log) on absence/parse error. */
async function readStoredSummary(storage: StorageProvider, commitHash: string): Promise<CommitSummary | null> {
	const json = await storage.readFile(`summaries/${commitHash}.json`);
	if (!json) return null;
	try {
		return JSON.parse(json) as CommitSummary;
	} catch {
		log.warn("SharedBranchImporter", `local summary for ${commitHash.slice(0, 8)} is unparseable`);
		return null;
	}
}

/**
 * The head summary to render, local-authoritative-first: the target bank's own copy when it
 * pre-exists (a superset of the lossy export), else the just-parsed export head, else the
 * first parsed commit. Shared by the ingest and display-only paths so the precedence stays
 * one contract. `summaryByHash` is non-empty by the time this runs.
 */
async function resolveHeadSummary(
	storage: StorageProvider,
	data: SharedBranchExport,
	summaryByHash: Map<string, CommitSummary>,
): Promise<CommitSummary> {
	return (
		(await readStoredSummary(storage, data.headCommitHash)) ??
		summaryByHash.get(data.headCommitHash) ??
		[...summaryByHash.values()][0]
	);
}

/** Collect plan/note fold bodies for every parsed commit, head last so its body wins a
 * slug shared across commits. */
function collectAllAttachmentFiles(
	data: SharedBranchExport,
	summaryByHash: Map<string, CommitSummary>,
): Map<string, FileWrite> {
	const files = new Map<string, FileWrite>();
	const ordered = [...data.commits].sort((a, b) =>
		Number(a.commitHash === data.headCommitHash) - Number(b.commitHash === data.headCommitHash),
	);
	for (const commit of ordered) {
		const summary = summaryByHash.get(commit.commitHash);
		if (summary) collectAttachmentFiles(commit, summary, data.branch, files);
	}
	return files;
}

/**
 * Materialize a downloaded shared branch, in one of three modes keyed on where the
 * recipient stands relative to the share's repo. Returns null when no commit carried a
 * usable structured summary (e.g. a legacy share with no sidecar).
 *
 * 1. **Currently-open repo** (`ingestedLocally: true`) — the share is for the repo the
 *    recipient has open. Each commit they don't already have is REALLY ingested via
 *    `bridge.storeSummary` (force=false → the commitHash duplicate guard skips ones they
 *    have under any branch, so their authoritative copy is never clobbered), which writes
 *    the summary + index.json + catalog on the orphan branch (system of record) + folder.
 *    That is what makes `recall <branch>` / `search` surface the shared content — the
 *    whole point of importing. Plan/note fold bodies are filled into the repo's folder
 *    (gaps only) and the caller renders a normal writable local panel.
 *
 *    Caveat: this requires the folder layer. Under `storageMode === "orphan"`
 *    `createReadStorageForCurrentRepo` returns null, so an orphan-only user opening a share
 *    of their OWN repo silently falls through to mode 3 (read-only sandbox) and the share is
 *    never indexed for recall/search. Acceptable today (fold bodies need the folder), but a
 *    known capability gap, not a repo-identity decision.
 *
 * 2. **Foreign local repo, not open** — a discovered bank for a different repo. recall /
 *    search are scoped to the active repo, so ingesting here buys nothing until it's
 *    opened, and `storeSummary` would need that repo's own cwd/lock. Treated as display-
 *    only: fill plan/note gaps into its folder, render read-only foreign.
 *
 * 3. **No local repo** (pure external recipient) — a dedicated import dir under the
 *    extension's global storage, OUTSIDE the Memory-Bank discovery namespace (so it never
 *    masquerades as a real repo, and stays invisible to recall/search — there is no repo
 *    context to search it within). Holds nothing but share copies, so plan/note bodies AND
 *    the raw summary JSON are written and overwritten freely (single-slot re-visits stay
 *    fresh), making the dir a self-contained re-openable copy. Rendered read-only.
 *
 * Local-authoritative-first for display in modes 2/3: when the target bank already holds
 * the head summary, `head` is that (superset) local copy, not the export's lossy one.
 */
export async function importSharedBranchForDisplay(
	data: SharedBranchExport,
	bridge: JolliMemoryBridge,
	context: vscode.ExtensionContext,
): Promise<ImportedSharedBranch | null> {
	const summaryByHash = new Map<string, CommitSummary>();
	for (const commit of data.commits) {
		const summary = parseCommitSummary(commit);
		if (summary) summaryByHash.set(commit.commitHash, summary);
	}
	if (summaryByHash.size === 0) return null;

	// createStorageForRepo is foreign-only (it skips the isCurrentRepo entry), so a share
	// of the repo the recipient has open needs the current-repo lookup, gated on an
	// identity check so a share of some OTHER repo never lands in the current repo's bank.
	const foreign = await bridge.createStorageForRepo(data.repoName, data.repoUrl);
	if (foreign) {
		return await importDisplayOnly(data, summaryByHash, foreign.storage);
	}
	const current = await bridge.createReadStorageForCurrentRepo();
	if (current && sharedRepoIdentityMatches(data.repoName, data.repoUrl, current.repoName, current.remoteUrl)) {
		return await ingestIntoCurrentRepo(data, summaryByHash, bridge, current.storage);
	}

	// Pure external: sandbox dir under global storage, outside the discovery namespace.
	const importRoot = join(context.globalStorageUri.fsPath, "shared-imports", slugForDir(data.repoName));
	const sandbox = new FolderStorage(importRoot, new MetadataManager(join(importRoot, ".jolli")));
	return await importDisplayOnly(data, summaryByHash, sandbox, { persistSummaries: true, overwrite: true });
}

/**
 * Mode 1: really ingest the commits the recipient lacks into the currently-open repo so
 * `recall`/`search` find them, then hand back the local writable view.
 */
async function ingestIntoCurrentRepo(
	data: SharedBranchExport,
	summaryByHash: Map<string, CommitSummary>,
	bridge: JolliMemoryBridge,
	folderStorage: StorageProvider,
): Promise<ImportedSharedBranch> {
	let ingested = 0;
	for (const summary of summaryByHash.values()) {
		// force=false: the commitHash duplicate guard keeps the recipient's own summary
		// (under whatever branch) instead of overwriting it with the lossy export.
		await bridge.storeSummary(ensureDiffStats(summary), false);
		ingested++;
	}
	log.info("SharedBranchImporter", `ingested ${ingested} shared commit(s) into the current repo for recall/search`);

	// Plan/note fold bodies → the repo's folder (gaps only): the writable panel reads
	// folds from this same folder storage (the sidebar's local-commit path does the same).
	const files = collectAllAttachmentFiles(data, summaryByHash);
	if (files.size > 0) {
		const existing = new Set([
			...(await folderStorage.listFiles("plans")),
			...(await folderStorage.listFiles("notes")),
		]);
		const toWrite = [...files.values()].filter(f => !existing.has(f.path));
		if (toWrite.length > 0) await folderStorage.writeFiles(toWrite, "shared branch import (plan/note bodies)");
	}

	// Prefer whatever authoritative summary now backs the head (the recipient's own if it
	// pre-existed, else the just-ingested one).
	const head = await resolveHeadSummary(folderStorage, data, summaryByHash);
	return { storage: folderStorage, head, commitCount: summaryByHash.size, ingestedLocally: true };
}

/**
 * Modes 2/3: no ingest — write plan/note fold bodies (and, for the sandbox, the raw
 * summary JSON) into `storage`, then render read-only. `fillGaps` protects a real bank's
 * existing files; the sandbox overwrites freely.
 */
async function importDisplayOnly(
	data: SharedBranchExport,
	summaryByHash: Map<string, CommitSummary>,
	storage: StorageProvider,
	opts: { persistSummaries?: boolean; overwrite?: boolean } = {},
): Promise<ImportedSharedBranch> {
	const files = collectAllAttachmentFiles(data, summaryByHash);
	if (opts.persistSummaries) {
		// Sandbox only: raw summary JSON makes the dir a self-contained re-openable copy.
		for (const commit of data.commits) {
			if (summaryByHash.has(commit.commitHash) && commit.summaryJson) {
				files.set(`summaries/${commit.commitHash}.json`, {
					path: `summaries/${commit.commitHash}.json`,
					content: commit.summaryJson,
					branch: data.branch,
				});
			}
		}
	}
	if (files.size > 0) {
		let toWrite = [...files.values()];
		if (!opts.overwrite) {
			// Real bank: fill gaps only — the local authoritative version always wins.
			const existing = new Set([...(await storage.listFiles("plans")), ...(await storage.listFiles("notes"))]);
			toWrite = toWrite.filter(f => !existing.has(f.path));
			if (toWrite.length < files.size) {
				log.info(
					"SharedBranchImporter",
					`kept ${files.size - toWrite.length} existing local file(s) — the share only fills gaps`,
				);
			}
		}
		if (toWrite.length > 0) await storage.writeFiles(toWrite, "shared branch import (display)");
	}

	// Local-authoritative-first: show the bank's own head summary over the lossy import.
	const head = await resolveHeadSummary(storage, data, summaryByHash);
	return { storage, head, commitCount: summaryByHash.size, ingestedLocally: false };
}
