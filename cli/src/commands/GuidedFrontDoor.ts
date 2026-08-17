/**
 * The guided front door — what bare `jolli` (no args, interactive TTY) runs.
 *
 * It reads two orthogonal capabilities and guides the next step:
 *   - can generate — is there a usable engine (`canGenerateNow`)? For the local
 *     agent this actually probes that the CONFIGURED tool is runnable, so a
 *     broken CLI is caught here rather than silently at commit time.
 *   - can sync     — is there any Jolli credential (OAuth token or jolliApiKey)
 *                    to push memories to a Space?
 *
 * Flow (order is fixed and identical across states — a run only shows the steps
 * its state still needs):
 *   git repo? → onboarding (fresh only) → repair broken provider → Sign in? →
 *   Enable? → status line → cloud side-effects → backfill → listening →
 *   import history into the dashboard DB → Next steps → serve the dashboard
 *
 * The dashboard is LAST, after Next steps, because serving blocks until Ctrl+C —
 * anything printed after it would never be seen. That splits what used to be one
 * `jolli dashboard` call into an import half and a serve half; see
 * `importLocalDashboard` and `offerLocalDashboard`.
 *
 * `Sign in?` deliberately precedes `Enable?`. The opening status line moved to
 * AFTER `Enable?` so `✓ enabled` is always truthful. Non-git directories are a
 * dead end (Jolli attaches memory to commits). The exit code is coarse: non-zero
 * only on a hard blocker (not a repo, install failure); a valid decline is 0.
 */

import { basename } from "node:path";
import { loadAuthToken } from "../auth/AuthConfig.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import { maybeEmitOnboardingProgress } from "../core/OnboardingFunnel.js";
import { readManualDisableFlagSync } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitPipelineFullyInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { createLogger, errMsg, setLogDir } from "../Logger.js";
import { runBackfillFrontDoorStep } from "./BackfillFrontDoorStep.js";
import { isAffirmative, isExplicitYes, isInsideGitWorkTree, promptText, resolveProjectDir } from "./CliUtils.js";
import { importDashboardHistory, startForegroundDashboard } from "./DashboardCommand.js";
import { promptSetup } from "./EnableCommand.js";
import { canGenerateNow, promptGenerationFix } from "./GenerationFix.js";
import { offerOptionalJolliLogin } from "./OptionalLogin.js";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

const log = createLogger("GuidedFrontDoor");

/** Lightweight front-door status. Deliberately avoids the heavy `getStatus()`. */
export interface GuidedFrontDoorStatus {
	readonly enabled: boolean;
	readonly summaryCount: number;
}

/**
 * Reads only what the front door needs: whether the git pipeline is installed
 * and how many memories exist. Unlike `getStatus()`, this does not probe every
 * AI host, scan Codex / OpenCode sessions, or enumerate worktrees. `enabled`
 * uses the SAME shared predicate as `getStatus()` and the onboarding funnel's
 * lazy probe — this used to be a bare post-commit check, which made the
 * funnel's `repo_enabled` (and its dedup signature) disagree between the front
 * door and every other trigger site on a partially-installed repo.
 */
export async function getGuidedFrontDoorStatus(cwd: string): Promise<GuidedFrontDoorStatus> {
	const enabled = await isGitPipelineFullyInstalled(cwd);
	// Read the count straight from the active storage (set by runGuidedFrontDoor
	// before calling this). getSummaryCount returns 0 when no index exists, so
	// this covers the fresh-repo case without gating on the orphan branch —
	// gating on it would report 0 for folder-only repos that have memories but
	// no orphan branch.
	const summaryCount = await getSummaryCount(cwd);
	return { enabled, summaryCount };
}

/** Extracts the host from a saved Jolli site URL, if any, for the status line. */
function siteHost(jolliUrl: string | undefined): string | undefined {
	if (!jolliUrl) return undefined;
	try {
		return new URL(jolliUrl).host;
	} catch {
		return undefined;
	}
}

