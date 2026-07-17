import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: vi.fn(async () => ({ apiKey: "test", localFolder: "/mb" })),
}));
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn(async () => ({})),
}));
vi.mock("../core/SummaryStore.js", () => ({
	setActiveStorage: vi.fn(),
	getActiveStorage: vi.fn(() => null),
}));
vi.mock("../core/IngestPipeline.js", () => ({
	drainIngest: vi.fn(async () => ({ batches: 1, ingested: 3, outcome: "OK", topicFailures: [] })),
}));
vi.mock("../core/IngestRunStore.js", () => ({
	appendCredentialMissingRun: vi.fn(async () => {}),
}));
vi.mock("../core/MultiRepoCompile.js", () => ({
	compileAllRepos: vi.fn(async () => ({
		repos: [{ folder: "jolli", ingested: 5, batches: 1 }],
		totalIngested: 5,
		failed: 0,
	})),
}));
vi.mock("../core/TopicWikiRenderer.js", () => ({
	renderTopicKBWiki: vi.fn(async () => {}),
}));
vi.mock("../core/ProcessedSourceStore.js", () => ({
	saveProcessedSet: vi.fn(async () => {}),
	emptyProcessedSet: vi.fn(() => ({
		schemaVersion: 1,
		processed: { summary: [], plan: [], note: [], userfile: [] },
	})),
}));
vi.mock("../core/TopicIndexStore.js", () => ({
	saveTopicIndex: vi.fn(async () => {}),
	emptyTopicIndex: vi.fn(() => ({ schemaVersion: 1, topics: [] })),
	readTopicIndex: vi.fn(async () => ({ schemaVersion: 1, topics: [] })),
}));
vi.mock("../core/TopicPageStore.js", () => ({
	purgeTopicPagesExcept: vi.fn(async () => []),
}));
vi.mock("../Logger.js", () => ({
	setLogDir: vi.fn(),
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../sync/SyncBootstrap.js", () => ({
	deriveMemoryBankRoot: vi.fn((localFolder: string | undefined) => localFolder ?? "/mb"),
}));
vi.mock("../sync/VaultWriteLock.js", async (importOriginal) => {
	// Keep the real `VaultWriteBusyError` so the production `instanceof` check
	// (busy → clean exit vs real error → propagate) is exercised faithfully; only
	// the lock acquisition itself is stubbed.
	const actual = await importOriginal<typeof import("../sync/VaultWriteLock.js")>();
	return {
		...actual,
		DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
		// Default: lock free → run the body and surface its value.
		withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
			ran: true,
			value: await body(),
		})),
	};
});
vi.mock("../hooks/QueueWorker.js", () => ({ launchWorker: vi.fn() }));
vi.mock("../graph/GraphBuilder.js", () => ({
	// Default: graph build is a no-op so it doesn't pull the real LLM-bearing
	// builder into every compile test. Individual tests override to throw and
	// exercise the non-fatal catch.
	buildKnowledgeGraph: vi.fn(async () => {}),
}));

import { drainIngest } from "../core/IngestPipeline.js";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { saveProcessedSet } from "../core/ProcessedSourceStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { readTopicIndex, saveTopicIndex } from "../core/TopicIndexStore.js";
import { purgeTopicPagesExcept } from "../core/TopicPageStore.js";
import { renderTopicKBWiki } from "../core/TopicWikiRenderer.js";
import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { withVaultWriteLock } from "../sync/VaultWriteLock.js";
import { registerCompileCommand } from "./CompileCommand.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockDrainIngest = vi.mocked(drainIngest);
const mockCompileAllRepos = vi.mocked(compileAllRepos);
const mockRenderTopicKBWiki = vi.mocked(renderTopicKBWiki);
const mockSaveProcessedSet = vi.mocked(saveProcessedSet);
const mockSaveTopicIndex = vi.mocked(saveTopicIndex);

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerCompileCommand(program);
	return program;
}

