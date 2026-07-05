import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock StorageFactory so `createStorage` is hermetic (no real git/config I/O),
// mirroring SearchCommand.test.ts's fake-storage pattern.
const fakeStorage = { __fake: "storage" } as unknown as import("../core/StorageProvider.js").StorageProvider;
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn(async () => fakeStorage),
}));

// Mock the orchestrator's pushBranchToJolli — `push`'s only dependency, tested
// independently in JolliMemoryPushOrchestrator.test.ts. `resolveSpaceId` is
// `bind`'s dependency too; keep the real (pure, synchronous-ish) implementation
// so numeric/slug resolution is exercised for real rather than re-stubbed here.
vi.mock("../core/JolliMemoryPushOrchestrator.js", async () => {
	const actual = await vi.importActual<typeof import("../core/JolliMemoryPushOrchestrator.js")>(
		"../core/JolliMemoryPushOrchestrator.js",
	);
	return {
		...actual,
		pushBranchToJolli: vi.fn(),
	};
});

// Mock JolliMemoryPushClient (used directly by `spaces`/`bind`) while keeping
// the real error classes so `instanceof BindingAlreadyExistsError` still works.
vi.mock("../core/JolliMemoryPushClient.js", async () => {
	const actual = await vi.importActual<typeof import("../core/JolliMemoryPushClient.js")>(
		"../core/JolliMemoryPushClient.js",
	);
	return {
		...actual,
		JolliMemoryPushClient: vi.fn(),
	};
});

vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn(async () => "https://github.com/acme/widgets"),
	deriveRepoNameFromUrl: vi.fn(() => "widgets"),
}));

