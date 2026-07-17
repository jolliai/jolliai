/**
 * Tests for the compileNow command registration (multi-repo sweep).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	registerCommand,
	showInformationMessage,
	showErrorMessage,
	withProgress,
	registeredHandlers,
	ProgressLocation,
} = vi.hoisted(() => {
	const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
	return {
		registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
			registeredHandlers.set(id, handler);
			return { dispose: vi.fn() };
		}),
		showInformationMessage: vi.fn(async () => undefined),
		showErrorMessage: vi.fn(async () => undefined),
		withProgress: vi.fn(async (_opts: unknown, task: (progress: { report: (v: unknown) => void }) => Promise<unknown>) =>
			task({ report: vi.fn() }),
		),
		registeredHandlers,
		ProgressLocation: { Notification: 15 },
	};
});

vi.mock("vscode", () => ({
	commands: { registerCommand },
	window: {
		showInformationMessage,
		showErrorMessage,
		withProgress,
		createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
	},
	ProgressLocation,
}));

// ─── CLI module mocks (dynamic imports) ──────────────────────────────────────

const mockLoadConfig = vi.fn();
const mockCompileAllRepos = vi.fn();

vi.mock("../../cli/src/core/SessionTracker.js", () => ({
	loadConfig: mockLoadConfig,
}));
vi.mock("../../cli/src/core/MultiRepoCompile.js", () => ({
	compileAllRepos: mockCompileAllRepos,
}));

import { registerCompileCommand } from "./CompileCommand.js";

function makeOpts() {
	return { sidebarProvider: { refreshKnowledgeBaseFolders: vi.fn() } };
}

beforeEach(() => {
	vi.clearAllMocks();
	registeredHandlers.clear();
	mockCompileAllRepos.mockResolvedValue({
		repos: [{ folder: "jolli", ingested: 2, batches: 1 }],
		totalIngested: 2,
		failed: 0,
	});
	delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerCompileCommand", () => {
	it("registers jollimemory.compileNow command", () => {
		registerCompileCommand(makeOpts());
		const ids = registerCommand.mock.calls.map((c) => c[0]);
		expect(ids).toContain("jollimemory.compileNow");
	});

	it("shows info and skips compile when no usable provider", async () => {
		mockLoadConfig.mockResolvedValue({ localFolder: "/mb" });
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("AI provider"));
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
	});

	it("compiles when the Local Agent provider is selected without any API key", async () => {
		// Local Agent generates through the agent tool's own login — a key-only gate
		// would wrongly block it. resolveLlmCredentialSource honors the choice.
		mockLoadConfig.mockResolvedValue({ aiProvider: "local-agent", localFolder: "/mb" });
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(mockCompileAllRepos).toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("AI provider"));
	});

	it("shows info and skips compile when no localFolder", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Memory Bank folder"));
		expect(mockCompileAllRepos).not.toHaveBeenCalled();
	});

	it("sweeps all repos and refreshes panel when API key + localFolder present", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		const opts = makeOpts();
		registerCompileCommand(opts);

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(mockCompileAllRepos).toHaveBeenCalledWith(
			"/mb",
			expect.objectContaining({ localFolder: "/mb" }),
			expect.objectContaining({ onProgress: expect.any(Function) }),
		);
		expect(opts.sidebarProvider.refreshKnowledgeBaseFolders).toHaveBeenCalled();
	});

	it("shows success toast with total + repo count", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		mockCompileAllRepos.mockResolvedValue({
			repos: [
				{ folder: "jolli", ingested: 3, batches: 1 },
				{ folder: "jolliai", ingested: 2, batches: 1 },
			],
			totalIngested: 5,
			failed: 0,
		});
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("5 source(s) across 2 repo(s)"));
	});

	it("surfaces failed count in the success toast", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		mockCompileAllRepos.mockResolvedValue({
			repos: [{ folder: "jolli", ingested: 3, batches: 1 }],
			totalIngested: 3,
			failed: 1,
		});
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
	});

	it("shows error toast and still refreshes on failure", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		mockCompileAllRepos.mockRejectedValue(new Error("network error"));
		const opts = makeOpts();
		registerCompileCommand(opts);

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("network error"));
		expect(opts.sidebarProvider.refreshKnowledgeBaseFolders).toHaveBeenCalled();
	});

	it("stringifies a non-Error rejection in the error toast", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		mockCompileAllRepos.mockRejectedValue("boom");
		const opts = makeOpts();
		registerCompileCommand(opts);

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("boom"));
		expect(opts.sidebarProvider.refreshKnowledgeBaseFolders).toHaveBeenCalled();
	});

	it("ignores a concurrent invocation while a compile is already in flight", async () => {
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		let release: () => void = () => {};
		mockCompileAllRepos.mockReturnValue(
			new Promise((resolve) => {
				release = () => resolve({ repos: [], totalIngested: 0, failed: 0 });
			}),
		);
		registerCompileCommand(makeOpts());
		const handler = registeredHandlers.get("jollimemory.compileNow");
		if (!handler) throw new Error("handler not registered");

		const first = handler(); // starts the sweep, parks on the deferred promise
		await new Promise((r) => setTimeout(r, 0)); // flush first call up to the in-flight point
		await handler(); // second invocation while the first is still running

		expect(mockCompileAllRepos).toHaveBeenCalledTimes(1);
		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("already"));

		release();
		await first;
	});

	it("forwards compile progress to the VS Code progress reporter", async () => {
		// The `onProgress` callback handed to compileAllRepos pipes each message
		// into the withProgress reporter. Drive the mock so it emits a progress
		// message and assert it reaches `progress.report`.
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test", localFolder: "/mb" });
		const reportSpy = vi.fn();
		withProgress.mockImplementationOnce(
			async (_opts: unknown, task: (progress: { report: (v: unknown) => void }) => Promise<unknown>) =>
				task({ report: reportSpy }),
		);
		mockCompileAllRepos.mockImplementationOnce(
			async (_folder: string, _config: unknown, options: { onProgress: (m: string) => void }) => {
				options.onProgress("Compiling jolli…");
				return { repos: [{ folder: "jolli", ingested: 1, batches: 1 }], totalIngested: 1, failed: 0 };
			},
		);
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(reportSpy).toHaveBeenCalledWith({ message: "Compiling jolli…" });
	});

	it("accepts ANTHROPIC_API_KEY env var as a key source", async () => {
		process.env.ANTHROPIC_API_KEY = "env-key";
		mockLoadConfig.mockResolvedValue({ localFolder: "/mb" });
		registerCompileCommand(makeOpts());

		await registeredHandlers.get("jollimemory.compileNow")?.();

		expect(mockCompileAllRepos).toHaveBeenCalled();
		delete process.env.ANTHROPIC_API_KEY;
	});
});
