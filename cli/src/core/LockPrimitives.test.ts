/**
 * Tests for the reusable file-lock primitives. Focused on:
 *   - `isPidAlive` branches: invalid PIDs, our own PID, ESRCH (dead), EPERM
 *     (treated as alive defensively), generic errors (also alive)
 *
 * Acquire / release / refresh integration paths are exercised through the
 * concrete lock wrappers (`Locks.test.ts`, `SyncLock.test.ts`).
 */

import { describe, expect, it, vi } from "vitest";
import { isPidAlive } from "./LockPrimitives.js";

describe("isPidAlive", () => {
	it("returns false for non-integer PID input", () => {
		expect(isPidAlive("")).toBe(false);
		expect(isPidAlive("abc")).toBe(false);
		// Floats are rejected too — PIDs are always integers.
		expect(isPidAlive("12.5")).toBe(false);
	});

	it("returns false for zero / negative PIDs", () => {
		expect(isPidAlive("0")).toBe(false);
		expect(isPidAlive("-1")).toBe(false);
	});

	it("returns true for our own PID without invoking process.kill", () => {
		// Self-check optimization: skip the kill(2) syscall entirely.
		const killSpy = vi.spyOn(process, "kill");
		try {
			expect(isPidAlive(String(process.pid))).toBe(true);
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});

	it("returns true when process.kill(pid, 0) succeeds (process exists, signalable)", () => {
		// Force the kill check path by passing a PID different from ours.
		const otherPid = process.pid === 1 ? 2 : 1;
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(((_pid: number, _sig: number | string) => true) as typeof process.kill);
		try {
			expect(isPidAlive(String(otherPid))).toBe(true);
			expect(killSpy).toHaveBeenCalledWith(otherPid, 0);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("returns false when process.kill throws ESRCH (no such process — owner crashed)", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
			const err = new Error("kill ESRCH") as Error & { code?: string };
			err.code = "ESRCH";
			throw err;
		}) as typeof process.kill);
		try {
			expect(isPidAlive("99999")).toBe(false);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("returns true when process.kill throws EPERM (alive under another uid — refuse to steal)", () => {
		// Defensive treatment: a foreign-uid process IS running, we just
		// can't signal it. Returning false would let us steal another user's
		// lock — far worse than holding a stale-but-honest lock.
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
			const err = new Error("kill EPERM") as Error & { code?: string };
			err.code = "EPERM";
			throw err;
		}) as typeof process.kill);
		try {
			expect(isPidAlive("99999")).toBe(true);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("returns true for any non-ESRCH error (errs on the side of treating as alive)", () => {
		// Anything we don't recognize must not lead us to clobber another
		// process's lock. EINVAL, EACCES, undefined code, etc.
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
			const err = new Error("kill EINVAL") as Error & { code?: string };
			err.code = "EINVAL";
			throw err;
		}) as typeof process.kill);
		try {
			expect(isPidAlive("99999")).toBe(true);
		} finally {
			killSpy.mockRestore();
		}
	});
});
