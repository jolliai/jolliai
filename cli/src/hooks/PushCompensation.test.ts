import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toForwardSlash } from "../core/PathUtils.js";
import { triggerPendingPushRetry } from "./PushCompensation.js";

const CWD = resolve("/repo");

const h = vi.hoisted(() => {
	const child = {
		once: vi.fn(),
		unref: vi.fn(),
	};
	return {
		child,
		existsSync: vi.fn(),
		getCurrentTraceId: vi.fn(),
		spawnHidden: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	};
});

vi.mock("node:fs", () => ({ existsSync: h.existsSync }));
vi.mock("../core/PushPendingStore.js", () => ({ PUSH_PENDING_FILE: "push-pending.json" }));
vi.mock("../core/TraceContext.js", () => ({
	getCurrentTraceId: h.getCurrentTraceId,
	TRACE_ID_ENV: "JOLLI_TRACE_ID",
}));
vi.mock("../Logger.js", () => ({
	createLogger: vi.fn(() => ({ debug: h.debug, error: h.error })),
	errMsg: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
	getJolliMemoryDir: vi.fn((cwd: string) => `${cwd}/.jolli/jollimemory`),
}));
vi.mock("../util/Subprocess.js", () => ({ spawnHidden: h.spawnHidden }));

function pathEndsWith(path: unknown, suffix: string): boolean {
	return toForwardSlash(String(path)).endsWith(suffix);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.existsSync.mockImplementation(
		(path) => pathEndsWith(path, "/push-pending.json") || pathEndsWith(path, "/PrePushWorker.js"),
	);
	h.getCurrentTraceId.mockReturnValue(undefined);
	h.spawnHidden.mockReturnValue(h.child);
});

describe("triggerPendingPushRetry", () => {
	it("returns without spawning when there is no pending backlog", () => {
		h.existsSync.mockReturnValue(false);

		triggerPendingPushRetry(CWD, "cli-front-door");

		expect(h.spawnHidden).not.toHaveBeenCalled();
		expect(h.debug).toHaveBeenCalledWith("Push compensation (%s): no push-pending backlog", "cli-front-door");
	});

	it("spawns and unreferences the built worker with trace propagation", () => {
		h.getCurrentTraceId.mockReturnValue("0123456789abcdef0123456789abcdef");

		triggerPendingPushRetry(CWD, "cli-auth-login");

		expect(h.spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			[expect.stringMatching(/PrePushWorker\.js$/), "--cwd", CWD, "--trigger", "cli-auth-login"],
			expect.objectContaining({
				detached: true,
				stdio: "ignore",
				cwd: CWD,
				env: expect.objectContaining({ JOLLI_TRACE_ID: "0123456789abcdef0123456789abcdef" }),
			}),
		);
		expect(h.child.once).toHaveBeenCalledWith("error", expect.any(Function));
		expect(h.child.unref).toHaveBeenCalledTimes(1);
	});

	it("omits the environment override when there is no ambient trace", () => {
		triggerPendingPushRetry(CWD);

		const options = h.spawnHidden.mock.calls[0]?.[2];
		expect(options).not.toHaveProperty("env");
	});

	it("uses the tsx loader arguments for the source worker in development", () => {
		h.existsSync.mockImplementation((path) => {
			if (pathEndsWith(path, "/push-pending.json")) return true;
			return pathEndsWith(path, "/PrePushWorker.ts");
		});

		triggerPendingPushRetry(CWD);

		const args = h.spawnHidden.mock.calls[0]?.[1] as ReadonlyArray<string>;
		expect(args.slice(-5)).toEqual([
			expect.stringMatching(/PrePushWorker\.ts$/),
			"--cwd",
			CWD,
			"--trigger",
			"activation",
		]);
		expect(args.slice(0, -5)).toEqual(process.execArgv);
	});

	it("leaves the backlog for later when no worker entry exists", () => {
		h.existsSync.mockImplementation((path) => pathEndsWith(path, "/push-pending.json"));

		triggerPendingPushRetry(CWD, "cli-enable");

		expect(h.spawnHidden).not.toHaveBeenCalled();
		expect(h.error).toHaveBeenCalledWith("Push compensation (%s): PrePushWorker entry not found", "cli-enable");
	});

	it("swallows synchronous spawn failures", () => {
		h.spawnHidden.mockImplementation(() => {
			throw new Error("spawn failed");
		});

		expect(() => triggerPendingPushRetry(CWD, "vscode-activation")).not.toThrow();
		expect(h.debug).toHaveBeenCalledWith(
			"Push compensation (%s) trigger failed: %s",
			"vscode-activation",
			"spawn failed",
		);
	});

	it("swallows asynchronous worker startup failures", () => {
		triggerPendingPushRetry(CWD, "vscode-sign-in");
		const errorHandler = h.child.once.mock.calls[0]?.[1] as (error: Error) => void;

		expect(() => errorHandler(new Error("worker failed"))).not.toThrow();
		expect(h.debug).toHaveBeenCalledWith(
			"Push compensation (%s) worker failed to start: %s",
			"vscode-sign-in",
			"worker failed",
		);
	});
});
