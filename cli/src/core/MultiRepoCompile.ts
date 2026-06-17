/**
 * MultiRepoCompile — runs the single-repo ingest unit over every repo in the
 * Memory Bank folder. Shared by `jolli compile` (no --cwd) and the VS Code
 * "Build Knowledge Wiki" button. Swept repos use folder-only storage (no orphan
 * working tree). Per-repo failures are isolated and reported, never swallowed.
 */

import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { createLogger } from "../Logger.js";
import { deriveMemoryBankRoot } from "../sync/SyncBootstrap.js";
import { withVaultWriteLock } from "../sync/VaultWriteLock.js";
import type { JolliMemoryConfig } from "../Types.js";
import { drainIngest, type IngestOptions } from "./IngestPipeline.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { purgeTopicPagesExcept } from "./TopicPageStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";

const log = createLogger("MultiRepoCompile");

export interface CompileAllRepoResult {
	readonly folder: string;
	readonly repoIdentity?: string;
	readonly ingested: number;
	readonly batches: number;
	readonly error?: string;
}

export interface CompileAllResult {
	readonly repos: CompileAllRepoResult[];
	readonly totalIngested: number;
	readonly failed: number;
	/** Set when the sweep was skipped because another compile already holds the lock. */
	readonly skipped?: boolean;
}

export interface CompileAllOptions extends Pick<IngestOptions, "batchSize"> {
	/**
	 * Optional one-line progress reporter for UI surfaces (the VS Code "Building
	 * knowledge wiki…" notification). Messages are prefixed with `[i/total] <repo>`
	 * so the user sees which repo and phase the sweep is on.
	 */
	readonly onProgress?: (message: string) => void;
}

export async function compileAllRepos(
	localFolder: string,
	config: JolliMemoryConfig,
	opts?: CompileAllOptions,
): Promise<CompileAllResult> {
	// This sweep writes each repo's canonical JSON and regenerates its `_wiki/` in
	// place. Serialise on the SAME `vault-write.lock` the QueueWorker and SyncEngine
	// hold (keyed off the vault root), so a sweep can't interleave on-disk writes
	// with a background worker ingest, a sync round, or a second sweep over the same
	// Memory Bank folder. NOTE: the risk is on-disk file contention, NOT in-memory
	// "global pollution" — `setActiveStorage` is per-process. The lock is PID-aware
	// (reclaims a crashed holder) and heartbeated by `withVaultWriteLock`, so a long
	// LLM-bearing drain can't be reaped mid-sweep.
	const vaultRoot = deriveMemoryBankRoot(localFolder);
	const result = await withVaultWriteLock(vaultRoot, "fail-fast", async () => {
		const targets = await discoverRepos(localFolder, config.compileExcludeFolders ?? []);
		const repos: CompileAllRepoResult[] = [];
		let totalIngested = 0;
		let failed = 0;
		const total = targets.length;

		// We swap the process-global storage override per repo (inner stores fall back
		// to it). Capture the prior value and restore it in a finally so the override
		// never leaks past this sweep into a long-lived host process (VS Code), where
		// it would silently point later reads/writes at the last-compiled repo.
		const previousStorage = getActiveStorage();
		try {
			for (const [i, t] of targets.entries()) {
				// `[i/total] <repo>: <phase>` — keeps the UI notification legible about
				// which repo and phase a long sweep is on.
				const report = (phase: string) => opts?.onProgress?.(`[${i + 1}/${total}] ${t.folder}: ${phase}`);
				try {
					const storage = createFolderStorageAtRoot(t.kbRoot);
					setActiveStorage(storage);
					report("ingesting sources");
					const { batches, ingested } = await drainIngest(t.kbRoot, config, {
						batchSize: opts?.batchSize,
						readStorage: storage,
						triggeredBy: "manual",
					});
					const index = await readTopicIndex(t.kbRoot, storage);
					await purgeTopicPagesExcept(
						index.topics.map((topic) => topic.stableSlug),
						t.kbRoot,
						storage,
					);
					report("rendering wiki");
					await renderTopicKBWiki(t.kbRoot, storage);
					// Build the knowledge graph from the freshly-ingested topic KB. Wrapped
					// non-fatal: a graph build failure or missing LLM key must never fail the
					// compile. Statically imported — unlike the SearchIndex warm-up below, the
					// graph module pulls no optional/native deps, so eager load is safe.
					try {
						await buildKnowledgeGraph(t.kbRoot, storage, config, {
							onProgress: (m) => report(`graph: ${m}`),
						});
					} catch (graphErr) {
						log.warn(
							"Knowledge graph build failed for %s (non-fatal): %s",
							t.folder,
							graphErr instanceof Error ? graphErr.message : String(graphErr),
						);
					}
					// Keep the local search index warm so query-time rebuilds are rare.
					// Disposable cache: a failure here must never fail the compile.
					// SearchIndex (→ @orama/*) is lazy-imported INSIDE this try so a
					// load failure is contained the same way the node:sqlite readers
					// are — a missing/incompatible orama degrades to "index not warmed",
					// it never crashes module load or the whole sweep.
					try {
						const { SearchIndex } = await import("./SearchIndex.js");
						await SearchIndex.rebuild(t.kbRoot, storage);
					} catch (idxErr) {
						log.warn(
							"Search index update failed for %s (non-fatal): %s",
							t.folder,
							idxErr instanceof Error ? idxErr.message : String(idxErr),
						);
					}
					totalIngested += ingested;
					repos.push({ folder: t.folder, repoIdentity: t.repoIdentity, ingested, batches });
					log.info("Compiled %s: %d source(s) in %d batch(es)", t.folder, ingested, batches);
				} catch (err) {
					failed++;
					const message = err instanceof Error ? err.message : String(err);
					repos.push({
						folder: t.folder,
						repoIdentity: t.repoIdentity,
						ingested: 0,
						batches: 0,
						error: message,
					});
					log.error("Compile failed for %s: %s", t.folder, message);
				}
			}
			return { repos, totalIngested, failed };
		} finally {
			setActiveStorage(previousStorage);
		}
	});

	if (!result.ran) {
		log.warn("Another vault writer is busy for %s — skipping this sweep", localFolder);
		return { repos: [], totalIngested: 0, failed: 0, skipped: true };
	}
	return result.value;
}
