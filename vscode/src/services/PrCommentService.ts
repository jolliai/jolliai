/**
 * PrCommentService
 *
 * Self-contained module for the "Create & Update PR" section in the Summary WebView.
 *
 * Responsibilities:
 * - gh CLI interaction (availability, auth, PR lookup, description edit)
 * - Dual-marker summary embedding in PR Description
 * - Handlers: checkPrStatus, createPr, postToPr (called from SummaryWebviewPanel)
 * - WebView HTML/CSS/JS snippets for the PR section
 *
 * All GitHub/git operations go through the `gh` / `git` CLI — no new dependencies.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { log } from "../util/Logger.js";

const execFileAsync = promisify(execFile);

const TAG = "PrSection";

// ─── HTML helper ─────────────────────────────────────────────────────────────

// ─── Marker constants ────────────────────────────────────────────────────────

const MARKER_START = "<!-- jollimemory-summary-start -->";
const MARKER_END = "<!-- jollimemory-summary-end -->";
const MARKER_PATTERN =
	/<!-- jollimemory-summary-start -->[\s\S]*?<!-- jollimemory-summary-end -->/;

// ─── Marker helpers ──────────────────────────────────────────────────────────

/** Wraps markdown content with start/end markers. */
export function wrapWithMarkers(markdown: string): string {
	return `${MARKER_START}\n${markdown}\n${MARKER_END}`;
}

/** Replaces the marker region in body, or appends if no markers found. */
function replaceSummaryInBody(
	currentBody: string,
	newMarkdown: string,
): string {
	const wrapped = wrapWithMarkers(newMarkdown);
	if (MARKER_PATTERN.test(currentBody)) {
		return currentBody.replace(MARKER_PATTERN, wrapped);
	}
	return currentBody ? `${currentBody}\n\n${wrapped}` : wrapped;
}

// ─── CLI helpers ─────────────────────────────────────────────────────────────

/** Runs a gh command and returns stdout. Throws on non-zero exit. */
async function execGh(args: Array<string>, cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8" });
	return stdout;
}

/** Result of a non-throwing gh invocation. */
type GhCmdResult =
	| { ok: true; stdout: string }
	| { ok: false; code?: string | number; err: Error; stderr?: string };

/**
 * Runs a gh command. Returns a discriminated result — never throws, never
 * returns undefined. Callers decide how to log based on the failure shape
 * (e.g. stderr containing "no pull requests found" is expected and should
 * be debug; anything else is warn).
 */
async function tryExecGh(
	args: Array<string>,
	cwd: string,
): Promise<GhCmdResult> {
	try {
		const stdout = await execGh(args, cwd);
		return { ok: true, stdout };
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		const code = (err as NodeJS.ErrnoException).code;
		// execFile failure: child_process attaches stderr to the error (when
		// within maxBuffer). Missing otherwise — callers must handle undefined.
		const stderr = (err as { stderr?: string }).stderr;
		return { ok: false, code, err, stderr };
	}
}

/** Delay between retry attempts for transient `gh` failures. Exposed for tests. */
export const GH_RETRY_DELAY_MS = 500;

/** Classification of a `gh` probe failure. */
type GhProbeFailure =
	| { ok: false; kind: "notFound"; err: Error }
	| { ok: false; kind: "nonZero"; err: Error }
	| { ok: false; kind: "transient"; err: Error };

type GhProbeResult = { ok: true; stdout: string } | GhProbeFailure;

/**
 * Runs a `gh` command and classifies the failure mode.
 *
 * - `notFound` → binary missing (ENOENT); definitive, no retry helps.
 * - `nonZero` → gh ran but exited non-zero; usually "not authenticated",
 *   but on Windows can also be a transient Credential Manager hiccup.
 * - `transient` → spawn error (EACCES, EBUSY, signal kill, etc.); retry may help.
 */
