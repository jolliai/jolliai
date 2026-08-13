import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("./GitOps.js", () => ({ isInsideGitRepo: vi.fn() }));
vi.mock("./LlmClient.js", () => ({ resolveLlmCredentialSource: vi.fn() }));
// Kept ONLY to prove the heavy probe is never called — the lazy status fallback
// is the lightweight GitHookInstaller/SummaryStore pair below, not getStatus().
vi.mock("../install/Installer.js", () => ({ getStatus: vi.fn() }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitPipelineFullyInstalled: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({ getSummaryCount: vi.fn() }));
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return { ...actual, getJolliMemoryDir: vi.fn() };
});
vi.mock("./Telemetry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./Telemetry.js")>();
	// Keep the real `bucket`; only track + the consent gate are controllable.
	return { ...actual, track: vi.fn(), getTelemetryContext: vi.fn() };
});
// The durable disable reader spawns a real `git rev-parse` — stubbed so this stays
// in the fast tier; the two gate tests below drive it explicitly.
vi.mock("./RepoProfile.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RepoProfile.js")>();
	return { ...actual, readManualDisableFlagSync: vi.fn() };
});

import { isGitPipelineFullyInstalled } from "../install/GitHookInstaller.js";
import { getStatus } from "../install/Installer.js";
import { getJolliMemoryDir, setManuallyDisabled } from "../Logger.js";
import { isInsideGitRepo } from "./GitOps.js";
import { resolveLlmCredentialSource } from "./LlmClient.js";
import { captureMethodOf, maybeEmitOnboardingProgress, resolveOnboardingFunnel } from "./OnboardingFunnel.js";
import { readManualDisableFlagSync } from "./RepoProfile.js";
import { getSummaryCount } from "./SummaryStore.js";
import { getTelemetryContext, track } from "./Telemetry.js";

const isGit = isInsideGitRepo as Mock;
const resolveSrc = resolveLlmCredentialSource as Mock;
const getStatusMock = getStatus as Mock;
const pipelineMock = isGitPipelineFullyInstalled as Mock;
const summaryCountMock = getSummaryCount as Mock;
const jolliDir = getJolliMemoryDir as Mock;
const trackMock = track as Mock;
const ctxMock = getTelemetryContext as Mock;
const durableDisabled = readManualDisableFlagSync as Mock;

const LEDGER = "onboarding-progress.json";
let tmp: string;

beforeEach(async () => {
	vi.clearAllMocks();
	tmp = await mkdtemp(join(tmpdir(), "onboarding-funnel-"));
	jolliDir.mockReturnValue(tmp);
	ctxMock.mockReturnValue({ enabled: true });
	isGit.mockResolvedValue(true);
	resolveSrc.mockReturnValue(null);
	durableDisabled.mockReturnValue(false);
});

afterEach(async () => {
	// Module-level flag: leaking `true` would silently no-op every later test here.
	setManuallyDisabled(false);
	await rm(tmp, { recursive: true, force: true });
});

describe("captureMethodOf", () => {
	it("maps each credential source onto the coarse discriminator", () => {
		const cases: Array<[unknown, string]> = [
			["local-agent", "local-agent"],
			["jolli-proxy", "jolli"],
			["anthropic-config", "anthropic"],
			["anthropic-env", "anthropic"],
			[null, "none"],
		];
		for (const [source, expected] of cases) {
			resolveSrc.mockReturnValue(source);
			expect(captureMethodOf({})).toBe(expected);
		}
	});
});