async function runCompile(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...msgs: unknown[]) => {
		stdout += `${msgs.map(String).join(" ")}\n`;
	};
	console.error = (...msgs: unknown[]) => {
		stderr += `${msgs.map(String).join(" ")}\n`;
	};
	process.exitCode = undefined;
	try {
		await makeProgram().parseAsync(["node", "jolli", "compile", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

describe("registerCompileCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfig.mockResolvedValue({ apiKey: "test", localFolder: "/mb" } as never);
		mockDrainIngest.mockResolvedValue({ batches: 1, ingested: 3, outcome: "OK", topicFailures: [] });
		mockCompileAllRepos.mockResolvedValue({
			repos: [{ folder: "jolli", ingested: 5, batches: 1 }],
			totalIngested: 5,
			failed: 0,
		});
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("no args: sweeps all Memory Bank repos", async () => {
		const { stdout } = await runCompile([]);

		expect(mockCompileAllRepos).toHaveBeenCalledOnce();
		expect(mockCompileAllRepos).toHaveBeenCalledWith("/mb", expect.anything());
		expect(mockDrainIngest).not.toHaveBeenCalled();
		expect(stdout).toContain("across 1 repo(s)");
		expect(stdout).toContain("jolli");
	});

	it("sweep with no localFolder: error + exitCode=1", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "test" } as never);
		const { stderr } = await runCompile([]);
		expect(stderr).toContain("No Memory Bank folder configured");
		expect(process.exitCode).toBe(1);
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
	});

	it("sweep reports per-repo failures + exitCode=1", async () => {
		mockCompileAllRepos.mockResolvedValue({
			repos: [
				{ folder: "jolli", ingested: 5, batches: 1 },
				{ folder: "boom", ingested: 0, batches: 0, error: "kaboom" },
			],
			totalIngested: 5,
			failed: 1,
		});
		const { stdout } = await runCompile([]);
		expect(stdout).toContain("✗ boom: kaboom");
		expect(stdout).toContain("1 failed");
		expect(process.exitCode).toBe(1);
	});

	it("--cwd: single-repo drain + render", async () => {
		const { stdout } = await runCompile(["--cwd", "/repo"]);

		expect(mockDrainIngest).toHaveBeenCalledOnce();
		expect(mockRenderTopicKBWiki).toHaveBeenCalledOnce();
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
		expect(stdout).toContain("Done:");
		expect(stdout).toContain("3 source(s)");
	});

	it("--cwd: drains with a per-write writeGuard (lock released during the LLM phase, not held across the whole drain)", async () => {
		await runCompile(["--cwd", "/repo"]);
		// The key contract: drainIngest gets a writeGuard so its reconcile LLM phase
		// runs UNLOCKED and only re-acquires the lock per write — a concurrent
		// commit-summary worker can interleave and generate its memory promptly.
		expect(mockDrainIngest).toHaveBeenCalledWith(
			"/repo",
			expect.anything(),
			expect.objectContaining({ triggeredBy: "manual", writeGuard: expect.any(Function) }),
		);
		// And that guard acquires the canonical vault lock in wait-mode with the
		// pending-worker wakeup hook (4th arg).
		expect(withVaultWriteLock).toHaveBeenCalledWith("/mb", { wait: 60_000 }, expect.any(Function), {
			launch: expect.any(Function),
		});
	});

	it("--cwd: a per-write guard that can't acquire the lock (ran:false) surfaces as a non-fatal warn, compile still completes", async () => {
		// The single writeGuard call on a non-rebuild compile is the search-index
		// warm-up; a busy lock makes withVaultWriteLock report ran:false, so the
		// guard throws "could not acquire vault-write.lock". That throw is the
		// disposable-cache catch's concern — it must NOT fail the compile.
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false });
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd: a non-Error thrown from the guarded search-index warm-up is stringified, still non-fatal", async () => {
		// The search-index warm-up is wrapped in a disposable-cache catch that
		// stringifies a non-Error throw (`String(idxErr)`). A throw from the guard
		// body propagates as-is, so a non-Error value exercises that branch.
		vi.mocked(withVaultWriteLock).mockImplementationOnce(async () => {
			throw "orama exploded (string, not Error)";
		});
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd --rebuild: store reset can't acquire the lock → clean 'busy' exit (exitCode=1), drain skipped, no uncaught throw", async () => {
		// On --rebuild the FIRST writeGuard call is the store reset (processed-set +
		// index). A busy lock makes withVaultWriteLock report ran:false, so the guard
		// throws VaultWriteBusyError. The reset is a real prerequisite — without it
		// the drain runs against the OLD index and is silently NOT a rebuild — so this
		// must surface as a clean retry-later exit, not an uncaught stack trace.
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false });
		const { stderr } = await runCompile(["--cwd", "/repo", "--rebuild"]);
		expect(stderr).toMatch(/busy/i);
		expect(process.exitCode).toBe(1);
		expect(mockDrainIngest).not.toHaveBeenCalled();
	});

	it("--cwd --rebuild: a non-lock error during store reset surfaces distinctly (not swallowed as 'busy')", async () => {
		// A real write failure (disk, corruption) is NOT a VaultWriteBusyError, so the
		// busy-exit catch must NOT masquerade it as lock contention. The library API
		// (compileSingleRepo) turns this into a structured `internal` failure; the CLI
		// wrapper renders it to stderr with `kind=internal` and exits 1. The old
		// behaviour was a raw rethrow — the shape changed with the library refactor
		// but the semantic (error surfaces distinctly, drain does NOT run) is preserved.
		mockSaveTopicIndex.mockRejectedValueOnce(new Error("disk full"));
		const { stderr } = await runCompile(["--cwd", "/repo", "--rebuild"]);
		expect(stderr).toContain("disk full");
		expect(stderr).toMatch(/kind=internal/);
		expect(stderr).not.toMatch(/busy/i);
		expect(process.exitCode).toBe(1);
		expect(mockDrainIngest).not.toHaveBeenCalled();
	});

	it("--cwd: render lock contention is non-fatal — the ingest already persisted, command still reports Done", async () => {
		// drainIngest swallows its own lock contention (sources held / pending), so by
		// the time the derived Markdown re-render runs the data is already on the orphan
		// branch. A busy lock on render must NOT fail the whole command (matches the
		// QueueWorker unlocked-ingest catch + the search-index disposable-cache catch).
		mockRenderTopicKBWiki.mockImplementationOnce(
			async (_cwd: string, _storage: unknown, guard?: (fn: () => Promise<void>) => Promise<void>) => {
				await guard?.(async () => {});
			},
		);
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false }); // render's per-write guard
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd --rebuild: a purge that can't acquire the lock is non-fatal — orphan pages are reclaimed on the next rebuild", async () => {
		// On --rebuild the guard call order is reset → (drain, no guard) → purge →
		// (render, no guard) → search-index. Make only the purge call busy.
		vi.mocked(withVaultWriteLock)
			.mockResolvedValueOnce({ ran: true, value: undefined }) // store reset
			.mockResolvedValueOnce({ ran: false }); // purge
		const { stdout } = await runCompile(["--cwd", "/repo", "--rebuild"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd --rebuild: a non-Error thrown from the purge is stringified, still non-fatal", async () => {
		// The purge is wrapped in a non-fatal catch that stringifies a non-Error
		// throw (`String(purgeErr)`). A non-Error rejection from the purge body
		// exercises that arm — the derived layer lags but the command completes.
		vi.mocked(purgeTopicPagesExcept).mockRejectedValueOnce("purge exploded (string, not Error)" as never);
		const { stdout } = await runCompile(["--cwd", "/repo", "--rebuild"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd: a non-Error thrown from the wiki re-render is stringified, still non-fatal", async () => {
		// The wiki re-render's non-fatal catch stringifies a non-Error throw
		// (`String(renderErr)`); a thrown string exercises that arm.
		mockRenderTopicKBWiki.mockImplementationOnce(async () => {
			throw "render exploded (string, not Error)";
		});
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd: a knowledge-graph build failure (Error) is non-fatal — compile still reports Done", async () => {
		// The graph is a derived artifact regenerated on the next compile, so a
		// build failure (or missing LLM key) must never fail the compile.
		vi.mocked(buildKnowledgeGraph).mockRejectedValueOnce(new Error("graph boom"));
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd: a non-Error thrown from the knowledge-graph build is stringified, still non-fatal", async () => {
		vi.mocked(buildKnowledgeGraph).mockRejectedValueOnce("graph exploded (string, not Error)" as never);
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("Done:");
		expect(process.exitCode).not.toBe(1);
	});

	it("--cwd --rebuild resets stores before drain", async () => {
		const callOrder: string[] = [];
		mockSaveProcessedSet.mockImplementation(async () => {
			callOrder.push("saveProcessedSet");
		});
		mockSaveTopicIndex.mockImplementation(async () => {
			callOrder.push("saveTopicIndex");
		});
		mockDrainIngest.mockImplementation(async () => {
			callOrder.push("drainIngest");
			return { batches: 0, ingested: 0, outcome: "OK", topicFailures: [] };
		});

		const { stdout } = await runCompile(["--cwd", "/repo", "--rebuild"]);

		expect(callOrder.indexOf("saveProcessedSet")).toBeLessThan(callOrder.indexOf("drainIngest"));
		expect(callOrder.indexOf("saveTopicIndex")).toBeLessThan(callOrder.indexOf("drainIngest"));
		expect(stdout).toContain("Rebuilding");
	});

	it("--rebuild without --cwd: error + exitCode=1", async () => {
		const { stderr } = await runCompile(["--rebuild"]);
		expect(stderr).toContain("--rebuild requires --cwd");
		expect(process.exitCode).toBe(1);
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
		expect(mockDrainIngest).not.toHaveBeenCalled();
	});

	it("missing API key (sweep): error + exitCode=1, skips compile", async () => {
		mockLoadConfig.mockResolvedValue({} as never);
		const prevEnv = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { stderr } = await runCompile([]);
			expect(stderr).toContain("No API key configured");
		} finally {
			if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
		}
		expect(process.exitCode).toBe(1);
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
	});

	it("missing API key (--cwd): error + exitCode=1, skips drain, no progress line printed first", async () => {
		mockLoadConfig.mockResolvedValue({} as never);
		const prevEnv = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { stdout, stderr } = await runCompile(["--cwd", "/repo"]);
			expect(stderr).toContain("No API key configured");
			// The cosmetic "Ingesting…/Rebuilding…" progress line must NOT precede the
			// no-credential error — the credential check now runs before it prints.
			expect(stdout).not.toContain("Ingesting");
			expect(stdout).not.toContain("Rebuilding");
		} finally {
			if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
		}
		expect(process.exitCode).toBe(1);
		expect(mockDrainIngest).not.toHaveBeenCalled();
		expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith("/repo", "manual");
	});

	it("local-agent (sweep): does not skip compile even with no stored key", async () => {
		mockLoadConfig.mockResolvedValue({ aiProvider: "local-agent", localFolder: "/mb" } as never);
		const prevEnv = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { stderr } = await runCompile([]);
			expect(stderr).toBe("");
		} finally {
			if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
		}
		expect(process.exitCode).not.toBe(1);
		expect(mockCompileAllRepos).toHaveBeenCalledOnce();
	});

	it("local-agent (--cwd): does not skip drain even with no stored key", async () => {
		mockLoadConfig.mockResolvedValue({ aiProvider: "local-agent" } as never);
		const prevEnv = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { stderr } = await runCompile(["--cwd", "/repo"]);
			expect(stderr).toBe("");
		} finally {
			if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
		}
		expect(mockDrainIngest).toHaveBeenCalledOnce();
		expect(vi.mocked(appendCredentialMissingRun)).not.toHaveBeenCalled();
	});

	it("--cwd --rebuild: purges to the index's stable slugs (purge runs ONLY on rebuild)", async () => {
		// Purge is gated to --rebuild: a routine compile must not purge (a concurrent
		// ingest could have added a page not yet in our index snapshot — deleting it
		// would be data loss). The slug-mapping callback only runs on a non-empty index.
		vi.mocked(readTopicIndex).mockResolvedValueOnce({
			schemaVersion: 1,
			topics: [{ stableSlug: "auth-flow" }, { stableSlug: "storage-layer" }],
		} as never);
		await runCompile(["--cwd", "/repo", "--rebuild"]);
		expect(vi.mocked(purgeTopicPagesExcept)).toHaveBeenCalledWith(
			["auth-flow", "storage-layer"],
			"/repo",
			expect.anything(),
		);
	});

	it("--cwd (no rebuild): does NOT purge (avoids deleting a page a concurrent ingest just added)", async () => {
		vi.mocked(readTopicIndex).mockResolvedValueOnce({
			schemaVersion: 1,
			topics: [{ stableSlug: "auth-flow" }],
		} as never);
		await runCompile(["--cwd", "/repo"]);
		expect(vi.mocked(purgeTopicPagesExcept)).not.toHaveBeenCalled();
	});

	it("--cwd: prints the outcome code and held topics in the summary", async () => {
		mockDrainIngest.mockResolvedValue({
			batches: 1,
			ingested: 2,
			outcome: "OK",
			topicFailures: [{ slug: "held", code: "RECONCILE_TRUNCATED" }],
		});
		const { stdout } = await runCompile(["--cwd", "/repo"]);
		expect(stdout).toContain("[OK]");
		expect(stdout).toContain("held (RECONCILE_TRUNCATED)");
		expect(mockDrainIngest).toHaveBeenCalledWith(
			"/repo",
			expect.anything(),
			expect.objectContaining({ triggeredBy: "manual" }),
		);
	});
});