async function probeGh(
	args: Array<string>,
	cwd: string,
): Promise<GhProbeResult> {
	try {
		const { stdout } = await execFileAsync("gh", args, {
			cwd,
			encoding: "utf8",
		});
		return { ok: true, stdout };
	} catch (e) {
		/* v8 ignore start -- defensive: execFile always rejects with Error; retain the coercion for unexpected non-Error throws */
		const err = e instanceof Error ? e : new Error(String(e));
		/* v8 ignore stop */
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { ok: false, kind: "notFound", err };
		}
		if (typeof code === "number") {
			return { ok: false, kind: "nonZero", err };
		}
		return { ok: false, kind: "transient", err };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether the `gh` CLI is installed and reachable.
 * Retries once on transient errors — but ENOENT is definitive (no retry).
 */
async function checkGhInstalled(
	cwd: string,
): Promise<"installed" | "notFound" | "error"> {
	const r1 = await probeGh(["--version"], cwd);
	if (r1.ok) {
		return "installed";
	}
	if (r1.kind === "notFound") {
		return "notFound";
	}
	log.warn(
		TAG,
		`gh --version failed (${r1.kind}): ${r1.err.message} — retrying once`,
	);
	await sleep(GH_RETRY_DELAY_MS);
	const r2 = await probeGh(["--version"], cwd);
	if (r2.ok) {
		return "installed";
	}
	if (r2.kind === "notFound") {
		return "notFound";
	}
	log.warn(TAG, `gh --version still failing (${r2.kind}): ${r2.err.message}`);
	return "error";
}

/**
 * Checks whether `gh` is authenticated.
 * Retries once on any failure — even non-zero exits can be transient on
 * Windows when Credential Manager is briefly locked (e.g. after sleep/wake).
 */
async function checkGhAuthenticated(
	cwd: string,
): Promise<"authenticated" | "unauthenticated" | "error"> {
	const r1 = await probeGh(["auth", "status"], cwd);
	if (r1.ok) {
		return "authenticated";
	}
	log.warn(
		TAG,
		`gh auth status failed (${r1.kind}): ${r1.err.message} — retrying once`,
	);
	await sleep(GH_RETRY_DELAY_MS);
	const r2 = await probeGh(["auth", "status"], cwd);
	if (r2.ok) {
		return "authenticated";
	}
	if (r2.kind === "nonZero") {
		return "unauthenticated";
	}
	log.warn(TAG, `gh auth status still failing (${r2.kind}): ${r2.err.message}`);
	return "error";
}

/** Runs a git command and returns stdout. */
async function execGit(args: Array<string>, cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
	});
	return stdout;
}

/** Returns the current branch name. */
async function getCurrentBranch(cwd: string): Promise<string> {
	const raw = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	return raw.trim();
}

/** Pushes the current branch to origin (no-op if already pushed). */
async function pushBranch(cwd: string): Promise<void> {
	await execGit(["push", "-u", "origin", "HEAD"], cwd);
}

interface PrInfo {
	number: number;
	url: string;
	title: string;
	body: string;
}

/**
 * A closed (merged or closed-without-merge) PR shown in the "Previously"
 * history strip below the active PR actions. URL is included so the webview
 * can render each entry as a clickable link without re-querying gh.
 */
export interface PrHistoryEntry {
	readonly number: number;
	readonly url: string;
	readonly state: "MERGED" | "CLOSED";
}

/**
 * Discriminated result of `findPrForBranch`.
 *
 * `kind === "found"` strictly means there is an open PR — when only merged /
 * closed PRs exist on the branch we return `kind === "noPr"` with `history`
 * populated. This keeps Edit PR off merged/closed entries (editing a merged
 * PR's title/body works but is almost never what the user wants) and lets the
 * user create a new PR on the same branch with the previous one visible as
 * history.
 *
 * Pre-refactor this function returned `PrInfo | undefined` and collapsed four
 * distinct outcomes into the same `undefined` value: real no-PR, auth/network
 * failure, unparseable JSON, and zero-numbered JSON. Callers then showed a
 * "No PR found" + Create PR button for all four, which misled users into
 * creating duplicate PRs after a token lapse. The union forces each caller
 * to decide between the three real outcomes.
 */
type PrLookup =
	| { kind: "found"; pr: PrInfo; history: ReadonlyArray<PrHistoryEntry> }
	| { kind: "noPr"; history: ReadonlyArray<PrHistoryEntry> }
	| { kind: "lookupError"; reason: string };

/** Raw row shape returned by `gh pr list --json number,url,title,body,state`. */
interface RawPrListRow {
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly body: string;
	readonly state: "OPEN" | "MERGED" | "CLOSED";
}

/**
 * Returns PR info for the given branch.
 *
 * Uses `gh pr list --state all --head <branch>` so we get the active PR (if
 * any) AND closed history in a single round-trip. The webview shows the active
 * one front-and-center, history as a "Previously: #N (merged) · ..." strip.
 *
 * Why list instead of view: `gh pr view <branch>` only returns the most-recent
 * PR regardless of state, so a force-pushed branch with PR1 merged + PR2 open
 * showed only PR2; PR1 disappeared from the UI even though the user could
 * still navigate to it on GitHub. List + state filtering is the right shape.
 *
 * `gh pr list` returns `[]` (success exit, empty JSON array) when no PRs match,
 * so we no longer need the brittle stderr regex for "no pull requests found".
 */
