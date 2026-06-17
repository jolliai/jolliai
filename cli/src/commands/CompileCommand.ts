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
import { DEFAULT_VAULT_WRITE_WAIT_MS, withVaultWriteLock } from "../sync/VaultWriteLock.js";

const log = createLogger("CompileCommand");

export type CompileOptions = { rebuild?: boolean; cwd?: string };

/** Compile a single repo rooted at `cwd` (dual-write). */
async function compileSingleRepo(cwd: string, rebuild: boolean): Promise<void> {
	setLogDir(cwd);
	const config = await loadConfig();
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
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
		// Serialise on the same `vault-write.lock` the background QueueWorker holds for
		// its ingest drain. Without it, a manual compile racing a post-commit worker
		// lost-updates `topics/index.json` and the `drainIngest → readTopicIndex →
		// purgeTopicPagesExcept` window can delete a topic page the worker just wrote.
		// Wait mode (not fail-fast): the user explicitly asked to compile, so yield to
		// a busy worker/sync rather than skip outright.
		const vaultRoot = deriveMemoryBankRoot(config.localFolder);
		const result = await withVaultWriteLock(vaultRoot, { wait: DEFAULT_VAULT_WRITE_WAIT_MS }, async () => {
			if (rebuild) {
				// Reset the watermark + index only. An empty index makes route treat every
				// topic as new, so reconcile gets current=null (clean rebuild).
				console.log("\n  Rebuilding knowledge base from scratch...");
				await saveProcessedSet(emptyProcessedSet(), cwd);
				await saveTopicIndex(emptyTopicIndex(), cwd);
			} else {
				console.log("\n  Ingesting pending sources into the knowledge base...");
			}

			const drainResult = await drainIngest(cwd, config, { triggeredBy: "manual" });
			// Converge the canonical layer to the index: drop topic pages no longer
			// referenced (e.g. left behind when --rebuild replays into fewer topics).
			const index = await readTopicIndex(cwd, storage);
			await purgeTopicPagesExcept(
				index.topics.map((t) => t.stableSlug),
				cwd,
				storage,
			);
			await renderTopicKBWiki(cwd, storage);
			// Build the knowledge graph from the freshly-ingested topic KB. Wrapped
			// non-fatal: a graph build failure or missing LLM key must never fail the
			// compile. Statically imported — the graph module pulls no optional/native
			// deps, so eager load is safe (unlike the SearchIndex warm-up below).
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
				await SearchIndex.rebuild(cwd, storage);
			} catch (idxErr) {
				log.warn(
					"Search index update failed (non-fatal): %s",
					idxErr instanceof Error ? idxErr.message : String(idxErr),
				);
			}
			return drainResult;
		});

		if (!result.ran) {
			console.error(
				"\n  Error: another vault writer (a background worker or sync) is busy — try again shortly.\n",
			);
			process.exitCode = 1;
			return;
		}

		const { batches, ingested, outcome, topicFailures } = result.value;
		let summary = `\n  Done: ${ingested} source(s) folded in ${batches} batch(es). Wiki rebuilt. [${outcome}]`;
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
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
		process.exitCode = 1;
		return;
	}
	if (!config.localFolder) {
		console.error("\n  Error: No Memory Bank folder configured (localFolder). Set one in Settings.\n");
		process.exitCode = 1;
		return;
	}
	console.log("\n  Ingesting pending sources across all Memory Bank repos...");
	const result = await compileAllRepos(config.localFolder, config);
	if (result.skipped) {
		console.log("\n  Another compile is already running for this Memory Bank folder — skipped.\n");
		return;
	}
	for (const r of result.repos) {
		console.log(r.error ? `    ✗ ${r.folder}: ${r.error}` : `    ✓ ${r.folder}: ${r.ingested} source(s)`);
	}
	const failedNote = result.failed ? `, ${result.failed} failed` : "";
	console.log(`\n  Done: ${result.totalIngested} source(s) across ${result.repos.length} repo(s)${failedNote}.\n`);
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