/**
 * Runs the guided front door. Assumes the caller (Api.ts) has already confirmed
 * an interactive TTY on both stdin and stdout — this never guards for that.
 */
export async function runGuidedFrontDoor(): Promise<void> {
	const cwd = resolveProjectDir();

	// ── Repo gate: Jolli attaches memory to commits, so it must run inside a git
	// working tree. Checked BEFORE storage init so a non-repo doesn't resolve a
	// bogus Memory Bank path off the cwd. Dead end by design (no git-init offer). ──
	if (!isInsideGitWorkTree(cwd)) {
		console.log("\n  Jolli guided setup");
		console.log(`  Checking directory ${cwd} ..... not a git repository`);
		console.log("  Jolli attaches memory to your commits, so it must run inside a git repository.");
		console.log("  Change into a repo and run `jolli` again:");
		console.log("    % cd ~/code/your-repo");
		console.log("    % jolli\n");
		// Funnel signal: installed but landed outside a git repo (in_git_repo=false).
		// This dead-end is the one trigger that fires in a non-git directory, so the
		// "never got into a git repo" drop-off is captured rather than invisible.
		await maybeEmitOnboardingProgress({ cwd, config: await loadConfig() });
		process.exitCode = 1;
		return;
	}

	// Repo confirmed: emit the same "Jolli guided setup" header the dead-end
	// branch prints, plus a positive confirmation line, so the framing is
	// identical whether the directory is a repo or not.
	console.log("\n  Jolli guided setup");
	console.log(`  ✓ Git repository ${cwd}`);

	// Initialise storage the way every other memory-reading command does, so
	// folder-mode users read from their Memory Bank rather than the orphan-branch
	// fallback (which also logs a resolveStorage warning).
	setActiveStorage(await createStorage(cwd, cwd));
	let token = await loadAuthToken();
	let config = await loadConfig();
	let { enabled, summaryCount } = await getGuidedFrontDoorStatus(cwd);
	// Onboarding-funnel snapshot on entry, reusing the front door's lightweight
	// status so the heavy `getStatus()` probe is skipped. Fires for every path
	// past the git gate — including the user who declines to enable — so those
	// early exits aren't blind spots. The enable *transition* is separately
	// marked by `surface_enabled` below.
	await maybeEmitOnboardingProgress({ cwd, config, status: { enabled, summaryCount } });

	// Any of these counts as "has some credential" and skips the sign-in guide.
	// `aiProvider: "local-agent"` is self-sufficient for generation — it drives the
	// local agent tool's own login, holding no jollimemory credential — so it must
	// short-circuit the onboarding guide too.
	const hasCredential = (): boolean =>
		Boolean(
			token ||
				config.jolliApiKey ||
				config.apiKey ||
				process.env.ANTHROPIC_API_KEY ||
				config.aiProvider === "local-agent",
		);

	// Snapshot NOW whether onboarding runs this run — it gates Next steps at the
	// very end, and `hasCredential()` flips to true after a sign-in mid-run, so it
	// cannot be recomputed there.
	const ranOnboarding = !hasCredential();

	// ── Auth axis: no credential at all → run the onboarding guide (Claude
	// auto-detect / provider menu). Shared with `jolli enable` via promptSetup. ──
	if (ranOnboarding) {
		await promptSetup();
		token = await loadAuthToken();
		config = await loadConfig();
	}

	// ── Two orthogonal capabilities, recomputed after each interactive step. ──
	let canGenerate = await canGenerateNow(config);
	let canSync = Boolean(token || config.jolliApiKey);

	// ── Rung 1 (blocking): a credential exists but the chosen provider can't use
	// it → repair the provider mismatch. Covers R1/R2 (anthropic/jolli) and R3 (a
	// configured local agent whose tool isn't runnable). `hasCredential()`
	// excludes the fresh user who just skipped setup (nothing to repair). ──
	if (!canGenerate && hasCredential()) {
		await promptGenerationFix(config);
		token = await loadAuthToken();
		config = await loadConfig();
		// Recompute from the freshly-saved config, not the fix's optimistic return:
		// a switch to Jolli only actually restores generation if a jolliApiKey now
		// exists, so trust canGenerateNow.
		canGenerate = await canGenerateNow(config);
		canSync = Boolean(token || config.jolliApiKey);
	}

	// ── Sign in BEFORE enable: generation works but memories can't sync → offer
	// sign-in once (default Yes; a prior global decline suppresses it). ──
	if (canGenerate && !canSync) {
		await offerOptionalJolliLogin();
		token = await loadAuthToken();
		config = await loadConfig();
		// Signing in can flip an unset provider to "jolli"; if no jolliApiKey was
		// minted, generation is no longer possible — recompute so the closing
		// "listening" promise stays honest.
		canGenerate = await canGenerateNow(config);
		canSync = Boolean(token || config.jolliApiKey);
	}

	// ── Enable axis: offer to enable AFTER identity/provider are settled. ──
	if (!enabled) {
		const repoName = basename(cwd);
		// The DEFAULT encodes what we believe the user wants, so it cannot be the same
		// for both repos that arrive here. A repo that was never set up wants enabling;
		// a repo the user switched off themselves wants to stay off — and a disabled
		// repo has its hooks removed, so `enabled` is false and this prompt is
		// UNAVOIDABLE for it. With one default, running `jolli` just to read the status
		// and pressing Enter silently undid an explicit decision (`install` clears the
		// switch, the repo is registered again, and a cutover attempt follows).
		//
		// The sync reader, deliberately: this is a question about wording, and the
		// async one migrates and persists.
		const previouslyDisabled = readManualDisableFlagSync(cwd);
		const answer = await promptText(
			previouslyDisabled
				? `\n  You switched Jolli Memory off in ${repoName}. Turn it back on? [y/N] `
				: `\n  Enable Jolli Memory in ${repoName}? [Y/n] `,
		);
		if (!(previouslyDisabled ? isExplicitYes(answer) : isAffirmative(answer))) {
			console.log("\n  Not enabled. Run `jolli` or `jolli enable` anytime.\n");
			return; // exitCode stays 0 — a valid choice, not an error.
		}
		setLogDir(cwd);
		const result = await install(cwd, { source: "cli", clearManualDisableOnSuccess: true });
		if (!result.success) {
			console.error(`\n  Error: ${result.message}\n`);
			for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
			process.exitCode = 1;
			return;
		}
		track("surface_enabled", { trigger: "cli" });
		for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
		// Concise install confirmation (the full per-path list stays in `jolli enable`).
		console.log("\n  ✓ Git hooks added (post-commit, post-rewrite, prepare-commit-msg)");
		console.log("  ✓ Agent hooks + MCP server added");
		console.log(`  ✓ Jolli Memory enabled in ${repoName}.`);
		// Git hooks record commits immediately, but the AI-agent session hooks
		// (Claude, Gemini) only attach on a fresh session — say so once here.
		console.log("  Restart your AI agent session so it records that session too.");
		enabled = true;
		summaryCount = await getSummaryCount(cwd);
	}

	// ── Status line (AFTER enable, so `✓ enabled` is always truthful). ──
	if (token) {
		const site = siteHost(config.jolliUrl);
		const engine =
			canGenerate && config.aiProvider === "local-agent"
				? ` · summaries via ${localAgentToolLabel(config.localAgentTool ?? "claude-code")}`
				: "";
		console.log(site ? `\n  ✓ signed in · ${site}${engine}` : `\n  ✓ signed in${engine}`);
	} else if (canGenerate && config.aiProvider === "local-agent") {
		console.log("\n  ✓ local agent set (not signed in to Jolli)");
	} else if (canGenerate) {
		// Label the key that would ACTUALLY be used (credSource), not just whichever
		// is present — a jolliApiKey alongside aiProvider="anthropic" still generates
		// via Anthropic.
		const keyLabel = resolveLlmCredentialSource(config) === "jolli-proxy" ? "Jolli API key" : "Anthropic API key";
		console.log(`\n  ✓ ${keyLabel} set (not signed in to Jolli)`);
	} else {
		console.log("\n  ✗ not signed in — run `jolli auth login` to start generating memories");
	}
	console.log(`  ✓ enabled · ${summaryCount} ${summaryCount === 1 ? "memory" : "memories"}`);

	// ── Cloud side-effects: only after credentials are settled. Bind the Space
	// first, then push the backlog — triggerPendingPushRetry no-ops when not
	// signed in. We are always enabled by here (the enable axis returned early on
	// decline). ──
	await runSpaceSyncStep(cwd);
	triggerPendingPushRetry(cwd, "cli-front-door");

	// ── Closing: only promise "listening" when generation actually works. The
	// back-fill offer and the listening line stay gated on canGenerate so we never
	// claim to be capturing memories with no engine to build them. ──
	if (canGenerate) {
		// Cold-start back-fill offer (unchanged). Best-effort — never throws.
		await runBackfillFrontDoorStep(cwd);
		summaryCount = await getSummaryCount(cwd);
		const listening =
			summaryCount === 0
				? "Jolli is listening — your next commit is your first memory"
				: "Jolli is listening — last memory saved.";
		console.log(`\n  ${listening}`);
		// Whatever the back-fill offer did (built memories, was declined, or never
		// appeared), the memories it may have just written reach the dashboard
		// database only through this import. Import-only: opening the dashboard is
		// a separate, later decision — see `offerLocalDashboard`.
		await importLocalDashboard(cwd);
	}

	// Next steps orientation — printed on EVERY path that reaches here, for new
	// and returning users alike and whether or not generation is configured
	// (unlike the listening line above, it makes no promise that could be false).
	// The ONLY states that never show Next steps are the three early-return dead
	// ends earlier in this function, none of which reach this line:
	//   1. not a git repository        → returned early with exitCode 1
	//   2. enable declined at the [Y/n] prompt → returned early (a valid choice)
	//   3. install failure             → returned early with exitCode 1
	printNextSteps();

	// LAST, because it may never return: the dashboard serves in this process
	// until Ctrl+C. Everything the front door has to say has been said by here.
	if (canGenerate) await offerLocalDashboard(cwd);
}

