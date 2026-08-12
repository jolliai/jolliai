import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	daemonSocketDir,
	encodeHandshakeLine,
	isCoreVersionNewer,
	isInSocketDir,
	isSocketDirSafe,
	parseDaemonGreeting,
} from "./DaemonHandshake.js";

describe("daemonSocketDir", () => {
	it("puts the prefix and uid in the directory name under tmpdir", () => {
		expect(daemonSocketDir("global", 501)).toBe(join(tmpdir(), ".jolli-global-501"));
	});

	it("gives two prefixes two directories for the same uid", () => {
		expect(daemonSocketDir("mcp", 501)).not.toBe(daemonSocketDir("global", 501));
	});
});

describe("isInSocketDir", () => {
	it("accepts a socket directly inside the given directory", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(dir, "daemon.sock"), dir, "linux")).toBe(true);
	});

	it("rejects a socket elsewhere", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(tmpdir(), "scratch.sock"), dir, "linux")).toBe(false);
	});

	it("is always false on win32, whose named pipes have no directory", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(dir, "daemon.sock"), dir, "win32")).toBe(false);
	});
});

// Real symlinks and real mode bits, so the stat call itself is what is under
// test. Windows has no ownership gate at all (see `isSocketDirSafe`).
describe.skipIf(process.platform === "win32")("isSocketDirSafe", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await mkdtemp(join(tmpdir(), "jolli-sockdir-"));
	});
	afterEach(async () => {
		await rm(scratch, { recursive: true, force: true });
	});

	it("accepts a directory this user owns with no group or other bits", () => {
		// `mkdtemp` creates 0700 — the control case, without which the rejection
		// below would pass even if the function rejected everything.
		expect(isSocketDirSafe(scratch, process.getuid?.() ?? 0)).toBe(true);
	});

	it("rejects a symlink, however safe its target is", async () => {
		const link = join(scratch, "link");
		await symlink(scratch, link);

		// The attack this gate exists to stop: on a shared `/tmp` another local
		// user wins the race to create `/tmp/.jolli-<flavour>-<uid>` and makes it a
		// symlink to a directory that DOES pass — 0700 and owned by us. Following
		// it answers "safe" about a path the attacker chose, and the daemon then
		// binds where they put it. A symlink is never our directory, so `lstat` is
		// the only primitive that can answer this question.
		expect(isSocketDirSafe(link, process.getuid?.() ?? 0)).toBe(false);
	});
});

describe("isCoreVersionNewer", () => {
	it("is strict so a tie attaches instead of retiring", () => {
		expect(isCoreVersionNewer("0.99.3", "0.99.3")).toBe(false);
	});

	it("ranks a higher patch as newer", () => {
		expect(isCoreVersionNewer("0.99.4", "0.99.3")).toBe(true);
	});

	it("treats the unrankable dev sentinel as equal in both directions", () => {
		expect(isCoreVersionNewer("dev", "0.99.3")).toBe(false);
		expect(isCoreVersionNewer("0.99.3", "dev")).toBe(false);
	});
});

describe("greeting framing", () => {
	it("round-trips a retire greeting through one NDJSON line", () => {
		const line = encodeHandshakeLine({ t: "retire" });
		expect(line.endsWith("\n")).toBe(true);
		expect(parseDaemonGreeting(line.trimEnd())).toEqual({ t: "retire" });
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseDaemonGreeting("{not json")).toBeUndefined();
	});

	it("returns undefined for an unknown verb", () => {
		expect(parseDaemonGreeting(JSON.stringify({ t: "explode" }))).toBeUndefined();
	});
});