async function findPrForBranch(
	cwd: string,
	branch: string,
	repoUrl?: string | null,
): Promise<PrLookup> {
	// When repoUrl is provided we are looking up a PR for a non-current
	// repo (Memory Bank cross-repo browsing). gh resolves --repo via the
	// REST API so the spawn cwd no longer needs to be inside a git working
	// tree; the local cwd is still passed because spawn requires one and
	// it doubles as a sensible default for stderr / temp-file locality.
	const repoArgs = repoUrl ? ["--repo", repoUrl] : [];
	const args = [
		"pr",
		"list",
		"--state",
		"all",
		"--head",
		branch,
		"--json",
		"number,url,title,body,state",
		...repoArgs,
	];
	const result = await tryExecGh(args, cwd);

	if (!result.ok) {
		const stderr = result.stderr ?? "";
		const reason = stderr.trim() || result.err.message;
		log.warn(
			TAG,
			`gh pr list failed for branch ${branch} (code=${result.code}): ${result.err.message}${
				stderr ? ` | stderr: ${stderr.trim()}` : ""
			}`,
		);
		return { kind: "lookupError", reason };
	}

	let parsed: ReadonlyArray<RawPrListRow>;
	try {
		const raw = JSON.parse(result.stdout) as unknown;
		// Defense in depth: gh could conceivably change its return shape; we
		// only proceed when we got the array we expect.
		if (!Array.isArray(raw)) {
			log.warn(
				TAG,
				`gh pr list returned non-array JSON for branch ${branch}. Raw length: ${result.stdout.length}`,
			);
			return {
				kind: "lookupError",
				reason: "Unexpected response shape from gh (expected array)",
			};
		}
		parsed = raw as ReadonlyArray<RawPrListRow>;
	} catch (err) {
		// JSON.parse only throws SyntaxError (an Error subclass), so we can
		// type-assert here and avoid an `instanceof Error ? : String()` branch
		// whose `String()` fallback would be unreachable.
		const message = (err as Error).message;
		log.warn(
			TAG,
			`gh pr list returned unparseable JSON for branch ${branch}: ${message}. Raw length: ${result.stdout.length}`,
		);
		return {
			kind: "lookupError",
			reason: `Unparseable response from gh: ${message}`,
		};
	}

	// Skip entries that look malformed — e.g. missing number (which `gh` has
	// returned as 0 in edge cases) or missing state. We'd rather show fewer
	// history pills than crash the section.
	const valid = parsed.filter(
		(p) => p.number > 0 && typeof p.state === "string",
	);
	// Open: GitHub allows at most one open PR per head branch; if more than
	// one appears (gh/GitHub anomaly) pick the highest-numbered (most recent).
	const openPrs = valid
		.filter((p) => p.state === "OPEN")
		.sort((a, b) => b.number - a.number);
	const closedPrs = valid
		.filter((p) => p.state === "MERGED" || p.state === "CLOSED")
		.sort((a, b) => b.number - a.number);

	const history: ReadonlyArray<PrHistoryEntry> = closedPrs.map((p) => ({
		number: p.number,
		url: p.url,
		state: p.state as "MERGED" | "CLOSED",
	}));

	if (openPrs.length === 0) {
		// `log.debug` only when the branch has zero PRs at all — a branch with
		// closed/merged-only PRs still flows into kind:noPr (so Edit PR stays
		// off), but it's not "no PR at all", so spamming the same debug line
		// would be misleading.
		if (valid.length === 0) {
			log.debug(TAG, `No PR for branch ${branch}`);
		}
		return { kind: "noPr", history };
	}

	const openPr = openPrs[0];
	const pr: PrInfo = {
		number: openPr.number,
		url: openPr.url,
		title: openPr.title,
		body: openPr.body,
	};
	return { kind: "found", pr, history };
}

// ─── Temp file helper ────────────────────────────────────────────────────────

/** Writes content to a unique temp file and returns its path. */
async function writeTempFile(content: string): Promise<string> {
	const name = `jollimemory-pr-${randomBytes(6).toString("hex")}.md`;
	const filePath = join(tmpdir(), name);
	await writeFile(filePath, content, "utf8");
	return filePath;
}

/** Safely removes a temp file. */
async function removeTempFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		/* already gone — harmless */
	}
}

// ─── PR Description edit ─────────────────────────────────────────────────────

/** Updates the PR description body via `gh pr edit --body-file`. */
async function editPrBody(
	prNumber: number,
	body: string,
	cwd: string,
): Promise<void> {
	const tmpPath = await writeTempFile(body);
	try {
		await execGh(["pr", "edit", String(prNumber), "--body-file", tmpPath], cwd);
	} finally {
		await removeTempFile(tmpPath);
	}
}

