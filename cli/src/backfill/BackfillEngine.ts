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
import { hasLlmCredentials } from "../core/LlmCredentials.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { generateSummary } from "../core/Summarizer.js";
import { getIndexEntryMap, setActiveStorage, storeSummary } from "../core/SummaryStore.js";
import { generateTranscriptId } from "../core/TranscriptId.js";
import { buildMultiSessionContext } from "../core/TranscriptReader.js";
import { launchWorker } from "../hooks/QueueWorker.js";
import { createLogger } from "../Logger.js";
import { type CommitSummary, CURRENT_SCHEMA_VERSION, type LlmConfig, type StoredTranscript } from "../Types.js";
import { type AttributedCommit, attributeCommits } from "./CommitAttributor.js";
import { buildCommitTargetIndex, type CommitTargetIndex } from "./CommitTargetIndex.js";
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

/**
 * Back-margin (matches {@link WINDOW_CAP_MS} in CommitAttributor) applied to the
 * oldest emitted commit's author time when gathering cursor-boundary candidates:
 * a commit's attribution window can reach back this far, so a neighbor commit that
 * old must still be present to truncate ownership.
 */
const CURSOR_BACK_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The single confidence tier EVERY back-fill entry point uses — manual `jolli
 * backfill`, the enable-time background worker, and the VS Code enable trigger.
 * "low" = window-collect-all: attach every in-window conversation turn within the
 * commit's effective worktree + cursor slice, and let the per-summary confidence
 * badge flag the weaker ones honestly. Chosen for maximal historical-context
 * recovery (highest recall, closest to the live pipeline's behavior). Still
 * overridable per invocation via `BackfillOptions.minTier` (the CLI exposes it as
 * `--min-confidence`); this is only the default when a caller omits it.
 */
export const DEFAULT_BACKFILL_TIER: "high" | "medium" | "low" = "low";

export type BackfillStatus = "generated" | "would-generate" | "skipped-has-summary" | "error";

export interface BackfillOutcome {
	readonly commitHash: string;
	/** Commit subject (first line) for human-friendly progress display. */
	readonly commitSubject?: string;
	readonly status: BackfillStatus;
	readonly confidence?: "high" | "medium" | "low";
	readonly method?: "file-overlap" | "branch-match" | "time-window" | "diff-only";
	readonly topics?: number;
	/**
	 * Number of AI conversations attributed to this commit (`attr.sessions.length`;
	 * 0 when no conversation was found → diff-only). Populated on both `would-generate`
	 * (dry-run preview) and `generated`. The UI shows this as "N 个会话".
	 */
	readonly sessions?: number;
	/**
	 * User-initiated conversation turns across the attributed sessions
	 * (`attr.conversationTurns`; count of human-role entries). 0 when diff-only,
	 * and possibly 0 even with sessions > 0 if the attributed turns are all
	 * non-human (AI/tool only). Deliberately NOT `transcriptEntries` (which
	 * includes AI/tool lines and is a larger, less intuitive number). The UI shows
	 * this as "N 轮对话".
	 */
	readonly conversationTurns?: number;
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
	/**
	 * Lowest confidence tier to attribute. Defaults to {@link DEFAULT_BACKFILL_TIER}
	 * ("low" = window-collect-all) for every entry point; pass an explicit value only
	 * to override (e.g. the CLI `--min-confidence` flag).
	 */
	readonly minTier?: "high" | "medium" | "low";
	/** Override for `~/.claude/projects` (tests inject a temp dir). */
	readonly projectsRoot?: string;
	/** Progress callback fired after each commit is processed. */
	readonly onProgress?: (done: number, total: number, outcome: BackfillOutcome) => void;
	/**
	 * Fired right BEFORE a commit's summary is generated (before its LLM call),
	 * unlike `onProgress` which fires after. Lets a UI show "now working on commit
	 * N/total" the instant that commit's (potentially slow) generation starts,
	 * instead of leaving the screen frozen until the first commit completes.
	 * `index` is 1-based over the commits that lack a summary.
	 */
	readonly onCommitStart?: (index: number, total: number, hash: string, subject?: string) => void;
	/**
	 * Cooperative cancellation. Checked at each commit boundary (before starting a
	 * commit's LLM call), so an abort stops the loop cleanly between commits — the
	 * commit in flight always finishes and stores, and the loop never leaves a
	 * half-written summary. Already-generated commits stay on the orphan branch, so
	 * a re-run resumes with only the still-missing commits. Used by the guided front
	 * door's Ctrl-C handler to make a long back-fill interruptible + resumable.
	 */
	readonly signal?: AbortSignal;
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

// hasLlmCredentials is imported from ../core/LlmCredentials.js (single source of
// truth shared with SessionStartHook, the summarizer, and compile).

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
	llmConfig: LlmConfig,
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
	const {
		cwd,
		hashes,
		dryRun = false,
		minTier = DEFAULT_BACKFILL_TIER,
		projectsRoot,
		onProgress,
		onCommitStart,
		signal,
	} = opts;
	const outcomes: BackfillOutcome[] = [];

	log.info("Back-fill start: cwd=%s candidates=%d dryRun=%s minTier=%s", cwd, hashes.length, dryRun, minTier);

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

	// 3. Attribute. `attributeCommits` needs cursor boundaries beyond the emitted
	// set: an already-summarized or out-of-`--last N` neighbor in the same worktree
	// must truncate the window so its conversation isn't mis-attributed. So we pass
	// EVERY own commit whose author time falls in the emitted range
	// `[minTs − 7d, maxTs]` as `candidates`, but only `missing` as `emitOnly`.
	const cursorCandidates = await gatherCursorCandidates(cwd, missing, index);
	const { attributed } = attributeCommits(cursorCandidates, bySession, index, {
		minTier,
		emitOnly: new Set(missing),
		worktreeRoots: roots,
	});

	// 4. Generate + store (unless dry-run).
	const config = await loadConfig();
	const llmConfig: LlmConfig = {
		apiKey: config.apiKey,
		model: config.model,
		jolliApiKey: config.jolliApiKey,
		aiProvider: config.aiProvider,
		localAgentTool: config.localAgentTool,
		localAgentPath: config.localAgentPath,
		localAgentModel: config.localAgentModel,
	};
	const credsOk = hasLlmCredentials(config);

	let done = 0;
	for (const hash of missing) {
		// Cooperative cancellation at the commit boundary: never mid-LLM. The commit
		// already generated is stored; we simply stop before starting the next one.
		// A re-run drops already-summarized commits (step 1) and resumes the rest.
		if (signal?.aborted) {
			log.info("Back-fill aborted at %d/%d commits (signal)", done, missing.length);
			break;
		}
		// `null` attribution → diff-only summary (no conversation confidently found),
		// mirroring the live pipeline's no-session path. The "better none than a wrong
		// one" rule only blocks *attaching* an unsure conversation; every own-commit
		// still gets at least a diff summary.
		const attr = attributed.get(hash) ?? null;
		const method = attr?.method ?? "diff-only";
		// Subject is already in the target index (no extra git call) — carry it so
		// progress UIs can show the commit's one-line message instead of a bare hash.
		const subject = index.commitMeta.get(hash)?.subject;
		// Announce the commit BEFORE its (slow) generation so a UI isn't frozen during
		// the first commit's LLM call. Skipped on dry-run (no generation to wait on).
		if (!dryRun) onCommitStart?.(done + 1, missing.length, hash, subject);
		let outcome: BackfillOutcome;
		if (dryRun) {
			outcome = {
				commitHash: hash,
				status: "would-generate",
				method,
				sessions: attr?.sessions.length ?? 0,
				conversationTurns: attr?.conversationTurns ?? 0,
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
					sessions: attr?.sessions.length ?? 0,
					conversationTurns: attr?.conversationTurns ?? 0,
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

/** The local git author identity (email + name); each field null when unset. */
async function localAuthorIdentity(cwd: string): Promise<{ email: string | null; name: string | null }> {
	const read = async (key: string): Promise<string | null> => {
		const res = await execGit(["config", key], cwd);
		const v = res.exitCode === 0 ? res.stdout.trim() : "";
		return v.length > 0 ? v : null;
	};
	return { email: await read("user.email"), name: await read("user.name") };
}

/**
 * Pushes the local author filter onto `args`. git treats multiple `--author` as
 * OR, so we match EITHER the configured email OR name — a commit made under a
 * different-but-equivalent identity (local/remote email mismatch, or a name-only
 * remote) still counts as the local user's own work, mirroring the live
 * `isLocallyAuthored` (email OR name).
 *
 * `--author` is matched as a regex by default (git's BRE), where `+ ( ) ? { } |`
 * are LITERALS — escaping them (as a naive regex-escape does) turns them into
 * operators and matches nothing (a Gmail `user+tag@…` alias or a `J. Doe (Acme)`
 * name would silently match zero commits). So we add `--fixed-strings` and pass
 * the identity verbatim as a literal substring, mirroring `BranchCommitLister`.
 * `--fixed-strings` is global but safe here since `--author` is the only pattern
 * operand (no `--grep`). Returns whether any filter was added (false → no git
 * identity configured, every commit is a candidate).
 */
async function pushAuthorFilter(args: string[], cwd: string): Promise<boolean> {
	const { email, name } = await localAuthorIdentity(cwd);
	if (!email && !name) return false;
	args.push("--fixed-strings");
	if (email) args.push(`--author=${email}`);
	if (name) args.push(`--author=${name}`);
	return true;
}

/**
 * Returns commit hashes reachable from HEAD, newest-first. Capped to `limit`
 * when given (`undefined` → all reachable commits). Shared by the CLI command,
 * the enable-time worker, and the VS Code "missing summaries" count/button.
 *
 * Scoped to the local user's OWN commits (author email OR name): commits authored
 * by others (merged or pulled in) never have Claude transcripts on this machine,
 * so back-filling them is pointless — they would always resolve to "no
 * conversation found" and inflate the missing-summary count. When no git author
 * identity is configured, the filter is dropped (every commit is a candidate).
 */
export async function recentCommitHashes(cwd: string, limit?: number): Promise<string[]> {
	const args = ["rev-list", "HEAD"];
	if (limit && limit > 0) args.push("--max-count", String(limit));
	await pushAuthorFilter(args, cwd);
	const res = await execGit(args, cwd);
	if (res.exitCode !== 0 || !res.stdout.trim()) return [];
	return res.stdout
		.trim()
		.split("\n")
		.filter((h) => h.length > 0);
}

/**
 * Builds the cursor-boundary candidate set for `attributeCommits`: every own
 * commit whose AUTHOR time (rebase-stable, unlike committer time) falls in the
 * emitted range `[min(emit ts) − 7d, max(emit ts)]`, unioned with `emitOnly`
 * itself. This pulls in already-summarized / out-of-`--last N` neighbors so they
 * can truncate the attribution window. The range is derived from the target
 * index's author times; `emitOnly` commits absent from the index (no real files)
 * simply keep the fallback (just `emitOnly`).
 */
async function gatherCursorCandidates(
	cwd: string,
	emitOnly: ReadonlyArray<string>,
	index: CommitTargetIndex,
): Promise<string[]> {
	const emitTimes: number[] = [];
	for (const h of emitOnly) {
		const ts = index.commitMeta.get(h)?.ts;
		if (typeof ts === "number") emitTimes.push(ts);
	}
	if (emitTimes.length === 0) return [...emitOnly];
	const minTs = Math.min(...emitTimes) - CURSOR_BACK_MARGIN_MS;
	const maxTs = Math.max(...emitTimes);

	// `git log --pretty=format:%H|%at` — one clean line per commit (no "commit"
	// header), %at = author epoch seconds. Own-author scoped (email OR name).
	const args = ["log", "HEAD", "--pretty=format:%H|%at"];
	await pushAuthorFilter(args, cwd);
	const res = await execGit(args, cwd);
	const candidates = new Set(emitOnly);
	if (res.exitCode === 0 && res.stdout.trim()) {
		for (const line of res.stdout.trim().split("\n")) {
			const sep = line.indexOf("|");
			if (sep < 0) continue;
			const hash = line.slice(0, sep);
			const ts = Number.parseInt(line.slice(sep + 1), 10) * 1000;
			if (hash && !Number.isNaN(ts) && ts >= minTs && ts <= maxTs) candidates.add(hash);
		}
	}
	return [...candidates];
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

/**
 * Whether this repo has ANY memory on ANY branch (orphan-branch index non-empty).
 * Cheap — a single index read, no transcript scan or LLM call. Drives the VS Code
 * per-repo cold-start decision: `false` → show the back-fill cold-start card.
 * NOT branch-scoped: a returning user on a fresh branch of a repo that already has
 * memories is not in cold start.
 */
export async function repoHasAnyMemory(cwd: string): Promise<boolean> {
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);
	const existing = await getIndexEntryMap(cwd, storage);
	return existing.size > 0;
}

/** One own commit that lacks a summary — the row shape the UI candidate list renders. */
export interface MissingCommitInfo {
	readonly commitHash: string;
	/** First line of the commit message. */
	readonly subject: string;
	/** Author time (epoch ms). Newest-first ordering + relative-date display. */
	readonly ts: number;
}

/**
 * Lists the local user's OWN commits that lack a summary, newest-first, optionally
 * bounded to those authored within the last `sinceMs` milliseconds.
 *
 * This is the metadata-carrying sibling of {@link recentCommitHashes}: the
 * VS Code cold-start card + Settings panel need the subject + timestamp per commit
 * (to render the selectable row and its relative date), not just the hash. Own-author
 * scoped (email OR name) like every other back-fill entry point — commits authored by
 * others never have local Claude transcripts, so back-filling them is pointless.
 *
 *   - `sinceMs` given  → cold-start window (e.g. "last 30 days"): only commits whose
 *                        AUTHOR time is `>= now - sinceMs`. `now` is derived from the
 *                        newest own commit (NOT wall-clock) so the window is stable and
 *                        testable without injecting a clock.
 *   - `sinceMs` omitted → every own commit lacking a summary (Settings full scope).
 *
 * `limit` (when > 0) caps the result to the `limit` NEWEST missing commits — used
 * by the cold-start card so a huge backlog doesn't produce an overwhelming list
 * (the excess is surfaced via the card's "manage all in Settings" link).
 */
export async function listMissingCommits(cwd: string, sinceMs?: number, limit?: number): Promise<MissingCommitInfo[]> {
	// `%x00` = NUL field separator so a commit subject containing '|' can't corrupt
	// parsing (mirrors the caution in gatherCursorCandidates, which only needed %at).
	const args = ["log", "HEAD", "--pretty=format:%H%x00%at%x00%s"];
	await pushAuthorFilter(args, cwd);
	const res = await execGit(args, cwd);
	if (res.exitCode !== 0 || !res.stdout.trim()) return [];

	const rows: MissingCommitInfo[] = [];
	let newest = Number.NEGATIVE_INFINITY;
	for (const line of res.stdout.split("\n")) {
		const parts = line.split("\u0000");
		if (parts.length < 3) continue;
		const [hash, atStr, subject] = parts;
		const ts = Number.parseInt(atStr, 10) * 1000;
		if (!hash || Number.isNaN(ts)) continue;
		if (ts > newest) newest = ts;
		rows.push({ commitHash: hash, subject, ts });
	}
	if (rows.length === 0) return [];

	// Time-window filter is applied relative to the newest own commit, not wall-clock:
	// keeps the boundary deterministic and lets tests fix `sinceMs` without a clock stub.
	// (The newest row always satisfies the bound for any non-negative sinceMs, so
	// `windowed` is never empty when `rows` isn't — no separate empty guard needed.)
	const windowed = typeof sinceMs === "number" ? rows.filter((r) => r.ts >= newest - sinceMs) : rows;

	// Drop the ones that already have a summary (index membership — no transcript scan).
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);
	const existing = await getIndexEntryMap(cwd, storage);
	const missing = windowed.filter((r) => !existing.has(r.commitHash));
	// Cap to the newest `limit` when requested (rows are already newest-first).
	return typeof limit === "number" && limit > 0 ? missing.slice(0, limit) : missing;
}
