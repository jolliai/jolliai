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
import type { CommitSummary } from "../../../cli/src/Types.js";
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

/**
 * Resolves the upstream default branch (what `origin/HEAD` points to), e.g.
 * `"origin/main"`, `"origin/master"`, `"origin/trunk"`. Returns `undefined`
 * when the ref is not set — common and healthy in repos without an `origin`
 * remote, in fresh clones before the first fetch, in detached states, or when
 * `origin/HEAD` was never pinned. Undefined is an expected outcome, not an
 * error: callers should treat it as "no baseline in this repo".
 */
async function resolveUpstreamBaseline(
	cwd: string,
): Promise<string | undefined> {
	try {
		const raw = await execGit(
			["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
			cwd,
		);
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Returns the number of commits on the current branch that are ahead of the
 * upstream default branch. Used only to gate the "multiple commits — please
 * squash" UI, so 0 means "don't gate" — a safe fallback whenever the baseline
 * cannot be determined or the count cannot be computed.
 */
async function getCommitCount(cwd: string): Promise<number> {
	const baseline = await resolveUpstreamBaseline(cwd);
	if (!baseline) {
		// No upstream baseline in this repo — squash gate does not apply.
		// Silent: this is the normal state for many healthy setups (no
		// `origin`, fresh clone, detached HEAD), not a condition to warn about.
		return 0;
	}
	try {
		const raw = await execGit(
			["rev-list", "--count", `${baseline}..HEAD`],
			cwd,
		);
		return Number.parseInt(raw.trim(), 10) || 0;
	} catch (err) {
		// Baseline resolved but rev-list failed — unusual (e.g. corrupted
		// repo, permissions). Worth a warn so debug.log has a trail.
		log.warn(
			TAG,
			`git rev-list --count ${baseline}..HEAD failed: ${(err as Error).message}`,
		);
		return 0;
	}
}

/** Returns the current branch name. */
async function getCurrentBranch(cwd: string): Promise<string> {
	const raw = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	return raw.trim();
}

// ─── Cross-branch detection ─────────────────────────────────────────────────
//
// A memory is "cross-branch" when the commit it was recorded for is NOT in
// the current branch's history. That happens when the user is viewing a
// memory from a different branch (e.g. browsing history while checked out
// elsewhere), or when that branch was deleted and recreated pointing at
// different commits.
//
// The common case is the opposite: the memory's commit IS in the current
// branch's history. That is when Create/Update PR operations make sense,
// because `git push origin HEAD` and `gh pr create` act on the current
// branch — and the current branch is the one that actually contains the
// commit the memory is about.
//
// We use commit reachability instead of comparing branch names because
// names are mutable labels: `git branch -m`, delete-and-recreate, and
// force-push all break name equality without changing whether the commit
// is part of the current branch's history. Reachability is the invariant
// that actually matches the semantics we want.

/**
 * Returns true if `commitHash` is in the current branch's history (reachable
 * from HEAD).
 *
 * `git merge-base --is-ancestor` exits 0 when the commit is an ancestor of
 * HEAD, 1 when it is not, and other codes on internal errors — in all
 * failure modes we conservatively return false.
 */
async function isCommitReachableFromHead(
	cwd: string,
	commitHash: string,
): Promise<boolean> {
	try {
		await execGit(["merge-base", "--is-ancestor", commitHash, "HEAD"], cwd);
		return true;
	} catch {
		return false;
	}
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
 * Returns PR info for the given branch.
 * Uses `gh pr view -- <branch>` which works for open, merged, and closed PRs.
 *
 * The `--` end-of-options sentinel prevents option injection: even if `branch`
 * starts with `-` (e.g. `--repo owner/evil`), `gh` treats it as a positional
 * argument rather than a flag. This is a defense-in-depth measure since the
 * value originates from persisted JSON on the orphan branch.
 */
async function findPrForBranch(
	cwd: string,
	branch: string,
): Promise<PrInfo | undefined> {
	const args = ["pr", "view", "--json", "number,url,title,body", "--", branch];
	const result = await tryExecGh(args, cwd);

	if (!result.ok) {
		const stderr = result.stderr ?? "";
		// "no pull requests found" is the expected miss path — keep it at
		// debug to avoid noise on every WebView open. Anything else (auth,
		// rate limit, network, repo config, non-zero exits) is a real
		// failure and deserves warn so it shows at default log level.
		const isExpectedNoPr = /no pull requests? found/i.test(stderr);
		if (isExpectedNoPr) {
			log.debug(TAG, `No PR for branch ${branch}`);
		} else {
			log.warn(
				TAG,
				`gh pr view failed for branch ${branch} (code=${result.code}): ${result.err.message}${
					stderr ? ` | stderr: ${stderr.trim()}` : ""
				}`,
			);
		}
		return;
	}

	try {
		const parsed = JSON.parse(result.stdout) as PrInfo;
		return parsed.number ? parsed : undefined;
	} catch (err) {
		log.warn(
			TAG,
			`gh pr view returned unparseable JSON for branch ${branch}: ${(err as Error).message}. Raw length: ${result.stdout.length}`,
		);
		return;
	}
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
 * Checks the PR status and sends the result to the webview.
 *
 * @param summaryBranch - The branch recorded in the summary at commit time.
 *   Resolved via {@link resolveTargetBranch} so we always pass an explicit
 *   branch to `gh pr view`, avoiding HEAD fall-through mis-association.
 * @param summaryCommitHash - The summary's commit hash. Used to determine if
 *   the memory belongs to the current branch via commit reachability, which is
 *   immune to branch rename / delete-and-recreate / force-push scenarios.
 */
export async function handleCheckPrStatus(
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
	summaryCommitHash?: string,
): Promise<void> {
	try {
		// The happy path is !isCrossBranch: the memory's commit is on the
		// current branch, so Create/Update PR acts on it. See the Cross-branch
		// section above for why we rely on commit reachability here.
		const isCrossBranch = summaryCommitHash
			? !(await isCommitReachableFromHead(cwd, summaryCommitHash))
			: false;

		// PR lookup must use the branch that actually contains the commit:
		//   • Normal / rename / force-push → current branch (memory is on it)
		//   • Cross-branch → summary.branch (our best guess for the other branch)
		const currentBranch = await getCurrentBranch(cwd);
		const targetBranch = isCrossBranch
			? (summaryBranch ?? currentBranch)
			: currentBranch;

		// Commit-count check: only relevant for the current working branch.
		if (!isCrossBranch) {
			const commitCount = await getCommitCount(cwd);
			if (commitCount > 1) {
				postMessage({
					command: "prStatus",
					status: "multipleCommits",
					count: commitCount,
				});
				return;
			}
		}

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
		const pr = await findPrForBranch(cwd, targetBranch);

		if (!pr) {
			postMessage({
				command: "prStatus",
				status: "noPr",
				branch: targetBranch,
				crossBranch: isCrossBranch,
			});
			return;
		}

		postMessage({
			command: "prStatus",
			status: "ready",
			pr: { number: pr.number, url: pr.url, title: pr.title },
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(TAG, `Check PR status failed: ${msg}`);
		postMessage({ command: "prStatus", status: "unavailable" });
	}
}

/**
 * Creates a new PR with the user-provided title and body.
 *
 * @param summaryBranch - The branch recorded in the summary. Passed through
 *   to the post-create refresh so the PR section re-queries for the same
 *   target branch.
 * @param summaryCommitHash - The summary's commit hash. Used to check that
 *   the memory's commit is reachable from the current HEAD, meaning `git push
 *   origin HEAD` and `gh pr create` operate on a branch that actually contains
 *   this work. Immune to branch rename / delete-and-recreate / force-push.
 */
export async function handleCreatePr(
	title: string,
	body: string,
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
	summaryCommitHash?: string,
): Promise<void> {
	postMessage({ command: "prCreating" });

	try {
		// Cross-branch guard: if the memory's commit is NOT on the current
		// branch, a PR created from HEAD would not contain this commit.
		// Non-cross-branch (the normal case) falls through to the push +
		// create flow below. See the Cross-branch section above.
		if (
			summaryCommitHash &&
			!(await isCommitReachableFromHead(cwd, summaryCommitHash))
		) {
			postMessage({ command: "prCreateFailed" });
			vscode.window.showWarningMessage(
				"Cannot create a PR — the memory's commit is not in the current branch's history. Check out a branch that includes this commit first.",
			);
			return;
		}

		// Ensure branch is pushed
		log.info(TAG, "Pushing branch to origin...");
		await pushBranch(cwd);

		// Create the PR
		log.info(TAG, `Creating PR: "${title}"`);
		const prUrl = await createPr(title, body, cwd);
		log.info(TAG, `PR created: ${prUrl}`);

		// Refresh section to show the new PR
		await handleCheckPrStatus(
			cwd,
			postMessage,
			summaryBranch,
			summaryCommitHash,
		);

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
 * Prepares the Update PR form by fetching the current PR data,
 * replacing the marker region with the latest summary, and sending
 * the pre-filled title + body to the webview.
 *
 * The branch is read directly from `summary.branch` — no separate parameter
 * needed, avoiding drift between the summary object and a loose branch arg.
 */
export async function handlePrepareUpdatePr(
	summary: CommitSummary,
	cwd: string,
	postMessage: PostMessageFn,
	buildMarkdownFn: (s: CommitSummary) => string,
): Promise<void> {
	try {
		// Same lookup strategy as handleCheckPrStatus — see the Cross-branch
		// section above. Normal case: use current branch so the pre-filled
		// edit form targets the PR that was just created.
		const isCrossBranch = !(await isCommitReachableFromHead(
			cwd,
			summary.commitHash,
		));
		const currentBranch = await getCurrentBranch(cwd);
		const targetBranch = isCrossBranch
			? (summary.branch ?? currentBranch)
			: currentBranch;
		const pr = await findPrForBranch(cwd, targetBranch);
		if (!pr) {
			vscode.window.showWarningMessage(
				`No pull request found for branch ${targetBranch}.`,
			);
			return;
		}

		const markdown = buildMarkdownFn(summary);
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
 * Updates the PR title and description with the user-edited values from the form.
 *
 * @param summaryBranch - The branch recorded in the summary. Resolved to an
 *   explicit branch name internally — never falls through to HEAD semantics.
 * @param summaryCommitHash - The summary's commit hash. Passed through to the
 *   post-update refresh so cross-branch detection stays consistent with
 *   `handleCheckPrStatus`.
 */
export async function handleUpdatePr(
	title: string,
	body: string,
	cwd: string,
	postMessage: PostMessageFn,
	summaryBranch?: string,
	summaryCommitHash?: string,
): Promise<void> {
	postMessage({ command: "prUpdating" });

	try {
		// Mirrors handleCheckPrStatus's lookup strategy:
		//   • !isCrossBranch (normal case) → update the PR on current branch
		//   • isCrossBranch → fall back to summary's stored branch
		const isCrossBranch = summaryCommitHash
			? !(await isCommitReachableFromHead(cwd, summaryCommitHash))
			: false;
		const currentBranch = await getCurrentBranch(cwd);
		const targetBranch = isCrossBranch
			? (summaryBranch ?? currentBranch)
			: currentBranch;
		const pr = await findPrForBranch(cwd, targetBranch);
		if (!pr) {
			postMessage({ command: "prUpdateFailed" });
			vscode.window.showWarningMessage(
				`No pull request found for branch ${targetBranch}.`,
			);
			return;
		}

		// Update title if changed
		if (title !== pr.title) {
			await execGh(["pr", "edit", String(pr.number), "--title", title], cwd);
		}

		// Update body
		await editPrBody(pr.number, body, cwd);

		log.info(TAG, `Updated PR #${pr.number}`);

		// Refresh section to reflect new state
		await handleCheckPrStatus(
			cwd,
			postMessage,
			summaryBranch,
			summaryCommitHash,
		);

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
  var prForm = document.getElementById('prForm');
  var prTitleInput = document.getElementById('prTitleInput');
  var prBodyInput = document.getElementById('prBodyInput');
  var prFormCancel = document.getElementById('prFormCancel');
  var prFormSubmit = document.getElementById('prFormSubmit');

  var prCurrentState = 'loading';

  /** Toggle visibility via the pr-hidden CSS class (CSP blocks inline style attributes). */
  function prShow(el) { if (el) el.classList.remove('pr-hidden'); }
  function prHide(el) { if (el) el.classList.add('pr-hidden'); }

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

      if (s === 'multipleCommits') {
        prStatusText.textContent = 'Branch has ' + msg.count + ' commits. Please squash into a single commit before creating or updating a PR.';
        prShow(prStatusText);
        prHide(prLinkRow);
        prHide(prActions);
      } else if (s === 'notInstalled') {
        prStatusText.textContent = 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ and reload the window.';
        prShow(prStatusText);
        prHide(prLinkRow);
        prHide(prActions);
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
      } else if (s === 'unavailable') {
        prStatusText.textContent = 'Could not reach GitHub CLI (gh). This is often transient — retry, or check the extension log.';
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
      } else if (s === 'noPr') {
        prHide(prLinkRow);
        if (msg.crossBranch) {
          prStatusText.textContent = 'No pull request found for branch ' + msg.branch + '. Check out that branch to create a PR.';
          prShow(prStatusText);
          prActions.textContent = '';
          prHide(prActions);
        } else {
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
        }
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
      }
    }

    // ── PR show create form ──
    if (msg.command === 'prShowCreateForm') {
      prHide(prStatusText);
      prHide(prLinkRow);
      var createBtn = document.getElementById('createPrBtn');
      if (createBtn) { createBtn.textContent = 'Create PR'; createBtn.disabled = false; }
      prHide(prActions);
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
