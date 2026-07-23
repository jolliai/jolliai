#!/usr/bin/env node
/**
 * SessionStartHook — Claude Code SessionStart Event Handler
 *
 * This script is invoked by Claude Code's hook system when a new session starts.
 * It outputs a mini-briefing as additionalContext, giving the LLM basic awareness
 * of the current branch's development history.
 *
 * The hook:
 *   1. Detects the current git branch
 *   2. Checks Jolli Memory index for recorded commits on this branch
 *   3. Loads the last commit's summary for topic titles and key decisions
 *   4. Reads local plans.json for associated plan names
 *   5. Outputs a concise briefing (~300-500 tokens) as plain text to stdout
 *
 * Performance target: <200ms with 500ms hard timeout.
 * Uses briefing cache to avoid redundant git calls when branch/commit unchanged.
 *
 * Data sources (~3 git calls + 1 fs read):
 *   - git branch --show-current → current branch name
 *   - orphan branch index.json → commit count, dates, diffStats
 *   - orphan branch summaries/{hash}.json → last topic title, decisions
 *   - .jolli/jollimemory/plans.json → associated plan names
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { resolveClientKind } from "../core/ClientHeader.js";
import { readFileFromBranch } from "../core/GitOps.js";
import { hasLlmCredentials } from "../core/LlmCredentials.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig, normalizePlansRegistry, saveConfig } from "../core/SessionTracker.js";
import { isLocalAgentAuthError } from "../core/SummaryErrorMarker.js";
import { getDisplayDate } from "../core/SummaryFormat.js";
import { getIndex } from "../core/SummaryStore.js";
import { collectAllTopics } from "../core/SummaryTree.js";
import { createLogger, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import type { CommitSummary, DiffStats, JolliMemoryConfig, PlansRegistry, SummaryIndexEntry } from "../Types.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { AUTH_FAILURE_REMINDER_TEXT } from "./AuthRemediation.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("SessionStartHook");

/** Branches that should be skipped (not feature branches) */
const SKIP_BRANCHES = new Set(["main", "master", "develop", "development", "staging", "production"]);

const HARD_TIMEOUT_MS = 500;

interface BriefingCache {
	readonly branch: string;
	readonly lastCommitHash: string;
	readonly briefingText: string;
	readonly generatedAt: string;
}

// ─── Login reminder (Claude Code plugin only) ────────────────────────────────

/**
 * Per-repo marker that silences the not-signed-in reminder. Lives beside the
 * other per-project state (`.jolli/jollimemory/`) so it is worktree-scoped.
 * Created on the user's request ("stop reminding me"); auto-removed once a
 * credential appears (see {@link getLoginReminder}).
 */
const LOGIN_REMINDER_DISMISS_MARKER = "login-reminder-dismissed";

/**
 * Shown at session start when the Claude Code plugin has no way to generate
 * memories yet. Plain text — Claude Code displays it to the user AND injects it
 * into Claude's context, so it doubles as an instruction the agent can act on.
 */
const LOGIN_REMINDER_TEXT = [
	"[Jolli Memory] Not signed in — no memories are being generated for your commits.",
	"→ Run /jolli:login to sign in to Jolli (AI summaries, no Anthropic API key needed).",
	`(To stop this reminder without signing in, create an empty file at` +
		` .jolli/jollimemory/${LOGIN_REMINDER_DISMISS_MARKER} in this repo.)`,
].join("\n");

/**
 * Pure decision for whether to surface the not-signed-in reminder. Kept
 * side-effect-free so every branch is unit-testable regardless of the build's
 * `__JOLLI_CLIENT_KIND__` value (which is fixed to `"cli"` in the CLI build).
 *
 * Only the Claude Code plugin shows this: the CLI and VS Code surfaces have
 * their own sign-in UX, and gating here keeps the reminder out of their
 * session-start output.
 */
export function computeLoginReminder(clientKind: string, hasCredential: boolean, dismissed: boolean): string | null {
	if (clientKind !== "claude-plugin") return null;
	if (hasCredential) return null;
	if (dismissed) return null;
	return LOGIN_REMINDER_TEXT;
}

