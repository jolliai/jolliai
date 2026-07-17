/**
 * CompileEstimate — cheap preview of "what would `jolli compile` do right now",
 * without calling the LLM or writing anything.
 *
 * Exists so UI surfaces (desktop cockpit's "Build" confirm dialog, VS Code's
 * pre-flight card) can tell the user before they commit: "N sources pending,
 * ~T tokens, ~$C". Everything comes from the same read path `drainIngest`
 * uses (`listPendingSources` + `loadSourceContent`), so a subsequent compile
 * sees the same set.
 */

import type { JolliMemoryConfig } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { discoverRepos, type RepoTarget } from "./MemoryBankRepoDiscovery.js";
import { MODEL_PRICES, PRICES_AS_OF } from "./Pricing.js";
import { emptyProcessedSet, readProcessedSet } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadSourceHeadline } from "./SourceContent.js";
import { listPendingSources } from "./SourceTimeline.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveModelId } from "./Summarizer.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

/**
 * Model whose list price is used when the caller passes no `model` (or an
 * unpriced one). Sonnet-class is the compile pipeline's default summarizer, and
 * its $3/$15 rate matches the previous hardcoded estimate — so an estimate with
 * no configured model is unchanged. Real per-model rates come from
 * {@link MODEL_PRICES}; this is only the fallback key.
 */
const DEFAULT_ESTIMATE_MODEL = "claude-sonnet-5";

/**
 * Resolve the input/output $/1M rates for `model` from the shared price table,
 * falling back to {@link DEFAULT_ESTIMATE_MODEL}. Estimate cost is
 * `input·inputPerMTok + output·outputPerMTok` (the cache segment is a compile
 * detail we don't model here — this is a "should I click Build?" figure, not an
 * invoice; the pipeline is input-heavy anyway).
 */
