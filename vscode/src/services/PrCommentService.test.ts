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

const { randomBytesMock } = vi.hoisted(() => {
	// Seed a return value in the hoisted factory (not just in beforeEach): the
	// mocked `randomBytes` is called at MODULE-LOAD time by a transitive import
	// (SessionTracker's top-level PROCESS_NONCE = randomBytes(4).toString(...)),
	// which runs before any beforeEach. A bare vi.fn() returns undefined there
	// and crashes the whole suite on load.
	const fn = vi.fn();
	fn.mockReturnValue({ toString: () => "a1b2c3d4e5f6" });
	return { randomBytesMock: fn };
});

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
	findOpenPrForBranch,
	findPrWithHistoryForBranch,
	handleCheckPrStatus,
	handleCreatePr,
	handlePrepareUpdatePr,
	handleUpdatePr,
	handleUpdatePrWithPush,
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

/**
 * Builds a gh-shaped error where stderr is attached as a property — matches
 * how `tryExecGh` extracts stderr in production (`(err as { stderr? }).stderr`).
 * `setupExecFile`'s handler throws this to simulate a non-zero gh exit with
 * a stderr line that drives the noPr / lookupError discriminator.
 */
function ghError(opts: {
	message: string;
	stderr?: string;
	code?: string | number;
}): Error {
	const err = new Error(opts.message) as Error & {
		stderr?: string;
		code?: string | number;
	};
	if (opts.stderr !== undefined) err.stderr = opts.stderr;
	if (opts.code !== undefined) err.code = opts.code;
	return err;
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

		it("handles prCreateBlockedCrossBranch by resetting the Create PR / Submit button state", () => {
			// Pins the cross-branch-guard reset branch into the rendered JS.
			// Without this, a Biome auto-fix or dead-code sweep could silently
			// drop the handler, and the user's clicked "Loading..." button
			// would stay stuck forever when the panel-side guard fires.
			const js = buildPrMessageScript();
			expect(js).toContain("msg.command === 'prCreateBlockedCrossBranch'");
			// The reset clears both the section-level Create PR button and the
			// form-level Submit button so retry works after `checkout`.
			expect(js).toContain("createPrBtn");
			expect(js).toContain("prFormSubmit");
		});

		it("renders Edit PR only under the 'ready' branch, never under 'noPr' (merged-only branches must not show Edit PR)", () => {
			// PR description's core promise: a branch with only merged/closed
			// PRs flows into kind:noPr and the panel surfaces a Create PR
			// button, never Edit PR. The two branches are emitted as adjacent
			// `if` blocks in the same JS string, so a future refactor that
			// accidentally hoists editPrBtn into the noPr branch would silently
			// regress this guarantee. Slice the noPr block out and assert the
			// Edit PR identifier appears ONLY after that slice ends.
			const js = buildPrMessageScript();
			const noPrIdx = js.indexOf("s === 'noPr'");
			const readyIdx = js.indexOf("s === 'ready'");
			expect(noPrIdx).toBeGreaterThan(-1);
			expect(readyIdx).toBeGreaterThan(noPrIdx);
			const noPrBlock = js.slice(noPrIdx, readyIdx);
			expect(noPrBlock).not.toContain("editPrBtn");
			expect(noPrBlock).not.toContain("'Edit PR'");
			// And the Create PR button MUST be the one wired up in the noPr branch.
			expect(noPrBlock).toContain("createPrBtn");
			expect(noPrBlock).toContain("'Create PR'");
		});
	});

	// ─── PR history webview rendering: defense-in-depth assertions ──────────

	describe("renderPrHistory (webview JS string)", () => {
		it("guards history-link href with an https:// prefix check before assignment", () => {
			// The webview never trusts upstream gh output unconditionally: an
			// entry whose `url` is not an https:// string must be silently
			// dropped so a malformed/compromised gh response cannot smuggle a
			// `javascript:` or `data:` link into the panel. This pins the
			// guard's literal substring so a refactor that loosens it (e.g.
			// dropping the check, replacing with regex-less prefix match)
			// fails the test instead of regressing the safety net.
			const js = buildPrSectionScript();
			expect(js).toContain("h.url.indexOf('https://')");
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
					return { stdout: JSON.stringify([{ ...prData, state: "OPEN" }]) };
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
				history: [],
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
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
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
				history: [],
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
				if (cmd === "gh" && args[0] === "pr") {
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
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

			expect(versionCalls).toBe(2);
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/br",
				history: [],
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
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/my-branch",
				history: [],
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
					return { stdout: JSON.stringify([{ ...prData, state: "OPEN" }]) };
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
				history: [],
			});
		});

		it("posts unavailable with lookup-error reason when gh pr view returns non-JSON output", async () => {
			// I-1 contract change: pre-refactor, unparseable JSON was folded
			// into noPr, which then showed a Create PR button — a token-lapse
			// could trick users into creating duplicate PRs. Now the
			// lookupError lane surfaces a Retry button with the real reason.
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
					return { stdout: "not valid json at all" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "unavailable",
					reason: expect.stringContaining("Unparseable response from gh"),
				}),
			);
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr" }),
			);
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
						stdout: JSON.stringify([
							{ number: 0, url: "", title: "", body: "", state: "OPEN" },
						]),
					};
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/branch",
				history: [],
			});
		});

		it("posts unavailable with the real reason when gh is available but getCurrentBranch throws", async () => {
			// Regression: the outer catch sits above both gh probes and the
			// `getCurrentBranch` (git) call. Previously the UI always said
			// "Could not reach GitHub CLI (gh)" — misleading when the failure
			// was on the git side. The `reason` field lets the webview show
			// the true error message.
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
					throw new Error("git exploded");
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
				reason: "git exploded",
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
				reason: "string error from git",
			});
			expect(logError).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("string error from git"),
			);
		});

		it("posts unavailable with the underlying error reason when all commands fail", async () => {
			setupExecFile(() => {
				throw new Error("command not found");
			});

			await handleCheckPrStatus(CWD, postMessage);

			// `getCurrentBranch` is the first call in the handler — it throws
			// "command not found" and the outer catch surfaces that as the
			// reason, instead of the previous hard-coded "could not reach gh"
			// text (which misled users when git was the broken side).
			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "unavailable",
				reason: "command not found",
			});
		});

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

		// `ghError` is defined at module top — shared by tests inside and
		// outside this describe to keep gh-mock shape consistent.

		it("does not emit warn/debug on the happy path (baseline)", async () => {
			setupHappyProbesWithPrHandler(() => ({
				stdout: JSON.stringify([
					{
						number: 7,
						url: "https://pr/7",
						title: "t",
						body: "b",
						state: "OPEN",
					},
				]),
			}));

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).not.toHaveBeenCalled();
			expect(debug).not.toHaveBeenCalled();
		});

		it("logs at debug when gh pr list returns an empty array (no PRs match)", async () => {
			// gh pr list returns `[]` on success exit when no PRs match the
			// --head filter. findPrForBranch logs at debug and returns noPr —
			// this is the standard "no PR" miss path under the list-based
			// implementation, replacing the old stderr "no pull requests found"
			// regex match.
			setupHappyProbesWithPrHandler(() => ({ stdout: "[]" }));

			await handleCheckPrStatus(CWD, postMessage);

			expect(debug).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("No PR for branch feature/br"),
			);
			expect(warn).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "noPr",
					branch: "feature/br",
					history: [],
				}),
			);
		});

		it("posts unavailable (NOT noPr) when gh pr list fails with a non-empty stderr (e.g. auth/ratelimit)", async () => {
			// I-1 contract change: auth lapses, rate limits, and other gh
			// non-zero exits used to be folded into noPr — leading the user
			// to click Create PR and either fail or duplicate. Now they
			// surface as `unavailable` with the real stderr in `reason`,
			// and the UI shows Retry.
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
					/gh pr list failed for branch feature\/br.*code=1.*stderr:.*authentication required/s,
				),
			);
			expect(debug).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "unavailable",
					reason: expect.stringContaining("authentication required"),
				}),
			);
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr" }),
			);
		});

		it("wraps a non-Error gh rejection in an Error so lookupError still has a message", async () => {
			// gh (via execFile) normally rejects with an Error, but a non-Error
			// rejection (e.g. a bare string) must be coerced by tryExecGh so
			// `result.err.message` is always populated for the lookupError reason.
			setupHappyProbesWithPrHandler(() => {
				throw "gh blew up";
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "unavailable",
					reason: expect.stringContaining("gh blew up"),
				}),
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

		it("logs at warn with Raw length AND posts unavailable when gh pr view returns unparseable JSON", async () => {
			// I-1: unparseable JSON now goes through lookupError → unavailable
			// instead of being folded into noPr.
			setupHappyProbesWithPrHandler(() => ({
				stdout: "not-json-{{{",
			}));

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringMatching(/unparseable JSON.*Raw length: \d+/s),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "unavailable",
					reason: expect.stringContaining("Unparseable response from gh"),
				}),
			);
		});

		// ── summaryBranch routing (Memory Bank) ──────────────────────────────
		//
		// When the user opens a summary from another branch in Memory Bank,
		// the PR lookup must target the summary's branch, not the user's
		// currently checked-out branch. We assert by capturing the `--head`
		// argument passed to `gh pr list`.

		it("queries the PR for the summary's branch when summaryBranch is passed", async () => {
			let prListHeadArg: string | undefined;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/current\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const sepIdx = args.indexOf("--head");
					if (sepIdx >= 0) {
						prListHeadArg = args[sepIdx + 1];
					}
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage, "feature/summary-branch");

			expect(prListHeadArg).toBe("feature/summary-branch");
			// noPr message also reflects the summary branch, not the current one.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "noPr",
					branch: "feature/summary-branch",
					history: [],
				}),
			);
		});

		it("strict branch routing: summaryBranch wins over currentBranch even when stale (post-rename)", async () => {
			// Contract: after `git branch -m feature/old feature/new`, the
			// summary still points at `feature/old`. We MUST query
			// `feature/old` and report `noPr` for it — NOT silently retarget
			// to `feature/new` or to currentBranch. Auto-recovery from
			// renames is out of scope here.
			let prViewBranchArg: string | undefined;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					// User has already renamed → currentBranch is the new name.
					return { stdout: "feature/new\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const sepIdx = args.indexOf("--head");
					if (sepIdx >= 0) {
						prViewBranchArg = args[sepIdx + 1];
					}
					// gh returns "no PR" for the stale name.
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage, "feature/old");

			// The lookup must hit the stale summaryBranch, not currentBranch.
			expect(prViewBranchArg).toBe("feature/old");
			// And the user-facing message must name the stale branch — that's
			// how they realize the rename caused the mismatch.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "noPr",
					branch: "feature/old",
					history: [],
				}),
			);
		});

		it("falls back to currentBranch when summaryBranch is undefined", async () => {
			let prListHeadArg: string | undefined;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/current\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const sepIdx = args.indexOf("--head");
					if (sepIdx >= 0) {
						prListHeadArg = args[sepIdx + 1];
					}
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(prListHeadArg).toBe("feature/current");
		});

		// ─── Explicit-repo (foreign) path ───────────────────────────────────
		// Memory Bank cross-repo browsing: when the panel knows the summary
		// belongs to a non-current repo, it passes the foreign repo's
		// remoteUrl as the 4th arg. The handler must skip the cwd-bound
		// current-branch lookup and instead pin every gh command to
		// `--repo <url>`. Without this, the panel would either query the
		// wrong repo's PR (silent data leak) or sit stuck on "Checking PR
		// status..." because the dispatch guard rejected the message.
		describe("foreign-repo path (gh --repo)", () => {
			it("skips git lookups and pins `gh pr view` to the supplied remote url", async () => {
				const ghPrCalls: Array<Array<string>> = [];
				setupExecFile((cmd, args) => {
					if (cmd === "git") {
						// Any git invocation here is a regression: foreign-repo
						// path has no working tree to query.
						throw new Error(`unexpected git ${args.join(" ")}`);
					}
					if (cmd === "gh" && args[0] === "--version") {
						return { stdout: "gh version 2.40.0\n" };
					}
					if (cmd === "gh" && args[0] === "auth") {
						return { stdout: "Logged in\n" };
					}
					if (cmd === "gh" && args[0] === "pr") {
						ghPrCalls.push(args);
						return {
							stdout: JSON.stringify([
								{
									number: 7,
									url: "https://github.com/other/repo/pull/7",
									title: "Foreign PR",
									body: "",
									state: "OPEN",
								},
							]),
						};
					}
					return { stdout: "" };
				});

				await handleCheckPrStatus(
					CWD,
					postMessage,
					"feature/foreign-branch",
					"https://github.com/other/repo.git",
				);

				expect(ghPrCalls).toHaveLength(1);
				expect(ghPrCalls[0]).toEqual(
					expect.arrayContaining([
						"--repo",
						"https://github.com/other/repo.git",
					]),
				);
				// targetBranch must come from summaryBranch — never from
				// `getCurrentBranch(cwd)` (cwd is the current repo, not the
				// foreign one).
				expect(ghPrCalls[0]).toEqual(
					expect.arrayContaining(["feature/foreign-branch"]),
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "prStatus",
					status: "ready",
					pr: {
						number: 7,
						url: "https://github.com/other/repo/pull/7",
						title: "Foreign PR",
					},
					history: [],
				});
			});

			it("posts unavailable when repoUrl is provided without summaryBranch (foreign-repo guard)", async () => {
				// Foreign-repo lookups MUST be paired with an explicit
				// summaryBranch: the cwd-bound `getCurrentBranch` fallback would
				// describe the *current* repo, which is the wrong branch when
				// the user is viewing a Memory Bank summary from a different
				// project. Pre-guard the call rather than send a misleading
				// PR status from the wrong repo.
				await handleCheckPrStatus(
					CWD,
					postMessage,
					undefined,
					"https://github.com/foreign/repo",
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "prStatus",
					status: "unavailable",
				});
				// No gh / git probes should have run on this guard path.
				expect(mockExecFileAsync).not.toHaveBeenCalled();
			});
		});

		// ─── Previously: PR history strip ────────────────────────────────────
		// Covers the new `gh pr list --state all` shape: an active open PR is
		// shown front-and-center while merged/closed PRs from the same branch
		// flow into a "Previously:" inline strip below the actions. These
		// tests pin both the discriminator (open → kind:found, merged-only →
		// kind:noPr) AND the ordering (number-desc, latest first).
		describe("PR history (Previously: strip)", () => {
			function happyProbes(pr: ReadonlyArray<unknown>): void {
				setupExecFile((cmd, args) => {
					if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
					if (cmd === "git" && args[0] === "rev-parse")
						return { stdout: "feature/br\n" };
					if (cmd === "gh" && args[0] === "--version")
						return { stdout: "ok\n" };
					if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
					if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
						return { stdout: JSON.stringify(pr) };
					}
					return { stdout: "" };
				});
			}

			it("passes merged/closed PRs as history alongside ready status when an open PR exists", async () => {
				happyProbes([
					{
						number: 104,
						url: "https://pr/104",
						title: "Active",
						body: "",
						state: "OPEN",
					},
					{
						number: 102,
						url: "https://pr/102",
						title: "Old",
						body: "",
						state: "MERGED",
					},
					{
						number: 98,
						url: "https://pr/98",
						title: "Older",
						body: "",
						state: "CLOSED",
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith({
					command: "prStatus",
					status: "ready",
					pr: { number: 104, url: "https://pr/104", title: "Active" },
					history: [
						{ number: 102, url: "https://pr/102", state: "MERGED" },
						{ number: 98, url: "https://pr/98", state: "CLOSED" },
					],
				});
			});

			it("returns noPr (NOT ready on merged) when only merged/closed PRs exist", async () => {
				// Pre-refactor (gh pr view) would surface a merged PR as
				// `kind: "found"` because gh returns it for the branch. That
				// showed Edit PR on a merged PR — editing a merged title/body
				// works but is almost never what the user wants. Switching to
				// gh pr list + state filter keeps merged/closed out of the
				// "active PR" slot.
				happyProbes([
					{
						number: 102,
						url: "https://pr/102",
						title: "Old",
						body: "",
						state: "MERGED",
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith({
					command: "prStatus",
					status: "noPr",
					branch: "feature/br",
					history: [{ number: 102, url: "https://pr/102", state: "MERGED" }],
				});
			});

			it("orders history by number descending (latest first)", async () => {
				// gh's own order isn't guaranteed; we sort so the user always
				// sees the most recently-numbered PR first.
				happyProbes([
					{
						number: 50,
						url: "https://pr/50",
						title: "B",
						body: "",
						state: "MERGED",
					},
					{
						number: 200,
						url: "https://pr/200",
						title: "C",
						body: "",
						state: "CLOSED",
					},
					{
						number: 1,
						url: "https://pr/1",
						title: "A",
						body: "",
						state: "MERGED",
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "noPr",
						history: [
							{ number: 200, url: "https://pr/200", state: "CLOSED" },
							{ number: 50, url: "https://pr/50", state: "MERGED" },
							{ number: 1, url: "https://pr/1", state: "MERGED" },
						],
					}),
				);
			});

			it("picks the highest-numbered open PR when gh returns more than one (anomaly) and warns about the dropped IDs", async () => {
				// GitHub enforces ≤1 open PR per head branch; if gh ever returns
				// more (replication lag, stale cache, future API change), the
				// lookup picks the latest by number. The other OPEN entries are
				// NOT downgraded into the history strip — that would encode the
				// anomaly into PrHistoryEntry's public shape. Instead they are
				// logged via log.warn so the dropped IDs are recoverable from
				// debug.log without bloating the type surface.
				happyProbes([
					{
						number: 10,
						url: "https://pr/10",
						title: "Stale open",
						body: "",
						state: "OPEN",
					},
					{
						number: 20,
						url: "https://pr/20",
						title: "Newer open",
						body: "",
						state: "OPEN",
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "ready",
						pr: expect.objectContaining({ number: 20 }),
					}),
				);
				// Dropped OPEN ids must surface in debug.log so the operator
				// can correlate against gh / GitHub UI when this fires.
				const warnCalls = warn.mock.calls.map((c) => c.join(" "));
				const matched = warnCalls.find(
					(line) =>
						line.includes("Multiple open PRs") &&
						line.includes("#20") &&
						line.includes("#10"),
				);
				expect(matched).toBeDefined();
			});

			it("ignores cross-repository (fork) PRs even when they have the highest number, and warns about each dropped ID", async () => {
				// `gh pr list --head <branch>` matches by branch name only,
				// which means a contributor fork that shares the head-branch
				// name with the user's local branch shows up in the result.
				// Without isCrossRepository filtering, the fork PR (#250)
				// would be picked over the user's own upstream PR (#42) and
				// — worse — become the target of Edit PR writes.
				happyProbes([
					{
						number: 250,
						url: "https://pr/250",
						title: "Fork contribution",
						body: "",
						state: "OPEN",
						isCrossRepository: true,
					},
					{
						number: 42,
						url: "https://pr/42",
						title: "Upstream PR",
						body: "",
						state: "OPEN",
						isCrossRepository: false,
					},
					{
						number: 30,
						url: "https://pr/30",
						title: "Old fork PR",
						body: "",
						state: "MERGED",
						isCrossRepository: true,
					},
					{
						number: 25,
						url: "https://pr/25",
						title: "Upstream merged",
						body: "",
						state: "MERGED",
						isCrossRepository: false,
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				// The active PR must be the upstream-owned one, not the
				// higher-numbered fork. History must only carry upstream
				// rows, never fork rows.
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "ready",
						pr: expect.objectContaining({ number: 42 }),
						history: [{ number: 25, url: "https://pr/25", state: "MERGED" }],
					}),
				);
				// Both dropped fork IDs must appear in the warn log so the
				// operator can reconcile against the gh / GitHub UI.
				const warnCalls = warn.mock.calls.map((c) => c.join(" "));
				const matched = warnCalls.find(
					(line) =>
						line.includes("cross-repository") &&
						line.includes("#250") &&
						line.includes("#30"),
				);
				expect(matched).toBeDefined();
			});

			it("returns noPr when every matching PR is a cross-repository fork PR", async () => {
				// Pure-fork edge case: the user's branch happens to share its
				// name with a contributor fork PR but the user has not opened
				// their own PR yet. The panel must surface a Create PR
				// affordance (kind:noPr), not present the fork PR as theirs.
				happyProbes([
					{
						number: 99,
						url: "https://pr/99",
						title: "Contributor PR",
						body: "",
						state: "OPEN",
						isCrossRepository: true,
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "noPr",
						history: [],
					}),
				);
			});

			it("drops malformed entries with number 0 or missing state from history", async () => {
				// Defense-in-depth: gh has been observed to return number 0 in
				// rare edge cases; we'd rather show fewer history pills than
				// crash the section. State is `unknown`-cast at parse, so a
				// missing `state` survives type-check but must be filtered.
				happyProbes([
					{
						number: 0,
						url: "https://pr/0",
						title: "",
						body: "",
						state: "MERGED",
					},
					{
						number: 50,
						url: "https://pr/50",
						title: "Real",
						body: "" /* no state */,
					},
					{
						number: 60,
						url: "https://pr/60",
						title: "Real",
						body: "",
						state: "MERGED",
					},
				]);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "noPr",
						history: [{ number: 60, url: "https://pr/60", state: "MERGED" }],
					}),
				);
			});

			it("posts unavailable with reason when gh returns non-array JSON (shape regression)", async () => {
				// gh could conceivably return a single object instead of an
				// array if its output shape changes; we treat that as a
				// lookupError rather than guessing how to coerce it.
				happyProbes(
					JSON.parse(
						'{"number":1,"state":"OPEN","url":"x","title":"y","body":""}',
					) as ReadonlyArray<unknown>,
				);

				await handleCheckPrStatus(CWD, postMessage);

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "unavailable",
						reason: expect.stringContaining("expected array"),
					}),
				);
			});
		});
	});

	// ─── handleCreatePr ─────────────────────────────────────────────────────

	describe("handleCreatePr", () => {
		/**
		 * Routes `gh pr list` two-phase: the FIRST call (handleCreatePr's pre-push
		 * existence check) returns noPr so the create path runs; every later call
		 * (the post-create status refresh) returns `createdPr`. Mirrors reality:
		 * before `gh pr create` the branch has no open PR; after it does. Without
		 * this split the pre-push lookup would see an open PR and route to update.
		 */
		function createRouter(
			createdPr: { number: number; url: string; title?: string },
			overrides: (cmd: string, args: Array<string>) => { stdout: string } | undefined = () => undefined,
		): (cmd: string, args: Array<string>) => { stdout: string } {
			let prListCalls = 0;
			return (cmd, args) => {
				const ov = overrides(cmd, args);
				if (ov !== undefined) return ov;
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: `${createdPr.url}\n` };
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh 2.40.0\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					prListCalls += 1;
					return prListCalls === 1
						? { stdout: "[]" }
						: {
								stdout: JSON.stringify([
									{
										number: createdPr.number,
										url: createdPr.url,
										title: createdPr.title ?? "T",
										body: "",
										state: "OPEN",
									},
								]),
							};
				}
				return { stdout: "" };
			};
		}

		it("creates the PR even when the summary's commit is no longer reachable (rebase-just-happened regression)", async () => {
			// Regression: pre-refactor, a non-reachable summary commit would block
			// PR creation. Branch-first model: ignore commit reachability — push
			// + create PR using the CURRENT branch.
			const prUrl = "https://github.com/org/repo/pull/77";
			// The pre-push lookup must return noPr (`[]`) so the create path runs;
			// the post-create status refresh then sees the freshly created PR.
			let prListCalls = 0;
			setupExecFile((cmd, args) => {
				// Whatever ancestor probe might still happen elsewhere — irrelevant
				// to handleCreatePr now; left as a non-ancestor to prove we don't
				// gate on it.
				if (cmd === "git" && args[0] === "merge-base") throw new Error("not ancestor");
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: `${prUrl}\n` };
				if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh 2.40.0\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					prListCalls += 1;
					// First list = pre-push existence check → no open PR. Subsequent
					// lists (post-create status refresh) → the created PR.
					return prListCalls === 1
						? { stdout: "[]" }
						: {
								stdout: JSON.stringify([
									{ number: 77, url: prUrl, title: "Rebased PR", body: "", state: "OPEN" },
								]),
							};
				}
				return { stdout: "" };
			});
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
				createRouter({ number: 99, url: prUrl, title: "New PR" }, (cmd, args) => {
					if (cmd === "git" && args[0] === "push") {
						gitPushCalled = true;
						return { stdout: "" };
					}
					if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
						prCreateCalled = true;
						return { stdout: `${prUrl}\n` };
					}
					return undefined;
				}),
			);

			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("New PR", "PR body", CWD, postMessage);

			expect(gitPushCalled).toBe(true);
			expect(prCreateCalled).toBe(true);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			// Per-step progress lines drive the text below the disabled buttons.
			expect(postMessage).toHaveBeenCalledWith({
				command: "prProgress",
				text: "Pushing branch to origin…",
			});
			expect(postMessage).toHaveBeenCalledWith({
				command: "prProgress",
				text: "Creating pull request…",
			});
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
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				// Pre-push lookup → no open PR, so the create path reaches the push.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
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
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				// Pre-push lookup → no open PR, so the create path reaches the push.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
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

			setupExecFile(createRouter({ number: 55, url: prUrl, title: "T" }));

			showInformationMessage.mockResolvedValue("Open PR");

			await handleCreatePr("T", "B", CWD, postMessage);

			// Wait for the .then() to resolve
			await vi.waitFor(() => {
				expect(openExternal).toHaveBeenCalled();
			});
			expect(uriParse).toHaveBeenCalledWith(prUrl);
		});

		// ── Submit-time branch guard (TOCTOU second line) ────────────────────
		//
		// The panel decides the effective branch when the form opens and passes
		// it as `expectedBranch`. `git push -u origin HEAD` pushes whatever is
		// checked out at submit, so if the user switched branches between
		// opening and submitting (e.g. away from the summary's branch), the
		// service must reject before any push/create — never push a different
		// branch's HEAD onto this PR.

		it("branch changed since prepare: rejects with prCreateBlockedCrossBranch and skips push/create when expectedBranch differs from currentBranch", async () => {
			let gitPushCalled = false;
			let prCreateCalled = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "feature/current\n" }),
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
					"gh:pr:create": () => {
						prCreateCalled = true;
						return { stdout: "https://example/0\n" };
					},
				}),
			);

			await handleCreatePr(
				"T",
				"B",
				CWD,
				postMessage,
				"feature/summary-branch",
			);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/summary-branch",
				currentBranch: "feature/current",
			});
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreating" });
			expect(gitPushCalled).toBe(false);
			expect(prCreateCalled).toBe(false);
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("feature/summary-branch"),
			);
		});

		it("cross-branch: proceeds normally when summaryBranch equals currentBranch", async () => {
			const prUrl = "https://github.com/org/repo/pull/123";
			let gitPushCalled = false;
			setupExecFile(
				createRouter({ number: 123, url: prUrl, title: "OK" }, (cmd, args) => {
					if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/same\n" };
					if (cmd === "git" && args[0] === "push") {
						gitPushCalled = true;
						return { stdout: "" };
					}
					return undefined;
				}),
			);
			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("T", "B", CWD, postMessage, "feature/same");

			expect(gitPushCalled).toBe(true);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "prCreateBlockedCrossBranch" }),
			);
		});

		it("detached HEAD: blocks with the shared 'cannot determine the current branch' message, not prCreateFailed", async () => {
			let gitPushCalled = false;
			setupExecFile(
				buildRouter({
					// `git rev-parse --abbrev-ref HEAD` returns the literal "HEAD"
					// in detached state.
					"git:rev-parse": () => ({ stdout: "HEAD\n" }),
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
				}),
			);

			await handleCreatePr("T", "B", CWD, postMessage, "feature/x");

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/x",
				currentBranch: "HEAD",
			});
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).not.toHaveBeenCalledWith({
				command: "prCreateFailed",
			});
			expect(gitPushCalled).toBe(false);
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Cannot determine the current branch"),
			);
		});

		it("git error reading the branch: normalized to detached block, not prCreateFailed", async () => {
			// A hard git failure (.git/index.lock, permission) makes the branch
			// read throw. getCurrentBranchSafe normalizes it to the "HEAD"
			// sentinel so it lands on the detached block rather than the outer
			// catch → prCreateFailed.
			let gitPushCalled = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => {
						throw new Error("fatal: unable to read HEAD");
					},
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
				}),
			);

			await handleCreatePr("T", "B", CWD, postMessage, "feature/x");

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/x",
				currentBranch: "HEAD",
			});
			expect(postMessage).not.toHaveBeenCalledWith({
				command: "prCreateFailed",
			});
			expect(gitPushCalled).toBe(false);
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Cannot determine the current branch"),
			);
		});

		it("detached HEAD with no expectedBranch: blocks with an empty summaryBranch field", async () => {
			setupExecFile(
				buildRouter({ "git:rev-parse": () => ({ stdout: "HEAD\n" }) }),
			);

			await handleCreatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "",
				currentBranch: "HEAD",
			});
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Cannot determine the current branch"),
			);
		});

		// ─── #2: existing-PR detected BEFORE push → confirm → update ──────────
		//
		// The pre-push lookup is the safety net for when the panel rendered
		// "Create" but an open PR actually exists (render-time findOpenPrForBranch
		// can't tell lookupError from noPr). We must detect it BEFORE pushing —
		// `pushBranch` may force-push, so a duplicate-create attempt must never
		// reach the remote. `gh pr create` is never called on this path.

		it("open PR detected before push → confirms and updates the existing PR (no create, push after confirm)", async () => {
			const ghEdits: Array<Array<string>> = [];
			let pushedBeforeConfirm = true;
			let confirmed = false;
			let createCalled = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					// Push must happen only AFTER the user confirms the update.
					pushedBeforeConfirm = !confirmed ? true : pushedBeforeConfirm;
					if (confirmed) pushedBeforeConfirm = false;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					createCalled = true;
					throw new Error("should never create — PR already exists");
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					ghEdits.push([...args]);
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return {
						stdout: JSON.stringify([
							{ number: 7, url: "https://gh/pr/7", title: "Old", body: "", state: "OPEN" },
						]),
					};
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				return { stdout: "" };
			});
			showWarningMessage.mockImplementationOnce(async () => {
				confirmed = true;
				return "Update Existing PR";
			});
			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("New title", "Body", CWD, postMessage);

			expect(createCalled).toBe(false);
			expect(pushedBeforeConfirm).toBe(false);
			expect(ghEdits.some((a) => a.includes("--body-file"))).toBe(true);
			expect(showInformationMessage).toHaveBeenCalledWith("Updated PR #7", "Open PR");
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("open PR detected, user confirms update, but declines the force-push: resets the button, no edit", async () => {
			let edited = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") return { stdout: "" };
					throw new Error("! [rejected] (non-fast-forward)");
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					edited = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return {
						stdout: JSON.stringify([
							{ number: 7, url: "https://gh/pr/7", title: "Old", body: "", state: "OPEN" },
						]),
					};
				return { stdout: "" };
			});
			// First warning = the "update existing PR?" confirm (accept); second =
			// the force-push confirm (decline).
			showWarningMessage.mockResolvedValueOnce("Update Existing PR");
			showWarningMessage.mockResolvedValueOnce(undefined);

			await handleCreatePr("New title", "Body", CWD, postMessage);

			expect(edited).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("open PR detected before push but the user declines: never pushes, never edits, resets the button", async () => {
			let pushed = false;
			let edited = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					pushed = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					edited = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return {
						stdout: JSON.stringify([
							{ number: 7, url: "https://gh/pr/7", title: "Old", body: "", state: "OPEN" },
						]),
					};
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(undefined); // declined

			await handleCreatePr("New title", "Body", CWD, postMessage);

			expect(pushed).toBe(false);
			expect(edited).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("aborts and never pushes when the pre-push PR lookup fails (lookupError)", async () => {
			// Transient gh failure (auth/ratelimit) masking an existing PR must NOT
			// silently force-push + create a duplicate — abort with an error.
			let pushed = false;
			let createCalled = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					pushed = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					createCalled = true;
					return { stdout: "https://gh/pr/1\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					throw ghError({ message: "gh exit 4", code: 4, stderr: "HTTP 401: Bad credentials" });
				return { stdout: "" };
			});

			await handleCreatePr("New title", "Body", CWD, postMessage);

			expect(pushed).toBe(false);
			expect(createCalled).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("HTTP 401"),
			);
		});

		it("create fails with a non-recoverable error (noPr path) → surfaces it", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				// Pre-push lookup → no open PR, so the create path runs and throws.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create")
					throw new Error("network unreachable");
				return { stdout: "" };
			});

			await handleCreatePr("New title", "Body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Create PR failed — network unreachable"),
			);
		});
	});

	// ─── handleCreatePr return value ─────────────────────────────────────────
	//
	// Task 2 of the push-on-submit feature: the panel (Task 3) needs to know
	// whether the submit actually landed so it can decide whether to run the
	// push-to-Space engine. Mirrors the mock arrangements from the "pushes
	// branch, creates PR..." / "branch changed since prepare" / "aborts
	// quietly when the user declines the force-push confirmation" cases above.

	describe("handleCreatePr return value", () => {
		it('resolves "succeeded" after a fresh PR is created', async () => {
			const prUrl = "https://github.com/org/repo/pull/99";
			let prListCalls = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/x\n" };
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh 2.40.0\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: `${prUrl}\n` };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					prListCalls += 1;
					return prListCalls === 1
						? { stdout: "[]" }
						: {
								stdout: JSON.stringify([
									{ number: 99, url: prUrl, title: "New PR", body: "", state: "OPEN" },
								]),
							};
				}
				return { stdout: "" };
			});
			showInformationMessage.mockResolvedValue(undefined);

			const outcome = await handleCreatePr("New PR", "PR body", CWD, postMessage, "feature/x");

			expect(outcome).toBe("succeeded");
		});

		it('resolves "failed" when blocked by the cross-branch guard', async () => {
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "other\n" }),
				}),
			);

			const outcome = await handleCreatePr("t", "b", CWD, postMessage, "feature/x");

			expect(outcome).toBe("failed");
		});

		it('resolves "failed" when the push is cancelled', async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/x\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") return { stdout: "" };
					throw new Error("! [rejected] (non-fast-forward)");
				}
				// Pre-push lookup → no open PR, so the create path reaches the push.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(undefined);

			const outcome = await handleCreatePr("t", "b", CWD, postMessage, "feature/x");

			expect(outcome).toBe("failed");
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{
								number: 10,
								url: "https://url",
								title: "PR Title",
								body: existingBody,
								state: "OPEN",
							},
						]),
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{
								number: 10,
								url: "https://url",
								title: "T",
								body: existingBody,
								state: "OPEN",
							},
						]),
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

		it("shows error AND re-runs status flow when PR lookup fails (auth/ratelimit/JSON)", async () => {
			// I-1: lookupError must not fold into noPr. The error toast tells
			// the user the real reason; the status refresh repaints the
			// section so the Edit PR button's "Loading..." state is reset
			// (the section will now show `unavailable` + Retry).
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					throw ghError({
						message: "gh exit 4",
						code: 4,
						stderr: "HTTP 401: Bad credentials",
					});
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("HTTP 401"),
			);
			// Status repaint triggers — section will show unavailable + Retry.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "unavailable",
					reason: expect.stringContaining("HTTP 401"),
				}),
			);
		});

		it("shows warning AND re-runs status flow when no PR is found (un-sticks the Edit PR button)", async () => {
			// Regression: the webview's Edit PR button sets itself to
			// "Loading..." + disabled on click. If `handlePrepareUpdatePr`
			// returns silently on the no-PR path, the button stays stuck
			// forever. After this fix, the no-PR path re-runs
			// `handleCheckPrStatus` so the section is repainted and the
			// button is rebuilt fresh.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/test-branch\n" };
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					// Mimic gh's real non-zero exit with the "no pull requests
					// found" stderr line — findPrForBranch reads it via
					// `(err as { stderr? }).stderr`, matches the regex,
					// returns `{ kind: "noPr" }`.
					// gh pr list returns an empty array (success exit) when no PRs match.
					return { stdout: "[]" };
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(MARKDOWN, CWD, postMessage);

			expect(showWarningMessage).toHaveBeenCalledWith(
				"No pull request found for branch feature/test-branch.",
			);
			// The section must repaint via prStatus so the click-time button
			// state is reset.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "noPr",
					branch: "feature/test-branch",
					history: [],
				}),
			);
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{
								number: 10,
								url: "https://url",
								title: "T",
								body: "",
								state: "OPEN",
							},
						]),
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

		// ── summaryBranch routing (Memory Bank) ──────────────────────────────

		it("looks up the PR on summaryBranch when provided, not currentBranch", async () => {
			let prViewBranchArg: string | undefined;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/current\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const sepIdx = args.indexOf("--head");
					if (sepIdx >= 0) {
						prViewBranchArg = args[sepIdx + 1];
					}
					return {
						stdout: JSON.stringify([
							{
								number: 5,
								url: "https://url",
								title: "T",
								body: "",
								state: "OPEN",
							},
						]),
					};
				}
				return { stdout: "" };
			});

			await handlePrepareUpdatePr(
				MARKDOWN,
				CWD,
				postMessage,
				"feature/summary-branch",
			);

			expect(prViewBranchArg).toBe("feature/summary-branch");
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return { stdout: JSON.stringify([{ ...pr, state: "OPEN" }]) };
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
				// gh pr list returns an empty array (success exit) when no PRs match.
				return { stdout: "[]" };
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showWarningMessage).toHaveBeenCalledWith(
				"No pull request found for branch branch.",
			);
		});

		it("shows error toast and posts prUpdateFailed when PR lookup fails (auth/network)", async () => {
			// I-1: distinguished from noPr — the form is open and the user
			// clicked Submit. We surface the real error reason so they know
			// it's not a "PR was deleted" situation, and bail out so they can
			// retry.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				throw ghError({
					message: "gh exit 4",
					code: 4,
					stderr: "HTTP 401: Bad credentials",
				});
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("HTTP 401"),
			);
			// Must NOT show the misleading "No pull request found" message.
			expect(showWarningMessage).not.toHaveBeenCalledWith(
				expect.stringContaining("No pull request found"),
			);
		});

		it("posts prUpdateFailed and shows error on gh failure", async () => {
			// First call (findPrForBranch) succeeds, second call (editPrBody) fails
			let callCount = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "branch\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{
								number: 5,
								url: "u",
								title: "T",
								body: "",
								state: "OPEN",
							},
						]),
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{
								number: 5,
								url: "u",
								title: "T",
								body: "",
								state: "OPEN",
							},
						]),
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return { stdout: JSON.stringify([{ ...pr, state: "OPEN" }]) };
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

		// ── summaryBranch routing (Memory Bank) ──────────────────────────────

		it("updates the PR on summaryBranch when provided, not currentBranch", async () => {
			let prViewBranchArg: string | undefined;
			setupTmpFile();
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") {
					return { stdout: "feature/current\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const sepIdx = args.indexOf("--head");
					if (sepIdx >= 0) {
						prViewBranchArg = args[sepIdx + 1];
					}
					return {
						stdout: JSON.stringify([
							{
								number: 11,
								url: "https://url",
								title: "T",
								body: "",
								state: "OPEN",
							},
						]),
					};
				}
				if (cmd === "gh" && args[0] === "--version") {
					return { stdout: "gh 2.40.0\n" };
				}
				if (cmd === "gh" && args[0] === "auth") {
					return { stdout: "ok\n" };
				}
				return { stdout: "" };
			});
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePr(
				"T",
				"new body",
				CWD,
				postMessage,
				"feature/summary-branch",
			);

			expect(prViewBranchArg).toBe("feature/summary-branch");
		});
	});

	// ─── findOpenPrForBranch ────────────────────────────────────────────────

	describe("findOpenPrForBranch", () => {
		it("returns the open PR's number + url when one exists", async () => {
			setupExecFile(
				buildRouter({
					"gh:pr:list": () => ({
						stdout: JSON.stringify([
							{ number: 42, url: "https://gh/pr/42", title: "T", body: "", state: "OPEN" },
						]),
					}),
				}),
			);
			const got = await findOpenPrForBranch(CWD, "feature/x");
			expect(got).toEqual({ number: 42, url: "https://gh/pr/42" });
		});

		it("returns undefined when there is no open PR", async () => {
			setupExecFile(buildRouter({ "gh:pr:list": () => ({ stdout: "[]" }) }));
			const got = await findOpenPrForBranch(CWD, "feature/x");
			expect(got).toBeUndefined();
		});

		it("returns undefined on a lookup error", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					throw ghError({ message: "network", stderr: "boom", code: 1 });
				}
				return { stdout: "" };
			});
			const got = await findOpenPrForBranch(CWD, "feature/x");
			expect(got).toBeUndefined();
		});
	});

	// ─── findPrWithHistoryForBranch ─────────────────────────────────────────

	describe("findPrWithHistoryForBranch", () => {
		it("returns the open PR plus the closed/merged history (newest-first)", async () => {
			setupExecFile(
				buildRouter({
					"gh:pr:list": () => ({
						stdout: JSON.stringify([
							{ number: 300, url: "https://gh/pr/300", title: "T", body: "", state: "OPEN" },
							{ number: 271, url: "https://gh/pr/271", title: "T", body: "", state: "MERGED" },
							{ number: 251, url: "https://gh/pr/251", title: "T", body: "", state: "CLOSED" },
						]),
					}),
				}),
			);
			const got = await findPrWithHistoryForBranch(CWD, "feature/x");
			expect(got.existingPr).toEqual({ number: 300, url: "https://gh/pr/300" });
			expect(got.history).toEqual([
				{ number: 271, url: "https://gh/pr/271", state: "MERGED" },
				{ number: 251, url: "https://gh/pr/251", state: "CLOSED" },
			]);
		});

		it("returns no open PR but keeps the merged history when only closed PRs exist", async () => {
			setupExecFile(
				buildRouter({
					"gh:pr:list": () => ({
						stdout: JSON.stringify([
							{ number: 271, url: "https://gh/pr/271", title: "T", body: "", state: "MERGED" },
						]),
					}),
				}),
			);
			const got = await findPrWithHistoryForBranch(CWD, "feature/x");
			expect(got.existingPr).toBeUndefined();
			expect(got.history).toEqual([{ number: 271, url: "https://gh/pr/271", state: "MERGED" }]);
		});

		it("returns empty history on a lookup error", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					throw ghError({ message: "network", stderr: "boom", code: 1 });
				}
				return { stdout: "" };
			});
			const got = await findPrWithHistoryForBranch(CWD, "feature/x");
			expect(got.existingPr).toBeUndefined();
			expect(got.history).toEqual([]);
		});
	});

	// ─── handleUpdatePrWithPush + smart pushBranch ──────────────────────────

	describe("handleUpdatePrWithPush", () => {
		const OPEN_PR = [
			{ number: 7, url: "https://gh/pr/7", title: "Existing title", body: "", state: "OPEN" },
		];

		/** Router with all prereqs green and a plain push that succeeds. */
		function happyRouter(overrides: Record<string, () => { stdout: string }> = {}) {
			return buildRouter({
				"git:rev-parse": () => ({ stdout: "feature/branch\n" }),
				"git:push": () => ({ stdout: "" }),
				"git:fetch": () => ({ stdout: "" }),
				"git:rev-list": () => ({ stdout: "0\t1\n" }),
				"gh:--version": () => ({ stdout: "gh 2.40\n" }),
				"gh:auth": () => ({ stdout: "ok\n" }),
				"gh:pr:list": () => ({ stdout: JSON.stringify(OPEN_PR) }),
				"gh:pr:edit": () => ({ stdout: "" }),
				...overrides,
			});
		}

		it("pushes, edits title+body of the open PR, refreshes status, and toasts Updated PR", async () => {
			const ghEdits: Array<Array<string>> = [];
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					ghEdits.push([...args]);
					return { stdout: "" };
				}
				return happyRouter()(cmd, args);
			});
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePrWithPush("New title", "Body", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreateFailed" });
			// title differs from PR's "Existing title" → a --title edit runs
			expect(ghEdits.some((a) => a.includes("--title"))).toBe(true);
			// body always synced via --body-file
			expect(ghEdits.some((a) => a.includes("--body-file"))).toBe(true);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ command: "prStatus", status: "ready" }),
			);
			expect(showInformationMessage).toHaveBeenCalledWith("Updated PR #7", "Open PR");
		});

		it("skips the --title edit when the drafted title matches the PR title", async () => {
			const ghEdits: Array<Array<string>> = [];
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
					ghEdits.push([...args]);
					return { stdout: "" };
				}
				return happyRouter()(cmd, args);
			});
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePrWithPush("Existing title", "Body", CWD, postMessage);

			expect(ghEdits.some((a) => a.includes("--title"))).toBe(false);
			expect(ghEdits.some((a) => a.includes("--body-file"))).toBe(true);
		});

		it("opens the PR externally when the user clicks Open PR", async () => {
			setupExecFile(happyRouter());
			showInformationMessage.mockResolvedValue("Open PR");

			await handleUpdatePrWithPush("New title", "Body", CWD, postMessage);

			await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
			expect(uriParse).toHaveBeenCalledWith("https://gh/pr/7");
		});

		it("cross-branch: blocks and skips push when summaryBranch differs from current", async () => {
			let pushed = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "feature/current\n" }),
					"git:push": () => {
						pushed = true;
						return { stdout: "" };
					},
				}),
			);

			await handleUpdatePrWithPush("T", "B", CWD, postMessage, "feature/other");

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/other",
				currentBranch: "feature/current",
			});
			expect(pushed).toBe(false);
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("feature/other"),
			);
		});

		it("detached HEAD: blocks with the shared message and never force-pushes detached HEAD", async () => {
			// rev-parse returns the literal "HEAD" when detached. The bare
			// getCurrentBranch would let summaryBranch===currentBranch pass and then
			// `git push -u origin HEAD` onto the detached HEAD; getCurrentBranchSafe +
			// the "HEAD" guard must block it, mirroring handleCreatePr.
			let gitPushCalled = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "HEAD\n" }),
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
				}),
			);

			await handleUpdatePrWithPush("T", "B", CWD, postMessage, "feature/x");

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/x",
				currentBranch: "HEAD",
			});
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreating" });
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(gitPushCalled).toBe(false);
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Cannot determine the current branch"),
			);
		});

		it("git error reading the branch: normalized to the detached block, not a generic prCreateFailed", async () => {
			// A hard git failure (.git/index.lock, permission) makes the branch read
			// throw. getCurrentBranchSafe normalizes it to the "HEAD" sentinel so it
			// lands on the block rather than the outer catch → prCreateFailed.
			let gitPushCalled = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => {
						throw new Error("fatal: unable to read HEAD");
					},
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
				}),
			);

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "",
				currentBranch: "HEAD",
			});
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(gitPushCalled).toBe(false);
		});

		it("falls back to creating a PR when the open PR vanished", async () => {
			let created = false;
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					created = true;
					return { stdout: "https://gh/pr/9\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					// Pre-push lookup (decide update vs create) → empty; the post-create
					// refresh also reads empty, which is fine for this assertion.
					return { stdout: "[]" };
				}
				return happyRouter()(cmd, args);
			});
			// noPr now requires an explicit confirmation before push + create.
			showWarningMessage.mockResolvedValueOnce("Create New PR");
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(created).toBe(true);
			expect(showInformationMessage).toHaveBeenCalledWith("Pull request created!", "Open PR");
		});

		it("vanished + user declines the confirmation: no push, no create, resets the button", async () => {
			let pushed = false;
			let created = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "push") {
					pushed = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					created = true;
					return { stdout: "https://gh/pr/9\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return { stdout: "[]" };
				}
				return happyRouter()(cmd, args);
			});
			showWarningMessage.mockResolvedValueOnce(undefined); // dismissed

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(pushed).toBe(false);
			expect(created).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("aborts with an error and never pushes when the pre-push PR lookup fails (lookupError)", async () => {
			let pushed = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "push") {
					pushed = true;
					return { stdout: "" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					// Transient gh failure (auth/ratelimit) → lookupError, must not be
					// mistaken for "no PR" and silently create a duplicate.
					throw ghError({ message: "gh exit 4", code: 4, stderr: "HTTP 401: Bad credentials" });
				}
				return happyRouter()(cmd, args);
			});

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(pushed).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("HTTP 401"),
			);
		});

		it("posts prCreateFailed and shows error on a non-recoverable push failure", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				// Pre-push lookup must find the PR so the flow reaches the push.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return { stdout: JSON.stringify(OPEN_PR) };
				if (cmd === "git" && args[0] === "push") throw new Error("auth failed");
				return { stdout: "" };
			});

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Update PR failed — auth failed"),
			);
		});

		it("empty rev-parse output normalizes to the HEAD sentinel and blocks", async () => {
			// getCurrentBranch returns "" (rev-parse output blank); getCurrentBranchSafe
			// applies its `|| "HEAD"` fallback, landing on the detached-HEAD block
			// rather than force-pushing an empty branch name.
			let gitPushCalled = false;
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "\n" }),
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
				}),
			);

			await handleUpdatePrWithPush("T", "B", CWD, postMessage, "feature/x");

			expect(postMessage).toHaveBeenCalledWith({
				command: "prCreateBlockedCrossBranch",
				summaryBranch: "feature/x",
				currentBranch: "HEAD",
			});
			expect(gitPushCalled).toBe(false);
		});

		it("vanished + confirmed but the push is cancelled: prCreateFailed without creating", async () => {
			// noPr → user confirms creating a fresh PR → the push is rejected as
			// non-fast-forward and the user dismisses the force modal → "cancelled".
			// No PR must be created and the button must reset without an error toast.
			let created = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") throw new Error("! [rejected] (non-fast-forward)");
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					created = true;
					return { stdout: "https://gh/pr/9\n" };
				}
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce("Create New PR"); // confirm the fallback
			showWarningMessage.mockResolvedValueOnce(undefined); // dismiss the force-push modal

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(created).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("posts prCreateFailed with the stringified value when the push rejects with a non-Error", async () => {
			// A non-Error rejection that is not a non-fast-forward error bubbles out of
			// pushBranch to the outer catch, which must stringify it for the toast.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return { stdout: JSON.stringify(OPEN_PR) };
				if (cmd === "git" && args[0] === "push") throw "kaboom";
				return { stdout: "" };
			});

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Update PR failed — kaboom"),
			);
		});

		// Mirrors PushCommand: ANY non-fast-forward rejection (remote diverged or
		// local history rewritten) offers a --force-with-lease push behind a
		// modal — never a fetch / ahead-behind disambiguation / "pull first".
		const FORCE_LABEL = "Force Push (--force-with-lease)";

		it("non-fast-forward + confirm: force-pushes with lease then updates the PR", async () => {
			let forcePushed = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") {
						forcePushed = true;
						return { stdout: "" };
					}
					throw new Error("! [rejected] (non-fast-forward)");
				}
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return { stdout: JSON.stringify(OPEN_PR) };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(FORCE_LABEL);
			showInformationMessage.mockResolvedValue(undefined);

			await handleUpdatePrWithPush("New title", "Body", CWD, postMessage);

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("rewrite remote history"),
				{ modal: true },
				FORCE_LABEL,
			);
			expect(forcePushed).toBe(true);
			expect(showInformationMessage).toHaveBeenCalledWith("Updated PR #7", "Open PR");
		});

		it("non-fast-forward + cancel: aborts quietly without force-pushing or erroring", async () => {
			let forcePushed = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") {
						forcePushed = true;
						return { stdout: "" };
					}
					throw new Error("! [rejected] (non-fast-forward)");
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return { stdout: JSON.stringify(OPEN_PR) };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(undefined); // user dismissed

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(forcePushed).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("merges the drafted block into the live PR body, preserving manual content outside the markers", async () => {
			// Regression: the Create-PR panel sends only the marker-wrapped Jolli
			// block. Writing it whole would delete any hand-written description /
			// checklist outside the markers. The body must be merged into the PR's
			// current body, replacing only the marker region.
			const existingBody = `## Reviewer checklist\n- [x] manual note\n${MARKER_START}\nold summary content\n${MARKER_END}\nRelease context below`;
			setupExecFile((cmd, args) => {
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: JSON.stringify([
							{ number: 7, url: "https://gh/pr/7", title: "Existing title", body: existingBody, state: "OPEN" },
						]),
					};
				}
				return happyRouter()(cmd, args);
			});
			showInformationMessage.mockResolvedValue(undefined);

			const draftedBlock = `${MARKER_START}\n## New Summary\n${MARKER_END}`;
			await handleUpdatePrWithPush("Existing title", draftedBlock, CWD, postMessage);

			const written = writeFileMock.mock.calls.map((c) => String(c[1]));
			const merged = written.find((b) => b.includes("## New Summary"));
			expect(merged).toBeDefined();
			// Manual content on both sides of the marker region survives.
			expect(merged).toContain("## Reviewer checklist");
			expect(merged).toContain("- [x] manual note");
			expect(merged).toContain("Release context below");
			// The stale summary inside the old marker region is gone.
			expect(merged).not.toContain("old summary content");
		});

		it("non-fast-forward + confirm fails on the force-push: surfaces the error", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") {
						throw new Error("stale info (lease)");
					}
					throw new Error("! [rejected] (non-fast-forward)");
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
					return { stdout: JSON.stringify(OPEN_PR) };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce("Force Push (--force-with-lease)");

			await handleUpdatePrWithPush("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Update PR failed — stale info (lease)"),
			);
		});
	});

	// ─── handleCreatePr: shared pushBranch force-push paths ─────────────────

	describe("handleCreatePr force-push fallback", () => {
		const FORCE_LABEL = "Force Push (--force-with-lease)";

		it("aborts quietly when the user declines the force-push confirmation", async () => {
			let forcePushed = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") {
						forcePushed = true;
						return { stdout: "" };
					}
					throw new Error("! [rejected] (non-fast-forward)");
				}
				// Pre-push lookup → no open PR, so the create path reaches the push.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(undefined);

			await handleCreatePr("T", "B", CWD, postMessage);

			expect(forcePushed).toBe(false);
			expect(postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("force-pushes with lease on confirm, then creates the PR", async () => {
			let forcePushed = false;
			let prListCalls = 0;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/branch\n" };
				if (cmd === "git" && args[0] === "push") {
					if (args[1] === "--force-with-lease") {
						forcePushed = true;
						return { stdout: "" };
					}
					throw new Error("! [rejected] (non-fast-forward)");
				}
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create")
					return { stdout: "https://gh/pr/12\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					prListCalls += 1;
					// Pre-push: no open PR. Post-create status refresh: the new PR.
					return prListCalls === 1
						? { stdout: "[]" }
						: {
								stdout: JSON.stringify([
									{ number: 12, url: "https://gh/pr/12", title: "T", body: "", state: "OPEN" },
								]),
							};
				}
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce(FORCE_LABEL);
			showInformationMessage.mockResolvedValue(undefined);

			await handleCreatePr("T", "B", CWD, postMessage);

			expect(forcePushed).toBe(true);
			expect(postMessage).not.toHaveBeenCalledWith({ command: "prCreateFailed" });
			expect(showInformationMessage).toHaveBeenCalledWith("Pull request created!", "Open PR");
		});
	});

	// ─── handleUpdatePrWithPush return value ─────────────────────────────────
	//
	// Mirrors the mock arrangements from "pushes, edits title+body of the open
	// PR..." and "aborts with an error and never pushes when the pre-push PR
	// lookup fails (lookupError)" above.

	describe("handleUpdatePrWithPush return value", () => {
		it('resolves "succeeded" after an existing PR is updated', async () => {
			const OPEN_PR = [
				{ number: 7, url: "https://gh/pr/7", title: "Existing title", body: "", state: "OPEN" },
			];
			setupExecFile(
				buildRouter({
					"git:rev-parse": () => ({ stdout: "feature/x\n" }),
					"git:push": () => ({ stdout: "" }),
					"gh:--version": () => ({ stdout: "gh 2.40\n" }),
					"gh:auth": () => ({ stdout: "ok\n" }),
					"gh:pr:list": () => ({ stdout: JSON.stringify(OPEN_PR) }),
					"gh:pr:edit": () => ({ stdout: "" }),
				}),
			);
			showInformationMessage.mockResolvedValue(undefined);

			const outcome = await handleUpdatePrWithPush("New title", "Body", CWD, postMessage, "feature/x");

			expect(outcome).toBe("succeeded");
		});

		it('resolves "failed" when lookup errors', async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/x\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					// Transient gh failure (auth/ratelimit) → lookupError.
					throw ghError({ message: "gh exit 4", code: 4, stderr: "HTTP 401: Bad credentials" });
				}
				return { stdout: "" };
			});

			const outcome = await handleUpdatePrWithPush("t", "b", CWD, postMessage, "feature/x");

			expect(outcome).toBe("failed");
		});

		it('resolves "succeeded" via the noPr→create fallback when the user confirms', async () => {
			// The open PR vanished (closed/merged) since the panel rendered; the
			// user confirms the "Create New PR" modal, push + create succeed.
			// Mirrors "falls back to creating a PR when the open PR vanished".
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse") return { stdout: "feature/x\n" };
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				if (cmd === "gh" && args[0] === "--version") return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: "https://gh/pr/9\n" };
				// Pre-push lookup → no open PR (noPr); post-create refresh also empty.
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
				return { stdout: "" };
			});
			showWarningMessage.mockResolvedValueOnce("Create New PR");
			showInformationMessage.mockResolvedValue(undefined);

			const outcome = await handleUpdatePrWithPush("t", "b", CWD, postMessage, "feature/x");

			expect(outcome).toBe("succeeded");
		});
	});
});
