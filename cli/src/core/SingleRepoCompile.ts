/**
 * SingleRepoCompile — the compile pipeline for ONE repo, extracted so that
 * out-of-process hosts (`jolli compile --cwd <dir>`, the VS Code plugin's
 * per-repo rebuild, the desktop cockpit's per-Wiki-tab rebuild button) can
 * drive it without duplicating the vault-write dance, the rebuild reset, the
 * wiki re-render, the graph build, or the search-index warm-up.
 *
 * Same shape as {@link compileAllRepos}: `onProgress` streams phase-level
 * lines, `signal` cooperatively cancels between phases, and per-write
 * `vault-write.lock` acquisition mirrors the sweep so a long ingest never
 * blocks commit-summary generation. Errors returned as a result envelope
 * instead of thrown — hosts render specific copy per failure kind.
 */

import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { createLogger } from "../Logger.js";
import { deriveMemoryBankRoot } from "../sync/SyncBootstrap.js";
import { DEFAULT_VAULT_WRITE_WAIT_MS, VaultWriteBusyError, withVaultWriteLock } from "../sync/VaultWriteLock.js";
import type { JolliMemoryConfig } from "../Types.js";
import { type CompileErrorKind, classifyCompileError } from "./CompileErrors.js";
import { withCompileLock } from "./CompileMutex.js";
import { type CompileProgressEvent, isAbortError, phaseLabel } from "./CompileProgress.js";
import type { IngestCode } from "./IngestErrors.js";
import { drainIngest, type IngestOptions, type TopicProgress } from "./IngestPipeline.js";
import { hasLlmCredentials } from "./LlmClient.js";
import { emptyProcessedSet, saveProcessedSet } from "./ProcessedSourceStore.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";
import { emptyTopicIndex, readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import { purgeTopicPagesExcept } from "./TopicPageStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";

const log = createLogger("SingleRepoCompile");

export interface CompileSingleRepoOptions extends Pick<IngestOptions, "batchSize"> {
	/**
	 * Explicit read/write storage for hosts that already resolved a folder-canonical
	 * Memory Bank root and do not have a Git working tree to derive it from.
	 */
	readonly storage?: StorageProvider;
	/**
	 * When true, wipe the processed-set + topic index BEFORE ingesting so every
	 * source is replayed from scratch. Enables the post-ingest orphan-page purge.
	 */
	readonly rebuild?: boolean;
	/**
	 * Legacy string progress reporter — one self-contained `<label> — <repo>` line
	 * per phase. Kept BC-compatible with `compileAllRepos.onProgress`.
	 */
	readonly onProgress?: (message: string) => void;
	/**
	 * Structured progress reporter — same phases as `onProgress` but shaped so
	 * consumers can style / color-code / i18n without parsing the line back apart.
	 * Fired ALONGSIDE `onProgress` so hosts can pick either or both.
	 */
	readonly onProgressEvent?: (event: CompileProgressEvent) => void;
	/**
	 * Fine-grained per-topic progress — forwarded to `drainIngest` so a host can
	 * render "reconciled N of M topics" during a batch's reconcile fan-out (the
	 * phase that otherwise looks stalled for tens of seconds). Fires
	 * `topicsInBatch` times per batch. Absent by default. Errors thrown by the
	 * callback are swallowed inside the pipeline — progress can never fail a compile.
	 */
	readonly onTopic?: (progress: TopicProgress) => void;
	/**
	 * Cooperative cancellation. Threaded into `drainIngest` (checked between
	 * batches AND forwarded into the route/reconcile LLM calls, so an in-flight
	 * ingest call is torn down promptly) and re-checked before the graph and
	 * search-index phases. The graph build itself does NOT receive the signal —
	 * once it starts it runs to completion, so a mid-graph abort is only observed
	 * when the build returns (see the graph phase below). An abort before a phase
	 * returns `cancelled` without doing that phase's work.
	 */
	readonly signal?: AbortSignal;
}

export type CompileSingleRepoFailureReason =
	| { readonly kind: "noApiKey" }
	| { readonly kind: "vaultBusy" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "internal"; readonly message: string; readonly errorKind: CompileErrorKind };

export interface CompileSingleRepoSuccess {
	readonly ok: true;
	readonly ingested: number;
	readonly batches: number;
	readonly outcome: IngestCode;
	readonly topicFailures: readonly { readonly slug: string; readonly code: IngestCode }[];
}

export interface CompileSingleRepoFailure {
	readonly ok: false;
	readonly failure: CompileSingleRepoFailureReason;
}

export type CompileSingleRepoResult = CompileSingleRepoSuccess | CompileSingleRepoFailure;

/**
 * Compile a single repo rooted at `cwd`. Returns a discriminated result rather
 * than throwing on expected failures (missing API key, vault busy, cancel), so
 * out-of-process hosts can render per-kind copy. Genuinely unexpected errors
 * are captured as `{kind: 'internal'}` with a classified `errorKind`.
 */
export function compileSingleRepo(
	cwd: string,
	config: JolliMemoryConfig,
	opts?: CompileSingleRepoOptions,
): Promise<CompileSingleRepoResult> {
	// Serialize process-wide with every other compile: this swaps the process-
	// global storage override, so an overlapping in-process compile (another tab's
	// rebuild, a concurrent sweep) would stomp it (see CompileMutex).
	return withCompileLock(() => compileSingleRepoLocked(cwd, config, opts));
}

async function compileSingleRepoLocked(
	cwd: string,
	config: JolliMemoryConfig,
	opts?: CompileSingleRepoOptions,
): Promise<CompileSingleRepoResult> {
	if (!hasLlmCredentials(config)) {
		return { ok: false, failure: { kind: "noApiKey" } };
	}

	const rebuild = opts?.rebuild === true;
	const emit = (phase: CompileProgressEvent["phase"], detail?: string, batchIndex?: number) => {
		const repo = cwd;
		const line = detail ? `${phaseLabel(phase)} — ${repo} (${detail})` : `${phaseLabel(phase)} — ${repo}`;
		try {
			opts?.onProgress?.(line);
		} catch (e) {
			log.warn("onProgress threw (ignored): %s", e instanceof Error ? e.message : String(e));
		}
		try {
			opts?.onProgressEvent?.({ phase, repo, detail, batchIndex });
		} catch (e) {
			log.warn("onProgressEvent threw (ignored): %s", e instanceof Error ? e.message : String(e));
		}
	};

	if (opts?.signal?.aborted) return { ok: false, failure: { kind: "cancelled" } };

	// Storage swap — capture and restore so a single-repo compile doesn't leak
	// the override into a long-lived host (mirrors compileAllRepos).
	const storage = opts?.storage ?? (await createStorage(cwd, cwd));
	const previousStorage = getActiveStorage();

	// Vault-write guard: per-write lock so the long LLM phase never holds
	// vault-write.lock (mirrors compileAllRepos). `launchWorker` is imported
	// lazily so callers that never trigger a busy path don't pull QueueWorker's
	// transcript-reader/detector graph in. Resolve it BEFORE the storage swap:
	// this dynamic import evaluates that heavy graph (incl. lazy node:sqlite) and
	// can throw at module-eval time. The swap therefore lives INSIDE the try
	// below — mirroring compileAllRepos — so that an import throw can never leave
	// the process-global override set with no `finally` to restore it, which
	// would point a long-lived host's later reads/writes at this repo.
	const vaultRoot = deriveMemoryBankRoot(config.localFolder);
	const { launchWorker } = await import("../hooks/QueueWorker.js");
	const writeGuard = async (fn: () => Promise<void>): Promise<void> => {
		const r = await withVaultWriteLock(vaultRoot, { wait: DEFAULT_VAULT_WRITE_WAIT_MS }, fn, {
			launch: launchWorker,
		});
		if (!r.ran) throw new VaultWriteBusyError();
	};

	try {
		setActiveStorage(storage);
		if (rebuild) {
			// Reset watermark + index BEFORE ingest — a busy lock here is a real
			// failure (the rebuild is a prerequisite, not a derived view), so we
			// surface it as `vaultBusy` instead of letting the drain silently
			// run as an incremental.
			try {
				await writeGuard(async () => {
					await saveProcessedSet(emptyProcessedSet(), cwd);
					await saveTopicIndex(emptyTopicIndex(), cwd);
				});
			} catch (e) {
				if (e instanceof VaultWriteBusyError) return { ok: false, failure: { kind: "vaultBusy" } };
				throw e;
			}
		}

		emit("wiki");
		const drainResult = await drainIngest(cwd, config, {
			batchSize: opts?.batchSize,
			readStorage: storage,
			triggeredBy: "manual",
			writeGuard,
			signal: opts?.signal,
			onBatch: (bp) => emit("wiki", `batch ${bp.batchIndex}`, bp.batchIndex),
			onTopic: opts?.onTopic,
		});

		if (opts?.signal?.aborted) return { ok: false, failure: { kind: "cancelled" } };

		// Purge orphaned pages — ONLY on --rebuild. A routine drain must NOT
		// purge (a concurrent ingest may have added a page not in our snapshot;
		// purging would delete it). Wrapped non-fatal.
		if (rebuild) {
			try {
				await writeGuard(async () => {
					const index = await readTopicIndex(cwd, storage);
					await purgeTopicPagesExcept(
						index.topics.map((tp) => tp.stableSlug),
						cwd,
						storage,
					);
				});
			} catch (purgeErr) {
				log.warn(
					"Topic-page purge skipped (non-fatal): %s",
					purgeErr instanceof Error ? purgeErr.message : String(purgeErr),
				);
			}
		}

		// Re-render the Markdown wiki. Non-fatal on failure — the memories are
		// safe; only the regenerated view lags until the next drain.
		try {
			await renderTopicKBWiki(cwd, storage, writeGuard);
		} catch (renderErr) {
			log.warn(
				"Wiki re-render skipped (non-fatal): %s",
				renderErr instanceof Error ? renderErr.message : String(renderErr),
			);
		}

		if (opts?.signal?.aborted) return { ok: false, failure: { kind: "cancelled" } };

		// Cancellation is honored BEFORE this phase (the check just above), not
		// during it: `buildKnowledgeGraph` does not receive `signal`, so once the
		// graph build starts it runs to completion even if the caller aborts
		// mid-build. Threading the signal through the whole distiller (several LLM
		// calls across multiple functions) was judged too invasive for the
		// cancel-latency it would save on a derived artifact that is regenerated on
		// the next compile anyway. A build failure (or missing LLM key) degrades to
		// "no graph this run" and never fails the compile.
		emit("graph");
		try {
			await buildKnowledgeGraph(cwd, storage, config, {
				onProgress: (m) => emit("graph", m),
			});
		} catch (graphErr) {
			log.warn(
				"Knowledge graph build failed (non-fatal): %s",
				graphErr instanceof Error ? graphErr.message : String(graphErr),
			);
		}

		emit("search-index");
		try {
			const { SearchIndex } = await import("./SearchIndex.js");
			await writeGuard(async () => {
				await SearchIndex.rebuild(cwd, storage);
			});
		} catch (idxErr) {
			log.warn(
				"Search index update failed (non-fatal): %s",
				idxErr instanceof Error ? idxErr.message : String(idxErr),
			);
		}

		return {
			ok: true,
			ingested: drainResult.ingested,
			batches: drainResult.batches,
			outcome: drainResult.outcome,
			topicFailures: drainResult.topicFailures,
		};
	} catch (err) {
		if (isAbortError(err)) return { ok: false, failure: { kind: "cancelled" } };
		const message = err instanceof Error ? err.message : String(err);
		const errorKind = classifyCompileError(err);
		log.error("Single-repo compile failed: %s (kind=%s)", message, errorKind);
		return { ok: false, failure: { kind: "internal", message, errorKind } };
	} finally {
		setActiveStorage(previousStorage);
	}
}
