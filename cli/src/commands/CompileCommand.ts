/**
 * CompileCommand — ingest pending sources into the topic KB.
 *
 * Usage:
 *   `jolli compile`              — sweep every repo in the Memory Bank folder.
 *   `jolli compile --cwd <dir>`  — compile a single repo (dual-write).
 *   `jolli compile --cwd <dir> --rebuild` — reset that repo's KB then re-ingest.
 *
 * Bare `compile` (no --cwd) targets all repos under `localFolder`; this matches
 * the VS Code "Build Knowledge Wiki" button, which is repo-wide.
 */

import type { Command } from "commander";
import { drainIngest } from "../core/IngestPipeline.js";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { emptyProcessedSet, saveProcessedSet } from "../core/ProcessedSourceStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getActiveStorage, setActiveStorage } from "../core/SummaryStore.js";
import { emptyTopicIndex, readTopicIndex, saveTopicIndex } from "../core/TopicIndexStore.js";
import { purgeTopicPagesExcept } from "../core/TopicPageStore.js";
import { renderTopicKBWiki } from "../core/TopicWikiRenderer.js";
import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { createLogger, setLogDir } from "../Logger.js";
import { deriveMemoryBankRoot } from "../sync/SyncBootstrap.js";
import { DEFAULT_VAULT_WRITE_WAIT_MS, VaultWriteBusyError, withVaultWriteLock } from "../sync/VaultWriteLock.js";

const log = createLogger("CompileCommand");

export type CompileOptions = { rebuild?: boolean; cwd?: string };

