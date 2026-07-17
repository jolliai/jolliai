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
import { type CompileErrorKind, classifyCompileError } from "./CompileErrors.js";
import { withCompileLock } from "./CompileMutex.js";
import { type CompileProgressEvent, isAbortError, phaseLabel } from "./CompileProgress.js";
import { drainIngest, type IngestOptions, type TopicProgress } from "./IngestPipeline.js";
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
	/**
	 * Classification of `error`, populated whenever a repo raises. `undefined`
	 * on success. Consumers should default-branch on unknown values — new
	 * kinds may be added (see `CompileErrors.ts`).
	 */
	readonly errorKind?: CompileErrorKind;
}

export interface CompileAllResult {
	readonly repos: CompileAllRepoResult[];
	readonly totalIngested: number;
	readonly failed: number;
}

export interface CompileAllOptions extends Pick<IngestOptions, "batchSize"> {
	/**
	 * Optional one-line progress reporter for UI surfaces (the VS Code progress
	 * notification). Each message is a self-contained `<label> — <repo> [(<detail>)]`
	 * line: the label is one of the two top-level phases ("Building knowledge wiki"
	 * / "Building knowledge graph"), `<repo>` is the folder being swept, and the
	 * optional `(<detail>)` is the graph distiller's sub-progress. wiki/graph are
	 * surfaced as two peers (ingest + render are merged into "Building knowledge
	 * wiki" — no separate "rendering" line). Ingest sub-phase adds a
	 * `— batch <i>` counter when drainIngest reports batch-level progress; VS
	 * Code's Progress notification treats it as an in-place update.
	 */
	readonly onProgress?: (message: string) => void;
	/**
	 * Structured progress reporter — fires alongside `onProgress` so hosts can
	 * i18n / color-code / group by phase without parsing the pre-formatted
	 * `<label> — <repo> (<detail>)` string back apart. Two consumers on the
	 * same sweep (a VS Code notification wants the string, a desktop banner
	 * wants the structure) can each pick their preferred shape.
	 */
	readonly onProgressEvent?: (event: CompileProgressEvent) => void;
	/**
	 * Fine-grained per-topic progress — forwarded straight down to `drainIngest`
	 * so a host can render "reconciled N of M topics" while a batch's reconcile
	 * fan-out is in flight (the phase that otherwise looks stalled for tens of
	 * seconds). Fires `topicsInBatch` times per batch. Absent by default; hosts
	 * that only want phase-level ticks omit it. Errors thrown by the callback are
	 * swallowed inside the pipeline — progress display can never fail a compile.
	 */
	readonly onTopic?: (progress: TopicProgress) => void;
	/**
	 * Cooperative cancellation. Checked between repos and before each repo's graph
	 * and search-index phases, and threaded into `drainIngest` (checked between
	 * batches AND forwarded into the route/reconcile LLM calls, so an in-flight
	 * ingest call is torn down promptly). The graph build itself does NOT receive
	 * the signal — once started it runs to completion, so a mid-graph abort is only
	 * observed when the build returns (see the graph phase below). Throws
	 * `AbortError` when triggered mid-sweep; a signal aborted before the first repo
	 * throws before any work starts.
	 */
	readonly signal?: AbortSignal;
}

export function compileAllRepos(
	localFolder: string,
	config: JolliMemoryConfig,
	opts?: CompileAllOptions,
): Promise<CompileAllResult> {
	// Serialize process-wide: the sweep swaps the process-global storage override
	// per repo, so an overlapping in-process compile would stomp it (see
	// CompileMutex). Cross-process sweeps are unaffected — each has its own global.
	return withCompileLock(() => compileAllReposLocked(localFolder, config, opts));
}

