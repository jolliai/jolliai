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
	state: "OPEN" | "CLOSED" | "MERGED";
	isCrossRepository: boolean;
}

/**
 * Discriminated result of `findPrForBranch`.
 *
 * Pre-refactor this function returned `PrInfo | undefined` and collapsed four
 * distinct outcomes into the same `undefined` value: real no-PR, auth/network
 * failure, unparseable JSON, and zero-numbered JSON. Callers then showed a
 * "No PR found" + Create PR button for all four, which misled users into
 * creating duplicate PRs after a token lapse. The union forces each caller
 * to decide between the three real outcomes.
 */
type PrLookup =
	| { kind: "found"; pr: PrInfo }
	| { kind: "noPr" }
	| { kind: "lookupError"; reason: string };

/**
 * Returns PR info for the given branch.
 *
 * Uses two `gh pr list --head <branch>` queries — first `--state open`, then
 * `--state all` as fallback — to make the "OPEN takes precedence over historic
 * terminal-state PRs" policy explicit. `gh pr view <branch>` collapses all
 * states into one undocumented "most relevant" result, so we couldn't tell an
 * OPEN PR apart from a MERGED follow-up that happens to share a branch.
 *
 * A branch can have multiple PRs over time: CLOSED-then-reopened, or the
 * MERGED-then-follow-up pattern. We render the OPEN one when it exists, and
 * the most recent terminal-state one (MERGED/CLOSED) as the "previousPr" hint
 * when the branch has only history. See {@link handleCheckPrStatus} for how
 * the dispatch decides between "Edit PR" and "Create PR + Previous PR" CTAs.
 *
 * `gh pr list --head <branch>` does NOT support `<owner>:<branch>` syntax —
 * bare branch names can match same-named heads on forks. We filter
 * `isCrossRepository === true` results to avoid mis-binding to a fork's PR;
 * the safe degradation is "show Create PR" rather than editing someone else's.
 */
async function findPrForBranch(cwd: string, branch: string): Promise<PrLookup> {
	const open = await listFirstPr(cwd, branch, "open");
	// `found` → OPEN PR ready to edit. `lookupError` → don't paper over with a
	// second call that may also fail; surface the real reason to the user.
	if (open.kind !== "noPr") return open;
	// No OPEN PR: try terminal-state PRs to surface a "Previous PR" hint.
	return listFirstPr(cwd, branch, "all");
}

/**
 * Runs `gh pr list --head <branch> --state <state> --limit 1` and returns
 * the first valid PR (or `noPr` / `lookupError`).
 *
 * Rejects cross-repo (fork) PRs and unknown state values as `noPr` — the
 * caller falls back to the next state query (or to overall `noPr`), keeping
 * the error semantics strictly on gh invocation failure / JSON parse failure.
 */
