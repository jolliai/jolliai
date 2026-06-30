/**
 * BackfillEngine — orchestrates historical summary back-fill.
 *
 * Fully isolated from the live post-commit pipeline (QueueWorker / sessions.json
 * / cursors.json). For a list of candidate commit hashes it:
 *   1. drops the ones that already have a summary;
 *   2. scans on-disk Claude transcripts and the repo's real-commit index;
 *   3. attributes transcript slices to commits ({@link attributeCommits});
 *   4. for each confidently-attributed commit, reuses the SAME summary
 *      generation + storage path as the live flow (`generateSummary` /
 *      `storeSummary`), tagging the result `backfilled`.
 *
 * `dryRun` stops after step 3 and reports the attribution + confidence without
 * any LLM call — used for validation and to tune thresholds.
 */

import { execGit, getCommitInfo, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { generateSummary } from "../core/Summarizer.js";
import { getIndexEntryMap, setActiveStorage, storeSummary } from "../core/SummaryStore.js";
import { generateTranscriptId } from "../core/TranscriptId.js";
import { buildMultiSessionContext } from "../core/TranscriptReader.js";
import { launchWorker } from "../hooks/QueueWorker.js";
import { createLogger } from "../Logger.js";
import { type CommitSummary, CURRENT_SCHEMA_VERSION, type StoredTranscript } from "../Types.js";
import { type AttributedCommit, attributeCommits } from "./CommitAttributor.js";
import { buildCommitTargetIndex } from "./CommitTargetIndex.js";
import { cwdInRoots, scanClaudeTranscripts } from "./RawTranscriptScanner.js";

const log = createLogger("BackfillEngine");

/**
 * Branch label for a diff-only back-filled summary (no conversation attributed).
 * A historical commit's *development* branch cannot be reliably recovered after
 * the fact — git stores no "made on branch X" in the commit object; the original
 * branch may be merged/deleted and `git branch --contains` / `git log --source`
 * return arbitrary refs. So instead of stamping the run-time HEAD (wrong) we use
 * an explicit "backfilled" marker. When a conversation IS attributed, its
 * transcript `gitBranch` (captured at edit time) is used — that one is reliable.
 */
const DIFF_ONLY_BRANCH = "backfilled";

export type BackfillStatus = "generated" | "would-generate" | "skipped-has-summary" | "error";

export interface BackfillOutcome {
	readonly commitHash: string;
	/** Commit subject (first line) for human-friendly progress display. */
	readonly commitSubject?: string;
	readonly status: BackfillStatus;
	readonly confidence?: "high" | "medium";
	readonly method?: "file-overlap" | "time-window" | "diff-only";
	readonly topics?: number;
	readonly message?: string;
}

export interface BackfillReport {
	readonly total: number;
	readonly generated: number;
	readonly skipped: number;
	readonly errors: number;
	readonly outcomes: ReadonlyArray<BackfillOutcome>;
}

export interface BackfillOptions {
	readonly cwd: string;
	/** Candidate commit hashes, newest-first (engine drops those already summarized). */
	readonly hashes: ReadonlyArray<string>;
	readonly dryRun?: boolean;
	readonly includeMedium?: boolean;
	/** Override for `~/.claude/projects` (tests inject a temp dir). */
	readonly projectsRoot?: string;
	/** Progress callback fired after each commit is processed. */
	readonly onProgress?: (done: number, total: number, outcome: BackfillOutcome) => void;
}

/** Returns the repo's worktree roots (for scoping transcripts by cwd). */
async function worktreeRoots(cwd: string): Promise<string[]> {
	const roots = new Set<string>([cwd]);
	const res = await execGit(["worktree", "list", "--porcelain"], cwd);
	if (res.exitCode === 0) {
		for (const line of res.stdout.split("\n")) {
			if (line.startsWith("worktree ")) roots.add(line.slice("worktree ".length).trim());
		}
	}
	return [...roots];
}

function hasLlmCredentials(config: { apiKey?: string; jolliApiKey?: string }): boolean {
	return Boolean(config.apiKey || config.jolliApiKey || process.env.ANTHROPIC_API_KEY);
}

/** Converts an attributed commit's sessions into the orphan-branch transcript artifact. */
function toStoredTranscript(attr: AttributedCommit): StoredTranscript {
	return {
		sessions: attr.sessions.map((s) => ({
			sessionId: s.sessionId,
			source: s.source,
			transcriptPath: s.transcriptPath,
			entries: [...s.entries],
		})),
	};
}

/**
 * Generates and stores one back-filled summary. Throws on LLM/storage failure.
 *
 * `attr === null` is the **diff-only** path: no conversation was confidently
 * attributed, so the summary is generated from the git diff alone — mirroring
 * the live pipeline's no-active-session behavior. 宁缺毋滥 governs only whether a
 * conversation is *attached* (never guess); the diff summary is always produced.
 */
async function generateAndStore(
	hash: string,
	attr: AttributedCommit | null,
	cwd: string,
	llmConfig: { apiKey?: string; model?: string; jolliApiKey?: string; aiProvider?: "anthropic" | "jolli" },
	storage: StorageProvider,
): Promise<number> {
	const commitInfo = await getCommitInfo(hash, cwd);
	const diff = await getDiffContent(`${hash}~1`, hash, cwd);
	const diffStats = await getDiffStats(`${hash}~1`, hash, cwd);
	const conversation = attr ? buildMultiSessionContext(attr.sessions) : "";
	// Tree hash gives the summary parity with the live pipeline's cross-branch
	// matching (same tree on a different branch resolves to this summary).
	const treeRes = await execGit(["rev-parse", `${hash}^{tree}`], cwd);
	const treeHash = treeRes.exitCode === 0 ? treeRes.stdout.trim() : undefined;

	const result = await generateSummary({
		conversation,
		diff,
		commitInfo,
		diffStats,
		transcriptEntries: attr?.transcriptEntries ?? 0,
		conversationTurns: attr?.conversationTurns ?? 0,
		config: llmConfig,
	});

	const transcriptId = attr ? generateTranscriptId() : undefined;
	const summary: CommitSummary = {
		version: CURRENT_SCHEMA_VERSION,
		commitHash: hash,
		commitMessage: commitInfo.message,
		commitAuthor: commitInfo.author,
		commitDate: commitInfo.date,
		branch: attr?.branch || DIFF_ONLY_BRANCH,
		generatedAt: new Date().toISOString(),
		commitType: "commit",
		commitSource: "cli",
		transcriptEntries: result.transcriptEntries,
		conversationTurns: result.conversationTurns,
		llm: result.llm,
		stats: result.stats,
		diffStats: result.stats,
		topics: result.topics,
		backfilled: true,
		backfillMethod: attr?.method ?? "diff-only",
		...(attr ? { backfillConfidence: attr.confidence } : {}),
		...(transcriptId ? { transcripts: [transcriptId] } : {}),
		...(treeHash ? { treeHash } : {}),
		...(result.ticketId ? { ticketId: result.ticketId } : {}),
		...(result.recap ? { recap: result.recap } : {}),
	};

	// Only attach a transcript artifact when a conversation was attributed.
	const artifacts =
		attr && transcriptId ? { transcript: { id: transcriptId, data: toStoredTranscript(attr) } } : undefined;
	await storeSummary(summary, cwd, false, artifacts, storage);
	return result.topics.length;
}

/**
 * Runs the back-fill flow for `opts.hashes`. Never throws for a single commit's
 * failure — per-commit errors become `error` outcomes so a batch always finishes.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillReport> {
	const { cwd, hashes, dryRun = false, includeMedium = false, projectsRoot, onProgress } = opts;
	const outcomes: BackfillOutcome[] = [];

	log.info(
		"Back-fill start: cwd=%s candidates=%d dryRun=%s includeMedium=%s",
		cwd,
		hashes.length,
		dryRun,
		includeMedium,
	);

	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);

	// 1. Drop commits that already have a summary.
	const existing = await getIndexEntryMap(cwd, storage);
	const missing: string[] = [];
	for (const h of hashes) {
		if (existing.has(h)) outcomes.push({ commitHash: h, status: "skipped-has-summary" });
		else missing.push(h);
	}
	log.info("Back-fill: %d/%d commits lack a summary", missing.length, hashes.length);

	if (missing.length === 0) {
		log.info("Back-fill: nothing to do — all candidates already summarized");
		return summarize(hashes.length, outcomes);
	}

	// 2. Build offline indexes.
	const roots = await worktreeRoots(cwd);
	const bySession = await scanClaudeTranscripts(cwdInRoots(roots), projectsRoot);
	const index = await buildCommitTargetIndex(cwd);
	log.info(
		"Back-fill indexes: %d transcript session(s), %d target commit(s), worktree roots=%j",
		bySession.size,
		index.commitMeta.size,
		roots,
	);

	// 3. Attribute.
	const { attributed } = attributeCommits(missing, bySession, index, { includeMedium });

	// 4. Generate + store (unless dry-run).
	const config = await loadConfig();
	const llmConfig = {
		apiKey: config.apiKey,
		model: config.model,
		jolliApiKey: config.jolliApiKey,
		aiProvider: config.aiProvider,
	};
	const credsOk = hasLlmCredentials(config);

	let done = 0;
	for (const hash of missing) {
		// `null` attribution → diff-only summary (no conversation confidently found),
		// mirroring the live pipeline's no-session path. 宁缺毋滥 only blocks *attaching*
		// an unsure conversation; every own-commit still gets at least a diff summary.
		const attr = attributed.get(hash) ?? null;
		const method = attr?.method ?? "diff-only";
		// Subject is already in the target index (no extra git call) — carry it so
		// progress UIs can show the commit's one-line message instead of a bare hash.
		const subject = index.commitMeta.get(hash)?.subject;
		let outcome: BackfillOutcome;
		if (dryRun) {
			outcome = {
				commitHash: hash,
				status: "would-generate",
				method,
				...(attr ? { confidence: attr.confidence } : {}),
			};
		} else if (!credsOk) {
			outcome = { commitHash: hash, status: "error", message: "no LLM credentials configured" };
		} else {
			try {
				const topics = await generateAndStore(hash, attr, cwd, llmConfig, storage);
				log.info("Back-fill generated %s via %s (%d topics)", hash.substring(0, 8), method, topics);
				outcome = {
					commitHash: hash,
					status: "generated",
					method,
					topics,
					...(attr ? { confidence: attr.confidence } : {}),
				};
			} catch (err) {
				outcome = { commitHash: hash, status: "error", message: (err as Error).message };
				log.error("Back-fill failed for %s: %s", hash.substring(0, 8), (err as Error).message);
			}
		}
		if (subject) outcome = { ...outcome, commitSubject: subject };
		outcomes.push(outcome);
		done++;
		onProgress?.(done, missing.length, outcome);
	}

	// After the WHOLE batch (never per-summary), trigger ONE repo-wide wiki/graph
	// ingest via the same path the live post-commit flow uses. `force` bypasses
	// the debounce cooldown so a deliberate back-fill always refreshes the
	// knowledge wiki/graph; `launchWorker` drains the enqueued ingest op in a
	// detached worker. Skipped on dry-run and when nothing was generated.
	if (!dryRun && outcomes.some((o) => o.status === "generated")) {
		log.info("Back-fill batch done — triggering one repo-wide wiki/graph ingest");
		await enqueueIngestOperation(cwd, "manual", { force: true });
		launchWorker(cwd);
	}

	const report = summarize(hashes.length, outcomes);
	log.info(
		"Back-fill complete: generated=%d skipped=%d errors=%d (of %d candidates)",
		report.generated,
		report.skipped,
		report.errors,
		report.total,
	);
	return report;
}

function summarize(total: number, outcomes: BackfillOutcome[]): BackfillReport {
	let generated = 0;
	let errors = 0;
	let skipped = 0;
	for (const o of outcomes) {
		if (o.status === "generated") generated++;
		else if (o.status === "error") errors++;
		else if (o.status !== "would-generate") skipped++;
	}
	return { total, generated, skipped, errors, outcomes };
}

/** The local git author email, or null when unset (used to scope to own commits). */
async function localAuthorEmail(cwd: string): Promise<string | null> {
	const res = await execGit(["config", "user.email"], cwd);
	const email = res.exitCode === 0 ? res.stdout.trim() : "";
	return email.length > 0 ? email : null;
}

/**
 * Escapes regex metacharacters so a string matches literally. `git rev-list
 * --author=<v>` treats `<v>` as a regex, so an unescaped `.`/`+` in an email
 * (e.g. a Gmail `user+tag@…` alias) would match unintended authors and pull in
 * other people's commits — breaking the "own commits only" scoping.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns commit hashes reachable from HEAD, newest-first. Capped to `limit`
 * when given (`undefined` → all reachable commits). Shared by the CLI command,
 * the enable-time worker, and the VS Code "missing summaries" count/button.
 *
 * Scoped to the local user's OWN commits via `--author=<git user.email>`:
 * commits authored by others (merged or pulled in) never have Claude transcripts
 * on this machine, so back-filling them is pointless — they would always resolve
 * to "no conversation found" and inflate the missing-summary count. When no git
 * author email is configured, the filter is dropped (every commit is a candidate).
 */
export async function recentCommitHashes(cwd: string, limit?: number): Promise<string[]> {
	const args = ["rev-list", "HEAD"];
	if (limit && limit > 0) args.push("--max-count", String(limit));
	const email = await localAuthorEmail(cwd);
	if (email) args.push(`--author=${escapeRegex(email)}`);
	const res = await execGit(args, cwd);
	if (res.exitCode !== 0 || !res.stdout.trim()) return [];
	return res.stdout
		.trim()
		.split("\n")
		.filter((h) => h.length > 0);
}

/**
 * Counts how many commits reachable from HEAD lack a summary. Cheap — only an
 * index membership check, no transcript scan or LLM call. Used by the Settings
 * panel to show "N commits lack a summary".
 */
export async function countMissingSummaries(cwd: string): Promise<{ missing: number; total: number }> {
	const hashes = await recentCommitHashes(cwd);
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);
	const existing = await getIndexEntryMap(cwd, storage);
	let missing = 0;
	for (const h of hashes) if (!existing.has(h)) missing++;
	return { missing, total: hashes.length };
}
