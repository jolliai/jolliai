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
vi.mock("../sync/VaultWriteLock.js", () => ({
	DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
	// Default: lock free → run the body and surface its value.
	withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
		ran: true,
		value: await body(),
	})),
}));

import { drainIngest } from "../core/IngestPipeline.js";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { saveProcessedSet } from "../core/ProcessedSourceStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { readTopicIndex, saveTopicIndex } from "../core/TopicIndexStore.js";
import { purgeTopicPagesExcept } from "../core/TopicPageStore.js";
import { renderTopicKBWiki } from "../core/TopicWikiRenderer.js";
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

	it("sweep skipped (another compile running): prints skip note, no per-repo output", async () => {
		mockCompileAllRepos.mockResolvedValue({ repos: [], totalIngested: 0, failed: 0, skipped: true });
		const { stdout } = await runCompile([]);
		expect(stdout).toContain("Another compile is already running");
		expect(stdout).not.toContain("Done:");
		expect(process.exitCode).not.toBe(1);
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

	it("--cwd: runs the drain under the canonical vault-write lock (wait mode)", async () => {
		await runCompile(["--cwd", "/repo"]);
		expect(withVaultWriteLock).toHaveBeenCalledWith("/mb", { wait: 60_000 }, expect.any(Function));
	});

	it("--cwd: another vault writer busy → error, exitCode=1, no drain/render", async () => {
		// Lock held by a worker/sync → body never runs.
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false });
		const { stderr } = await runCompile(["--cwd", "/repo"]);
		expect(stderr).toContain("another vault writer");
		expect(process.exitCode).toBe(1);
		expect(mockDrainIngest).not.toHaveBeenCalled();
		expect(mockRenderTopicKBWiki).not.toHaveBeenCalled();
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

	it("missing API key (--cwd): error + exitCode=1, skips drain", async () => {
		mockLoadConfig.mockResolvedValue({} as never);
		const prevEnv = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { stderr } = await runCompile(["--cwd", "/repo"]);
			expect(stderr).toContain("No API key configured");
		} finally {
			if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
		}
		expect(process.exitCode).toBe(1);
		expect(mockDrainIngest).not.toHaveBeenCalled();
		expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith("/repo", "manual");
	});

	it("--cwd: passes the index's stable slugs to the topic-page purge", async () => {
		// The slug-mapping callback in the `purgeTopicPagesExcept(index.topics.map(...))`
		// call only executes when the index is non-empty. The default mock returns an
		// empty `topics` array, leaving that arrow uncovered; a populated index exercises
		// it and pins the convergence contract (keep exactly the indexed slugs).
		vi.mocked(readTopicIndex).mockResolvedValueOnce({
			schemaVersion: 1,
			topics: [{ stableSlug: "auth-flow" }, { stableSlug: "storage-layer" }],
		} as never);
		await runCompile(["--cwd", "/repo"]);
		expect(vi.mocked(purgeTopicPagesExcept)).toHaveBeenCalledWith(
			["auth-flow", "storage-layer"],
			"/repo",
			expect.anything(),
		);
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
		expect(mockDrainIngest).toHaveBeenCalledWith("/repo", expect.anything(), { triggeredBy: "manual" });
	});
});