/** Compile a single repo rooted at `cwd` (dual-write). */
async function compileSingleRepo(cwd: string, rebuild: boolean): Promise<void> {
	setLogDir(cwd);
	const config = await loadConfig();
	if (resolveLlmCredentialSource(config) === null) {
		console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
		await appendCredentialMissingRun(cwd, "manual");
		process.exitCode = 1;
		return;
	}
	const storage = await createStorage(cwd, cwd);
	// Capture + restore the process-global override so a single-repo compile
	// doesn't leak it into a long-lived host (mirrors compileAllRepos). Benign in
	// the one-shot CLI, but executeCompile is an exported entry point.
	const previousStorage = getActiveStorage();
	setActiveStorage(storage);
	try {
		// Per-write `vault-write.lock` instead of one lock held across the whole drain:
		// the long reconcile LLM phase runs UNLOCKED and only each persistence call
		// re-acquires the lock briefly, so a concurrent commit-summary worker can grab
		// the lock between our writes and generate its summary promptly (commit memory
		// is high-priority; "build wiki" can proceed slowly). This mirrors the
		// QueueWorker unlocked-ingest phase. Data safety is preserved by drainIngest's
		// own guarded-write phase: topic pages re-read + compare before write (no
		// clobber), the index + processed-set are RMW under the same guard (no
		// lost-update). The releaseHook wakes any worker that still timed out waiting
		// on us (defense-in-depth — see VaultWriteLock).
		const vaultRoot = deriveMemoryBankRoot(config.localFolder);
		// `launchWorker` is imported lazily so this command's module load (at CLI
		// startup, via registerCompileCommand) doesn't eagerly pull QueueWorker's
		// transcript-reader/detector graph in. A busy miss throws VaultWriteBusyError
		// (caught for the rebuild prerequisite below).
		const { launchWorker } = await import("../hooks/QueueWorker.js");
		const writeGuard = async (fn: () => Promise<void>): Promise<void> => {
			const r = await withVaultWriteLock(vaultRoot, { wait: DEFAULT_VAULT_WRITE_WAIT_MS }, fn, {
				launch: launchWorker,
			});
			if (!r.ran) throw new VaultWriteBusyError();
		};

		if (rebuild) {
			// Reset the watermark + index only. An empty index makes route treat every
			// topic as new, so reconcile gets current=null (clean rebuild).
			//
			// This reset is a PREREQUISITE, not a derived view: if it can't take the
			// lock the index stays populated and the drain below runs as a no-op
			// incremental — a silent non-rebuild. So a busy lock here exits cleanly with
			// the same "try again shortly" message the whole-lock predecessor printed,
			// rather than letting the guard's throw bubble out as an uncaught stack
			// trace. A real (non-lock) write error still propagates. The QueueWorker
			// ingest path logs-and-continues instead because its drain is best-effort
			// background work; a user-invoked compile owes the user a clear exit code.
			console.log("\n  Rebuilding knowledge base from scratch...");
			try {
				await writeGuard(async () => {
					await saveProcessedSet(emptyProcessedSet(), cwd);
					await saveTopicIndex(emptyTopicIndex(), cwd);
				});
			} catch (e) {
				if (e instanceof VaultWriteBusyError) {
					console.error(
						"\n  Error: another vault writer (a background worker or sync) is busy — try again shortly.\n",
					);
					process.exitCode = 1;
					return;
				}
				throw e;
			}
		} else {
			console.log("\n  Ingesting pending sources into the knowledge base...");
		}

		const drainResult = await drainIngest(cwd, config, { triggeredBy: "manual", writeGuard });
		// Converge the canonical layer to the index: drop topic pages no longer
		// referenced. ONLY on --rebuild (which replays into a possibly smaller topic
		// set). A routine compile must NOT purge: with the lock released between writes
		// a concurrent ingest can add a page that is not yet in our index snapshot, and
		// purging "everything not in the index" would delete it — data loss. Orphans
		// from topic consolidation are reclaimed on the next --rebuild instead. The
		// rebuild path is an explicit single-repo reset, so the read+purge under one
		// writeGuard is sufficient there.
		// Purge + Markdown re-render are DERIVED-layer regeneration over data the
		// drain already persisted to the orphan branch / canonical JSON. A busy lock
		// (or any other failure) here is non-fatal: the memories are safe, only the
		// regenerated views lag until the next drain. Failing the whole command on a
		// derived-layer hiccup is what made a successful ingest report as a failure.
		// Mirrors the QueueWorker unlocked-ingest catch and the search-index
		// disposable-cache catch below. Orphan pages a skipped purge leaves behind are
		// reclaimed on the next explicit --rebuild.
		if (rebuild) {
			try {
				await writeGuard(async () => {
					const index = await readTopicIndex(cwd, storage);
					await purgeTopicPagesExcept(
						index.topics.map((t) => t.stableSlug),
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
		try {
			await renderTopicKBWiki(cwd, storage, writeGuard);
		} catch (renderErr) {
			log.warn(
				"Wiki re-render skipped (non-fatal): %s",
				renderErr instanceof Error ? renderErr.message : String(renderErr),
			);
		}
		// Build the knowledge graph from the freshly-ingested topic KB. Wrapped
		// non-fatal: a graph build failure or missing LLM key must never fail the
		// compile. Run UNGUARDED — it is LLM-bearing, so holding vault-write.lock
		// across it would re-create the commit-blocking stall this fix removes (the
		// graph is a derived artifact, regenerated on the next compile).
		try {
			await buildKnowledgeGraph(cwd, storage, config);
		} catch (graphErr) {
			log.warn(
				"Knowledge graph build failed (non-fatal): %s",
				graphErr instanceof Error ? graphErr.message : String(graphErr),
			);
		}
		// Keep the local search index warm so the next query (MCP server / `jolli
		// search`) rarely pays a lazy rebuild. Disposable cache: a failure here must
		// never fail the compile. SearchIndex (→ @orama/*) is lazy-imported INSIDE
		// this try so a load failure is contained (mirrors compileAllRepos).
		try {
			const { SearchIndex } = await import("../core/SearchIndex.js");
			await writeGuard(async () => {
				await SearchIndex.rebuild(cwd, storage);
			});
		} catch (idxErr) {
			log.warn(
				"Search index update failed (non-fatal): %s",
				idxErr instanceof Error ? idxErr.message : String(idxErr),
			);
		}

		const { batches, ingested, outcome, topicFailures } = drainResult;
		// User-facing wording: say "commit summaries" (not the internal "sources"), and
		// let 0 read as "already up to date" rather than "0 sources". Mirrors the VS Code toast.
		const addedNote =
			ingested === 0
				? "already up to date -- no new commit summaries to add"
				: `added ${ingested} new commit summar${ingested === 1 ? "y" : "ies"} (${batches} batch(es))`;
		let summary = `\n  Done: ${addedNote}. Wiki rebuilt. [${outcome}]`;
		if (topicFailures.length > 0) {
			summary += `\n  ${topicFailures.length} topic(s) held: ${topicFailures.map((f) => `${f.slug} (${f.code})`).join(", ")}`;
		}
		console.log(`${summary}\n`);
	} finally {
		setActiveStorage(previousStorage);
	}
}

/** Sweep every repo under the Memory Bank folder. */
async function compileSweep(): Promise<void> {
	const config = await loadConfig();
	if (resolveLlmCredentialSource(config) === null) {
		console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
		process.exitCode = 1;
		return;
	}
	if (!config.localFolder) {
		console.error("\n  Error: No Memory Bank folder configured (localFolder). Set one in Settings.\n");
		process.exitCode = 1;
		return;
	}
	console.log("\n  Adding pending commit summaries across all Memory Bank repos...");
	const result = await compileAllRepos(config.localFolder, config);
	for (const r of result.repos) {
		const perRepo =
			r.ingested === 0 ? "up to date" : `${r.ingested} new commit summar${r.ingested === 1 ? "y" : "ies"}`;
		console.log(r.error ? `    ✗ ${r.folder}: ${r.error}` : `    ✓ ${r.folder}: ${perRepo}`);
	}
	const failedNote = result.failed ? `, ${result.failed} failed` : "";
	const repos = `${result.repos.length} repo(s)`;
	const summary =
		result.totalIngested === 0
			? `all ${repos} already up to date -- no new commit summaries to add`
			: `added ${result.totalIngested} new commit summar${result.totalIngested === 1 ? "y" : "ies"} across ${repos}`;
	console.log(`\n  Done: ${summary}${failedNote}.\n`);
	if (result.failed > 0) process.exitCode = 1;
}

export async function executeCompile(options: CompileOptions): Promise<void> {
	if (options.cwd) {
		await compileSingleRepo(options.cwd, options.rebuild === true);
		return;
	}
	if (options.rebuild) {
		console.error("\n  Error: --rebuild requires --cwd <dir> (rebuild targets a single repo).\n");
		process.exitCode = 1;
		return;
	}
	await compileSweep();
}

export function registerCompileCommand(program: Command): void {
	program
		.command("compile")
		.description("Ingest pending development sources into the topic knowledge base")
		.option("--rebuild", "Discard the knowledge base and replay every source from scratch (requires --cwd)")
		.option("--cwd <dir>", "Compile a single repo at this directory (default: sweep all Memory Bank repos)")
		.action(executeCompile);
}
