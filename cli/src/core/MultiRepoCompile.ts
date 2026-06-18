/**
 * MultiRepoCompile — runs the single-repo ingest unit over every repo in the
 * Memory Bank folder. Shared by `jolli compile` (no --cwd) and the VS Code
 * "Build Knowledge Wiki" button. Swept repos use folder-only storage (no orphan
 * working tree). Per-repo failures are isolated and reported, never swallowed.
 */

import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { createLogger, getLogDir, resetLogDir, setLogDir } from "../Logger.js";
import { deriveMemoryBankRoot } from "../sync/SyncBootstrap.js";
import { DEFAULT_VAULT_WRITE_WAIT_MS, VaultWriteBusyError, withVaultWriteLock } from "../sync/VaultWriteLock.js";
import type { JolliMemoryConfig } from "../Types.js";
import { drainIngest, type IngestOptions } from "./IngestPipeline.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";
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
}

export interface CompileAllOptions extends Pick<IngestOptions, "batchSize"> {
	/**
	 * Optional one-line progress reporter for UI surfaces (the VS Code "Building
	 * knowledge wiki…" notification). Messages take the form `[i/total] <repo>:
	 * <phase>` so the user sees which repo (and how far through the sweep) plus the
	 * current phase.
	 */
	readonly onProgress?: (message: string) => void;
}

export async function compileAllRepos(
	localFolder: string,
	config: JolliMemoryConfig,
	opts?: CompileAllOptions,
): Promise<CompileAllResult> {
	// This sweep writes each repo's canonical JSON and regenerates its `_wiki/`. Rather
	// than hold `vault-write.lock` across the whole (multi-minute, LLM-bearing) drain —
	// which starved commit-summary workers that timed out waiting and left their queue
	// entries orphaned — it acquires the lock PER WRITE via `writeGuard` and runs the
	// reconcile LLM phase UNLOCKED. A concurrent commit-summary worker can then grab the
	// lock between our writes and generate its summary promptly ("build wiki" is
	// low-priority and may proceed slowly). Data safety is preserved by drainIngest's
	// guarded-write phase: topic pages re-read + compare before write (no clobber), the
	// index + processed-set are RMW under the same guard (no lost-update). The
	// releaseHook wakes any worker that still timed out waiting on a write (defense in
	// depth — see VaultWriteLock). The lock is keyed off the vault root (shared by all
	// repos under this Memory Bank folder), matching QueueWorker / SyncEngine.
	//
	// Dropping the whole-sweep lock means two sweeps over the same folder can now
	// overlap; that is safe (the same optimistic-concurrency / RMW guards apply), just
	// potentially redundant LLM work — so the sweep no longer reports a "skipped"
	// outcome (there is no longer a whole-sweep lock to contend for).
	const vaultRoot = deriveMemoryBankRoot(localFolder);
	// `launchWorker` is imported lazily (not at module top) so importing
	// MultiRepoCompile — which the VS Code "Build wiki" path does dynamically —
	// doesn't eagerly pull QueueWorker's transcript-reader/detector graph into the
	// compile path. A busy miss throws VaultWriteBusyError (a TYPED busy signal,
	// shared verbatim with the other per-write guards) so `drainIngest` can tell
	// transient contention apart from a real write fault. NOTE: this PER-WRITE guard
	// REPLACES the former whole-sweep `fail-fast` lock — the long, LLM-bearing drain
	// must NOT hold the vault lock or it re-starves the commit-summary workers this
	// fix unblocks. Two overlapping sweeps are safe (optimistic-concurrency / RMW).
	const { launchWorker } = await import("../hooks/QueueWorker.js");
	const writeGuard = async (fn: () => Promise<void>): Promise<void> => {
		const r = await withVaultWriteLock(vaultRoot, { wait: DEFAULT_VAULT_WRITE_WAIT_MS }, fn, {
			launch: launchWorker,
		});
		if (!r.ran) throw new VaultWriteBusyError();
	};

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
	// Capture the global log dir too: we re-point it per repo (below) so each repo's
	// ingest/graph logs land in its OWN <kbRoot>/.jolli/jollimemory/debug.log instead
	// of the host process's cwd. Restored in the finally so the override never leaks
	// into the long-lived VS Code host past this sweep.
	const previousLogDir = getLogDir();
	try {
		for (const [i, t] of targets.entries()) {
			// `[i/total] <repo>: <phase>` — keeps the UI notification legible about
			// which repo and phase a long sweep is on.
			const report = (phase: string) => opts?.onProgress?.(`[${i + 1}/${total}] ${t.folder}: ${phase}`);
			try {
				setLogDir(t.kbRoot);
				const storage = createFolderStorageAtRoot(t.kbRoot);
				setActiveStorage(storage);
				report("ingesting sources");
				const { batches, ingested } = await drainIngest(t.kbRoot, config, {
					batchSize: opts?.batchSize,
					readStorage: storage,
					triggeredBy: "manual",
					writeGuard,
				});
				// NO purge here: with the lock released between writes a concurrent ingest
				// can add a topic page not yet in our index snapshot, and purging
				// "everything not in the index" would delete it (data loss). Orphan pages
				// from topic consolidation are reclaimed by an explicit `jolli compile
				// --cwd <repo> --rebuild`, never by the routine sweep.
				report("rendering wiki");
				await renderTopicKBWiki(t.kbRoot, storage, writeGuard);
				// Build the knowledge graph from the freshly-ingested topic KB. Wrapped
				// non-fatal: a graph build failure or missing LLM key must never fail the
				// compile. Run UNGUARDED — it is LLM-bearing, so holding vault-write.lock
				// across it would re-create the commit-blocking stall this fix removes
				// (the graph is a derived artifact, regenerated on the next sweep).
				try {
					report("building knowledge graph");
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
					await writeGuard(async () => {
						await SearchIndex.rebuild(t.kbRoot, storage);
					});
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
		if (previousLogDir === undefined) resetLogDir();
		else setLogDir(previousLogDir);
	}
}
