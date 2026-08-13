/**
 * OnboardingFunnel — the per-install onboarding-funnel snapshot behind the
 * `onboarding_progressed` telemetry event (JOLLI core-telemetry-checkpoints).
 *
 * The product question this answers: *after someone installs, where do they
 * stall before memories get generated — is it the key or the repo?* The four
 * checkpoints, keyed by the machine-global `installId` that rides every
 * envelope:
 *
 *   0. installed          — `install_id` exists (denominator; `app_installed`).
 *   1. in a git repo      — `in_git_repo`: JolliMemory is meaningless outside a
 *                           git working tree, so this is the first real gate.
 *      enabled here       — `repo_enabled`: `jolli enable` succeeded (hooks in).
 *   2. can capture at all — `capture_configured` / `capture_method`: at least
 *                           one LLM route exists (local-agent, an Anthropic key,
 *                           or a Jolli key). None ⇒ memory can never be made.
 *   3. memories generated — `memories_generated` / `memories_bucket`.
 *
 * (Connecting the repo to a Jolli Space — the shared-to-web step — is a
 * *separate, later* event, not part of this critical-path snapshot.)
 *
 * Everything here is content-free: booleans, one enum, and a coarse count
 * bucket. No path, repo name, URL, or key ever enters the payload — so it
 * clears the client scrubber and the backend allowlist unchanged.
 *
 * The snapshot is emitted from a *repo context* (the cwd of the trigger), so a
 * single install that works across many repos reports each repo's state. The
 * backend aggregates per `install_id` ("does this install have any repo that
 * reached checkpoint N"). No repo identifier is attached — see the funnel
 * design notes; a salted repo hash was deliberately left out to keep the
 * snapshot maximally conservative.
 *
 * Dedup-ledger location: the ledger lives at `getJolliMemoryDir(cwd)` — the
 * *literal* cwd, not the git root (the same cwd contract as the telemetry
 * buffer, JOLLI-1957). The consequence points the OPPOSITE way from the
 * buffer's: buffer fragmentation strands events, but ledger fragmentation
 * *duplicates* sends — running from two subdirectories of one repo yields two
 * ledgers and one extra emit (plus a daily heartbeat each). Accepted for now
 * because every shipped trigger passes a repo-root / workspace-root cwd
 * (`resolveProjectDir`, `bridge.cwd`, `project.basePath`, the QueueWorker cwd);
 * if a subdirectory-cwd trigger is ever added, anchor the ledger to the git
 * common-dir instead. Writes go through `atomicWriteFile` and a per-path
 * in-flight guard so the read→decide→write cycle can't interleave (VS Code
 * fires `refresh()` from ≥5 uncoordinated triggers).
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir, isManuallyDisabled } from "../Logger.js";
import type { JolliMemoryConfig, StatusInfo } from "../Types.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { isInsideGitRepo } from "./GitOps.js";
import { resolveLlmCredentialSource } from "./LlmClient.js";
import { readManualDisableFlagSync } from "./RepoProfile.js";
import { type BucketLabel, bucket, getTelemetryContext, track } from "./Telemetry.js";

/** Which route (if any) the user has configured to capture memory. */
export type CaptureMethod = "local-agent" | "anthropic" | "jolli" | "none";

/** The content-free onboarding state for one repo context. */
export interface OnboardingFunnelState {
	/** Is the cwd inside a git working tree at all? */
	readonly inGitRepo: boolean;
	/** Is JolliMemory enabled here (git hooks installed)? Always false when not in a git repo. */
	readonly repoEnabled: boolean;
	/** Does at least one memory-capture route exist (any of local-agent / Anthropic key / Jolli key)? */
	readonly captureConfigured: boolean;
	/** Which capture route is configured — the discriminator behind `captureConfigured`. */
	readonly captureMethod: CaptureMethod;
	/** Are there any generated memories in this repo? */
	readonly memoriesGenerated: boolean;
	/** Coarse bucket of the stored-memory count. */
	readonly memoriesBucket: BucketLabel;
}

/** The config subset that decides the capture route. */
type CaptureConfig = Pick<JolliMemoryConfig, "apiKey" | "jolliApiKey" | "aiProvider">;

/**
 * Collapse `resolveLlmCredentialSource` — the *same* function that actually
 * drives generation, so this can never drift from reality — onto the funnel's
 * coarse discriminator. `anthropic-config` and `anthropic-env` both fold to
 * `anthropic`; `jolli-proxy` to `jolli`; `null` to `none`.
 */
export function captureMethodOf(config: CaptureConfig): CaptureMethod {
	switch (resolveLlmCredentialSource(config)) {
		case "local-agent":
			return "local-agent";
		case "jolli-proxy":
			return "jolli";
		case "anthropic-config":
		case "anthropic-env":
			return "anthropic";
		default:
			return "none";
	}
}

/** The status fields the funnel reads. Accepted precomputed so trigger sites that already ran `getStatus()` don't pay for it twice. */
type FunnelStatus = Pick<StatusInfo, "enabled" | "summaryCount">;