import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import { BindingAlreadyExistsError, JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { pushBranchToJolli } from "../core/JolliMemoryPushOrchestrator.js";
import { registerBindCommand, registerPushCommand, registerSpacesCommand } from "./JolliCloudCommands.js";

const mockPushBranchToJolli = vi.mocked(pushBranchToJolli);
const MockClient = vi.mocked(JolliMemoryPushClient);
const mockGetCanonicalRepoUrl = vi.mocked(getCanonicalRepoUrl);
const mockDeriveRepoNameFromUrl = vi.mocked(deriveRepoNameFromUrl);

const SAMPLE_SPACES = [
	{ id: 1, name: "Acme", slug: "acme" },
	{ id: 2, name: "Widgets", slug: "widgets" },
];

function makeClientStub(overrides: Partial<JolliMemoryPushClient> = {}): JolliMemoryPushClient {
	return {
		listSpaces: vi.fn(async () => ({ spaces: SAMPLE_SPACES, defaultSpaceId: 1 })),
		createBinding: vi.fn(async () => ({ bindingId: 9, jmSpaceId: 1, repoName: "widgets" })),
		...overrides,
	} as unknown as JolliMemoryPushClient;
}

/**
 * `new JolliMemoryPushClient()` requires the mock implementation to be a real
 * constructible function — an arrow function throws "is not a constructor"
 * when invoked with `new`. `mockImplementation(function () {...})` sidesteps
 * that; this helper keeps call sites reading like a plain stub swap.
 */
function setClientStub(stub: JolliMemoryPushClient): void {
	MockClient.mockImplementation(function (this: unknown) {
		return stub;
	} as unknown as typeof JolliMemoryPushClient);
}

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerPushCommand(program);
	registerSpacesCommand(program);
	registerBindCommand(program);
	return program;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

describe("jolli push / spaces / bind commands", () => {
	beforeEach(() => {
		mockPushBranchToJolli.mockReset();
		MockClient.mockReset();
		setClientStub(makeClientStub());
		mockGetCanonicalRepoUrl.mockClear();
		mockDeriveRepoNameFromUrl.mockClear();
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = 0;
	});

	describe("push", () => {
		it("--format json prints the pushed result verbatim", async () => {
			mockPushBranchToJolli.mockResolvedValue({
				type: "pushed",
				pushed: 2,
				skipped: 1,
				urls: ["https://jolli.ai/articles?doc=1", "https://jolli.ai/articles?doc=2"],
			});
			const { stdout } = await runCommand(["push", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({
				type: "pushed",
				pushed: 2,
				skipped: 1,
				urls: ["https://jolli.ai/articles?doc=1", "https://jolli.ai/articles?doc=2"],
			});
			expect(mockPushBranchToJolli).toHaveBeenCalledWith({
				cwd: "/tmp/x",
				baseBranch: undefined,
				space: undefined,
			});
		});

		it("passes --base and --space through to pushBranchToJolli", async () => {
			mockPushBranchToJolli.mockResolvedValue({ type: "pushed", pushed: 0, skipped: 0, urls: [] });
			await runCommand(["push", "--base", "develop", "--space", "acme", "--format", "json", "--cwd", "/tmp/x"]);
			expect(mockPushBranchToJolli).toHaveBeenCalledWith({
				cwd: "/tmp/x",
				baseBranch: "develop",
				space: "acme",
			});
		});

		it("default output summarizes a pushed result and lists urls", async () => {
			mockPushBranchToJolli.mockResolvedValue({
				type: "pushed",
				pushed: 2,
				skipped: 1,
				urls: ["https://jolli.ai/articles?doc=1"],
			});
			const { stdout } = await runCommand(["push", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("Pushed 2 memories");
			expect(stdout).toContain("1 skipped");
			expect(stdout).toContain("https://jolli.ai/articles?doc=1");
		});

		it("binding_required prints the space list as JSON passthrough", async () => {
			mockPushBranchToJolli.mockResolvedValue({
				type: "binding_required",
				repoUrl: "https://github.com/acme/widgets",
				spaces: SAMPLE_SPACES,
				defaultSpaceId: 1,
			});
			const { stdout } = await runCommand(["push", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({
				type: "binding_required",
				repoUrl: "https://github.com/acme/widgets",
				spaces: SAMPLE_SPACES,
				defaultSpaceId: 1,
			});
		});

		it("binding_required default output lists spaces and tells the user to retry with --space", async () => {
			mockPushBranchToJolli.mockResolvedValue({
				type: "binding_required",
				repoUrl: "https://github.com/acme/widgets",
				spaces: SAMPLE_SPACES,
				defaultSpaceId: 2,
			});
			const { stdout } = await runCommand(["push", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("https://github.com/acme/widgets");
			expect(stdout).toContain("Acme");
			expect(stdout).toContain("Widgets");
			expect(stdout).toContain("(default)");
			expect(stdout).toContain("--space <id|slug>");
		});

		it("error result sets exitCode=1 and emits JSON", async () => {
			mockPushBranchToJolli.mockResolvedValue({ type: "error", message: "Not signed in to Jolli." });
			const { stdout } = await runCommand(["push", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "Not signed in to Jolli." });
			expect(process.exitCode).toBe(1);
		});

		it("error result renders to stderr in text mode", async () => {
			mockPushBranchToJolli.mockResolvedValue({ type: "error", message: "boom" });
			const { stderr } = await runCommand(["push", "--cwd", "/tmp/x"]);
			expect(stderr).toContain("boom");
			expect(process.exitCode).toBe(1);
		});

		it("a thrown error (e.g. from createStorage) is caught as {type:error} + exitCode 1", async () => {
			mockPushBranchToJolli.mockRejectedValue(new Error("disk exploded"));
			const { stdout } = await runCommand(["push", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "disk exploded" });
			expect(process.exitCode).toBe(1);
		});

		it("stringifies non-Error throwables", async () => {
			mockPushBranchToJolli.mockRejectedValue("plain string failure");
			const { stdout } = await runCommand(["push", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "plain string failure" });
			expect(process.exitCode).toBe(1);
		});
	});

	describe("spaces", () => {
		it("--format json prints {spaces, defaultSpaceId}", async () => {
			const { stdout } = await runCommand(["spaces", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ spaces: SAMPLE_SPACES, defaultSpaceId: 1 });
		});

		it("default output lists spaces with a default marker", async () => {
			const { stdout } = await runCommand(["spaces", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("Acme");
			expect(stdout).toContain("acme");
			expect(stdout).toContain("Widgets");
			expect(stdout).toContain("(default)");
		});

		it("empty space list prints a friendly message", async () => {
			setClientStub(makeClientStub({ listSpaces: vi.fn(async () => ({ spaces: [], defaultSpaceId: null })) }));
			const { stdout } = await runCommand(["spaces", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("No Jolli Spaces");
		});

		it("propagates listSpaces errors as {type:error} + exitCode 1", async () => {
			setClientStub(
				makeClientStub({
					listSpaces: vi.fn(async () => {
						throw new Error("Not signed in to Jolli.");
					}),
				}),
			);
			const { stdout } = await runCommand(["spaces", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "Not signed in to Jolli." });
			expect(process.exitCode).toBe(1);
		});

		it("propagates listSpaces errors to stderr in text mode", async () => {
			setClientStub(
				makeClientStub({
					listSpaces: vi.fn(async () => {
						throw new Error("Not signed in to Jolli.");
					}),
				}),
			);
			const { stderr } = await runCommand(["spaces", "--cwd", "/tmp/x"]);
			expect(stderr).toContain("Not signed in to Jolli.");
			expect(process.exitCode).toBe(1);
		});

		it("stringifies non-Error throwables from listSpaces", async () => {
			setClientStub(
				makeClientStub({
					listSpaces: vi.fn(async () => {
						throw "plain string failure";
					}),
				}),
			);
			const { stdout } = await runCommand(["spaces", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "plain string failure" });
			expect(process.exitCode).toBe(1);
		});
	});

	describe("bind", () => {
		it("resolves a numeric --space id (no name/slug match) and binds", async () => {
			const createBinding = vi.fn(async () => ({ bindingId: 9, jmSpaceId: 2, repoName: "widgets" }));
			const listSpaces = vi.fn(async () => ({ spaces: SAMPLE_SPACES, defaultSpaceId: 1 }));
			setClientStub(makeClientStub({ createBinding, listSpaces }));

			const { stdout } = await runCommand(["bind", "--space", "2", "--format", "json", "--cwd", "/tmp/x"]);

			// resolveSpaceId now lists spaces first (to let a digit-named Space win by
			// name); "2" matches no name/slug in SAMPLE_SPACES so it falls back to id 2.
			expect(listSpaces).toHaveBeenCalled();
			expect(createBinding).toHaveBeenCalledWith({
				repoUrl: "https://github.com/acme/widgets",
				repoName: "widgets",
				jmSpaceId: 2,
			});
			expect(JSON.parse(stdout.trim())).toMatchObject({ type: "bound", jmSpaceId: 2, repoName: "widgets" });
		});

		it("resolves a slug --space by listing spaces first", async () => {
			const createBinding = vi.fn(async () => ({ bindingId: 9, jmSpaceId: 1, repoName: "acme" }));
			setClientStub(makeClientStub({ createBinding }));

			await runCommand(["bind", "--space", "acme", "--format", "json", "--cwd", "/tmp/x"]);

			expect(createBinding).toHaveBeenCalledWith({
				repoUrl: "https://github.com/acme/widgets",
				repoName: "widgets",
				jmSpaceId: 1,
			});
		});

		it("--repo-name overrides the derived repo name", async () => {
			const createBinding = vi.fn(async () => ({ bindingId: 9, jmSpaceId: 1, repoName: "custom" }));
			setClientStub(makeClientStub({ createBinding }));

			await runCommand(["bind", "--space", "1", "--repo-name", "custom", "--format", "json", "--cwd", "/tmp/x"]);

			expect(createBinding).toHaveBeenCalledWith({
				repoUrl: "https://github.com/acme/widgets",
				repoName: "custom",
				jmSpaceId: 1,
			});
			expect(mockDeriveRepoNameFromUrl).not.toHaveBeenCalled();
		});

		it("an unmatched slug/name surfaces as an error", async () => {
			const { stdout } = await runCommand(["bind", "--space", "nope", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toMatchObject({
				type: "error",
				message: expect.stringContaining("nope"),
			});
			expect(process.exitCode).toBe(1);
		});

		it("default output confirms the binding", async () => {
			const { stdout } = await runCommand(["bind", "--space", "1", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("Bound");
			expect(stdout).toContain("https://github.com/acme/widgets");
		});

		it("BindingAlreadyExistsError is handled as a friendly message, not a crash", async () => {
			const createBinding = vi.fn(async () => {
				throw new BindingAlreadyExistsError("binding_already_exists");
			});
			setClientStub(makeClientStub({ createBinding }));

			const { stdout } = await runCommand(["bind", "--space", "1", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toMatchObject({ type: "already_bound" });
			expect(process.exitCode).toBe(0);
		});

		it("BindingAlreadyExistsError in text mode prints a friendly message", async () => {
			const createBinding = vi.fn(async () => {
				throw new BindingAlreadyExistsError("binding_already_exists");
			});
			setClientStub(makeClientStub({ createBinding }));

			const { stdout } = await runCommand(["bind", "--space", "1", "--cwd", "/tmp/x"]);
			expect(stdout).toContain("already bound");
			expect(process.exitCode).toBe(0);
		});

		it("other createBinding errors are surfaced as {type:error} + exitCode 1", async () => {
			const createBinding = vi.fn(async () => {
				throw new Error("HTTP 500");
			});
			setClientStub(makeClientStub({ createBinding }));

			const { stdout } = await runCommand(["bind", "--space", "1", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "HTTP 500" });
			expect(process.exitCode).toBe(1);
		});

		it("stringifies non-Error throwables from createBinding", async () => {
			const createBinding = vi.fn(async () => {
				throw "plain string failure";
			});
			setClientStub(makeClientStub({ createBinding }));

			const { stdout } = await runCommand(["bind", "--space", "1", "--format", "json", "--cwd", "/tmp/x"]);
			expect(JSON.parse(stdout.trim())).toEqual({ type: "error", message: "plain string failure" });
			expect(process.exitCode).toBe(1);
		});
	});
});