async function compileAllReposLocked(
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
	// overlap ACROSS PROCESSES; that is safe (the same optimistic-concurrency / RMW
	// guards apply), just potentially redundant LLM work — so the sweep no longer
	// reports a "skipped" outcome (there is no longer a whole-sweep lock to contend
	// for). In-process overlap is a different matter — two sweeps in one process
	// would stomp the shared `setActiveStorage` override — and is prevented by the
	// process-wide `withCompileLock` gate on the exported entry point above.
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
	// Pre-sweep abort: no work, no side-effects. Matches the "cancelled call is a
	// no-op" contract the desktop UI relies on for undo-safe cancel.
	if (opts?.signal?.aborted) throw abortError();
	try {
		for (const t of targets) {
			// Self-contained `<label> — <repo> [(<detail>)]` lines so the notification
			// reads as two peer phases (wiki / graph) on a named repo, not a counter.
			// Also fire the structured `onProgressEvent` with the same info split into
			// `{ phase, repo, detail, batchIndex }` — string- and struct-consuming UIs
			// stay in lockstep. Both callbacks are wrapped so a throw never sinks
			// the sweep.
			const phaseMsg = (phase: CompileProgressEvent["phase"], detail?: string, batchIndex?: number) => {
				const label = phaseLabel(phase);
				const line = detail ? `${label} — ${t.folder} (${detail})` : `${label} — ${t.folder}`;
				try {
					opts?.onProgress?.(line);
				} catch (e) {
					log.warn("onProgress threw (ignored): %s", e instanceof Error ? e.message : String(e));
				}
				try {
					opts?.onProgressEvent?.({ phase, repo: t.folder, detail, batchIndex });
				} catch (e) {
					log.warn("onProgressEvent threw (ignored): %s", e instanceof Error ? e.message : String(e));
				}
			};
			// Cancel between repos — cheapest granularity. A repo that already
			// started completes; the sweep just stops before touching the next one.
			if (opts?.signal?.aborted) throw abortError();
			try {
				setLogDir(t.kbRoot);
				const storage = createFolderStorageAtRoot(t.kbRoot);
				setActiveStorage(storage);
				// ingest + render are one user-facing phase: "Building knowledge wiki".
				phaseMsg("wiki");
				const { batches, ingested } = await drainIngest(t.kbRoot, config, {
					batchSize: opts?.batchSize,
					readStorage: storage,
					triggeredBy: "manual",
					writeGuard,
					signal: opts?.signal,
					// Batch-level detail rides on the same wiki phase label so the UI
					// shows "Building knowledge wiki — myrepo — batch 3" as one
					// evolving line, not a second concurrent phase. No /total —
					// pendingCount isn't known until batch 1 returns and the drain's
					// batch count depends on route decisions we can't predict.
					onBatch: (bp) => phaseMsg("wiki", `batch ${bp.batchIndex}`, bp.batchIndex),
					onTopic: opts?.onTopic,
				});
				// NO purge here: with the lock released between writes a concurrent ingest
				// can add a topic page not yet in our index snapshot, and purging
				// "everything not in the index" would delete it (data loss). Orphan pages
				// from topic consolidation are reclaimed by an explicit `jolli compile
				// --cwd <repo> --rebuild`, never by the routine sweep.
				await renderTopicKBWiki(t.kbRoot, storage, writeGuard);
				// Between-phase cancel: if aborted after the wiki phase, skip the
				// graph build (and search-index warm-up below) rather than kicking
				// off another minute-scale LLM stage for a result the user asked us
				// to abandon.
				if (opts?.signal?.aborted) throw abortError();
				// Build the knowledge graph from the freshly-ingested topic KB. Wrapped
				// non-fatal: a graph build failure or missing LLM key must never fail the
				// compile. Run UNGUARDED — it is LLM-bearing, so holding vault-write.lock
				// across it would re-create the commit-blocking stall this fix removes
				// (the graph is a derived artifact, regenerated on the next sweep).
				//
				// Cancellation is honored BEFORE this phase (the between-phase check just
				// above), not during it: `buildKnowledgeGraph` does not receive `signal`,
				// so once the graph build starts it runs to completion even if the caller
				// aborts mid-build. Threading the signal through the whole distiller was
				// judged too invasive for the latency it would save on an artifact
				// regenerated next sweep.
				try {
					phaseMsg("graph");
					await buildKnowledgeGraph(t.kbRoot, storage, config, {
						onProgress: (m) => phaseMsg("graph", m),
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
					// Emit the search-index phase so struct-consuming UIs see the same
					// phase sequence on the sweep as on the single-repo path.
					phaseMsg("search-index");
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
				// AbortError is a sweep-wide signal, not a per-repo failure — bubble
				// out so the outer promise rejects with AbortError and the caller can
				// distinguish "user cancelled" from "one repo threw".
				if (isAbortError(err)) throw err;
				failed++;
				const message = err instanceof Error ? err.message : String(err);
				const errorKind = classifyCompileError(err);
				repos.push({
					folder: t.folder,
					repoIdentity: t.repoIdentity,
					ingested: 0,
					batches: 0,
					error: message,
					errorKind,
				});
				log.error("Compile failed for %s: %s (kind=%s)", t.folder, message, errorKind);
			}
		}
		return { repos, totalIngested, failed };
	} finally {
		setActiveStorage(previousStorage);
		if (previousLogDir === undefined) resetLogDir();
		else setLogDir(previousLogDir);
	}
}

/** Standard Web-platform AbortError so callers detect cancel via `err.name`. */
function abortError(): DOMException {
	return new DOMException("Compile cancelled", "AbortError");
}