/**
 * The lazy fallback for trigger sites that hold no precomputed status: reads
 * ONLY the two fields the snapshot uses. This used to be a full `getStatus()`,
 * which probes every AI host, scans session stores and enumerates worktrees —
 * several times the cost of these two reads — and some no-status triggers sit
 * on blocking per-session paths (the plugin SessionStart bootstraps), where
 * `install(..., { repoHooksOnly })` deliberately skips exactly those host
 * probes to stay fast. `enabled` is `getStatus()`'s own derivation, via the
 * SHARED `isGitPipelineFullyInstalled` predicate — a shared function rather
 * than a copied conjunction, so the dedup-ledger signature cannot drift apart
 * between precomputing and lazy trigger sites. The two independent reads run
 * in parallel. Lazy imports break the static Installer ⇆ OnboardingFunnel cycle.
 */
async function resolveFunnelStatusLight(cwd: string): Promise<FunnelStatus> {
	const [gitHooks, summaryStore] = await Promise.all([
		import("../install/GitHookInstaller.js"),
		import("./SummaryStore.js"),
	]);
	const [enabled, summaryCount] = await Promise.all([
		gitHooks.isGitPipelineFullyInstalled(cwd),
		summaryStore.getSummaryCount(cwd),
	]);
	return { enabled, summaryCount };
}

export interface ResolveFunnelOptions {
	/** Repo context to snapshot. */
	readonly cwd: string;
	/** Global config carrying the capture credentials. */
	readonly config: CaptureConfig;
	/** Precomputed status, when the caller already has one; otherwise computed lazily (git repos only). */
	readonly status?: FunnelStatus;
}

/**
 * Compute the onboarding snapshot for a repo context. **Rejects** if the
 * underlying `isInsideGitRepo` / status calls fail — the caller
 * (`maybeEmitOnboardingProgress`) is where the swallow-and-continue guard lives,
 * so telemetry never breaks the command. When the cwd is not a git repo we
 * short-circuit — no hooks, no summaries — and never touch the status probe.
 */
export async function resolveOnboardingFunnel(opts: ResolveFunnelOptions): Promise<OnboardingFunnelState> {
	const captureMethod = captureMethodOf(opts.config);
	const captureConfigured = captureMethod !== "none";
	const inGitRepo = await isInsideGitRepo(opts.cwd);
	if (!inGitRepo) {
		return {
			inGitRepo: false,
			repoEnabled: false,
			captureConfigured,
			captureMethod,
			memoriesGenerated: false,
			memoriesBucket: "0",
		};
	}
	const status = opts.status ?? (await resolveFunnelStatusLight(opts.cwd));
	const summaryCount = status.summaryCount ?? 0;
	return {
		inGitRepo: true,
		repoEnabled: Boolean(status.enabled),
		captureConfigured,
		captureMethod,
		memoriesGenerated: summaryCount > 0,
		memoriesBucket: bucket(summaryCount),
	};
}

/** On-disk dedup ledger — one per repo context, colocated with the telemetry buffer. */
const LEDGER_FILE = "onboarding-progress.json";
/** Re-emit an unchanged state at most once per day so a steady install still reports "alive". */
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

interface OnboardingLedger {
	readonly sig: string;
	readonly tsIso: string;
}

/**
 * Signature the dedup keys on. `captureConfigured` is omitted because it is a
 * pure function of `captureMethod`; everything else that can move the funnel is
 * present, so any real state change re-emits.
 */
function signatureOf(state: OnboardingFunnelState): string {
	return [
		state.inGitRepo,
		state.repoEnabled,
		state.captureMethod,
		state.memoriesGenerated,
		state.memoriesBucket,
	].join("|");
}

async function readLedger(path: string): Promise<OnboardingLedger | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as OnboardingLedger;
		if (typeof parsed?.sig === "string" && typeof parsed?.tsIso === "string") return parsed;
	} catch {
		// Missing / malformed ledger ⇒ treat as first emit.
	}
	return undefined;
}

/**
 * Serializes the read→decide→write cycle per ledger path. VS Code drives
 * `StatusStore.refresh()` (a fire-and-forget with no in-flight guard) from ≥5
 * uncoordinated triggers — activation, the sessions/HEAD watchers, the manual
 * refresh command, a fan-out — so two calls can land in the same tick. Without
 * this they'd both read the same (or absent) ledger, both pass the dedup gate,
 * and both emit for one state change. Keyed by ledger path so distinct repos
 * still run concurrently.
 */
const ledgerLocks = new Map<string, Promise<unknown>>();

/**
 * Emit an `onboarding_progressed` snapshot for this repo context, deduped so we
 * only send when the state tuple changed or a day has elapsed. Never throws —
 * telemetry must never break product code.
 *
 * Short-circuits when telemetry is inactive (uninitialized or opted out) so an
 * opted-out user pays no git/`getStatus()` cost and the ledger is only written
 * once an emit could actually have been buffered.
 */
