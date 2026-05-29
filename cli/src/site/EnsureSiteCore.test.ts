import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module mocks ───────────────────────────────────────────────────────────

const mockResolve = vi.fn<(specifier: string) => string>();
const mockCreateRequire = vi.fn(() => ({ resolve: mockResolve }));
const mockSpawn = vi.fn();
const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: mockClose }));

vi.mock("node:module", () => ({
	createRequire: mockCreateRequire,
}));

vi.mock("../util/Subprocess.js", () => ({
	spawnHidden: mockSpawn,
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

// ─── Test helpers ───────────────────────────────────────────────────────────

function buildSpawnChild(): EventEmitter {
	// `spawn` returns a ChildProcess that emits 'exit' / 'error'. We don't
	// need the full surface area — an EventEmitter that we control via
	// `emit("exit", code)` is enough.
	return new EventEmitter();
}

function expectExit(): { exitMock: ReturnType<typeof vi.spyOn> } {
	// We throw a tagged sentinel from the mock so the function under test
	// halts where the real `process.exit` would. The assertion in each test
	// just looks for exit code 1.
	const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`__exit_${code}__`);
	});
	return { exitMock };
}

function silenceStderr(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("isSiteCoreInstalled", () => {
	beforeEach(() => {
		vi.resetModules();
		mockResolve.mockReset();
	});

	it("returns true when require.resolve succeeds", async () => {
		mockResolve.mockReturnValue("/fake/path/index.js");
		const { isSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		expect(isSiteCoreInstalled()).toBe(true);
		expect(mockResolve).toHaveBeenCalledWith("@jolli.ai/site-core");
	});

	it("returns false when require.resolve throws MODULE_NOT_FOUND", async () => {
		mockResolve.mockImplementation(() => {
			const err = new Error("Cannot find module '@jolli.ai/site-core'");
			(err as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
			throw err;
		});
		const { isSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		expect(isSiteCoreInstalled()).toBe(false);
	});

	it("returns false on any other resolve error too (avoid leaking exceptions)", async () => {
		mockResolve.mockImplementation(() => {
			throw new Error("unexpected resolve error");
		});
		const { isSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		// Defensive — production code shouldn't crash if Node hands back an
		// odd error subclass. `try/catch` in the implementation handles this.
		expect(isSiteCoreInstalled()).toBe(false);
	});
});

describe("ensureSiteCoreInstalled — already installed", () => {
	beforeEach(() => {
		vi.resetModules();
		mockResolve.mockReset();
		mockSpawn.mockReset();
		mockCreateInterface.mockClear();
	});

	it("returns immediately, no prompt, no spawn", async () => {
		mockResolve.mockReturnValue("/fake/path/index.js");
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).resolves.toBeUndefined();
		expect(mockCreateInterface).not.toHaveBeenCalled();
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("ensureSiteCoreInstalled — missing + non-TTY", () => {
	let stdinTTYOriginal: boolean | undefined;
	let errSpy: ReturnType<typeof silenceStderr>;
	let exitInfo: ReturnType<typeof expectExit>;

	beforeEach(() => {
		vi.resetModules();
		mockResolve.mockReset();
		mockResolve.mockImplementation(() => {
			const err = new Error("Cannot find module");
			(err as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
			throw err;
		});
		stdinTTYOriginal = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
		errSpy = silenceStderr();
		exitInfo = expectExit();
	});

	afterEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTTYOriginal });
		errSpy.mockRestore();
		exitInfo.exitMock.mockRestore();
	});

	it("prints manual install instructions and exits 1", async () => {
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).rejects.toThrow("__exit_1__");
		expect(exitInfo.exitMock).toHaveBeenCalledWith(1);
		const printed = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(printed).toMatch(/Site rendering requires/);
		expect(printed).toMatch(/npm install -g @jolli\.ai\/site-core/);
	});

	it("does not prompt or spawn npm", async () => {
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).rejects.toThrow();
		expect(mockCreateInterface).not.toHaveBeenCalled();
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("ensureSiteCoreInstalled — missing + TTY", () => {
	let stdinTTYOriginal: boolean | undefined;
	let errSpy: ReturnType<typeof silenceStderr>;
	let exitInfo: ReturnType<typeof expectExit>;

	beforeEach(() => {
		vi.resetModules();
		mockResolve.mockReset();
		mockResolve.mockImplementation(() => {
			const err = new Error("Cannot find module");
			(err as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
			throw err;
		});
		mockSpawn.mockReset();
		mockQuestion.mockReset();
		mockClose.mockReset();
		mockCreateInterface.mockClear();
		stdinTTYOriginal = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		errSpy = silenceStderr();
		exitInfo = expectExit();
	});

	afterEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTTYOriginal });
		errSpy.mockRestore();
		exitInfo.exitMock.mockRestore();
	});

	it("answer 'n' → exits 1 with abort message", async () => {
		mockQuestion.mockImplementation((_q, cb) => cb("n"));
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).rejects.toThrow("__exit_1__");
		expect(exitInfo.exitMock).toHaveBeenCalledWith(1);
		expect(mockClose).toHaveBeenCalled();
		expect(mockSpawn).not.toHaveBeenCalled();
		const printed = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(printed).toMatch(/Aborted/);
	});

	it("empty answer (just Enter) defaults to yes → spawns npm install", async () => {
		mockQuestion.mockImplementation((_q, cb) => cb(""));
		mockSpawn.mockImplementation(() => {
			const child = buildSpawnChild();
			setImmediate(() => child.emit("exit", 0));
			return child;
		});
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).resolves.toBeUndefined();
		expect(mockSpawn).toHaveBeenCalledWith(
			"npm",
			["install", "-g", "@jolli.ai/site-core@^0.1.0"],
			expect.objectContaining({ stdio: "inherit" }),
		);
	});

	it("answer 'yes' → spawns npm install", async () => {
		mockQuestion.mockImplementation((_q, cb) => cb("yes"));
		mockSpawn.mockImplementation(() => {
			const child = buildSpawnChild();
			setImmediate(() => child.emit("exit", 0));
			return child;
		});
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).resolves.toBeUndefined();
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	it("npm install exits non-zero → rejects with descriptive error", async () => {
		mockQuestion.mockImplementation((_q, cb) => cb("y"));
		mockSpawn.mockImplementation(() => {
			const child = buildSpawnChild();
			setImmediate(() => child.emit("exit", 42));
			return child;
		});
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).rejects.toThrow(/npm install failed \(exit 42\)/);
		const printed = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(printed).toMatch(/exited with code 42/);
	});

	it("npm spawn 'error' event → rejects and prints manual command", async () => {
		mockQuestion.mockImplementation((_q, cb) => cb("y"));
		mockSpawn.mockImplementation(() => {
			const child = buildSpawnChild();
			setImmediate(() => child.emit("error", new Error("ENOENT")));
			return child;
		});
		const { ensureSiteCoreInstalled } = await import("./EnsureSiteCore.js");
		await expect(ensureSiteCoreInstalled()).rejects.toThrow(/ENOENT/);
		const printed = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
		expect(printed).toMatch(/Failed to spawn npm/);
	});
});