async function listFirstPr(
	cwd: string,
	branch: string,
	state: "open" | "all",
): Promise<PrLookup> {
	const args = [
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		state,
		"--limit",
		"1",
		"--json",
		"number,url,title,body,state,isCrossRepository",
	];
	const result = await tryExecGh(args, cwd);

	if (!result.ok) {
		const stderr = result.stderr ?? "";
		const reason = stderr.trim() || result.err.message;
		log.warn(
			TAG,
			`gh pr list --state ${state} failed for branch ${branch} (code=${result.code}): ${result.err.message}${
				stderr ? ` | stderr: ${stderr.trim()}` : ""
			}`,
		);
		return { kind: "lookupError", reason };
	}

	let arr: Array<PrInfo>;
	try {
		arr = JSON.parse(result.stdout) as Array<PrInfo>;
	} catch (err) {
		/* v8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(err) fallback is defensive only */
		const message = err instanceof Error ? err.message : String(err);
		log.warn(
			TAG,
			`gh pr list returned unparseable JSON for branch ${branch}: ${message}. Raw length: ${result.stdout.length}`,
		);
		return {
			kind: "lookupError",
			reason: `Unparseable response from gh: ${message}`,
		};
	}

	if (!Array.isArray(arr) || arr.length === 0) return { kind: "noPr" };
	const pr = arr[0];
	if (!pr.number) return { kind: "noPr" };
	if (pr.state !== "OPEN" && pr.state !== "CLOSED" && pr.state !== "MERGED") {
		log.warn(
			TAG,
			`gh pr list returned unexpected state "${pr.state}" for branch ${branch}; ignoring.`,
		);
		return { kind: "noPr" };
	}
	if (pr.isCrossRepository) {
		log.debug(
			TAG,
			`Ignoring cross-repository PR #${pr.number} for branch ${branch}`,
		);
		return { kind: "noPr" };
	}
	return { kind: "found", pr };
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
): Promise<void> {
	try {
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
		const lookup = await findPrForBranch(cwd, targetBranch);

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
			});
			return;
		}

		const { pr } = lookup;
		if (pr.state === "OPEN") {
			postMessage({
				command: "prStatus",
				status: "ready",
				pr: { number: pr.number, url: pr.url, title: pr.title },
			});
			return;
		}
		// MERGED or CLOSED: present as "no PR to edit" so the CTA flips to
		// Create PR (a branch can host multiple PRs over time), but pass the
		// terminal-state PR through as `previousPr` so the webview can render
		// a one-line "Previous PR #N (merged|closed)" link above the button.
		postMessage({
			command: "prStatus",
			status: "noPr",
			branch: targetBranch,
			previousPr: {
				number: pr.number,
				url: pr.url,
				state: pr.state,
			},
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
		if (pr.state !== "OPEN") {
			// The webview's Edit PR button only renders when state is OPEN, but
			// `retainContextWhenHidden` means a stale ready-view can still click
			// through after an external merge/close. Repaint the section so the
			// button gets rebuilt against the fresh (noPr + previousPr) state
			// and the user gets an explicit reason for the rejection.
			log.info(
				TAG,
				`Skipping prepareUpdatePr: PR #${pr.number} is ${pr.state}`,
			);
			vscode.window.showWarningMessage(
				`PR #${pr.number} is ${pr.state.toLowerCase()} — open a new PR instead.`,
			);
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}
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
			// Symmetric with handlePrepareUpdatePr: also repaint the section so
			// the main area syncs to the unavailable state — otherwise the user
			// closes the form and still sees a stale ready view.
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}

		if (lookup.kind === "noPr") {
			postMessage({ command: "prUpdateFailed" });
			vscode.window.showWarningMessage(
				`No pull request found for branch ${targetBranch}.`,
			);
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}

		const { pr } = lookup;
		if (pr.state !== "OPEN") {
			// Stale state: PR was merged/closed between checkPrStatus and the
			// Submit click. Solve the same way prepareUpdatePr does — repaint
			// + warn — but also clear the form's "Updating..." loading first.
			postMessage({ command: "prUpdateFailed" });
			log.info(TAG, `Skipping updatePr: PR #${pr.number} is ${pr.state}`);
			vscode.window.showWarningMessage(
				`PR #${pr.number} was ${pr.state.toLowerCase()} between checking and updating — open a new PR instead.`,
			);
			await handleCheckPrStatus(cwd, postMessage, summaryBranch);
			return;
		}

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
      // Restore correct visibility based on current state. For ready state
      // the link row holds the current PR anchor. For noPr the link row is
      // either empty (truly no PR) or holds a "Previous PR #N" anchor when
      // the branch has a MERGED/CLOSED history — both cases are encoded by
      // the noPr branch above as either an empty link row or a populated
      // one, so firstChild is the right discriminator.
      if (prCurrentState === 'ready') {
        prHide(prStatusText);
        prShow(prLinkRow);
      } else {
        prShow(prStatusText);
        if (prLinkRow.firstChild) {
          prShow(prLinkRow);
        } else {
          prHide(prLinkRow);
        }
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

      if (s === 'notInstalled') {
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
      } else if (s === 'noPr') {
        prHide(prLinkRow);
        // Clear residual link-row content so the Cancel handler's
        // firstChild-based visibility check never resurfaces a stale ready
        // anchor when this branch ran after a "ready → noPr" transition.
        prLinkRow.textContent = '';
        if (msg.previousPr) {
          // A branch can host multiple PRs over time. When the most recent
          // one is MERGED/CLOSED, surface it as a discoverable link above
          // the Create PR button so the user can revisit the historic
          // review/discussion without thinking it's the "current" PR.
          prStatusText.textContent = 'No open pull request for branch ' + msg.branch + '.';
          var prevA = document.createElement('a');
          prevA.href = msg.previousPr.url;
          prevA.textContent = 'Previous PR #' + msg.previousPr.number +
            ' (' + msg.previousPr.state.toLowerCase() + ')';
          prLinkRow.appendChild(prevA);
          prShow(prLinkRow);
        } else {
          prStatusText.textContent = 'No pull request found for branch ' + msg.branch + '.';
          // link row already cleared and hidden above; nothing more to do.
        }
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
