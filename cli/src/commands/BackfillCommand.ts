/**
 * BackfillCommand — `jolli backfill` CLI command.
 *
 * Generates jolli memory summaries for historical commits that lack one, by
 * attributing on-disk Claude transcripts to those commits offline. Fully
 * isolated from the live post-commit pipeline.
 *
 *   jolli backfill                        # last 20 commits, window-collect-all (low)
 *   jolli backfill --last 50              # last 50 commits
 *   jolli backfill --all                  # every commit reachable from HEAD
 *   jolli backfill --hashes h1,h2,h3      # an explicit commit subset (newest-first)
 *   jolli backfill --dry-run              # report attribution + confidence, no LLM call
 *   jolli backfill --min-confidence high  # only file-overlap (high) attributions
 *   jolli backfill --stream               # NDJSON progress events + final report line
 *   jolli backfill --list-candidates      # cold-start signals JSON (no LLM, no scan)
 *
 * The `--stream` and `--list-candidates` modes exist so out-of-process hosts
 * (the IntelliJ plugin) can drive the same cold-start / progress UX the VS Code
 * extension gets by calling the engine in-process.
 */

import type { Command } from "commander";
import {
	type BackfillOutcome,
	type BackfillReport,
	countMissingSummaries,
	DEFAULT_BACKFILL_TIER,
	listMissingCommits,
	recentCommitHashes,
	repoHasAnyMemory,
	runBackfill,
} from "../backfill/BackfillEngine.js";
import { setLogDir } from "../Logger.js";
import { parsePositiveInt, resolveProjectDir } from "./CliUtils.js";

type MinConfidence = "high" | "medium" | "low";

interface BackfillCliOptions {
	cwd: string;
	last?: number;
	all?: boolean;
	hashes?: ReadonlyArray<string>;
	dryRun?: boolean;
	minConfidence?: MinConfidence;
	format?: "json" | "text";
	stream?: boolean;
	listCandidates?: boolean;
	sinceDays?: number;
	limit?: number;
}

const DEFAULT_LAST = 20;
/** Default tier is shared across all entry points (see DEFAULT_BACKFILL_TIER). */
const DEFAULT_MIN_CONFIDENCE: MinConfidence = DEFAULT_BACKFILL_TIER;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Commander parser for `--min-confidence`; rejects anything outside the tier set. */
function parseMinConfidence(value: string): MinConfidence {
	if (value === "high" || value === "medium" || value === "low") return value;
	throw new Error(`--min-confidence must be one of: high, medium, low (got "${value}")`);
}

/** Commander parser for `--hashes`: splits a comma-separated list, dropping blanks. */
function parseHashes(value: string): string[] {
	return value
		.split(",")
		.map((h) => h.trim())
		.filter((h) => h.length > 0);
}

/** Resolves the candidate commit hash list (newest-first) from the CLI options. */
async function resolveHashes(opts: BackfillCliOptions): Promise<ReadonlyArray<string>> {
	// An explicit `--hashes` subset wins over the --last/--all range (the UI passes
	// exactly the commits the user selected in the cold-start card).
	if (opts.hashes && opts.hashes.length > 0) return opts.hashes;
	// Commander fills `last` with DEFAULT_LAST when the flag is omitted; `--all` drops the cap.
	return recentCommitHashes(opts.cwd, opts.all ? undefined : opts.last);
}

const STATUS_LABEL: Record<BackfillOutcome["status"], string> = {
	generated: "✓ generated",
	"would-generate": "○ would generate",
	"skipped-has-summary": "· already summarized",
	"skipped-in-progress": "· live capture in progress",
	error: "✗ error",
};

function renderText(report: BackfillReport, dryRun: boolean): string {
	const lines: string[] = [];
	for (const o of report.outcomes) {
		const short = o.commitHash.substring(0, 8);
		const conf = o.method ? ` [${o.confidence ? `${o.confidence}/` : ""}${o.method}]` : "";
		const topics = o.topics !== undefined ? ` (${o.topics} topics)` : "";
		const msg = o.message ? ` — ${o.message}` : "";
		lines.push(`  ${short}  ${STATUS_LABEL[o.status]}${conf}${topics}${msg}`);
	}
	const verb = dryRun ? "would generate" : "generated";
	lines.push("");
	lines.push(
		`  ${report.total} candidate(s): ${report.generated} ${verb}, ${report.skipped} skipped, ${report.errors} error(s).`,
	);
	return lines.join("\n");
}

