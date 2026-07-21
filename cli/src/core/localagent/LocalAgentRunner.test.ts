import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runInvocation } from "./LocalAgentRunner.js";
import { LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

type FakeChild = EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough & { end: (s: string) => void };
	kill: (sig?: string) => void;
};

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough() as PassThrough & { end: (s: string) => void };
	child.kill = vi.fn();
	return child;
}

/** Wraps a pre-built {@link FakeChild} as a `spawnImpl` that always returns it. */
function spawnReturning(child: FakeChild) {
	// biome-ignore lint/suspicious/noExplicitAny: test double for spawn's return
	return () => child as any;
}

function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number | null; hang?: boolean }) {
	return () => {
		const child = makeFakeChild();
		if (!opts.hang) {
			setImmediate(() => {
				if (opts.stdout) child.stdout.write(opts.stdout);
				if (opts.stderr) child.stderr.write(opts.stderr);
				child.stdout.end();
				child.stderr.end();
				child.emit("close", opts.code ?? 0);
			});
		}
		// biome-ignore lint/suspicious/noExplicitAny: test double for spawn's return
		return child as any;
	};
}

const inv = { file: "/x/claude", args: ["-p"], stdin: "PROMPT", env: {}, cwd: "/tmp" };

describe("runInvocation", () => {
	it("resolves stdout on a clean exit", async () => {
		const out = await runInvocation(inv, { spawnImpl: fakeSpawn({ stdout: '{"ok":true}', code: 0 }) });
		expect(out).toBe('{"ok":true}');
	});

	it("reassembles a multi-byte UTF-8 code point split across two stdout chunks", async () => {
		// A single non-ASCII code point (here the Chinese "好", bytes E5 A5 BD)
		// can straddle two `data` chunks. Decoding each chunk in isolation would
		// corrupt the boundary byte; the runner must decode the concatenation.
		const child = makeFakeChild();
		const promise = runInvocation(inv, { spawnImpl: spawnReturning(child) });
		const full = Buffer.from('{"r":"好"}', "utf8");
		const cut = full.length - 1; // splits the last byte of "好" off
		child.stdout.write(full.subarray(0, cut));
		child.stdout.write(full.subarray(cut));
		child.stdout.end();
		child.emit("close", 0);
		await expect(promise).resolves.toBe('{"r":"好"}');
	});

	it("throws a setup error with a stderr tail on nonzero exit", async () => {
		await expect(
			runInvocation(inv, { spawnImpl: fakeSpawn({ stderr: "boom details", code: 1 }) }),
		).rejects.toThrowError(/boom details/);
	});

	it("throws a setup error instance (not just a message match) on nonzero exit", async () => {
		await expect(
			runInvocation(inv, { spawnImpl: fakeSpawn({ stderr: "boom details", code: 1 }) }),
		).rejects.toBeInstanceOf(LocalAgentSetupError);
	});

	it("resolves the stdout envelope on a NONZERO exit when stdout is non-empty", async () => {
		// `claude -p --output-format json` reports auth/API failures as an is_error
		// envelope on STDOUT while exiting 1. The runner must hand that stdout to
		// the caller (so the backend's parseResult can classify it, e.g. into an
		// auth error) rather than discarding it and rejecting with the empty stderr.
		const envelope = '{"is_error":true,"result":"OAuth session expired and could not be refreshed"}';
		const out = await runInvocation(inv, {
			spawnImpl: fakeSpawn({ stdout: envelope, stderr: "", code: 1 }),
		});
		expect(out).toBe(envelope);
	});

	it("still rejects on a nonzero exit when stdout is empty (opaque failure)", async () => {
		await expect(
			runInvocation(inv, { spawnImpl: fakeSpawn({ stderr: "opaque boom", code: 1 }) }),
		).rejects.toBeInstanceOf(LocalAgentSetupError);
	});

	it("throws a transient error on timeout and kills the child", async () => {
		await expect(runInvocation(inv, { timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }) })).rejects.toThrowError(
			LocalAgentTransientError,
		);
	});

	it("throws a setup error when the child process itself fails to spawn", async () => {
		const spawnImpl = () => {
			const child = makeFakeChild();
			setImmediate(() => child.emit("error", new Error("ENOENT: no such file")));
			// biome-ignore lint/suspicious/noExplicitAny: test double for spawn's return
			return child as any;
		};
		await expect(runInvocation(inv, { spawnImpl })).rejects.toThrowError(/ENOENT/);
		await expect(runInvocation(inv, { spawnImpl })).rejects.toBeInstanceOf(LocalAgentSetupError);
	});

	it("sends SIGTERM immediately on timeout, then escalates to SIGKILL after the grace period", async () => {
		vi.useFakeTimers();
		try {
			const child = makeFakeChild();
			const promise = runInvocation(inv, { timeoutMs: 20, spawnImpl: spawnReturning(child) });
			const assertion = expect(promise).rejects.toThrowError(LocalAgentTransientError);

			await vi.advanceTimersByTimeAsync(20);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

			await assertion;

			// Child ignored SIGTERM — after the grace period we escalate to SIGKILL.
			await vi.advanceTimersByTimeAsync(2000);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not crash when the stdin stream emits an error (e.g. EPIPE); the close event still settles the promise", async () => {
		// Simulates `claude` closing stdin before consuming the full prompt (fast
		// auth failure): the write emits an `error` on the stdin stream itself —
		// a separate EventEmitter from `child`. Without a listener, that's an
		// uncaught exception. We can't easily force Node's real PassThrough to
		// synchronously throw on `.end()`, so this test drives the fake child's
		// stdin `error` event directly and asserts the run still resolves via the
		// existing close handler, proving the stdin listener didn't interfere
		// with or duplicate that settlement.
		const child = makeFakeChild();
		const promise = runInvocation(inv, { spawnImpl: spawnReturning(child) });

		// Emit the stdin error before the close event, mirroring the real
		// ordering (write fails immediately, then the process exits).
		expect(() => child.stdin.emit("error", new Error("EPIPE: write after end"))).not.toThrow();

		child.stdout.write('{"ok":true}');
		child.stdout.end();
		child.emit("close", 0);

		await expect(promise).resolves.toBe('{"ok":true}');
	});

	it("settles only once: a late close/error after timeout is ignored", async () => {
		vi.useFakeTimers();
		try {
			const child = makeFakeChild();
			const promise = runInvocation(inv, { timeoutMs: 20, spawnImpl: spawnReturning(child) });
			const assertion = expect(promise).rejects.toThrowError(LocalAgentTransientError);
			await vi.advanceTimersByTimeAsync(20);
			await assertion;

			// These arrive after the promise already settled — must be no-ops, not
			// a second resolve/reject (which would be an unhandled rejection/no-op
			// but signals a settle-guard bug if it ever throws here).
			expect(() => child.emit("close", 0)).not.toThrow();
			expect(() => child.emit("error", new Error("late"))).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});