export async function maybeEmitOnboardingProgress(opts: ResolveFunnelOptions): Promise<void> {
	let ledgerPath: string | undefined;
	let run: Promise<unknown> | undefined;
	// The WHOLE body is guarded — telemetry must never throw into the caller, even
	// if `getTelemetryContext` itself is unavailable (e.g. a test that mocks the
	// Telemetry module down to just `track`).
	try {
		// Short-circuit before any git/status work — and before taking the lock —
		// when telemetry is off, so an opted-out user pays nothing.
		if (!getTelemetryContext()?.enabled) return;
		// Same, for a repo the user durably opted out of (spec 304). The ledger is a
		// NEW repo-local file, not an append to the buffer the telemetry primitive
		// already owns, so the "telemetry recording is ungated" carve-out does not
		// cover it — without this gate the Disable command's own status refresh
		// writes into the repo it just disabled.
		//
		// BOTH readers are consulted because neither alone covers every trigger:
		//   - `isManuallyDisabled()` is the free in-memory mirror the editor host
		//     seeds at activate() and flips in lockstep with enable/disable. It is
		//     the only reader available on VS Code's synchronous write paths, but
		//     it is process-local — CLI processes never set it (see Logger.ts), so
		//     on its own it left `jolli status` / bare `jolli` / `jolli enable` /
		//     the QueueWorker's IngestRunStore recreating the ledger in a repo the
		//     user had already disabled.
		//   - `readManualDisableFlagSync` is the durable, disk-backed truth those
		//     CLI processes need. It must be the SYNC variant: the async
		//     `readManualDisableFlag` persists a legacy-marker migration decision,
		//     i.e. a write, which is exactly what this gate exists to prevent.
		//     Steady-state cost is one `readFileSync`: the `git rev-parse` it needs
		//     to anchor on the main worktree runs once per `cwd` and is then served
		//     from `_mainRootCache` (see `RepoProfile.ts`), because this gate is NOT
		//     a once-per-process seed — VS Code reaches it from every
		//     `StatusStore.refresh()`, including two file watchers that fire
		//     repeatedly while an AI session is live, so an unmemoized subprocess
		//     spawn per refresh would block the extension host's event loop. What
		//     is left is charged only after the telemetry-consent short-circuit,
		//     and is small next to the `isInsideGitRepo` / `getStatus` work
		//     `resolveOnboardingFunnel` runs immediately after it.
		//
		// KNOWN TRADE-OFF, deliberate: this sits ahead of `track()`, not merely ahead
		// of the ledger write, so disabling a repo silences the funnel INCLUDING the
		// `repo_enabled: false` snapshot that would have recorded the disable itself.
		// The last snapshot on record for that repo says "enabled" and nothing ever
		// supersedes it — so the drop-off this funnel exists to observe is the one
		// event it cannot see. Gating only the persist is NOT the fix: the dedup
		// ledger would go unread, turning every status refresh into a fresh emit, and
		// the zero-write contract (spec 304) is the stronger of the two promises.
		// Recovering the signal needs a one-shot emit at the disable GESTURE itself,
		// which is a separate design — not a relaxation of this gate.
		if (isManuallyDisabled() || readManualDisableFlagSync(opts.cwd)) return;
		ledgerPath = join(getJolliMemoryDir(opts.cwd), LEDGER_FILE);
		const path = ledgerPath;
		run = (ledgerLocks.get(path) ?? Promise.resolve()).then(() => emitOnce(opts, path));
		ledgerLocks.set(path, run);
		await run;
	} catch {
		// Never let a telemetry snapshot break the command that triggered it.
	} finally {
		// Drop the entry once this run is the tail, so the map can't grow unbounded.
		if (ledgerPath && run && ledgerLocks.get(ledgerPath) === run) ledgerLocks.delete(ledgerPath);
	}
}

/**
 * One dedup-gated snapshot emit for a single ledger path. Runs inside the
 * per-path serialization above, so its read of the ledger always sees the
 * previous winner's write. Never throws — a telemetry snapshot must not break
 * the command (or the promise chain) that triggered it.
 */
async function emitOnce(opts: ResolveFunnelOptions, ledgerPath: string): Promise<void> {
	try {
		const state = await resolveOnboardingFunnel(opts);
		const sig = signatureOf(state);
		const prev = await readLedger(ledgerPath);
		const now = Date.now();
		const changed = !prev || prev.sig !== sig;
		const elapsed = prev ? now - Date.parse(prev.tsIso) : Number.POSITIVE_INFINITY;
		const stale = !Number.isFinite(elapsed) || elapsed >= HEARTBEAT_MS;
		if (!changed && !stale) return;
		track("onboarding_progressed", {
			in_git_repo: state.inGitRepo,
			repo_enabled: state.repoEnabled,
			capture_configured: state.captureConfigured,
			capture_method: state.captureMethod,
			memories_generated: state.memoriesGenerated,
			memories_bucket: state.memoriesBucket,
		});
		const dir = getJolliMemoryDir(opts.cwd);
		await mkdir(dir, { recursive: true });
		// Atomic write: a torn ledger would be read back as "first emit" (see
		// readLedger), turning a crash mid-write into a duplicate rather than a skip.
		await atomicWriteFile(
			ledgerPath,
			JSON.stringify({ sig, tsIso: new Date(now).toISOString() } satisfies OnboardingLedger),
		);
	} catch {
		// Never let a telemetry snapshot break the command that triggered it.
	}
}