function estimateRates(model?: string): { inputPerMTok: number; outputPerMTok: number } {
	// `config.model` is routinely a short alias ("opus"/"sonnet"/"haiku"), but
	// MODEL_PRICES is keyed by full model ids — resolve the alias first so an
	// opus-configured repo isn't silently priced at the sonnet fallback.
	const resolved = model ? resolveModelId(model) : undefined;
	const price = (resolved && MODEL_PRICES[resolved]) || MODEL_PRICES[DEFAULT_ESTIMATE_MODEL];
	return { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
}

/**
 * Heuristic tokens-per-character. Anthropic's tokenizer is roughly 3.5–4 chars
 * per token on English prose; source bodies contain a lot of code + JSON, which
 * is denser. 3.5 is a middle-of-the-road number that overestimates slightly —
 * we'd rather show a bigger-than-real estimate than surprise the user with a
 * bill that overshoots. Callers who need precise counts must call the
 * Anthropic count-tokens API.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * How much of the current topic KB reconcile pulls in on each batch as
 * "existing pages" context — routed sources + current page bodies. We can't
 * know exactly without running route, so upper-bound it as `pagesInIndex ×
 * avgPageChars` capped by a per-batch ceiling. Same caveat: rough.
 */
const RECONCILE_CONTEXT_MULT = 0.35;

/** Output-token estimate per source folded in (the reconciled page delta). */
const OUTPUT_TOKENS_PER_SOURCE = 400;

export interface CompileEstimateResult {
	/** All pending sources — the same set the next compile would ingest. */
	readonly pending: readonly SourceRef[];
	/** Rough total tokens the compile would consume (input + output). */
	readonly estTokens: number;
	/** Rough USD cost, blended input+output at Anthropic pricing. */
	readonly estUsd: number;
	/** Batch count the drain would take with the given (or default) batch size. */
	readonly batches: number;
	/** Topic index size at estimate time (drives the reconcile-context guess). */
	readonly indexSize: number;
	/** Date of the price table used for `estUsd` (from {@link PRICES_AS_OF}) — surface staleness. */
	readonly pricesAsOf: string;
}

export interface CompileEstimateOptions {
	/** Estimate a full replay by treating every source as unprocessed. */
	readonly rebuild?: boolean;
	/** Match `ingestPendingBatch`'s default so batch count matches the real drain. */
	readonly batchSize?: number;
	/** Cap headline sampling — reading every source's body would defeat "cheap". */
	readonly sampleLimit?: number;
	/** Read-side storage override — matches `drainIngest`'s optional argument. */
	readonly readStorage?: StorageProvider;
	/**
	 * LLM model id whose list price to use for `estUsd` (looked up in
	 * {@link MODEL_PRICES}). Omitted / unpriced → {@link DEFAULT_ESTIMATE_MODEL}.
	 * Callers pass `config.model` so the estimate tracks the model that will
	 * actually run the compile.
	 */
	readonly model?: string;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_SAMPLE_LIMIT = 20;

/**
 * Estimate what one `compile` invocation on `cwd` would cost, without calling
 * the LLM. Reads pending sources through the same code path a real compile
 * does; samples up to `sampleLimit` headlines to extrapolate an average size
 * per source, then scales by the count and adds a reconcile-context term.
 * Never throws for a sample-load failure — a vanished source contributes 0.
 */
export async function estimateCompile(cwd: string, opts?: CompileEstimateOptions): Promise<CompileEstimateResult> {
	const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
	const sampleLimit = opts?.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
	const readStorage = opts?.readStorage ?? (await createReadStorage(cwd));

	const processed = opts?.rebuild ? emptyProcessedSet() : await readProcessedSet(cwd, readStorage);
	const pending = await listPendingSources(cwd, processed, readStorage);
	const index = await readTopicIndex(cwd, readStorage);

	if (pending.length === 0) {
		return {
			pending: [],
			estTokens: 0,
			estUsd: 0,
			batches: 0,
			indexSize: index.topics.length,
			pricesAsOf: PRICES_AS_OF,
		};
	}

	// Sample up to `sampleLimit` headlines evenly across the pending list so
	// the average isn't skewed by ordering. Headlines are already single-line
	// and represent the routing signal — cheap to load and good enough for
	// an order-of-magnitude size estimate. Actual bodies are larger, so we
	// scale up by a fixed multiplier below.
	const step = Math.max(1, Math.floor(pending.length / sampleLimit));
	const sampleIdxs: number[] = [];
	for (let i = 0; i < pending.length && sampleIdxs.length < sampleLimit; i += step) sampleIdxs.push(i);
	let totalHeadlineChars = 0;
	let samples = 0;
	for (const i of sampleIdxs) {
		try {
			const ref = pending[i];
			if (!ref) continue;
			const headline = await loadSourceHeadline(ref, cwd, readStorage);
			totalHeadlineChars += headline.length;
			samples++;
		} catch {
			// A vanished / unreadable source contributes 0 — the same treatment
			// the real drain gives it.
		}
	}
	const avgHeadlineChars = samples > 0 ? totalHeadlineChars / samples : 200;
	// Bodies are typically 10-40x the headline length; use 20x as a middle-
	// ground scaling factor. Rough, not precise.
	const avgBodyChars = avgHeadlineChars * 20;

	const inputCharsFromSources = pending.length * avgBodyChars;
	// Reconcile context: routed sources per page + the current page body. Reconcile
	// only loads pages for the topics route assigns in a batch — at most one per
	// source — so cap the per-batch topic count at `min(indexSize, batchSize)`
	// rather than assuming every batch pulls the ENTIRE topic index (which
	// over-estimated 10-100x on large indexes and scared users off Build).
	const batches = Math.ceil(pending.length / batchSize);
	const topicsPerBatch = Math.min(index.topics.length, batchSize);
	const reconcileContextChars = batches * topicsPerBatch * avgBodyChars * RECONCILE_CONTEXT_MULT;

	const inputTokens = Math.round((inputCharsFromSources + reconcileContextChars) / CHARS_PER_TOKEN);
	const outputTokens = pending.length * OUTPUT_TOKENS_PER_SOURCE;
	const estTokens = inputTokens + outputTokens;
	const rates = estimateRates(opts?.model);
	const estUsd = (inputTokens / 1_000_000) * rates.inputPerMTok + (outputTokens / 1_000_000) * rates.outputPerMTok;

	return {
		pending,
		estTokens,
		estUsd: Math.round(estUsd * 10_000) / 10_000,
		batches,
		indexSize: index.topics.length,
		pricesAsOf: PRICES_AS_OF,
	};
}

/** How many repos to estimate in parallel — fs-only reads, so a modest cap suffices. */
const SWEEP_ESTIMATE_CONCURRENCY = 8;

/** One repo's contribution to a Memory Bank sweep estimate. */
export interface SweepEstimateRepo {
	/** Folder name under the Memory Bank root. */
	readonly repo: string;
	readonly kbRoot: string;
	/** Pending source count this repo would ingest. */
	readonly sources: number;
	readonly tokens: number;
	readonly usd: number;
	/** Present when this repo's estimate failed; it then contributes 0 to totals. */
	readonly error?: string;
}

export interface SweepEstimateResult {
	readonly total: { readonly sources: number; readonly tokens: number; readonly usd: number };
	/** Per-repo breakdown, biggest pending-source contributors first. */
	readonly perRepo: readonly SweepEstimateRepo[];
	/** Date of the price table used for the USD figures (from {@link PRICES_AS_OF}). */
	readonly pricesAsOf: string;
}

/**
 * Estimate what a full Memory Bank sweep (`compileAllRepos`) would cost, without
 * the LLM. Fans {@link estimateCompile} out over every discovered repo (honoring
 * `config.compileExcludeFolders`) and aggregates. A per-repo estimate failure is
 * non-fatal: that repo records its `error` and contributes 0 — mirroring how the
 * real sweep isolates per-repo failures.
 */
export async function estimateSweep(
	localFolder: string,
	config: JolliMemoryConfig,
	opts?: CompileEstimateOptions,
): Promise<SweepEstimateResult> {
	const targets = await discoverRepos(localFolder, config.compileExcludeFolders ?? []);
	// Price every repo against the configured model unless the caller overrode it.
	// Forward ONLY the repo-agnostic knobs — NOT `readStorage`. That is a
	// single-repo read override; a sweep fans out over many repos, so propagating
	// one caller-supplied storage would read every repo through it. Each repo's
	// estimateCompile derives its OWN storage via createReadStorage(kbRoot).
	const perRepoOpts: CompileEstimateOptions = {
		rebuild: opts?.rebuild,
		batchSize: opts?.batchSize,
		sampleLimit: opts?.sampleLimit,
		model: opts?.model ?? config.model,
	};
	const perRepo = await mapWithConcurrency<RepoTarget, SweepEstimateRepo>(
		targets,
		SWEEP_ESTIMATE_CONCURRENCY,
		async (t) => {
			const est = await estimateCompile(t.kbRoot, perRepoOpts);
			return {
				repo: t.folder,
				kbRoot: t.kbRoot,
				sources: est.pending.length,
				tokens: est.estTokens,
				usd: est.estUsd,
			};
		},
		(t, err) => ({
			repo: t.folder,
			kbRoot: t.kbRoot,
			sources: 0,
			tokens: 0,
			usd: 0,
			error: err instanceof Error ? err.message : String(err),
		}),
	);

	let sources = 0;
	let tokens = 0;
	let usd = 0;
	for (const r of perRepo) {
		sources += r.sources;
		tokens += r.tokens;
		usd += r.usd;
	}
	const sorted = [...perRepo].sort((a, b) => b.sources - a.sources);
	return {
		total: { sources, tokens, usd: Math.round(usd * 10_000) / 10_000 },
		perRepo: sorted,
		pricesAsOf: PRICES_AS_OF,
	};
}