/**
 * Registers this repo and imports its memory into the dashboard database.
 *
 * Placed AFTER the back-fill step on purpose. `dbBackfillRepos` (which the
 * import half wraps) is the ONLY production caller of the source-of-truth
 * import: memories the back-fill just wrote would otherwise sit outside the
 * dashboard database until the user happened to run `jolli dashboard` by hand.
 * Registration alone is not the point — the hooks self-register from the write
 * path on the next commit (see ProducerHooks) — the import is.
 *
 * Deliberately triggered by the STEP COMPLETING, not by it having built
 * anything: `runBackfillFrontDoorStep` returns `void` by contract (it reports
 * nothing to the front door).
 *
 * This is the import HALF of what used to be one `executeDashboard` call. The
 * other half — binding a port and opening a browser — moved to
 * {@link offerLocalDashboard}, after Next steps, because `jolli dashboard` now
 * serves in its own process and does not return until Ctrl+C. Calling it from
 * here would mean the front door never printed Next steps and never exited, on
 * every run.
 */
async function importLocalDashboard(cwd: string): Promise<void> {
	// No flag-free `node:sqlite` → no database to import into. Gated here rather
	// than left to the importer, so nothing below announces a dashboard this
	// runtime cannot serve. Same gate as `jolli enable`.
	if (!canUseDashboardDb()) return;
	// Unthrottled, like every foreground caller. This used to pass a throttle
	// because a bare `jolli` is typed many times a day and the cutover's
	// containment compare reads every file the frozen tip lists — but a repo that
	// cut over short-circuits ahead of that window, so the only runs it ever
	// suppressed were the retries of an attempt that had failed. That is the one
	// case where a user standing at a terminal is about to retry anyway.
	await importDashboardHistory(cwd);
}

