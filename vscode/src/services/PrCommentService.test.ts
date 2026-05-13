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

/**
 * Builds a `gh pr list --json …` stdout for a single PR.
 *
 * `gh pr list` returns an array; we wrap the input so callers can stay terse
 * (`prJson({ number: 7 })`). State / isCrossRepository default to "OPEN" /
 * `false` so the bulk of existing fixtures keep their semantics — they meant
 * "an editable PR exists for this branch".
 */
function prJson(pr: {
	number: number;
	url?: string;
	title?: string;
	body?: string;
	state?: "OPEN" | "CLOSED" | "MERGED";
	isCrossRepository?: boolean;
}): string {
	return JSON.stringify([
		{
			url: "",
			title: "",
			body: "",
			state: "OPEN" as const,
			isCrossRepository: false,
			...pr,
		},
	]);
}

/** Empty `gh pr list` response — drives the noPr branch in findPrForBranch. */
const PR_LIST_EMPTY = "[]";

/**
 * Routes `gh pr list` by its `--state` argument so a single test can program
 * both queries that `findPrForBranch` may make (first `--state open`, then
 * `--state all` as fallback). git/auth/version probes are stubbed to success.
 */
function setupListByState(opts: {
	currentBranch?: string;
	open: string;
	all: string;
}): void {
	setupExecFile((cmd, args) => {
		if (cmd === "git" && args[0] === "rev-parse") {
			return { stdout: `${opts.currentBranch ?? "feature/br"}\n` };
		}
		if (cmd === "gh" && args[0] === "--version") return { stdout: "gh 2.40\n" };
		if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
		if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
			const stateIdx = args.indexOf("--state");
			const state = stateIdx >= 0 ? args[stateIdx + 1] : "";
			return { stdout: state === "open" ? opts.open : opts.all };
		}
		return { stdout: "" };
	});
}

/** Counts how many `gh pr list` calls reached the mock — used to assert that
 * the open-hit happy path skips the second `--state all` query. */