/**
 * `--list-candidates` — emits cold-start signals as a single JSON line, without
 * scanning transcripts or calling the LLM. This is the out-of-process sibling of
 * the VS Code `computeColdStartSignals()` in-process call: `hasAnyMemory` +
 * `missing`/`total` counts + the (windowed, capped) candidate rows the offer card
 * renders. `--since-days` bounds the candidate window; `--limit` caps the rows.
 */
async function emitCandidates(opts: BackfillCliOptions): Promise<void> {
	const hasAnyMemory = await repoHasAnyMemory(opts.cwd);
	const counts = await countMissingSummaries(opts.cwd);
	const sinceMs = typeof opts.sinceDays === "number" ? opts.sinceDays * MS_PER_DAY : undefined;
	const candidates = await listMissingCommits(opts.cwd, sinceMs, opts.limit);
	console.log(
		JSON.stringify({
			hasAnyMemory,
			total: counts.total,
			missing: counts.missing,
			candidates,
		}),
	);
}

/** Registers the `backfill` command on the given Commander program. */
export function registerBackfillCommand(program: Command): void {
	program
		.command("backfill")
		.description("Generate summaries for historical commits that lack one (Claude transcripts only)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--last <n>", "Number of most recent commits to consider", parsePositiveInt, DEFAULT_LAST)
		.option("--all", "Consider every commit reachable from HEAD")
		.option("--hashes <list>", "Comma-separated commit hashes to back-fill (overrides --last/--all)", parseHashes)
		.option("--dry-run", "Report attribution and confidence without calling the LLM")
		.option(
			"--min-confidence <tier>",
			"Lowest tier to attribute: high | medium | low",
			parseMinConfidence,
			DEFAULT_MIN_CONFIDENCE,
		)
		.option("--format <fmt>", "Output format: text | json", "text")
		.option("--stream", "Emit NDJSON progress events (one per commit) then a final report line")
		.option("--list-candidates", "Emit cold-start signals as JSON (no attribution, no LLM) and exit")
		.option("--since-days <n>", "For --list-candidates: only commits authored in the last N days", parsePositiveInt)
		.option("--limit <n>", "For --list-candidates: cap the number of candidate rows", parsePositiveInt)
		.action(async (opts: BackfillCliOptions) => {
			setLogDir(opts.cwd);

			if (opts.listCandidates) {
				await emitCandidates(opts);
				return;
			}

			const hashes = await resolveHashes(opts);
			if (hashes.length === 0) {
				// A machine consumer (`--stream`, e.g. the IntelliJ plugin) expects a terminal
				// report even when there is nothing to do — a repo with no own-authored commits.
				// Emit an empty report and exit 0 so the host renders "nothing to build" instead
				// of a spurious "no report emitted (exit 1)". The human text path still errors.
				if (opts.stream) {
					const empty: BackfillReport = { total: 0, generated: 0, skipped: 0, errors: 0, outcomes: [] };
					console.log(JSON.stringify({ type: "report", ...empty }));
					return;
				}
				console.error("  No commits found to back-fill.");
				process.exitCode = 1;
				return;
			}

			// `--stream` fires a NDJSON line per commit as the engine drains, so the
			// host UI can advance a progress bar without waiting for the whole batch.
			const onProgress = opts.stream
				? (done: number, total: number, outcome: BackfillOutcome) => {
						console.log(JSON.stringify({ type: "progress", done, total, outcome }));
					}
				: undefined;

			const report = await runBackfill({
				cwd: opts.cwd,
				hashes,
				dryRun: opts.dryRun,
				// Commander fills `minConfidence` with DEFAULT_MIN_CONFIDENCE when the flag
				// is omitted, so it is always a valid tier here.
				minTier: opts.minConfidence,
				onProgress,
			});

			if (opts.stream) {
				console.log(JSON.stringify({ type: "report", ...report }));
			} else if (opts.format === "json") {
				console.log(JSON.stringify(report, null, 2));
			} else {
				console.log(renderText(report, Boolean(opts.dryRun)));
			}
		});
}