/**
 * Opens the dashboard and serves it in this process, on any front-door run at a
 * terminal.
 *
 * Runs LAST, after Next steps, and that position is what makes it unconditional.
 * There used to be an `Open your dashboard now? [Y/n]` here, and its whole job
 * was to stop a blocking serve from swallowing the closing orientation — a
 * problem that only existed while this ran mid-function. Everything the front
 * door has to say has been said by the time we get here, so the question cost a
 * keystroke and bought nothing: declining it and pressing Ctrl+C are the same
 * one key, and only one of the two leaves the user with the dashboard that
 * finishing setup was for.
 *
 * **The one gate it did NOT replace:** `isTTY`, and it is defence in depth rather
 * than the thing that actually decides. Its point is that a non-interactive run
 * has no Ctrl+C, so serving would hold the process open forever at the very end
 * of an otherwise successful setup, where it reads as a hang rather than a
 * choice — but no CI job or install script reaches this line to find out.
 * `Api.ts` runs the front door only when stdin AND stdout are both TTYs, and it
 * is the only caller, so this branch is unreachable from the CLI today
 * (**measured**: bare `jolli` on a pipe prints the grouped help and exits — it
 * never enters `runGuidedFrontDoor` at all). Keep it anyway: it is what makes the
 * function safe for any future caller that does not pre-check, and
 * `GuidedFrontDoor.test.ts` pins both branches. Do not promote it back to
 * "load-bearing" — the gate that carries that weight is the one in `Api.ts`.
 * (`canUseDashboardDb` sits alongside it, but that one is capability, not policy
 * — there is no database on this runtime to serve.)
 *
 * **A `justEnabled` gate is deliberately NOT among them, and this is the place
 * that decision is recorded.** A returning `jolli` at a terminal serves too:
 * opening the dashboard whenever it can is what makes `jolli` the one command a
 * user has to remember. The objection it answers — that a returning run is only a
 * status check, so taking its terminal is not an answer to "how are things" — is
 * settled by the position rather than by a gate: the status line, the listening
 * line and Next steps are all on screen before this blocks, so nothing the run had
 * to say is withheld, and Ctrl+C costs the same one keystroke that declining a
 * prompt would have. `GuidedFrontDoor.test.ts` pins it ("a returning run serves
 * too"), so re-adding the gate fails that test rather than quietly reverting the
 * contract.
 *
 * Never fails the front door: `process.exitCode` must stay untouched here — the
 * front door's exit code is non-zero only for a hard blocker (not a repo,
 * install failure).
 */
async function offerLocalDashboard(cwd: string): Promise<void> {
	if (!canUseDashboardDb()) return;
	if (!process.stdin.isTTY) {
		console.log("  Open your dashboard anytime: jolli dashboard\n");
		return;
	}
	try {
		// The import already ran above, so this is the serve half only — going
		// through `executeDashboard` would re-run it and print "all N memories were
		// already migrated" directly under the block that just migrated them.
		const dashboard = await startForegroundDashboard("stats", { cwd });
		await dashboard.waitForShutdown();
	} catch (err) {
		log.warn("dashboard did not start (non-fatal): %s", errMsg(err));
		console.log("  (Dashboard did not open — run 'jolli dashboard' to retry.)\n");
	}
}

/** Prints the closing orientation shown on every non-dead-end front-door run. */
function printNextSteps(): void {
	console.log("\n  Next steps");
	console.log("    1. Keep working in your agent — every commit becomes a memory, automatically.");
	console.log("    2. Reach back: jolli recall · jolli search · jolli compile · jolli graph · jolli mcp");
	console.log("    3. In your editor: add the VS Code extension or IntelliJ plugin.");
	console.log("    4. See all commands: jolli help\n");
}
