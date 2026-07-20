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
 *
 * The single-repo pipeline lives in `core/SingleRepoCompile.ts` and the sweep
 * in `core/MultiRepoCompile.ts`. This module is the CLI-only shim: parse args,
 * call the library, format outcomes for the terminal.
 */

import type { Command } from "commander";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { type CompileSingleRepoFailureReason, compileSingleRepo } from "../core/SingleRepoCompile.js";
import { setLogDir } from "../Logger.js";

export type CompileOptions = { rebuild?: boolean; cwd?: string };

/** Compile a single repo rooted at `cwd` (dual-write). */
async function runSingleRepo(cwd: string, rebuild: boolean): Promise<void> {
	setLogDir(cwd);
	const config = await loadConfig();
	if (resolveLlmCredentialSource(config) === null) {
		// handleSingleRepoFailure({ kind: "noApiKey" }) owns BOTH the console error
		// and the credential-missing telemetry — don't duplicate them here, or the
		// user sees the error twice and `ingest-runs.json` records two attempts.
		process.exitCode = 1;
		await handleSingleRepoFailure({ kind: "noApiKey" }, cwd);
		return;
	}

	if (rebuild) {
		console.log("\n  Rebuilding knowledge base from scratch...");
	} else {
		console.log("\n  Ingesting pending sources into the knowledge base...");
	}

	const result = await compileSingleRepo(cwd, config, { rebuild });

	if (!result.ok) {
		process.exitCode = 1;
		await handleSingleRepoFailure(result.failure, cwd);
		return;
	}

	const { batches, ingested, outcome, topicFailures } = result;
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
}

async function handleSingleRepoFailure(reason: CompileSingleRepoFailureReason, cwd: string): Promise<void> {
	switch (reason.kind) {
		case "noApiKey":
			console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
			// Preserve the pre-refactor telemetry hook: a credential-missing run is
			// recorded so `ingest-runs.json` reflects the attempt.
			await appendCredentialMissingRun(cwd, "manual");
			return;
		case "vaultBusy":
			console.error(
				"\n  Error: another vault writer (a background worker or sync) is busy — try again shortly.\n",
			);
			return;
		case "cancelled":
			console.error("\n  Cancelled.\n");
			return;
		case "internal":
			console.error(`\n  Error: ${reason.message} (kind=${reason.errorKind})\n`);
			return;
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
		await runSingleRepo(options.cwd, options.rebuild === true);
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
