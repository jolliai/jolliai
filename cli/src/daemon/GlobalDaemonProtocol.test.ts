import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GLOBAL_DAEMON_PROTOCOL,
	GLOBAL_HELLO_TIMEOUT_MS,
	globalSocketPath,
	parseGlobalDaemonHello,
	windowsUserKey,
} from "./GlobalDaemonProtocol.js";

describe("globalSocketPath", () => {
	it("uses one fixed filename per user — there is no path to encode", () => {
		expect(globalSocketPath({ platform: "linux", uid: 501 })).toBe(
			join(tmpdir(), ".jolli-global-501", "daemon.sock"),
		);
	});

	it("gives two users two sockets", () => {
		expect(globalSocketPath({ platform: "linux", uid: 501 })).not.toBe(
			globalSocketPath({ platform: "linux", uid: 502 }),
		);
	});

	it("uses a named pipe on win32", () => {
		expect(globalSocketPath({ platform: "win32", home: "C:\\Users\\ada" })).toBe(
			`\\\\.\\pipe\\jolli-global-${windowsUserKey("C:\\Users\\ada")}`,
		);
	});

	it("ignores uid on win32 — there is none to read there", () => {
		expect(globalSocketPath({ platform: "win32", home: "C:\\Users\\ada", uid: 501 })).toBe(
			globalSocketPath({ platform: "win32", home: "C:\\Users\\ada", uid: 502 }),
		);
	});

	// The bug this pins: `process.getuid` is undefined on win32, so a uid-keyed
	// pipe name defaulted every account on the machine onto `jolli-global-0`.
	// Asserted through the PRODUCTION default — no `home`, no `uid` — because
	// that is the only call shape any caller actually uses, and the previous
	// win32 test passed an explicit uid and so could never have caught it.
	it("keys the default win32 pipe on this user, not on a uid win32 does not have", () => {
		const derived = globalSocketPath({ platform: "win32" });
		expect(derived).toBe(`\\\\.\\pipe\\jolli-global-${windowsUserKey(homedir())}`);
		expect(derived).not.toBe("\\\\.\\pipe\\jolli-global-0");
	});

	it("gives two Windows accounts two pipes", () => {
		expect(globalSocketPath({ platform: "win32", home: "C:\\Users\\ada" })).not.toBe(
			globalSocketPath({ platform: "win32", home: "C:\\Users\\bob" }),
		);
	});

	it("folds case — one home spelled two ways is one daemon, not two", () => {
		expect(windowsUserKey("C:\\Users\\Ada")).toBe(windowsUserKey("c:/users/ada"));
	});

	it("defaults to process.platform and process.getuid() when called with no arguments", () => {
		const withDefaults = globalSocketPath();
		const withExplicit = globalSocketPath({
			platform: process.platform,
			uid: process.getuid?.() ?? 0,
			home: homedir(),
		});
		expect(withDefaults).toBe(withExplicit);
	});
});

describe("parseGlobalDaemonHello", () => {
	const valid = {
		t: "hello",
		protocol: GLOBAL_DAEMON_PROTOCOL,
		version: "0.99.3",
		pid: 4242,
		startedAt: 1_754_000_000_000,
	};

	it("accepts a well-formed hello", () => {
		expect(parseGlobalDaemonHello(JSON.stringify(valid))).toEqual(valid);
	});

	it("rejects a foreign protocol rather than guessing", () => {
		expect(parseGlobalDaemonHello(JSON.stringify({ ...valid, protocol: 99 }))).toBeUndefined();
	});

	it("rejects a hello missing startedAt", () => {
		const { startedAt: _dropped, ...withoutStartedAt } = valid;
		expect(parseGlobalDaemonHello(JSON.stringify(withoutStartedAt))).toBeUndefined();
	});

	it("rejects malformed JSON without throwing", () => {
		expect(parseGlobalDaemonHello("{")).toBeUndefined();
	});

	it("rejects a non-object payload", () => {
		expect(parseGlobalDaemonHello("42")).toBeUndefined();
	});

	it("rejects a hello with wrong t value", () => {
		expect(parseGlobalDaemonHello(JSON.stringify({ ...valid, t: "goodbye" }))).toBeUndefined();
	});

	it("rejects a literal null payload", () => {
		expect(parseGlobalDaemonHello("null")).toBeUndefined();
	});

	it("rejects when a required field has the wrong type", () => {
		expect(parseGlobalDaemonHello(JSON.stringify({ ...valid, pid: "4242" }))).toBeUndefined();
	});
});

describe("GLOBAL_HELLO_TIMEOUT_MS", () => {
	it("is far below the MCP handshake budget — this one rides a git hook", () => {
		expect(GLOBAL_HELLO_TIMEOUT_MS).toBe(300);
	});
});
