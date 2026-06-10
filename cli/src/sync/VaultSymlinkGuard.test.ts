import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNoSymlinksInPath, assertNoSymlinksInPathSync, safeAtomicWriteSync } from "./VaultSymlinkGuard.js";

describe("assertNoSymlinksInPath", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "vault-symlink-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("accepts a clean target (no symlinks anywhere in chain)", async () => {
		mkdirSync(join(vault, "myrepo", ".jolli", "summaries"), { recursive: true });
		await expect(
			assertNoSymlinksInPath(vault, join(vault, "myrepo", ".jolli", "summaries", "abc.json")),
		).resolves.toBeUndefined();
	});

	it("accepts a target whose path segments don't exist yet (mkdir will create them)", async () => {
		// Cold-start path: nothing under <vault>/myrepo/ exists yet, the
		// caller is about to write `myrepo/.jolli/summaries/abc.json`. The
		// guard must not throw on ENOENT segments.
		await expect(
			assertNoSymlinksInPath(vault, join(vault, "myrepo", ".jolli", "summaries", "abc.json")),
		).resolves.toBeUndefined();
	});

	it("rejects a symlink at the FIRST intermediate segment (repo folder)", async () => {
		// Build a /tmp dir we control + a symlink at <vault>/evil → /tmp.
		// Writing to <vault>/evil/anything would escape the vault entirely.
		const escapeTarget = mkdtempSync(join(tmpdir(), "escape-"));
		try {
			symlinkSync(escapeTarget, join(vault, "evil"), "dir");
			await expect(assertNoSymlinksInPath(vault, join(vault, "evil", "leak.json"))).rejects.toThrow(
				/path segment is a symlink/,
			);
		} finally {
			rmSync(escapeTarget, { recursive: true, force: true });
		}
	});

	it("rejects a symlink at an INNER segment (the .jolli case from the threat model)", async () => {
		// <vault>/myrepo/.jolli → some other directory. mkdirSync(...
		// summaries) on that path would create the dir inside the symlink
		// target — atomicWrite would then write+rename into the foreign
		// location.
		mkdirSync(join(vault, "myrepo"), { recursive: true });
		const escapeTarget = mkdtempSync(join(tmpdir(), "escape-"));
		try {
			symlinkSync(escapeTarget, join(vault, "myrepo", ".jolli"), "dir");
			await expect(
				assertNoSymlinksInPath(vault, join(vault, "myrepo", ".jolli", "summaries", "abc.json")),
			).rejects.toThrow(/path segment is a symlink/);
		} finally {
			rmSync(escapeTarget, { recursive: true, force: true });
		}
	});

	it("rejects a regular file where a directory is expected", async () => {
		// Someone replaced <vault>/myrepo with a file. mkdirSync would
		// fail anyway, but the guard's error is clearer than ENOTDIR.
		writeFileSync(join(vault, "myrepo"), "not a dir");
		await expect(assertNoSymlinksInPath(vault, join(vault, "myrepo", ".jolli", "index.json"))).rejects.toThrow(
			/not a directory/,
		);
	});

	it("does NOT check the leaf (caller's O_NOFOLLOW handles that)", async () => {
		// The leaf can be a symlink and the guard still passes — leaf
		// protection is delegated to the caller's openSync(O_NOFOLLOW).
		// This split exists so the per-write hot path doesn't double-stat.
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "leaf-target"), "target");
		symlinkSync(join(vault, "leaf-target"), join(vault, "myrepo", ".jolli", "index.json"), "file");
		await expect(
			assertNoSymlinksInPath(vault, join(vault, "myrepo", ".jolli", "index.json")),
		).resolves.toBeUndefined();
	});

	it("rejects a target OUTSIDE the vault (path escape)", async () => {
		// Caller passed an absTargetPath that's not actually inside
		// vaultRoot. Could happen via a bug in path-joining. Defence in
		// depth.
		await expect(assertNoSymlinksInPath(vault, "/etc/passwd")).rejects.toThrow(/not inside vault/);
	});

	it("rejects relative paths (caller contract: both args absolute)", async () => {
		await expect(assertNoSymlinksInPath(vault, "myrepo/.jolli/index.json")).rejects.toThrow(/must be absolute/);
		await expect(assertNoSymlinksInPath("relative-vault", join(vault, "x.json"))).rejects.toThrow(
			/must be absolute/,
		);
	});
});

// The sync twin shares the exact contract of the async function; these mirror
// the async cases so FolderStorage's sync atomicWrite path is equally guarded.
describe("assertNoSymlinksInPathSync", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "vault-symlink-sync-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("accepts a clean target and tolerates not-yet-existing segments", () => {
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		expect(() =>
			assertNoSymlinksInPathSync(vault, join(vault, "myrepo", ".jolli", "summaries", "abc.json")),
		).not.toThrow();
		// ENOENT tail (nothing under <vault>/cold/ exists) must not throw.
		expect(() => assertNoSymlinksInPathSync(vault, join(vault, "cold", "x", "y.json"))).not.toThrow();
	});

	it("rejects a symlink in the path chain", () => {
		mkdirSync(join(vault, "myrepo"), { recursive: true });
		const escapeTarget = mkdtempSync(join(tmpdir(), "escape-"));
		try {
			symlinkSync(escapeTarget, join(vault, "myrepo", ".jolli"), "dir");
			expect(() =>
				assertNoSymlinksInPathSync(vault, join(vault, "myrepo", ".jolli", "summaries", "abc.json")),
			).toThrow(/path segment is a symlink/);
		} finally {
			rmSync(escapeTarget, { recursive: true, force: true });
		}
	});

	it("rejects a regular file where a directory is expected", () => {
		writeFileSync(join(vault, "myrepo"), "not a dir");
		expect(() => assertNoSymlinksInPathSync(vault, join(vault, "myrepo", ".jolli", "index.json"))).toThrow(
			/not a directory/,
		);
	});

	it("rejects a target outside the vault and non-absolute args", () => {
		expect(() => assertNoSymlinksInPathSync(vault, "/etc/passwd")).toThrow(/not inside vault/);
		expect(() => assertNoSymlinksInPathSync(vault, "myrepo/x.json")).toThrow(/must be absolute/);
		expect(() => assertNoSymlinksInPathSync("rel-vault", join(vault, "x.json"))).toThrow(/must be absolute/);
	});
});

describe("safeAtomicWriteSync", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "vault-safewrite-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("writes string content atomically, creating parent dirs, and leaves no .tmp behind", () => {
		const target = join(vault, "myrepo", ".jolli", "index.json");
		safeAtomicWriteSync(vault, target, '{"k":1}');
		expect(readFileSync(target, "utf-8")).toBe('{"k":1}');
		expect(() => lstatSync(`${target}.tmp`)).toThrow(); // tmp renamed away
	});

	it("writes Buffer content (the binary branch)", () => {
		const target = join(vault, "myrepo", "blob.bin");
		const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
		safeAtomicWriteSync(vault, target, buf);
		expect(readFileSync(target).equals(buf)).toBe(true);
	});

	it("refuses to write through a symlinked path segment", () => {
		mkdirSync(join(vault, "myrepo"), { recursive: true });
		const escapeTarget = mkdtempSync(join(tmpdir(), "escape-"));
		try {
			symlinkSync(escapeTarget, join(vault, "myrepo", ".jolli"), "dir");
			expect(() => safeAtomicWriteSync(vault, join(vault, "myrepo", ".jolli", "x.json"), "leak")).toThrow(
				/symlink/,
			);
		} finally {
			rmSync(escapeTarget, { recursive: true, force: true });
		}
	});
});