/** Creates a new PR via `gh pr create`. Returns the new PR URL. */
async function createPr(
	title: string,
	body: string,
	cwd: string,
): Promise<string> {
	const tmpPath = await writeTempFile(body);
	try {
		const output = await execGh(
			["pr", "create", "--title", title, "--body-file", tmpPath],
			cwd,
		);
		return output.trim();
	} finally {
		await removeTempFile(tmpPath);
	}
}

// ─── Handlers (called from SummaryWebviewPanel) ─────────────────────────────

type PostMessageFn = (msg: Record<string, unknown>) => void;

/**
 * Checks the PR status for the summary's branch and sends the result to the webview.
 *
 * PR operations are branch-scoped, not commit-scoped: we look up the PR on
 * `summaryBranch` (the branch the summary was generated on), with fallback to
 * the current branch when no summary is in view. This keeps Memory Bank
 * cross-branch navigation honest — clicking a summary on `feat-x` while
 * checked out on `feat-y` shows `feat-x`'s PR, not `feat-y`'s. Commit hash
 * is intentionally ignored to stay rebase-safe across squash/amend.
 */
export async function handleCheckPrStatus(
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
	repoUrl?: string | null,
): Promise<void> {
	try {
		// Foreign-repo path (Memory Bank cross-repo browsing): when the
		// caller hands us an explicit repoUrl, the panel is showing a
		// summary that belongs to a non-current repo. The cwd-bound
		// current-branch fallback would describe the *current* repo, so we
		// require summaryBranch and let `findPrForBranch` route the gh call
		// through `--repo`.
		if (repoUrl && !summaryBranch) {
			postMessage({ command: "prStatus", status: "unavailable" });
			return;
		}
		const targetBranch = summaryBranch ?? (await getCurrentBranch(cwd));

		// Check gh availability — distinguish "not installed" (definitive) from
		// transient spawn errors so the user gets an actionable message.
		const availability = await checkGhInstalled(cwd);
		if (availability === "notFound") {
			postMessage({ command: "prStatus", status: "notInstalled" });
			return;
		}
		if (availability === "error") {
			postMessage({ command: "prStatus", status: "unavailable" });
			return;
		}

		// Check auth — retry once so a brief keyring hiccup doesn't look like
		// "not authenticated" when the user actually is logged in.
		const auth = await checkGhAuthenticated(cwd);
		if (auth === "unauthenticated") {
			postMessage({ command: "prStatus", status: "notAuthenticated" });
			return;
		}
		if (auth === "error") {
			postMessage({ command: "prStatus", status: "unavailable" });
			return;
		}

		// Always pass an explicit branch — never rely on HEAD semantics
		const lookup = await findPrForBranch(cwd, targetBranch, repoUrl);

		if (lookup.kind === "lookupError") {
			// Reuse the `unavailable + reason` channel (already wired for the
			// outer-catch git/gh failures). The user sees the real cause and
			// gets a Retry button instead of a misleading "Create PR" CTA.
			postMessage({
				command: "prStatus",
				status: "unavailable",
				reason: lookup.reason,
			});
			return;
		}

		if (lookup.kind === "noPr") {
			postMessage({
				command: "prStatus",
				status: "noPr",
				branch: targetBranch,
				history: lookup.history,
			});
			return;
		}

		const { pr, history } = lookup;
		postMessage({
			command: "prStatus",
			status: "ready",
			pr: { number: pr.number, url: pr.url, title: pr.title },
			history,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(TAG, `Check PR status failed: ${msg}`);
		// Surface the real reason so the webview can distinguish git failures
		// (e.g. detached HEAD, .git/index.lock, permission) from gh failures.
		// The previous "Could not reach GitHub CLI (gh)" text was misleading
		// whenever the throw came from `getCurrentBranch` rather than the gh
		// probes — the catch sits above both code paths.
		postMessage({ command: "prStatus", status: "unavailable", reason: msg });
	}
}

/**
 * Creates a new PR for the summary's branch.
 *
 * Routing is by `summaryBranch` (matches Check/Update PR), but the physical
 * `git push -u origin HEAD` requires that branch to be the one currently
 * checked out. So we guard: if `summaryBranch !== currentBranch` (Memory Bank
 * cross-branch view), reject with `prCreateBlockedCrossBranch` and let the
 * webview prompt the user to checkout first. When `summaryBranch` is undefined
 * (no summary context), fall back to current-branch behavior.
 */
export async function handleCreatePr(
	title: string,
	body: string,
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
): Promise<void> {
	try {
		const currentBranch = await getCurrentBranch(cwd);
		if (summaryBranch && summaryBranch !== currentBranch) {
			vscode.window.showWarningMessage(
				`This summary is on branch ${summaryBranch}. Checkout ${summaryBranch} to create its PR.`,
			);
			postMessage({
				command: "prCreateBlockedCrossBranch",
				summaryBranch,
				currentBranch,
			});
			return;
		}

		postMessage({ command: "prCreating" });

		// Ensure branch is pushed
		log.info(TAG, "Pushing branch to origin...");
		await pushBranch(cwd);

		// Create the PR
		log.info(TAG, `Creating PR: "${title}"`);
		const prUrl = await createPr(title, body, cwd);
		log.info(TAG, `PR created: ${prUrl}`);

		// Refresh section to show the new PR
		await handleCheckPrStatus(cwd, postMessage, summaryBranch);

		// Toast with "Open PR" action
		vscode.window
			.showInformationMessage("Pull request created!", "Open PR")
			.then((choice) => {
				if (choice === "Open PR") {
					vscode.env.openExternal(vscode.Uri.parse(prUrl));
				}
			});
	} catch (err: unknown) {
		postMessage({ command: "prCreateFailed" });
		const msg = err instanceof Error ? err.message : String(err);
		log.error(TAG, `Create PR failed: ${msg}`);
		vscode.window.showErrorMessage(`Create PR failed — ${msg}`);
	}
}

/**
 * Prepares the Update PR form by fetching the summary's PR data, replacing
 * the marker region with the caller-provided markdown, and sending the
 * pre-filled title + body to the webview.
 *
 * Routes by `summaryBranch` (Memory Bank cross-branch viewing needs to target
 * the summary's branch, not whatever the user has checked out). Falls back to
 * `currentBranch` when `summaryBranch` is undefined. The caller assembles
 * `markdown` (single-summary or branch-aggregated) — this function only
 * handles the GitHub-side lookup + marker replacement.
 */
export async function handlePrepareUpdatePr(
	markdown: string,
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
): Promise<void> {
	try {
		const targetBranch = summaryBranch ?? (await getCurrentBranch(cwd));
		const lookup = await findPrForBranch(cwd, targetBranch);

		// Both `noPr` and `lookupError` paths need to repaint the section:
		// the webview's Edit PR button sets itself to "Loading..." + disabled
		// on click. Returning without `prStatus` leaves it stuck forever.
		if (lookup.kind === "lookupError") {
			vscode.window.showErrorMessage(
				`Could not load PR for branch ${targetBranch} — ${lookup.reason}`,
			);
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}

		if (lookup.kind === "noPr") {
			vscode.window.showWarningMessage(
				`No pull request found for branch ${targetBranch}.`,
			);
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}

		const { pr } = lookup;
		const newBody = replaceSummaryInBody(pr.body || "", markdown);

		postMessage({
			command: "prShowUpdateForm",
			title: pr.title,
			body: newBody,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(TAG, `Prepare update PR failed: ${msg}`);
		vscode.window.showErrorMessage(`Failed to load PR data — ${msg}`);
	}
}

/**
 * Updates the summary's PR title and description with the user-edited values
 * from the form.
 *
 * Routes by `summaryBranch` (Memory Bank cross-branch viewing edits the
 * summary's branch's PR, not currentBranch's). Falls back to `currentBranch`
 * when `summaryBranch` is undefined.
 */
export async function handleUpdatePr(
	title: string,
	body: string,
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
): Promise<void> {
	postMessage({ command: "prUpdating" });

	try {
		const targetBranch = summaryBranch ?? (await getCurrentBranch(cwd));
		const lookup = await findPrForBranch(cwd, targetBranch);

		if (lookup.kind === "lookupError") {
			postMessage({ command: "prUpdateFailed" });
			vscode.window.showErrorMessage(
				`Could not update PR for branch ${targetBranch} — ${lookup.reason}`,
			);
			return;
		}

		if (lookup.kind === "noPr") {
			postMessage({ command: "prUpdateFailed" });
			vscode.window.showWarningMessage(
				`No pull request found for branch ${targetBranch}.`,
			);
			return;
		}

		const { pr } = lookup;

		// Update title if changed
		if (title !== pr.title) {
			await execGh(["pr", "edit", String(pr.number), "--title", title], cwd);
		}

		// Update body
		await editPrBody(pr.number, body, cwd);

		log.info(TAG, `Updated PR #${pr.number}`);

		// Refresh section to reflect new state — pass summaryBranch through so
		// the refresh stays scoped to the same branch we just updated.
		await handleCheckPrStatus(cwd, postMessage, summaryBranch);

		vscode.window
			.showInformationMessage(`Updated PR #${pr.number}`, "Open PR")
			.then((choice) => {
				if (choice === "Open PR") {
					vscode.env.openExternal(vscode.Uri.parse(pr.url));
				}
			});
	} catch (err: unknown) {
		postMessage({ command: "prUpdateFailed" });
		const msg = err instanceof Error ? err.message : String(err);
		log.error(TAG, `Update PR failed: ${msg}`);
		vscode.window.showErrorMessage(`Update PR failed — ${msg}`);
	}
}

// ─── WebView: HTML ───────────────────────────────────────────────────────────

/** GitHub Pull Request SVG icon (16x16). */
const PR_ICON = `<svg class="pr-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>`;

/** Returns the initial HTML for the PR section (loading state). */
export function buildPrSectionHtml(): string {
	return `
<div class="section" id="prSection">
  <div class="section-header">
    <div class="section-title">${PR_ICON} Pull Request</div>
  </div>
  <p class="pr-status-text" id="prStatusText">Checking PR status...</p>
  <div class="pr-link-row pr-hidden" id="prLinkRow"></div>
  <div class="pr-actions pr-hidden" id="prActions"></div>
  <div class="pr-history pr-hidden" id="prHistory"></div>
  <div class="pr-form pr-hidden" id="prForm">
    <label class="pr-form-label">Title</label>
    <input type="text" class="pr-form-input" id="prTitleInput" />
    <label class="pr-form-label">Body</label>
    <textarea class="pr-form-textarea" id="prBodyInput" rows="12"></textarea>
    <div class="pr-form-actions">
      <button class="action-btn" id="prFormCancel">Cancel</button>
      <button class="action-btn primary" id="prFormSubmit">Submit PR</button>
    </div>
  </div>
</div>
<hr class="separator" />`;
}

// ─── WebView: CSS ────────────────────────────────────────────────────────────

/** Returns the CSS for the PR section. */
export function buildPrSectionCss(): string {
	return `
  /* ── PR Section ── */
  .pr-hidden {
    display: none;
  }
  .pr-icon {
    vertical-align: -2px;
    margin-right: 4px;
  }
  .pr-status-text {
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
    line-height: 1.5;
    margin: 4px 0 8px;
  }
  .pr-link-row {
    margin: 4px 0 10px;
  }
  .pr-link-row a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    font-weight: 500;
  }
  .pr-link-row a:hover {
    text-decoration: underline;
  }
  .pr-actions {
    margin: 8px 0 4px;
  }
  /* ── PR History (Previously: …) ── */
  /*
   * Inline pill row shown beneath the active PR's actions. GitHub's own
   * merged-purple / closed-red are used so the colors are recognizable, but
   * a textual "(merged)" / "(closed)" label is also rendered — colorblind /
   * high-contrast theme users still read the state from the text.
   */
  .pr-history {
    margin: 6px 0 4px;
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }
  .pr-history-label {
    margin-right: 4px;
  }
  .pr-history a {
    text-decoration: none;
  }
  .pr-history a:hover {
    text-decoration: underline;
  }
  .pr-history-merged {
    color: #8957e5;
  }
  .pr-history-closed {
    color: #cf222e;
  }
  .pr-history-sep {
    margin: 0 6px;
    color: var(--vscode-descriptionForeground);
  }
  /* ── PR Create Form ── */
  .pr-form {
    margin-top: 10px;
  }
  .pr-form-label {
    display: block;
    font-size: 0.88em;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin: 8px 0 4px;
  }
  .pr-form-input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    font-size: 0.92em;
    font-family: var(--vscode-font-family);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px;
  }
  .pr-form-textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 360px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px;
    padding: 10px;
    resize: vertical;
  }
  .pr-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }`;
}

// ─── WebView: Script ─────────────────────────────────────────────────────────

/** Returns the full JS for the PR section (auto-trigger + event handlers + status listener). */
export function buildPrSectionScript(): string {
	return `
  // ── PR Section ──
  var prStatusText = document.getElementById('prStatusText');
  var prLinkRow = document.getElementById('prLinkRow');
  var prActions = document.getElementById('prActions');
  var prHistory = document.getElementById('prHistory');
  var prForm = document.getElementById('prForm');
  var prTitleInput = document.getElementById('prTitleInput');
  var prBodyInput = document.getElementById('prBodyInput');
  var prFormCancel = document.getElementById('prFormCancel');
  var prFormSubmit = document.getElementById('prFormSubmit');

  var prCurrentState = 'loading';
  // Cache the last 'Previously:' history so the form-cancel handler can
  // restore the strip without re-running gh.
  var prLastHistory = [];

  /** Toggle visibility via the pr-hidden CSS class (CSP blocks inline style attributes). */
  function prShow(el) { if (el) el.classList.remove('pr-hidden'); }
  function prHide(el) { if (el) el.classList.add('pr-hidden'); }

  /**
   * Renders the "Previously: #N (merged) · #M (closed) · ..." strip.
   * Hides the row when history is empty. Each entry links to the PR URL;
   * merged/closed are color-coded AND text-labeled so users in high-contrast
   * themes still see the state without depending on color.
   */
  function renderPrHistory(history) {
    prLastHistory = Array.isArray(history) ? history : [];
    if (prLastHistory.length === 0) {
      prHide(prHistory);
      return;
    }
    prHistory.textContent = '';
    var label = document.createElement('span');
    label.className = 'pr-history-label';
    label.textContent = 'Previously:';
    prHistory.appendChild(label);
    for (var i = 0; i < prLastHistory.length; i++) {
      var h = prLastHistory[i];
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'pr-history-sep';
        sep.textContent = '·';
        prHistory.appendChild(sep);
      }
      var link = document.createElement('a');
      link.href = h.url;
      link.title = 'Open PR in browser';
      link.className = h.state === 'MERGED' ? 'pr-history-merged' : 'pr-history-closed';
      link.textContent = '#' + h.number + ' (' + (h.state === 'MERGED' ? 'merged' : 'closed') + ')';
      prHistory.appendChild(link);
    }
    prShow(prHistory);
  }

  // Auto-check PR status on load
  vscode.postMessage({ command: 'checkPrStatus' });

  // ── PR form event handlers ──
  if (prFormCancel) {
    prFormCancel.addEventListener('click', function() {
      prHide(prForm);
      prShow(prActions);
      // Restore Edit PR button state
      var editBtn = document.getElementById('editPrBtn');
      if (editBtn) { editBtn.textContent = 'Edit PR'; editBtn.disabled = false; }
      // Restore correct visibility based on current state
      if (prCurrentState === 'ready') {
        prHide(prStatusText);
        prShow(prLinkRow);
      } else {
        prShow(prStatusText);
        prHide(prLinkRow);
      }
      // Restore the 'Previously:' strip from the cached last history.
      renderPrHistory(prLastHistory);
    });
  }
  if (prFormSubmit) {
    prFormSubmit.addEventListener('click', function() {
      var title = prTitleInput.value.trim();
      var body = prBodyInput.value;
      if (!title) { prTitleInput.focus(); return; }
      var mode = prForm.dataset.mode || 'create';
      if (mode === 'update') {
        vscode.postMessage({ command: 'updatePr', title: title, body: body });
      } else {
        vscode.postMessage({ command: 'createPr', title: title, body: body });
      }
    });
  }`;
}

/** Returns the message-listener JS for PR status updates (insert inside the message listener). */
export function buildPrMessageScript(): string {
	return `
    // ── PR Section status ──
    if (msg.command === 'prStatus') {
      var s = msg.status;
      prCurrentState = s;
      prHide(prForm);

      if (s === 'notInstalled') {
        prStatusText.textContent = 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ and reload the window.';
        prShow(prStatusText);
        prHide(prLinkRow);
        prHide(prActions);
        prHide(prHistory);
      } else if (s === 'notAuthenticated') {
        prStatusText.textContent = 'GitHub CLI (gh) is not authenticated. Run "gh auth login" in a terminal, then retry.';
        prShow(prStatusText);
        prHide(prLinkRow);
        prActions.textContent = '';
        var retryAuthBtn = document.createElement('button');
        retryAuthBtn.className = 'action-btn';
        retryAuthBtn.textContent = 'Retry';
        retryAuthBtn.addEventListener('click', function() {
          prStatusText.textContent = 'Checking PR status...';
          vscode.postMessage({ command: 'checkPrStatus' });
        });
        prActions.appendChild(retryAuthBtn);
        prShow(prActions);
        prHide(prHistory);
      } else if (s === 'unavailable') {
        prStatusText.textContent = msg.reason
          ? ('Could not load PR status — ' + msg.reason + '. Retry, or check the extension log.')
          : 'Could not reach GitHub CLI (gh). This is often transient — retry, or check the extension log.';
        prShow(prStatusText);
        prHide(prLinkRow);
        prActions.textContent = '';
        var retryBtn = document.createElement('button');
        retryBtn.className = 'action-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', function() {
          prStatusText.textContent = 'Checking PR status...';
          vscode.postMessage({ command: 'checkPrStatus' });
        });
        prActions.appendChild(retryBtn);
        prShow(prActions);
        prHide(prHistory);
      } else if (s === 'noPr') {
        prHide(prLinkRow);
        prStatusText.textContent = 'No pull request found for branch ' + msg.branch + '.';
        prShow(prStatusText);
        prActions.textContent = '';
        var btn = document.createElement('button');
        btn.className = 'action-btn';
        btn.id = 'createPrBtn';
        btn.textContent = 'Create PR';
        prActions.appendChild(btn);
        prShow(prActions);
        // Bind Create PR button — request fresh body from backend so that
        // content generated after the webview opened (e.g. E2E test) is included.
        btn.addEventListener('click', function() {
          btn.disabled = true;
          btn.textContent = 'Loading...';
          vscode.postMessage({ command: 'prepareCreatePr' });
        });
        renderPrHistory(msg.history);
      } else if (s === 'ready') {
        var pr = msg.pr;
        prHide(prStatusText);
        // Build PR link via DOM
        prLinkRow.textContent = '';
        var a = document.createElement('a');
        a.href = pr.url;
        a.title = 'Open PR in browser';
        a.textContent = '#' + pr.number + ' ' + pr.title;
        prLinkRow.appendChild(a);
        prShow(prLinkRow);
        // Build Edit PR button via DOM
        prActions.textContent = '';
        var editBtn = document.createElement('button');
        editBtn.className = 'action-btn';
        editBtn.id = 'editPrBtn';
        editBtn.textContent = 'Edit PR';
        prActions.appendChild(editBtn);
        prShow(prActions);
        // Bind Edit PR button — asks extension to prepare the form
        editBtn.addEventListener('click', function() {
          editBtn.textContent = 'Loading...';
          editBtn.disabled = true;
          vscode.postMessage({ command: 'prepareUpdatePr' });
        });
        renderPrHistory(msg.history);
      }
    }

    // ── PR show create form ──
    if (msg.command === 'prShowCreateForm') {
      prHide(prStatusText);
      prHide(prLinkRow);
      var createBtn = document.getElementById('createPrBtn');
      if (createBtn) { createBtn.textContent = 'Create PR'; createBtn.disabled = false; }
      prHide(prActions);
      prHide(prHistory);
      prShow(prForm);
      prForm.dataset.mode = 'create';
      prFormSubmit.textContent = 'Submit PR';
      prFormSubmit.disabled = false;
      prFormCancel.disabled = false;
      prTitleInput.value = msg.title || '';
      prBodyInput.value = msg.body || '';
      prTitleInput.focus();
    }

    // ── PR show update form ──
    if (msg.command === 'prShowUpdateForm') {
      prHide(prStatusText);
      prHide(prLinkRow);
      prHide(prActions);
      prHide(prHistory);
      prShow(prForm);
      prForm.dataset.mode = 'update';
      prFormSubmit.textContent = 'Update PR';
      prFormSubmit.disabled = false;
      prFormCancel.disabled = false;
      prTitleInput.value = msg.title || '';
      prBodyInput.value = msg.body || '';
      prTitleInput.focus();
    }

    // ── PR form submit status (shared by create + update) ──
    if (msg.command === 'prCreating' && prFormSubmit) {
      prFormSubmit.textContent = 'Creating...';
      prFormSubmit.disabled = true;
      prFormCancel.disabled = true;
    }
    if (msg.command === 'prCreateFailed' && prFormSubmit) {
      prFormSubmit.textContent = 'Submit PR';
      prFormSubmit.disabled = false;
      prFormCancel.disabled = false;
    }
    // ── PR create blocked by cross-branch guard ──
    // Fires when the summary's branch differs from the current branch. The
    // extension side has already shown a warning toast; here we just revert
    // any "Loading..." / "Creating..." UI back to a clickable state so the
    // user can checkout the right branch and retry without a stale UI.
    if (msg.command === 'prCreateBlockedCrossBranch') {
      var blockedBtn = document.getElementById('createPrBtn');
      if (blockedBtn) { blockedBtn.textContent = 'Create PR'; blockedBtn.disabled = false; }
      if (prFormSubmit) {
        prFormSubmit.textContent = 'Submit PR';
        prFormSubmit.disabled = false;
      }
      if (prFormCancel) { prFormCancel.disabled = false; }
    }
    if (msg.command === 'prUpdating' && prFormSubmit) {
      prFormSubmit.textContent = 'Updating...';
      prFormSubmit.disabled = true;
      prFormCancel.disabled = true;
    }
    if (msg.command === 'prUpdateFailed' && prFormSubmit) {
      prFormSubmit.textContent = 'Update PR';
      prFormSubmit.disabled = false;
      prFormCancel.disabled = false;
    }`;
}