/**
 * The Claude Code plugin defaults `aiProvider` to `"local-agent"`. A plugin user
 * is by definition running inside Claude Code, so a signed-in `claude` CLI is
 * already on hand — driving it through the local-agent backend generates memories
 * with zero extra setup: no Anthropic API key, no Jolli sign-in. We seed that
 * choice on the plugin's session start, but ONLY when the user has expressed no
 * explicit provider preference; an explicit "anthropic" / "jolli" / "local-agent"
 * pick is never overwritten. `localAgentTool` is seeded alongside so the runner
 * has its target tool.
 *
 * Called BEFORE {@link getLoginReminder} in `main()` so a brand-new plugin user is
 * immediately "credentialed" (`hasLlmCredentials` counts local-agent) and never
 * sees the spurious "Not signed in — no memories" reminder on their first session.
 *
 * Gated to the plugin build (`clientKind === "claude-plugin"`): the CLI and VS Code
 * surfaces keep their own default-derivation and are intentionally left untouched.
 * Returns whether it wrote the default. Swallows write failures — a config-write
 * hiccup must never block session startup or suppress the briefing; the fallback
 * (no write) just leaves the reminder armed, which is the safe direction.
 */
export async function ensurePluginDefaultProvider(
	clientKind: string,
	config: Pick<JolliMemoryConfig, "aiProvider">,
): Promise<boolean> {
	if (clientKind !== "claude-plugin") return false;
	if (config.aiProvider !== undefined) return false;
	try {
		await saveConfig({ aiProvider: "local-agent", localAgentTool: "claude-code" });
		log.info("Seeded default aiProvider=local-agent for the Claude Code plugin");
		return true;
	} catch (error) {
		log.info("Failed to seed default local-agent provider: %s", (error as Error).message);
		return false;
	}
}

/**
 * Wiring for {@link computeLoginReminder}: resolves the build's client kind,
 * whether any LLM credential is configured (Anthropic key, Jolli Space key, or the
 * `local-agent` provider — which needs no jollimemory-held key), and whether the
 * dismiss marker is present — then returns the reminder text or null. Also cleans
 * up a stale dismiss marker once a credential exists, so a later sign-out re-arms
 * the reminder cleanly.
 */
export async function getLoginReminder(
	projectDir: string,
	clientKind: string = resolveClientKind(),
): Promise<string | null> {
	const config = await loadConfig();
	// Authoritative predicate (shared with the summarizer / compile / back-fill):
	// counts `local-agent` as credentialed. A hand-rolled key-only check here would
	// falsely tell local-agent users "Not signed in" though they generate memories
	// fine. Imported from the LlmCredentials leaf so this LLM-free hook stays light.
	const hasCredential = hasLlmCredentials(config);
	const markerPath = join(projectDir, ".jolli", "jollimemory", LOGIN_REMINDER_DISMISS_MARKER);
	const dismissed = existsSync(markerPath);

	// Once a credential is present, a leftover dismiss marker is moot — remove it
	// so signing out later starts from a clean slate.
	if (hasCredential && dismissed) {
		try {
			rmSync(markerPath);
		} catch {
			// Non-fatal — a stale marker only suppresses a reminder that a present
			// credential already suppresses.
		}
	}

	return computeLoginReminder(clientKind, hasCredential, dismissed);
}

// ─── Local-agent auth-failure reminder (Claude Code plugin only) ──────────────

/**
 * Reminder text is shared with the post-commit inline surface (see
 * {@link file://./AuthRemediation.ts}) so the two never drift. No manual
 * dismiss marker (unlike the not-signed-in reminder): a broken-login state is
 * transient, not a steady-state choice, so silencing it would just keep
 * generation failing silently — the exact UX this exists to kill. It clears
 * automatically once a later commit generates successfully (the marker on the
 * newest commit is then absent).
 */

/**
 * Reads the newest summarized commit on the current branch and reports whether
 * it carries the local-agent auth-failure marker. One git read (mirrors
 * {@link loadLastSummary}); reads current truth, so the reminder self-clears
 * after a successful regeneration without any persisted dismiss state.
 */
async function isLatestCommitAuthFailure(commitHash: string, cwd: string): Promise<boolean> {
	try {
		const raw = await readFileFromBranch(ORPHAN_BRANCH, `summaries/${commitHash}.json`, cwd);
		if (!raw) return false;
		return isLocalAgentAuthError(JSON.parse(raw) as CommitSummary);
	} catch (error: unknown) {
		/* v8 ignore next 3 - defensive: summary load failure degrades to "no reminder" */
		log.info("Failed to check auth-failure state for %s: %s", commitHash.substring(0, 8), (error as Error).message);
		return false;
	}
}

