import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

/**
 * Mock strategy for execFile:
 *
 * The source calls `promisify(execFile)` to get `execFileAsync`.
 * We mock `node:util` so that `promisify` returns our `mockExecFileAsync`
 * function directly — this is the same pattern used in GitOps.test.ts.
 */
const { mockExecFileAsync } = vi.hoisted(() => ({
	mockExecFileAsync: vi.fn(),
}));

const { randomBytesMock } = vi.hoisted(() => ({
	randomBytesMock: vi.fn(),
}));

const { writeFileMock, unlinkMock } = vi.hoisted(() => ({
	writeFileMock: vi.fn(),
	unlinkMock: vi.fn(),
}));

const { tmpdirMock } = vi.hoisted(() => ({
	tmpdirMock: vi.fn(),
}));

const {
	debug,
	info,
	warn,
	error: logError,
} = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

const {
	showInformationMessage,
	showWarningMessage,
	showErrorMessage,
	openExternal,
	uriParse,
} = vi.hoisted(() => ({
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	openExternal: vi.fn(),
	uriParse: vi.fn((s: string) => s),
}));

// ─── vi.mock declarations ───────────────────────────────────────────────────

vi.mock("vscode", () => ({
	window: {
		showInformationMessage,
		showWarningMessage,
		showErrorMessage,
	},
	env: {
		openExternal,
	},
	Uri: {
		parse: uriParse,
	},
}));

vi.mock("node:util", () => ({
	promisify: vi.fn(() => mockExecFileAsync),
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:crypto", () => ({
	randomBytes: randomBytesMock,
}));

vi.mock("node:fs/promises", () => ({
	writeFile: writeFileMock,
	unlink: unlinkMock,
}));

vi.mock("node:os", () => ({
	tmpdir: tmpdirMock,
}));

vi.mock("../util/Logger.js", () => ({
	log: { debug, info, warn, error: logError },
}));

// ─── Import under test ──────────────────────────────────────────────────────

import {
	buildPrMessageScript,
	buildPrSectionCss,
	buildPrSectionHtml,
	buildPrSectionScript,
	handleCheckPrStatus,
	handleCreatePr,
	handlePrepareUpdatePr,
	handleUpdatePr,
} from "./PrCommentService.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sets up mockExecFileAsync to route calls based on command + args.
 * The handler should return `{ stdout: "..." }` or throw to simulate failure.
 */
/** Builds a command router from a key→handler map. Key format: "cmd:arg0[:arg1]". */
function buildRouter(
	routes: Record<string, () => { stdout: string }>,
): (cmd: string, args: Array<string>) => { stdout: string } {
	return (cmd, args) => {
		const key2 = `${cmd}:${args[0]}:${args[1]}`;
		const key1 = `${cmd}:${args[0]}`;
		const handler = routes[key2] ?? routes[key1];
		return handler ? handler() : { stdout: "" };
	};
}

function setupExecFile(
	handler: (cmd: string, args: Array<string>) => { stdout: string },
) {
	mockExecFileAsync.mockImplementation((cmd: string, args: Array<string>) => {
		try {
			const result = handler(cmd, args);
			return Promise.resolve(result);
		} catch (err) {
			return Promise.reject(err);
		}
	});
}

function setupTmpFile() {
	tmpdirMock.mockReturnValue("/tmp");
	randomBytesMock.mockReturnValue({ toString: () => "a1b2c3d4e5f6" });
	writeFileMock.mockResolvedValue(undefined);
	unlinkMock.mockResolvedValue(undefined);
}