function countPrListCalls(): number {
	return mockExecFileAsync.mock.calls.filter(
		(call: Array<unknown>) =>
			call[0] === "gh" &&
			Array.isArray(call[1]) &&
			(call[1] as Array<string>)[0] === "pr" &&
			(call[1] as Array<string>)[1] === "list",
	).length;
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
					return { stdout: prJson(prData) };
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
					return { stdout: PR_LIST_EMPTY };
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
				if (cmd === "gh" && args[0] === "pr") {
					return { stdout: PR_LIST_EMPTY };
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
					return { stdout: PR_LIST_EMPTY };
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
					return { stdout: prJson(prData) };
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
						stdout: prJson({ number: 0, url: "", title: "", body: "" }),
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
				stdout: prJson({
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

		it("posts noPr with branch name when gh pr list returns an empty array (no PR exists)", async () => {
			// `gh pr list` never errors when no PR matches — it returns `[]`.
			// The Task-1 noPr arm therefore replaces the old "stderr says no
			// pull requests found" path: empty stdout array, no warn, no debug.
			setupHappyProbesWithPrHandler(() => ({ stdout: PR_LIST_EMPTY }));

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).not.toHaveBeenCalled();
			expect(debug).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
		});

		it("posts unavailable (NOT noPr) when gh pr list fails with a non-expected stderr (e.g. auth/ratelimit)", async () => {
			// I-1 contract change: auth lapses, rate limits, and other gh
			// non-zero exits used to be folded into noPr — leading the user
			// to click Create PR and either fail or duplicate. Now they
			// surface as `unavailable` with the real stderr in `reason`, and
			// the UI shows Retry.
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
					/gh pr list --state open failed for branch feature\/br.*code=1.*stderr:.*authentication required/s,
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
					return { stdout: PR_LIST_EMPTY };
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
				}),
			);
		});

		it("strict branch routing: summaryBranch wins over currentBranch even when stale (post-rename)", async () => {
			// Contract: after `git branch -m feature/old feature/new`, the
			// summary still points at `feature/old`. We MUST query
			// `feature/old` and report `noPr` for it — NOT silently retarget
			// to `feature/new` or to currentBranch. Auto-recovery from
			// renames is a separate spike (see plan doc "Out of scope").
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
					return { stdout: PR_LIST_EMPTY };
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
					return { stdout: PR_LIST_EMPTY };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(prListHeadArg).toBe("feature/current");
		});

		// ── state dispatch + previousPr + cross-repo + future state ──────────
		//
		// These pin the Task-1/Task-2 contract: findPrForBranch must prefer
		// OPEN over historic state, must skip cross-repository PRs and unknown
		// states, and the dispatch must hand the right shape to the webview.

		it("posts ready (no previousPr) when --state open hits an OPEN PR and skips the --state all call", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: prJson({
					number: 7,
					url: "https://pr/7",
					title: "Open PR",
					state: "OPEN",
				}),
				all: prJson({ number: 999, state: "MERGED" }), // never reached
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "ready",
				pr: { number: 7, url: "https://pr/7", title: "Open PR" },
			});
			// Confirm no `previousPr` leaked into the ready payload.
			const readyCall = postMessage.mock.calls.find(
				(c) => (c[0] as { status?: string }).status === "ready",
			);
			expect(readyCall?.[0]).not.toHaveProperty("previousPr");
			// And the historic-state fallback query never ran.
			expect(countPrListCalls()).toBe(1);
		});

		it("posts noPr + previousPr.state=MERGED when --state open is empty and --state all returns a MERGED PR", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({
					number: 42,
					url: "https://pr/42",
					title: "Merged",
					state: "MERGED",
				}),
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/br",
				previousPr: {
					number: 42,
					url: "https://pr/42",
					state: "MERGED",
				},
			});
			// Both queries fired — open (empty) then all (hit).
			expect(countPrListCalls()).toBe(2);
		});

		it("posts noPr + previousPr.state=CLOSED when --state open is empty and --state all returns a CLOSED PR", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({
					number: 11,
					url: "https://pr/11",
					title: "Closed",
					state: "CLOSED",
				}),
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({
				command: "prStatus",
				status: "noPr",
				branch: "feature/br",
				previousPr: {
					number: 11,
					url: "https://pr/11",
					state: "CLOSED",
				},
			});
		});

		it("treats an unrecognised PR state as noPr and warns about it (defense-in-depth)", async () => {
			// Future-proofing: if GitHub adds a fourth state value (e.g.
			// "FROZEN" or "ARCHIVED"), don't render a confident UI — degrade
			// to noPr with a warn log so the user can still Create PR.
			setupListByState({
				currentBranch: "feature/br",
				open: prJson({ number: 5, state: "FROZEN" as never }),
				all: PR_LIST_EMPTY,
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('unexpected state "FROZEN"'),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ status: "ready" }),
			);
		});

		it("treats a cross-repository (fork) PR as noPr — falls back through both queries", async () => {
			// `gh pr list --head <branch>` matches fork heads of the same name
			// because the manual doesn't accept `<owner>:<branch>`. Filtering
			// `isCrossRepository === true` keeps Edit PR from binding to a
			// stranger's PR; the safe degradation is "show Create PR".
			setupListByState({
				currentBranch: "feature/br",
				open: prJson({
					number: 100,
					state: "OPEN",
					isCrossRepository: true,
				}),
				all: prJson({
					number: 101,
					state: "MERGED",
					isCrossRepository: true,
				}),
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(debug).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining(
					"Ignoring cross-repository PR #100 for branch feature/br",
				),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ status: "noPr", branch: "feature/br" }),
			);
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ previousPr: expect.anything() }),
			);
		});

		it("tryExecGh wraps non-Error rejections into Error so lookupError still carries a reason", async () => {
			// Defensive coverage for the `e instanceof Error ? e : new Error(String(e))`
			// branch in tryExecGh — exercised when gh rejects with a non-Error value
			// (very rare but possible if a future Node child_process runtime tweak
			// skips the Error wrap). The reason field must still contain the
			// stringified rejection so the webview shows it instead of a blank pane.
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					throw "raw string rejection";
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "unavailable",
					reason: expect.stringContaining("raw string rejection"),
				}),
			);
		});

		it("does NOT issue a second --state all call when --state open errors (avoid duplicate failure)", async () => {
			// Reflects the Task-1 decision: an error on the first query bubbles
			// to lookupError immediately so the user gets one accurate reason,
			// rather than two warn logs and a misleading "no PR" fallback.
			let openCalled = false;
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const stateIdx = args.indexOf("--state");
					const state = stateIdx >= 0 ? args[stateIdx + 1] : "";
					if (state === "open") {
						openCalled = true;
						throw ghError({
							message: "gh: exit 1",
							code: 1,
							stderr: "network down",
						});
					}
					// If we ever fall through here, the test fails the assertion below.
					return { stdout: PR_LIST_EMPTY };
				}
				return { stdout: "" };
			});

			await handleCheckPrStatus(CWD, postMessage);

			expect(openCalled).toBe(true);
			expect(countPrListCalls()).toBe(1);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "unavailable",
					reason: expect.stringContaining("network down"),
				}),
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
					"gh:pr:list": () => ({
						stdout: prJson({
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
					"gh:pr:list": () => ({
						stdout: prJson({
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
					"gh:pr:list": () => ({
						stdout: prJson({
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

		// ── Cross-branch guard (Memory Bank) ─────────────────────────────────
		//
		// When the user is viewing a summary on branch X while checked out on
		// branch Y, `git push -u origin HEAD` would push Y's commits to X's PR
		// — silently wrong. The service-side guard must reject before any
		// push/create runs.

		it("cross-branch: rejects with prCreateBlockedCrossBranch and skips push/create when summaryBranch differs from currentBranch", async () => {
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
				buildRouter({
					"git:rev-parse": () => ({ stdout: "feature/same\n" }),
					"git:push": () => {
						gitPushCalled = true;
						return { stdout: "" };
					},
					"gh:pr:create": () => ({ stdout: `${prUrl}\n` }),
					"git:rev-list": () => ({ stdout: "1\n" }),
					"gh:--version": () => ({ stdout: "gh 2.40.0\n" }),
					"gh:auth": () => ({ stdout: "ok\n" }),
					"gh:pr:list": () => ({
						stdout: prJson({
							number: 123,
							url: prUrl,
							title: "OK",
							body: "",
						}),
					}),
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

		it("refresh after successful Create PR flips section from MERGED+previousPr to ready (Task 6 regression)", async () => {
			// Two-phase scenario across one `mockExecFileAsync.mockImplementation`:
			//   Phase A (before pr create): --state open returns []; --state all
			//                                returns a historic MERGED PR — the
			//                                webview should see noPr + previousPr.
			//   Phase B (after pr create):  --state open returns the new OPEN PR;
			//                                the post-create refresh should
			//                                surface it as ready without `previousPr`.
			let phase: "before" | "after" = "before";
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "git" && args[0] === "push") return { stdout: "" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
					phase = "after";
					return { stdout: "https://pr/200\n" };
				}
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					const stateIdx = args.indexOf("--state");
					const state = stateIdx >= 0 ? args[stateIdx + 1] : "";
					if (phase === "before") {
						if (state === "open") return { stdout: PR_LIST_EMPTY };
						return {
							stdout: prJson({
								number: 100,
								url: "https://pr/100",
								title: "Old merged",
								state: "MERGED",
							}),
						};
					}
					// Phase B: the new OPEN PR exists; --state all must not be
					// queried because findPrForBranch returns on the open hit.
					if (state === "open") {
						return {
							stdout: prJson({
								number: 200,
								url: "https://pr/200",
								title: "New PR",
								state: "OPEN",
							}),
						};
					}
					return { stdout: PR_LIST_EMPTY };
				}
				return { stdout: "" };
			});

			// Phase A: assert the pre-create section dispatched noPr + MERGED.
			await handleCheckPrStatus(CWD, postMessage);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "noPr",
					previousPr: expect.objectContaining({ state: "MERGED" }),
				}),
			);

			postMessage.mockClear();

			// Phase B: handleCreatePr flips phase via gh pr create, then its
			// internal handleCheckPrStatus must dispatch ready with the new PR.
			await handleCreatePr("New PR", "Body", CWD, postMessage);

			const readyCalls = postMessage.mock.calls.filter(
				(c) => (c[0] as { status?: string }).status === "ready",
			);
			expect(readyCalls).toHaveLength(1);
			expect(readyCalls[0][0]).toEqual({
				command: "prStatus",
				status: "ready",
				pr: { number: 200, url: "https://pr/200", title: "New PR" },
			});
			expect(readyCalls[0][0]).not.toHaveProperty("previousPr");
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
						stdout: prJson({
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: prJson({
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
					return { stdout: PR_LIST_EMPTY };
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
						stdout: prJson({
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
						stdout: prJson({
							number: 5,
							url: "https://url",
							title: "T",
							body: "",
						}),
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

		// ── Task 3: state-guarded prepareUpdatePr ────────────────────────────
		//
		// When `findPrForBranch` returns a terminal-state PR (the panel's
		// retainContextWhenHidden lets the user click a stale Edit PR after
		// an external merge/close), prepareUpdatePr must refuse to assemble
		// the form, warn explicitly, and re-emit prStatus so the section
		// rebuilds with the noPr + previousPr view (button stops being stuck).

		it("refuses to open the update form when PR is MERGED and repaints the section + warns", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({
					number: 42,
					url: "https://pr/42",
					title: "Merged",
					state: "MERGED",
				}),
			});

			await handlePrepareUpdatePr("body", CWD, postMessage);

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "prShowUpdateForm" }),
			);
			expect(showWarningMessage).toHaveBeenCalledWith(
				"PR #42 is merged — open a new PR instead.",
			);
			// prStatus repaint flips the main area to noPr + previousPr so
			// the Edit PR button (Loading state) is discarded by the rebuild.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "noPr",
					previousPr: expect.objectContaining({
						number: 42,
						state: "MERGED",
					}),
				}),
			);
		});

		it("refuses to open the update form when PR is CLOSED and repaints + warns", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({
					number: 13,
					url: "https://pr/13",
					title: "Closed",
					state: "CLOSED",
				}),
			});

			await handlePrepareUpdatePr("body", CWD, postMessage);

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "prShowUpdateForm" }),
			);
			expect(showWarningMessage).toHaveBeenCalledWith(
				"PR #13 is closed — open a new PR instead.",
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					previousPr: expect.objectContaining({ state: "CLOSED" }),
				}),
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return { stdout: prJson(pr) };
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
				return { stdout: PR_LIST_EMPTY };
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
						stdout: prJson({
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return {
						stdout: prJson({
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
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					return { stdout: prJson(pr) };
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
						stdout: prJson({
							number: 11,
							url: "https://url",
							title: "T",
							body: "",
						}),
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

		// ── Task 3: state guard + symmetric repaint on noPr/lookupError ─────

		it("refuses to update when PR is MERGED — clears Updating loading and repaints + warns", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({
					number: 42,
					url: "https://pr/42",
					title: "Merged",
					state: "MERGED",
				}),
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			// Loading dismissed first so the form's Submit doesn't stay spinning.
			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			// No gh pr edit was attempted.
			const editCalls = mockExecFileAsync.mock.calls.filter(
				(c: Array<unknown>) =>
					c[0] === "gh" &&
					Array.isArray(c[1]) &&
					(c[1] as Array<string>)[1] === "edit",
			);
			expect(editCalls).toHaveLength(0);
			// Section repaint flips the main area to noPr + previousPr.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "noPr",
					previousPr: expect.objectContaining({ state: "MERGED" }),
				}),
			);
			expect(showWarningMessage).toHaveBeenCalledWith(
				"PR #42 was merged between checking and updating — open a new PR instead.",
			);
		});

		it("refuses to update when PR is CLOSED with the same clear-loading + repaint + warn shape", async () => {
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: prJson({ number: 13, state: "CLOSED" }),
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showWarningMessage).toHaveBeenCalledWith(
				"PR #13 was closed between checking and updating — open a new PR instead.",
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					previousPr: expect.objectContaining({ state: "CLOSED" }),
				}),
			);
		});

		it("noPr path also repaints the section (symmetric with handlePrepareUpdatePr)", async () => {
			// Pre-fix asymmetry: updatePr only emitted prUpdateFailed and
			// left the main area on a stale ready view. Now both Update form
			// (Submit → prUpdateFailed) AND the main section (Edit PR button)
			// get re-synced when the PR vanishes mid-submit.
			setupListByState({
				currentBranch: "feature/br",
				open: PR_LIST_EMPTY,
				all: PR_LIST_EMPTY,
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			// The repaint sent a noPr prStatus, no previousPr (truly no PR).
			const prStatusCalls = postMessage.mock.calls.filter(
				(c) => (c[0] as { command?: string }).command === "prStatus",
			);
			expect(prStatusCalls).toHaveLength(1);
			expect(prStatusCalls[0][0]).toEqual({
				command: "prStatus",
				status: "noPr",
				branch: "feature/br",
			});
		});

		it("lookupError path also repaints the section (symmetric with handlePrepareUpdatePr)", async () => {
			setupExecFile((cmd, args) => {
				if (cmd === "git" && args[0] === "rev-parse")
					return { stdout: "feature/br\n" };
				if (cmd === "gh" && args[0] === "--version")
					return { stdout: "gh 2.40\n" };
				if (cmd === "gh" && args[0] === "auth") return { stdout: "ok\n" };
				if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
					throw ghError({
						message: "gh: exit 1",
						code: 1,
						stderr: "network down",
					});
				}
				return { stdout: "" };
			});

			await handleUpdatePr("T", "B", CWD, postMessage);

			expect(postMessage).toHaveBeenCalledWith({ command: "prUpdateFailed" });
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("network down"),
			);
			// The repaint surfaces the same reason via prStatus.unavailable.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "prStatus",
					status: "unavailable",
					reason: expect.stringContaining("network down"),
				}),
			);
		});
	});

	// ─── buildPrMessageScript: previousPr rendering (Task 4) ───────────────

	describe("buildPrMessageScript previousPr rendering", () => {
		it("includes the previousPr branch in the noPr handler with DOM-safe construction", () => {
			const js = buildPrMessageScript();
			// The branch reads `msg.previousPr` (presence triggers the link).
			expect(js).toContain("msg.previousPr");
			// Anchor is built via DOM API — no innerHTML, no inline events.
			expect(js).toContain("document.createElement('a')");
			expect(js).not.toContain("innerHTML");
			// state suffix is lowercased on render so users see "(merged)".
			expect(js).toContain("msg.previousPr.state.toLowerCase()");
			// "Previous PR #" literal is what the user reads above Create PR.
			expect(js).toContain("'Previous PR #'");
			// Sanity: the textContent reset on the noPr branch must occur so
			// a "ready → noPr" transition doesn't leave the ready anchor in
			// the DOM for the Cancel handler's firstChild test to resurface.
			const noPrIdx = js.indexOf("s === 'noPr'");
			const readyIdx = js.indexOf("s === 'ready'");
			expect(noPrIdx).toBeGreaterThan(0);
			expect(readyIdx).toBeGreaterThan(noPrIdx);
			const noPrBlock = js.slice(noPrIdx, readyIdx);
			expect(noPrBlock).toContain("prLinkRow.textContent = ''");
		});
	});

	// ─── buildPrSectionScript: Cancel firstChild visibility (Task 5) ───────

	describe("buildPrSectionScript Cancel handler firstChild visibility", () => {
		it("decides link-row visibility off prLinkRow.firstChild (not blanket hide)", () => {
			const js = buildPrSectionScript();
			// Cancel handler must keep a "Previous PR #N" anchor visible when
			// it survived the form-show, but hide an empty link row.
			expect(js).toContain("prLinkRow.firstChild");
			// Both branches present — the firstChild test must drive show/hide.
			expect(js).toContain("prShow(prLinkRow)");
			expect(js).toContain("prHide(prLinkRow)");
		});
	});
});