/**
 * Returns the auth-failure reminder when the newest summarized commit on the
 * current branch failed on an expired local `claude` login, else null.
 *
 * Plugin-only (like {@link getLoginReminder}): other surfaces have their own
 * failure UI. Checks only the NEWEST commit — a later healthy commit means the
 * login is working again, so nothing to remind about.
 *
 * Unlike the branch briefing, this deliberately does NOT skip main/master/etc.
 * (`SKIP_BRANCHES`): a broken local login fails generation on EVERY branch, so a
 * user who only ever commits on `main` must still be warned. The only branch
 * guard is a detached HEAD (no branch to scan).
 *
 * `clientKind` is injected (defaulting to the build's resolved kind) for the
 * same reason {@link computeLoginReminder} takes it: the CLI test build pins
 * `__JOLLI_CLIENT_KIND__` to "cli", so a hard-coded `resolveClientKind()` here
 * would make the plugin path untestable.
 */
export async function getAuthFailureReminder(
	projectDir: string,
	clientKind: string = resolveClientKind(),
): Promise<string | null> {
	if (clientKind !== "claude-plugin") return null;
	const branch = getCurrentBranch(projectDir);
	if (!branch) return null;
	const index = await getIndex(projectDir);
	if (!index) return null;
	const rootEntries = index.entries.filter(
		(e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined),
	);
	if (rootEntries.length === 0) return null;
	const newest = [...rootEntries].sort(
		(a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime(),
	)[0];
	return (await isLatestCommitAuthFailure(newest.commitHash, projectDir)) ? AUTH_FAILURE_REMINDER_TEXT : null;
}

/**
 * Main entry point — called when this script is executed by Claude Code SessionStart hook.
 */
export async function main(): Promise<void> {
	// Skip when this Claude session was spawned by jollimemory's local-agent
	// backend: generating a briefing here would re-enter jollimemory against a
	// throwaway temp cwd (and, under local-agent, recurse into another spawn).
	// See AgentReentry.
	if (isLocalAgentChild()) {
		log.info("SessionStart hook skipped — running inside a jollimemory-spawned local agent");
		return;
	}
	try {
		const input = await readStdin();
		const { cwd } = JSON.parse(input) as { cwd?: string };
		const projectDir = cwd ?? process.cwd();
		setLogDir(projectDir);

		log.info("SessionStartHook invoked (cwd=%s)", projectDir);
		if (await readManualDisableFlag(projectDir)) {
			log.info("SessionStart hook skipped — repository manually disabled");
			return;
		}

		const context = await buildSessionStartContext(projectDir, "shared", {
			includeBriefing: true,
			includePluginReminders: false,
		});
		if (context) {
			process.stdout.write(context);
		} else {
			log.info("No briefing or reminder generated (skipped or timed out)");
		}
	} catch (error: unknown) {
		/* v8 ignore next 2 - defensive: main() catches unexpected errors to never block session startup */
		log.info("SessionStartHook failed: %s", (error as Error).message);
	}
}

/**
 * Builds the SessionStart context without writing stdout. The canonical
 * settings-installed hook passes `shared`, while PluginBootstrap passes
 * `claude-plugin` to cover the very first session before that hook is loaded.
 */
export async function buildSessionStartContext(
	projectDir: string,
	clientKind: string,
	options: { readonly includeBriefing?: boolean; readonly includePluginReminders?: boolean } = {},
): Promise<string | null> {
	const includeBriefing = options.includeBriefing !== false;
	const includePluginReminders = options.includePluginReminders !== false;
	const [briefing, authReminder, reminder] = await Promise.all([
		includeBriefing
			? Promise.race([generateBriefing(projectDir), timeout(HARD_TIMEOUT_MS)])
			: Promise.resolve(null),
		includePluginReminders
			? Promise.race([getAuthFailureReminder(projectDir, clientKind), timeout(HARD_TIMEOUT_MS)])
			: Promise.resolve(null),
		includePluginReminders
			? Promise.race([getLoginReminder(projectDir, clientKind), timeout(HARD_TIMEOUT_MS)])
			: Promise.resolve(null),
	]);
	const sections = [authReminder, reminder, briefing].filter((section): section is string => Boolean(section));
	if (sections.length === 0) return null;
	log.info("SessionStart output (%d sections)", sections.length);
	return sections.join("\n\n");
}

/**
 * Generates a briefing for the current branch, or returns null to skip.
 */
async function generateBriefing(projectDir: string): Promise<string | null> {
	// Step 1: Get current branch
	const branch = getCurrentBranch(projectDir);
	if (!branch || SKIP_BRANCHES.has(branch)) {
		return null;
	}

	// Step 2: Check briefing cache
	const cacheResult = checkBriefingCache(projectDir, branch);
	if (cacheResult) {
		return cacheResult;
	}

	// Step 3: Load index and filter for this branch
	const index = await getIndex(projectDir);
	if (!index) {
		return null;
	}

	// Intentionally root-only (not leaf): aligned with `jolli view` and
	// `jolli search`. The 2026-05-12 leaf-only-memory-display redesign flipped
	// the VS Code display surfaces (Timeline, Memory Bank tree, Branch tab) to
	// leaves; this session-briefing path stays on root semantics until a
	// follow-up explicitly verifies its tests + UX under the leaf model.
	const rootEntries = index.entries.filter(
		(e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined),
	);

	if (rootEntries.length === 0) {
		return null;
	}

	// Sort by activity date (newest first, to find "last worked on") — see getDisplayDate.
	const sorted = [...rootEntries].sort(
		(a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime(),
	);

	const lastEntry = sorted[0];
	const oldestEntry = sorted[sorted.length - 1];

	// Skip if only 1 commit made today
	if (sorted.length === 1 && isToday(getDisplayDate(lastEntry))) {
		return null;
	}

	// Step 4: Load last commit's summary for topic titles and decisions
	const lastSummary = await loadLastSummary(lastEntry.commitHash, projectDir);

	// Step 5: Load local plans.json for associated plan names
	const planNames = loadAssociatedPlanNames(projectDir, branch);

	// Step 6: Aggregate diffStats from index entries (cached since PROJ-597)
	const aggregatedDiffStats = aggregateIndexDiffStats(sorted);

	// Step 7: Build enriched briefing
	const briefing = buildBriefingText(
		branch,
		sorted,
		lastEntry,
		oldestEntry,
		lastSummary,
		planNames,
		aggregatedDiffStats,
	);

	// Step 8: Cache the result (use HEAD hash as cache key, not index commit hash,
	// because HEAD may be ahead of the last summarized commit during active development)
	const headHash = getCurrentHeadHash(projectDir);
	saveBriefingCache(projectDir, branch, headHash ?? lastEntry.commitHash, briefing);

	return briefing;
}

// ─── Summary and plan data loading ──────────────────────────────────────────

/** Extracted data from the last commit's summary */
interface LastSummaryData {
	readonly lastTopicTitle: string | null;
	readonly keyDecisions: ReadonlyArray<string>;
}

/**
 * Loads the last commit's summary file directly (one git call).
 * Extracts topic title and key decisions without loading the full tree.
 */
async function loadLastSummary(commitHash: string, cwd: string): Promise<LastSummaryData> {
	try {
		const raw = await readFileFromBranch(ORPHAN_BRANCH, `summaries/${commitHash}.json`, cwd);
		if (!raw) {
			return { lastTopicTitle: null, keyDecisions: [] };
		}
		const summary = JSON.parse(raw) as CommitSummary;
		const topics = collectAllTopics(summary);

		// Get the most recent topic's title (topics are chronological, last = newest)
		const lastTopicTitle = topics.length > 0 ? topics[topics.length - 1].title : null;

		// Collect all non-empty decisions
		const keyDecisions: string[] = [];
		for (const topic of topics) {
			if (topic.decisions && topic.decisions.trim().length > 0) {
				keyDecisions.push(topic.decisions);
			}
		}

		return { lastTopicTitle, keyDecisions };
	} catch (error: unknown) {
		/* v8 ignore next 3 - defensive: summary load failure degrades gracefully */
		log.info("Failed to load last summary: %s", (error as Error).message);
		return { lastTopicTitle: null, keyDecisions: [] };
	}
}

/**
 * Reads local plans.json to find active plan names for the current branch.
 * Pure filesystem read — no git calls.
 */
function loadAssociatedPlanNames(projectDir: string, _branch: string): ReadonlyArray<string> {
	try {
		const plansPath = join(projectDir, ".jolli", "jollimemory", "plans.json");
		if (!existsSync(plansPath)) return [];

		// Route through the §14 normalizer (pure/sync) so legacy soft-deleted
		// (`ignored:true`) and dead-field rows don't leak into the session-start
		// context before detect* physically rewrites plans.json.
		const parsed = JSON.parse(readFileSync(plansPath, "utf-8")) as Partial<PlansRegistry>;
		const registry = normalizePlansRegistry(parsed).registry;
		const names: string[] = [];
		for (const entry of Object.values(registry.plans)) {
			// Include active (uncommitted) plans — worktree-scoped, no branch filter
			if (!entry.commitHash && entry.title) {
				names.push(entry.title);
			}
		}
		return names;
	} catch {
		/* v8 ignore next 2 - defensive: plans.json parse failure */
		return [];
	}
}

/**
 * Aggregates diffStats from index entries that have cached stats.
 * Entries without diffStats (legacy) are skipped — partial data is better than none.
 */
function aggregateIndexDiffStats(entries: ReadonlyArray<SummaryIndexEntry>): DiffStats | null {
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	let hasAny = false;

	for (const entry of entries) {
		if (entry.diffStats) {
			filesChanged += entry.diffStats.filesChanged;
			insertions += entry.diffStats.insertions;
			deletions += entry.diffStats.deletions;
			hasAny = true;
		}
	}

	return hasAny ? { filesChanged, insertions, deletions } : null;
}

// ─── Briefing text builder ──────────────────────────────────────────────────

/**
 * Builds the enriched briefing text from index + summary + plan data.
 *
 * Output format targets ~300-500 tokens for the LLM's context window.
 */
function buildBriefingText(
	branch: string,
	entries: ReadonlyArray<SummaryIndexEntry>,
	lastEntry: SummaryIndexEntry,
	oldestEntry: SummaryIndexEntry,
	summaryData: LastSummaryData,
	planNames: ReadonlyArray<string>,
	diffStats: DiffStats | null,
): string {
	const commitCount = entries.length;
	const periodStart = formatDate(getDisplayDate(oldestEntry));
	const periodEnd = formatDate(getDisplayDate(lastEntry));
	const daysSinceLastCommit = daysBetween(getDisplayDate(lastEntry), new Date().toISOString());

	const lines: string[] = [];

	// Line 1: Branch header
	lines.push(`[Jolli Memory — ${branch}]`);

	// Line 2: Commit stats + diffStats
	let statsLine = `${commitCount} commits (${periodStart} ~ ${periodEnd})`;
	if (diffStats) {
		statsLine += ` | ${diffStats.filesChanged} files, +${diffStats.insertions} -${diffStats.deletions}`;
	}
	lines.push(statsLine);

	// Line 3: Last topic (from summary) or fallback to commit message
	const lastLabel = summaryData.lastTopicTitle ?? lastEntry.commitMessage;
	lines.push(`Last: ${lastLabel} (${periodEnd})`);

	// Line 4: Key decisions (semicolon-separated, truncated to fit)
	if (summaryData.keyDecisions.length > 0) {
		const decisionsText = truncateDecisions(summaryData.keyDecisions);
		lines.push(`Decisions: ${decisionsText}`);
	}

	// Line 5: Associated plans
	if (planNames.length > 0) {
		lines.push(`Plans: ${planNames.join("; ")}`);
	}

	// Line 6: Recall suggestion based on time gap.
	const recallSuggestion = formatRecallSuggestion(daysSinceLastCommit, resolveClientKind());
	if (recallSuggestion) lines.push(recallSuggestion);

	return lines.join("\n");
}

/**
 * Builds the session-start recall call-to-action, or null when the last commit is
 * same-day (nothing to suggest).
 *
 * The recall entry point differs by surface, so this deliberately NEVER names an
 * unnamespaced `jolli-recall` skill: the Claude Code plugin exposes recall as the
 * namespaced `/jolli:recall` skill, while every other surface reaches the same
 * capability through the `jolli recall` CLI (the `recall` MCP tool wraps the same
 * engine). Recall defaults to the current branch, so no argument is needed.
 *
 * Pure and `clientKind`-parameterized (mirrors {@link computeLoginReminder}) so both
 * the plugin and non-plugin branches are unit-testable regardless of the build's
 * fixed `__JOLLI_CLIENT_KIND__` (always `"cli"` in the CLI test build).
 */
export function formatRecallSuggestion(daysSinceLastCommit: number, clientKind: string): string | null {
	if (daysSinceLastCommit <= 0) return null;
	const recallHint = clientKind === "claude-plugin" ? "/jolli:recall" : "`jolli recall`";
	return daysSinceLastCommit > 3
		? `Warning: ${daysSinceLastCommit} days since last commit. Run ${recallHint} for full context.`
		: `Tip: run ${recallHint} for full context`;
}

/**
 * Truncates a list of decisions into a semicolon-separated string,
 * keeping it under ~200 characters to avoid bloating the briefing.
 */
function truncateDecisions(decisions: ReadonlyArray<string>): string {
	const MAX_LENGTH = 200;
	const joined: string[] = [];
	let totalLength = 0;

	for (const decision of decisions) {
		// Strip trailing period/semicolon for consistency
		let clean = decision.replace(/[.;]\s*$/, "").trim();
		// Hard-cap individual decisions that exceed the limit
		if (clean.length > MAX_LENGTH) {
			clean = `${clean.slice(0, MAX_LENGTH - 1)}…`;
		}
		if (totalLength + clean.length > MAX_LENGTH && joined.length > 0) {
			break;
		}
		joined.push(clean);
		// +2 for the "; " separator
		totalLength += clean.length + 2;
	}

	return joined.join("; ");
}

// ─── Briefing cache ─────────────────────────────────────────────────────────

function getBriefingCachePath(projectDir: string): string {
	return join(projectDir, ".jolli", "jollimemory", "briefing-cache.json");
}

function checkBriefingCache(projectDir: string, branch: string): string | null {
	const cachePath = getBriefingCachePath(projectDir);
	if (!existsSync(cachePath)) return null;

	try {
		const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as BriefingCache;
		if (cache.branch !== branch) return null;

		// Validate that HEAD hasn't moved since we cached the briefing
		const currentHead = getCurrentHeadHash(projectDir);
		if (!currentHead || cache.lastCommitHash !== currentHead) return null;

		return cache.briefingText;
	} catch {
		return null;
	}
}

function saveBriefingCache(projectDir: string, branch: string, lastCommitHash: string, briefingText: string): void {
	const cachePath = getBriefingCachePath(projectDir);
	const cache: BriefingCache = {
		branch,
		lastCommitHash,
		briefingText,
		generatedAt: new Date().toISOString(),
	};

	try {
		const dir = dirname(cachePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(cachePath, JSON.stringify(cache, null, "\t"), "utf-8");
	} catch {
		// Non-critical — cache write failure is fine
	}
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function getCurrentHeadHash(projectDir: string): string | null {
	try {
		return (
			execFileSyncHidden("git", ["rev-parse", "HEAD"], {
				encoding: "utf-8",
				cwd: projectDir,
			}).trim() || null
		);
	} catch {
		/* v8 ignore next */ return null;
	}
}

function getCurrentBranch(projectDir: string): string | null {
	try {
		return (
			execFileSyncHidden("git", ["branch", "--show-current"], {
				encoding: "utf-8",
				cwd: projectDir,
			}).trim() || null
		);
	} catch {
		/* v8 ignore next */ return null;
	}
}

/* v8 ignore next 6 - timeout is used internally by Promise.race; not directly testable */
function timeout(ms: number): Promise<null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref();
	});
}

function isToday(isoDate: string): boolean {
	const date = new Date(isoDate);
	const today = new Date();
	return (
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate()
	);
}

function daysBetween(isoA: string, isoB: string): number {
	const a = new Date(isoA).getTime();
	const b = new Date(isoB).getTime();
	return Math.floor(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
	/* v8 ignore next */
	if (!iso) return "unknown";
	return iso.split("T")[0];
}

/* v8 ignore next 3 - script entry point */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	main();
}