describe("resolveOnboardingFunnel", () => {
	it("short-circuits outside a git repo without touching any status probe", async () => {
		isGit.mockResolvedValue(false);
		resolveSrc.mockReturnValue("anthropic-config");
		const state = await resolveOnboardingFunnel({ cwd: tmp, config: {} });
		expect(state).toEqual({
			inGitRepo: false,
			repoEnabled: false,
			captureConfigured: true,
			captureMethod: "anthropic",
			memoriesGenerated: false,
			memoriesBucket: "0",
		});
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(pipelineMock).not.toHaveBeenCalled();
		expect(summaryCountMock).not.toHaveBeenCalled();
	});

	it("uses a precomputed status without running any probe", async () => {
		resolveSrc.mockReturnValue("local-agent");
		const state = await resolveOnboardingFunnel({
			cwd: tmp,
			config: {},
			status: { enabled: true, summaryCount: 3 },
		});
		expect(state).toEqual({
			inGitRepo: true,
			repoEnabled: true,
			captureConfigured: true,
			captureMethod: "local-agent",
			memoriesGenerated: true,
			memoriesBucket: "1-5",
		});
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(pipelineMock).not.toHaveBeenCalled();
		expect(summaryCountMock).not.toHaveBeenCalled();
	});

	it("reports not-enabled and zero memories for a bare git repo", async () => {
		const state = await resolveOnboardingFunnel({
			cwd: tmp,
			config: {},
			status: { enabled: false, summaryCount: 0 },
		});
		expect(state.repoEnabled).toBe(false);
		expect(state.captureConfigured).toBe(false);
		expect(state.captureMethod).toBe("none");
		expect(state.memoriesGenerated).toBe(false);
		expect(state.memoriesBucket).toBe("0");
	});

	it("lazily computes status via the lightweight probe when none is provided — never getStatus()", async () => {
		resolveSrc.mockReturnValue("jolli-proxy");
		pipelineMock.mockResolvedValue(true);
		summaryCountMock.mockResolvedValue(50);
		const state = await resolveOnboardingFunnel({ cwd: tmp, config: {} });
		// `enabled` comes from the SAME shared predicate getStatus() uses, so the
		// dedup-ledger signature cannot drift between precomputing and lazy
		// trigger sites.
		expect(pipelineMock).toHaveBeenCalledWith(tmp);
		expect(summaryCountMock).toHaveBeenCalledWith(tmp);
		// The heavy probe (host detection, session-store scans, worktree
		// enumeration) must stay out of the lazy path — some no-status triggers
		// sit on blocking per-session paths (plugin SessionStart bootstraps).
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(state.repoEnabled).toBe(true);
		expect(state.captureMethod).toBe("jolli");
		expect(state.memoriesGenerated).toBe(true);
		expect(state.memoriesBucket).toBe("21-100");
	});

	it("reports not enabled when the shared pipeline predicate says so", async () => {
		pipelineMock.mockResolvedValue(false);
		summaryCountMock.mockResolvedValue(0);
		const state = await resolveOnboardingFunnel({ cwd: tmp, config: {} });
		expect(state.repoEnabled).toBe(false);
	});

	it("treats a missing summaryCount as zero", async () => {
		pipelineMock.mockResolvedValue(true);
		summaryCountMock.mockResolvedValue(undefined);
		const state = await resolveOnboardingFunnel({ cwd: tmp, config: {} });
		expect(state.memoriesGenerated).toBe(false);
		expect(state.memoriesBucket).toBe("0");
	});
});