const CWD = "/fake/repo";
const MARKER_START = "<!-- jollimemory-summary-start -->";
const MARKER_END = "<!-- jollimemory-summary-end -->";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PrCommentService", () => {
	let postMessage: ReturnType<typeof vi.fn> &
		((msg: Record<string, unknown>) => void);

	beforeEach(() => {
		vi.clearAllMocks();
		postMessage = vi.fn() as typeof postMessage;
		setupTmpFile();
	});

	// ─── buildPrSectionHtml ─────────────────────────────────────────────────

	describe("buildPrSectionHtml", () => {
		it("includes the PR section structure with status text and form", () => {
			const html = buildPrSectionHtml();
			expect(html).toContain('id="prSection"');
			expect(html).toContain('id="prStatusText"');
			expect(html).toContain('id="prForm"');
			expect(html).toContain('id="prTitleInput"');
			expect(html).toContain('id="prBodyInput"');
			expect(html).toContain('id="prFormSubmit"');
			expect(html).toContain("Pull Request");
			expect(html).not.toContain("data-title");
			expect(html).not.toContain("data-body");
		});
	});

	// ─── buildPrSectionCss ──────────────────────────────────────────────────

	describe("buildPrSectionCss", () => {
		it("returns a non-empty CSS string", () => {
			const css = buildPrSectionCss();
			expect(css.length).toBeGreaterThan(0);
		});

		it("contains expected class names", () => {
			const css = buildPrSectionCss();
			expect(css).toContain(".pr-hidden");
			expect(css).toContain(".pr-form");
			expect(css).toContain(".pr-icon");
			expect(css).toContain(".pr-status-text");
			expect(css).toContain(".pr-link-row");
			expect(css).toContain(".pr-actions");
			expect(css).toContain(".pr-form-label");
			expect(css).toContain(".pr-form-input");
			expect(css).toContain(".pr-form-textarea");
			expect(css).toContain(".pr-form-actions");
		});
	});

	// ─── buildPrSectionScript ───────────────────────────────────────────────

	describe("buildPrSectionScript", () => {
		it("returns a non-empty JS string", () => {
			const js = buildPrSectionScript();
			expect(js.length).toBeGreaterThan(0);
		});

		it("contains expected element lookups and event handler code", () => {
			const js = buildPrSectionScript();
			expect(js).toContain("getElementById('prStatusText')");
			expect(js).toContain("getElementById('prForm')");
			expect(js).toContain("addEventListener('click'");
			expect(js).toContain("postMessage({ command: 'checkPrStatus' })");
			expect(js).toContain("postMessage({ command: 'createPr'");
			expect(js).toContain("postMessage({ command: 'updatePr'");
		});
	});

	// ─── buildPrMessageScript ───────────────────────────────────────────────

	describe("buildPrMessageScript", () => {
		it("returns JS string with PR status handler code", () => {
			const js = buildPrMessageScript();
			expect(js.length).toBeGreaterThan(0);
			expect(js).toContain("msg.command === 'prStatus'");
			expect(js).toContain("msg.command === 'prShowUpdateForm'");
			expect(js).toContain("msg.command === 'prCreating'");
			expect(js).toContain("msg.command === 'prCreateFailed'");
			expect(js).toContain("msg.command === 'prUpdating'");
			expect(js).toContain("msg.command === 'prUpdateFailed'");
		});
	});

	// ─── handleCheckPrStatus ────────────────────────────────────────────────

	describe("handleCheckPrStatus", () => {
		it("proceeds past the (now removed) commit-count gate regardless of multi-commit branches", async () => {
			// Multi-commit branches no longer trigger a "multipleCommits" status —
			// the gate was removed when multi-commit PRs became supported.
			// This test asserts the gate is gone: with `gh` available + a PR found,
			// status becomes 'ready' even though git history shows multiple commits.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/multi\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					const prData = {
						number: 42,
						url: "https://github.com/example/repo/pull/42",
						title: "Multi-commit PR",
						body: "",
					};
					return { stdout: JSON.stringify(prData) };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ status: "multipleCommits" }),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "ready",
				pr: {
					number: 42,
					url: "https://github.com/example/repo/pull/42",
					title: "Multi-commit PR",
				},
			});
		});

		it("posts notInstalled when gh binary is missing (ENOENT)", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
					err.code = "ENOENT";
					throw err;
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "notInstalled",
			});
		});

		it("posts notAuthenticated when gh auth status exits non-zero twice", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					// execFile sets numeric exit codes on the error object; production
					// `probeGh` uses `typeof code === "number"` to detect the
					// non-zero-exit case (despite the Node.js TS typing claiming
					// `code: string | undefined`). Cast through `unknown` so we can
					// simulate the runtime shape the production code actually checks.
					const err = new Error("not logged in") as unknown as {
						code: number;
					} & Error;
					err.code = 1;
					throw err;
				}
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const promise = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await promise;
			} finally {
				vi.useRealTimers();
			}

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "notAuthenticated",
			});
		});

		it("recovers when gh auth status fails once then succeeds", async () => {
			let authCalls = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/my-branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					authCalls++;
					if (authCalls === 1) {
						const err = new Error("credential manager locked") as unknown as {
							code: number;
						} & Error;
						err.code = 1;
						throw err;
					}
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					throw new Error("no PRs found");
				}
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const promise = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await promise;
			} finally {
				vi.useRealTimers();
			}

			// Retried and succeeded → treated as authenticated
			expect(authCalls).toBe(2);
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/my-branch",
			});
		});

		it("recovers when gh --version fails once (transient) then succeeds on retry", async () => {
			// Covers checkGhInstalled retry → r2.ok success path.
			let versionCalls = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "gh" && args[0] === "--version") {
					versionCalls++;
					if (versionCalls === 1) {
						const err = new Error("EACCES") as NodeJS.ErrnoException;
						err.code = "EACCES";
						throw err;
					}
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr") throw new Error("no PR");
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const p = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await p;
			} finally {
				vi.useRealTimers();
			}

			expect(versionCalls).toBe(2);
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/br",
			});
		});

		it("posts notInstalled when gh --version fails transiently then fails with ENOENT on retry", async () => {
			// Covers checkGhInstalled retry → r2.kind === "notFound" branch.
			let versionCalls = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "gh" && args[0] === "--version") {
					versionCalls++;
					const err = new Error(
						versionCalls === 1 ? "EACCES" : "ENOENT",
					) as NodeJS.ErrnoException;
					err.code = versionCalls === 1 ? "EACCES" : "ENOENT";
					throw err;
				}
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const p = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await p;
			} finally {
				vi.useRealTimers();
			}

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "notInstalled",
			});
		});

		it("posts unavailable when gh auth fails transiently twice (error status propagates)", async () => {
			// Covers checkGhAuthenticated retry with non-nonZero failure:
			// r2.kind !== "nonZero" → returns "error" → handleCheckPrStatus reaches the
			// `if (auth === "error")` branch → posts "unavailable".
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") {
					const err = new Error("spawn EACCES") as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const p = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await p;
			} finally {
				vi.useRealTimers();
			}

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
			});
		});

		it("posts unavailable when gh --version fails with a transient error twice", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					const err = new Error("spawn EACCES") as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				return { stdout: "" };
			});

			vi.useFakeTimers();
			try {
				const promise = handleCheckPrStatus(CWD, postMessage);
				await vi.runAllTimersAsync();
				await promise;
			} finally {
				vi.useRealTimers();
			}

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
			});
		});

		it("posts noPr with branch name when no PR found", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/my-branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					throw new Error("no PRs found");
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/my-branch",
			});
		});

		it("posts ready with PR info when PR is found", async () => {
			const prData = {
				number: 42,
				url: "https://github.com/org/repo/pull/42",
				title: "My PR",
				body: "desc",
			};

			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/my-branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					return { stdout: JSON.stringify(prData) };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "ready",
				pr: {
					number: 42,
					url: "https://github.com/org/repo/pull/42",
					title: "My PR",
				},
			});
		});

		it("posts noPr when gh pr view returns non-JSON output", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					// Return non-JSON string — triggers the catch in findPrForBranch (lines 129-130)
					return { stdout: "not valid json at all" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/branch",
			});
		});

		it("posts noPr when gh pr view returns valid JSON with number: 0 (falsy)", async () => {
			// Exercises the `parsed.number ? parsed : undefined` branch on line 127
			// where parsed.number is 0 (falsy), so findPrForBranch returns undefined.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh version 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "Logged in\n" };
				}
				if (cmd === "gh" && args[0] === "pr") {
					return {
						stdout: JSON.stringify({ number: 0, url: "", title: "", body: "" }),
					};
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/branch",
			});
		});

		it("posts unavailable when gh available but getCurrentBranch throws", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				// getCurrentBranch (git rev-parse) throws — triggers outer catch
				if (cmd === "git" && args[0] === "rev-parse") {
					throw new Error("git exploded");
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
			});
			expect(logError).toHaveBeenCalled();
		});

		it("coerces non-Error to string in outer catch (line 217)", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					// Throw a non-Error to exercise the String(err) branch on line 217
					throw "string error from git";
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
			});
			expect(logError).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("string error from git"),
			);
		});

		it("posts unavailable when all commands fail (gh not found path)", async () => {
			setupExecFile(() => {
				throw new Error("command not found");
			});

			await handleCheckPrStatus(CWD, postMessage);

			// getCommitCount catches → returns 0, isGhAvailable catches → returns false
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
			});
		});

		// ── branch parameter tests ────────────────────────────────────────────

		// ── debug.log observability (non-goal: UI folding stays the same) ─────

		/**
		 * Builds an execFile router stub where `gh pr view` (or a custom gh call)
		 * can be programmed. All the prereq probes (`git rev-list`, `git rev-parse`,
		 * `gh --version`, `gh auth status`) return success so the flow reaches
		 * `findPrForBranch`. `ghPrHandler` controls what `gh pr ...` does.
		 */
		function setupHappyProbesWithPrHandler(
			ghPrHandler: () => { stdout: string },
		): void {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "symbolic-ref")
					return { stdout: "origin/main\n" };
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr") return ghPrHandler();
				return { stdout: "" };
			});
		}

		/** Builds an Error with `code` and `stderr` attached, mimicking child_process execFile rejection shape. */
		function ghError(opts: {
			message: string;
			code?: string | number;
			stderr?: string;
		}): Error {
			const err = new Error(opts.message) as Error & {
				code?: string | number;
				stderr?: string;
			};
			if (opts.code !== undefined) err.code = opts.code;
			if (opts.stderr !== undefined) err.stderr = opts.stderr;
			return err;
		}

		it("does not emit warn/debug on the happy path (baseline)", async () => {
			setupHappyProbesWithPrHandler(() => ({
				stdout: JSON.stringify({
					number: 7,
					url: "https://pr/7",
					title: "t",
					body: "b",
				}),
			}));

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).not.toHaveBeenCalled();
			expect(debug).not.toHaveBeenCalled();
		});

		it("logs at debug when gh pr view stderr indicates 'no pull requests found'", async () => {
			setupHappyProbesWithPrHandler(() => {
				throw ghError({
					message: "gh: exit 1",
					code: 1,
					stderr: "no pull requests found for branch feature/br\n",
				});
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(debug).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("No PR for branch feature/br"),
			);
			expect(warn).not.toHaveBeenCalled();
			// UI folding unchanged — see plan non-goal
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
		});

		it("logs at warn when gh pr view fails with a non-expected stderr (e.g. auth/ratelimit)", async () => {
			setupHappyProbesWithPrHandler(() => {
				throw ghError({
					message: "gh: exit 1",
					code: 1,
					stderr: "authentication required: please run gh auth login\n",
				});
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringMatching(
					/gh pr view failed for branch feature\/br.*code=1.*stderr:.*authentication required/s,
				),
			);
			expect(debug).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
		});

		it("logs at warn with code=ENOENT when gh binary is missing for the pr view call", async () => {
			// Note: pre-check `gh --version` succeeds in this stub; we only fail
			// the `gh pr view` call, to exercise tryExecGh's ENOENT branch
			// specifically (rather than checkGhInstalled's).
			setupHappyProbesWithPrHandler(() => {
				throw ghError({ message: "spawn gh ENOENT", code: "ENOENT" });
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("code=ENOENT"),
			);
		});

		it("logs at warn with Raw length when gh pr view returns unparseable JSON", async () => {
			setupHappyProbesWithPrHandler(() => ({
				stdout: "not-json-{{{",
			}));

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringMatching(/unparseable JSON.*Raw length: \d+/s),
			);
			// UI folding unchanged
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
		});
	});

	// ─── handleCreatePr ─────────────────────────────────────────────────────

	describe("handleCreatePr", () => {
		it("creates the PR even when the summary's commit is no longer reachable (rebase-just-happened regression)", async () => {
			// Regression: pre-refactor, a non-reachable summary commit would block
			// PR creation. Branch-first model: ignore commit reachability — push
			// + create PR using the CURRENT branch.
			const prUrl = "https://github.com/org/repo/pull/77";
			setupExecFile(
				buildRouter({
					// Whatever ancestor probe might still happen elsewhere — irrelevant
					// to handleCreatePr now; left as a non-ancestor to prove we don't
					// gate on it.
					"git:merge-base": () => {
						throw new Error("not ancestor");
					},
					"git:push": () => ({ stdout: "" }),
					"gh:pr:create": () => ({ stdout: `${prUrl}\n` }),
					"git:rev-list": () => ({ stdout: "1\n" }),
					"git:rev-parse": () => ({ stdout: "feature/branch\n" }),
					"gh:--version": () => ({ stdout: "gh 2.40.0\n" }),
					"gh:auth": () => ({ stdout: "ok\n" }),
					"gh:pr:view": () => ({
						stdout: JSON.stringify({
							number: 77,
							url: prUrl,
							title: "Rebased PR",
							body: "",
						}),
					}),
				}),
			);
			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("Rebased PR", "PR body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).not.toHaveBeenCalledWith({
				command: "prCreateFailed",
			});
			expect(showWarningMessage).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot create a PR"),
			);
		});

		it("pushes branch, creates PR, refreshes status, and shows info message", async () => {
			const prUrl = "https://github.com/org/repo/pull/99";
			let gitPushCalled = false;
			let prCreateCalled = false;

			setupExecFile(
				buildRouter({
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
					"gh:pr:create": () => {
						prCreateCalled = true;
						return { stdout: `${prUrl}\n` };
					},
					"git:rev-list": () => ({ stdout: "1\n" }),
					"git:rev-parse": () => ({ stdout: "feature/branch\n" }),
					"gh:--version": () => ({ stdout: "gh 2.40.0\n" }),
					"gh:auth": () => ({ stdout: "ok\n" }),
					"gh:pr:view": () => ({
						stdout: JSON.stringify({
							number: 99,
							url: prUrl,
							title: "New PR",
							body: "",
						}),
					}),
				}),
			);

			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("New PR", "PR body", CWD, postMessage);

			expect(gitPushCalled).toBe(true);
			expect(prCreateCalled).toBe(true);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			// handleCheckPrStatus should post the ready status
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ command: "prStatus", status: "ready" }),
			);
			expect(showInformationMessage).toHaveBeenCalledWith(
				"Pull request created!",
				"Open PR",
			);
		});

		it("posts prCreateFailed and shows error on failure", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "push") {
					throw new Error("push denied");
				}
				return { stdout: "" };
			});

			await handleCreatePr("Title", "Body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("push denied"),
			);
			expect(logError).toHaveBeenCalled();
		});

		it("coerces non-Error thrown from createPr to string in error message", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "push") {
					throw "string-only rejection";
				}
				return { stdout: "" };
			});

			await handleCreatePr("Title", "Body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("string-only rejection"),
			);
		});

		it("opens external URL when user clicks 'Open PR'", async () => {
			const prUrl = "https://github.com/org/repo/pull/55";

			setupExecFile(
				buildRouter({
					"git:push": () => ({ stdout: "" }),
					"gh:pr:create": () => ({ stdout: `${prUrl}\n` }),
					"git:rev-list": () => ({ stdout: "1\n" }),
					"git:rev-parse": () => ({ stdout: "branch\n" }),
					"gh:--version": () => ({ stdout: "ok\n" }),
					"gh:auth": () => ({ stdout: "ok\n" }),
					"gh:pr:view": () => ({
						stdout: JSON.stringify({
							number: 55,
							url: prUrl,
							title: "T",
							body: "",
						}),
					}),
				}),
			);

			showInformationMessage.mockResolvedValue("Open PR");

			await handleCreatePr("T", "B", CWD, postMessage);

			// Wait for the .then() to resolve
			await vi.waitFor(() => {
				expect(openExternal).toHaveBeenCalled();
			});
			expect(uriParse).toHaveBeenCalledWith(prUrl);
		});
	});

	// ─── handlePrepareUpdatePr ──────────────────────────────────────────────

	describe("handlePrepareUpdatePr", () => {
		// Caller pre-builds the markdown. The function is purely PR-lookup +
		// marker-merge — single-summary vs aggregated rendering happens upstream
		// in SummaryWebviewPanel before the call.
		const MARKDOWN = "## Summary\nFixed a bug";

		it("posts prShowUpdateForm with merged body when PR exists", async () => {
			const existingBody = "Old description";
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({
							number: 10,
							url: "https://url",
							title: "PR Title",
							body: existingBody,
						}),
					};
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prShowUpdateForm",
				title: "PR Title",
				body: `Old description\n\n${MARKER_START}\n## Summary\nFixed a bug\n${MARKER_END}`,
			});
		});

		it("replaces existing markers in PR body", async () => {
			const existingBody = `Before\n${MARKER_START}\nold content\n${MARKER_END}\nAfter`;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({
							number: 10,
							url: "https://url",
							title: "T",
							body: existingBody,
						}),
					};
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			const call = postMessage.mock.calls[0][0];
			expect(call.body).toContain("Before\n");
			expect(call.body).toContain("\nAfter");
			expect(call.body).toContain("## Summary\nFixed a bug");
			// Old content should be replaced
			expect(call.body).not.toContain("old content");
		});

		it("shows warning when no PR is found", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				throw new Error("no PR");
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(showWarningMessage).toHaveBeenCalledWith(
				"No pull request found for branch feature/test-branch.",
			);
			expect(postMessage).not.toHaveBeenCalled();
		});

		it("shows error and logs when an unexpected error is thrown", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					throw new Error("git rev-parse exploded");
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("git rev-parse exploded"),
			);
			expect(logError).toHaveBeenCalled();
		});

		it("coerces non-Error thrown to string in error message", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					throw "plain string error";
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("plain string error"),
			);
			expect(logError).toHaveBeenCalled();
		});

		it("handles empty PR body by creating wrapped content without separator", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({
							number: 10,
							url: "https://url",
							title: "T",
							body: "",
						}),
					};
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			const call = postMessage.mock.calls[0][0];
			expect(call.body).toBe(
				`${MARKER_START}\n## Summary\nFixed a bug\n${MARKER_END}`,
			);
		});
	});

	// ─── handleUpdatePr ─────────────────────────────────────────────────────

	describe("handleUpdatePr", () => {
		function setupPrViewExecFile(pr: {
			number: number;
			url: string;
			title: string;
			body: string;
		}) {
			const ghEditCalls: Array<{ cmd: string; args: Array<string> }> = [];

			setupExecFile((cmd, args) => {
				// findPrForBranch
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return { stdout: JSON.stringify(pr) };
				}
				// execGh for pr edit (title change)
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					ghEditCalls.push({ cmd, args: [...args] });
					return { stdout: "" };
				}
				// handleCheckPrStatus calls
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				return { stdout: "" };
			});

			return ghEditCalls;
		}

		it("updates title AND body when title changed, then shows info", async () => {
			const pr = {
				number: 7,
				url: "https://pr/7",
				title: "Old Title",
				body: "old body",
			};
			const ghEditCalls = setupPrViewExecFile(pr);
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePr("New Title", "new body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			// Should have a title edit call and a body-file edit call
			const titleEdit = ghEditCalls.find((c) => c.args.includes("--title"));
			const bodyEdit = ghEditCalls.find((c) => c.args.includes("--body-file"));
			expect(titleEdit).toBeDefined();
			expect(titleEdit?.args).toContain("New Title");
			expect(bodyEdit).toBeDefined();
			expect(showInformationMessage).toHaveBeenCalledWith(
				"Updated PR #7",
				"Open PR",
			);
		});

		it("only updates body when title is the same", async () => {
			const pr = {
				number: 7,
				url: "https://pr/7",
				title: "Same Title",
				body: "old",
			};
			const ghEditCalls = setupPrViewExecFile(pr);
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePr("Same Title", "new body", CWD, postMessage);

			const titleEdit = ghEditCalls.find((c) => c.args.includes("--title"));
			const bodyEdit = ghEditCalls.find((c) => c.args.includes("--body-file"));
			expect(titleEdit).toBeUndefined();
			expect(bodyEdit).toBeDefined();
		});

		it("shows warning and posts prUpdateFailed when no PR found", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				throw new Error("no PR");
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showWarningMessage).toHaveBeenCalledWith(
				"No pull request found for branch branch.",
			);
		});

		it("posts prUpdateFailed and shows error on gh failure", async () => {
			// First call (findPrForBranch) succeeds, second call (editPrBody) fails
			let callCount = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({
							number: 5,
							url: "u",
							title: "T",
							body: "",
						}),
					};
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					callCount++;
					if (callCount >= 1) {
						throw new Error("permission denied");
					}
					return { stdout: "" };
				}
				return { stdout: "" };
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("permission denied"),
			);
			expect(logError).toHaveBeenCalled();
		});

		it("coerces non-Error thrown from updatePr to string in error message", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({
							number: 5,
							url: "u",
							title: "T",
							body: "",
						}),
					};
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					throw "raw string rejection";
				}
				return { stdout: "" };
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("raw string rejection"),
			);
		});

		it("succeeds even when temp file cleanup fails (removeTempFile catch)", async () => {
			const pr = { number: 7, url: "https://pr/7", title: "T", body: "" };
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
					return { stdout: JSON.stringify(pr) };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					return { stdout: "" };
				}
				if (cmd === "git" && args[0] === "rev-list") {
					return { stdout: "1\n" };
				}
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				return { stdout: "" };
			});

			// Make unlink reject to trigger the removeTempFile catch (line 149)
			unlinkMock.mockRejectedValue(new Error("ENOENT: file already deleted"));
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePr("T", "new body", CWD, postMessage);

			// Should still succeed despite unlink failure
			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			expect(showInformationMessage).toHaveBeenCalledWith(
				"Updated PR #7",
				"Open PR",
			);
		});

		it("opens external URL when user clicks 'Open PR' after update", async () => {
			const prUrl = "https://pr/7";
			const pr = { number: 7, url: prUrl, title: "T", body: "" };
			setupPrViewExecFile(pr);
			showInformationMessage.mockResolvedValue("Open PR");

			await handleUpdatePr("T", "new body", CWD, postMessage);

			await vi.waitFor(() => {
				expect(openExternal).toHaveBeenCalled();
			});
			expect(uriParse).toHaveBeenCalledWith(prUrl);
		});
	});
});
