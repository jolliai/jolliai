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
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import type { JolliMemoryConfig, StatusInfo } from "../Types.js";
import { isInsideGitRepo } from "./GitOps.js";
import { resolveLlmCredentialSource } from "./LlmClient.js";
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

export interface ResolveFunnelOptions {
	/** Repo context to snapshot. */
	readonly cwd: string;
	/** Global config carrying the capture credentials. */
	readonly config: CaptureConfig;
	/** Precomputed status, when the caller already has one; otherwise computed lazily (git repos only). */
	readonly status?: FunnelStatus;
}

/**
 * Compute the onboarding snapshot for a repo context. Never throws. When the
 * cwd is not a git repo we short-circuit — no hooks, no summaries — and never
 * touch `getStatus()`.
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
	let status = opts.status;
	if (!status) {
		// Lazy import breaks the static Installer ⇆ OnboardingFunnel cycle.
		const { getStatus } = await import("../install/Installer.js");
		status = await getStatus(opts.cwd);
	}
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
 * Emit an `onboarding_progressed` snapshot for this repo context, deduped so we
 * only send when the state tuple changed or a day has elapsed. Never throws —
 * telemetry must never break product code.
 *
 * Short-circuits when telemetry is inactive (uninitialized or opted out) so an
 * opted-out user pays no git/`getStatus()` cost and the ledger is only written
 * once an emit could actually have been buffered.
 */
export async function maybeEmitOnboardingProgress(opts: ResolveFunnelOptions): Promise<void> {
	try {
		if (!getTelemetryContext()?.enabled) return;
		const state = await resolveOnboardingFunnel(opts);
		const dir = getJolliMemoryDir(opts.cwd);
		const ledgerPath = join(dir, LEDGER_FILE);
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
		await mkdir(dir, { recursive: true });
		await writeFile(
			ledgerPath,
			JSON.stringify({ sig, tsIso: new Date(now).toISOString() } satisfies OnboardingLedger),
			"utf-8",
		);
	} catch {
		// Never let a telemetry snapshot break the command that triggered it.
	}
}