describe("maybeEmitOnboardingProgress", () => {
	const ledgerPath = (): string => join(tmp, LEDGER);

	it("does nothing (no git work, no ledger) when telemetry is inactive", async () => {
		ctxMock.mockReturnValue(null);
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 1 } });
		expect(trackMock).not.toHaveBeenCalled();
		expect(isGit).not.toHaveBeenCalled();
		await expect(readFile(ledgerPath(), "utf-8")).rejects.toThrow();
	});

	it("does nothing (no git work, no ledger) when the repo is manually disabled", async () => {
		// Spec 304: the in-memory suppression flag is the gate every write site in the
		// editor host consults. This emitter used to skip it entirely, so the Disable
		// command's own status refresh created `onboarding-progress.json` inside the
		// repo it had just disabled — a second, undocumented write class.
		setManuallyDisabled(true);
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 1 } });
		expect(trackMock).not.toHaveBeenCalled();
		expect(isGit).not.toHaveBeenCalled();
		await expect(readFile(ledgerPath(), "utf-8")).rejects.toThrow();
	});

	it("does nothing (no git work, no ledger) when only the durable flag says disabled", async () => {
		// The CLI half of spec 304. `setManuallyDisabled` is process-local and no CLI
		// entry point ever calls it, so after `jolli disable` the in-memory mirror is
		// still false in a fresh `jolli status` / bare `jolli` / QueueWorker process.
		// Without the durable reader those recreated `onboarding-progress.json` in the
		// repo the user had just disabled.
		setManuallyDisabled(false);
		durableDisabled.mockReturnValue(true);
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 1 } });
		expect(durableDisabled).toHaveBeenCalledWith(tmp);
		expect(trackMock).not.toHaveBeenCalled();
		expect(isGit).not.toHaveBeenCalled();
		await expect(readFile(ledgerPath(), "utf-8")).rejects.toThrow();
	});

	it("skips the durable read entirely when the in-memory mirror already says disabled", async () => {
		// Short-circuit order matters: the editor host seeds the free mirror at
		// activate() and fires this from ≥5 uncoordinated refresh triggers, so a
		// disabled workspace must not pay a sync `git rev-parse` per refresh.
		setManuallyDisabled(true);
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 1 } });
		expect(durableDisabled).not.toHaveBeenCalled();
	});

	it("skips the durable read entirely when telemetry is inactive", async () => {
		// The consent short-circuit stays first: an opted-out user pays no disk/git cost.
		ctxMock.mockReturnValue(null);
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 1 } });
		expect(durableDisabled).not.toHaveBeenCalled();
	});

	it("emits the content-free snapshot and writes the dedup ledger on first run", async () => {
		resolveSrc.mockReturnValue("anthropic-config");
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } });
		expect(trackMock).toHaveBeenCalledTimes(1);
		expect(trackMock).toHaveBeenCalledWith("onboarding_progressed", {
			in_git_repo: true,
			repo_enabled: true,
			capture_configured: true,
			capture_method: "anthropic",
			memories_generated: true,
			memories_bucket: "1-5",
		});
		const ledger = JSON.parse(await readFile(ledgerPath(), "utf-8"));
		expect(typeof ledger.sig).toBe("string");
		expect(typeof ledger.tsIso).toBe("string");
	});

	it("dedups an unchanged state within the heartbeat window", async () => {
		const opts = { cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } };
		await maybeEmitOnboardingProgress(opts);
		await maybeEmitOnboardingProgress(opts);
		expect(trackMock).toHaveBeenCalledTimes(1);
	});

	it("re-emits when the state tuple changes", async () => {
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } });
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 30 } });
		expect(trackMock).toHaveBeenCalledTimes(2);
		expect(trackMock.mock.calls[1][1].memories_bucket).toBe("21-100");
	});

	it("re-emits an unchanged state once the daily heartbeat has elapsed", async () => {
		const opts = { cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } };
		await maybeEmitOnboardingProgress(opts);
		// Backdate the ledger past the 24h heartbeat, keeping the same signature.
		const ledger = JSON.parse(await readFile(ledgerPath(), "utf-8"));
		const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		await writeFile(ledgerPath(), JSON.stringify({ sig: ledger.sig, tsIso: dayAgo }), "utf-8");
		await maybeEmitOnboardingProgress(opts);
		expect(trackMock).toHaveBeenCalledTimes(2);
	});

	it("treats a malformed ledger as a first emit", async () => {
		await writeFile(ledgerPath(), "not json", "utf-8");
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } });
		expect(trackMock).toHaveBeenCalledTimes(1);
	});

	it("treats a ledger missing fields as a first emit", async () => {
		await writeFile(ledgerPath(), JSON.stringify({ sig: 123 }), "utf-8");
		await maybeEmitOnboardingProgress({ cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } });
		expect(trackMock).toHaveBeenCalledTimes(1);
	});

	it("never throws when state resolution fails", async () => {
		isGit.mockRejectedValue(new Error("boom"));
		await expect(maybeEmitOnboardingProgress({ cwd: tmp, config: {} })).resolves.toBeUndefined();
		expect(trackMock).not.toHaveBeenCalled();
	});

	it("serializes concurrent calls so one unchanged state emits exactly once", async () => {
		const opts = { cwd: tmp, config: {}, status: { enabled: true, summaryCount: 2 } };
		// Same tick, no in-flight guard at the caller (VS Code's fire-and-forget refresh):
		// without per-ledger serialization these would race read→write and double-emit.
		await Promise.all([
			maybeEmitOnboardingProgress(opts),
			maybeEmitOnboardingProgress(opts),
			maybeEmitOnboardingProgress(opts),
		]);
		expect(trackMock).toHaveBeenCalledTimes(1);
	});
});
