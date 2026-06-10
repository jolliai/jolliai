import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__vaultLockCanonicalForTesting as canonicalise,
	canonicaliseLocalFolder,
	getVaultWriteLockPath,
} from "./VaultLockPath.js";

describe("canonicaliseLocalFolder", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "vaultlockpath-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it('rejects empty input loudly — caller has a bug if it passes ""', () => {
		expect(() => canonicaliseLocalFolder("")).toThrow("empty input");
	});

	it("returns an absolute path for a relative input", () => {
		// Relative paths resolve against `process.cwd()`. The exact result
		// depends on where the test runs, so assert structural properties
		// (absolute + ends with the input segment) rather than literal value.
		const out = canonicaliseLocalFolder("some-relative-dir");
		expect(out.startsWith(sep) || /^[A-Za-z]:\\/.test(out)).toBe(true);
		expect(out.endsWith("some-relative-dir") || out.endsWith("some-relative-dir".toLowerCase())).toBe(true);
	});

	it("collapses duplicate separators", () => {
		const out = canonicaliseLocalFolder(`${tmpRoot}${sep}${sep}sub${sep}${sep}leaf`);
		// No `//` or `\\` runs (after step 5).
		expect(out).not.toMatch(/[/\\]{2,}/);
	});

	it("trims a trailing separator from a non-root path", () => {
		const out = canonicaliseLocalFolder(`${tmpRoot}${sep}sub${sep}`);
		expect(out.endsWith(sep)).toBe(false);
		expect(out.endsWith(`sub`)).toBe(true);
	});

	it("resolves `..` and `.` segments", () => {
		const out = canonicaliseLocalFolder(`${tmpRoot}${sep}a${sep}..${sep}b`);
		// `<tmpRoot>/a/../b` → `<tmpRoot>/b`. The `a` directory does NOT exist,
		// so step 3's nearest-existing-ancestor realpath finds `<tmpRoot>`
		// (which exists in this test) and appends `b` lexically.
		expect(out.endsWith(`${sep}b`)).toBe(true);
		expect(out).not.toContain(`..`);
	});

	it("realpaths symlinked parent segments (step 3 — production caller correctness)", () => {
		// Build: <tmpRoot>/real/data and a symlink <tmpRoot>/link → real.
		// canonicalise(<tmpRoot>/link/data) must resolve through the symlink
		// to <tmpRoot>/real/data — otherwise sync and worker would compute
		// different lock paths for the same vault depending on which one
		// the user typed into their localFolder config.
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(tmpRoot, "real", "data"), { recursive: true });
		symlinkSync(join(tmpRoot, "real"), join(tmpRoot, "link"), "dir");

		const viaReal = canonicaliseLocalFolder(join(tmpRoot, "real", "data"));
		const viaLink = canonicaliseLocalFolder(join(tmpRoot, "link", "data"));
		expect(viaLink).toBe(viaReal);
	});

	it("handles a pre-init path whose deeper segments don't exist (the cold-start case)", () => {
		// The whole reason for step 3's nearest-existing-ancestor trick is
		// that `localFolder` is allowed to point at a directory that hasn't
		// been cloned/created yet. Pure `realpath` throws ENOENT. The helper
		// must not throw — it returns a stable string for the same input
		// regardless of whether the path materialises later.
		const notYetExisting = join(tmpRoot, "deep", "not", "created", "yet");
		const out1 = canonicaliseLocalFolder(notYetExisting);
		expect(out1.endsWith(`yet`)).toBe(true);
		// Stable across calls (no fs writes in between → same canonical):
		const out2 = canonicaliseLocalFolder(notYetExisting);
		expect(out2).toBe(out1);
	});

	it("treats POSIX-style mixed separators consistently (collapse to platform sep)", () => {
		const mixed = `${tmpRoot}/a\\b/c`;
		const out = canonicaliseLocalFolder(mixed);
		// Platform sep is what step 5 collapses to. No runs of mixed
		// separators remain.
		expect(out).not.toMatch(/[/\\]{2,}/);
	});

	it("expands a bare `~` to the home directory (step 1)", () => {
		const { homedir } = require("node:os");
		// `~` alone → exactly the home dir (after the realpath/case-fold steps,
		// which are idempotent for an existing dir like $HOME).
		const out = canonicaliseLocalFolder("~");
		const expected = canonicaliseLocalFolder(homedir());
		expect(out).toBe(expected);
	});

	it("expands a leading `~/` prefix to the home directory (step 1)", () => {
		const { homedir } = require("node:os");
		const out = canonicaliseLocalFolder("~/some-vault-dir");
		const expected = canonicaliseLocalFolder(join(homedir(), "some-vault-dir"));
		expect(out).toBe(expected);
	});

	it("__vaultLockCanonicalForTesting is a thin re-export of canonicaliseLocalFolder (test seam stability)", () => {
		// If someone refactors and breaks the test-seam alias, dependent
		// tests would silently start using stale logic. Pin the alias.
		expect(canonicalise(tmpRoot)).toBe(canonicaliseLocalFolder(tmpRoot));
	});
});

describe("getVaultWriteLockPath", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "vaultlockpath-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("produces a deterministic path for the same input", () => {
		const a = getVaultWriteLockPath(tmpRoot);
		const b = getVaultWriteLockPath(tmpRoot);
		expect(a).toBe(b);
	});

	it("produces different paths for different inputs (different vaults = different locks)", () => {
		const a = getVaultWriteLockPath(join(tmpRoot, "vaultA"));
		const b = getVaultWriteLockPath(join(tmpRoot, "vaultB"));
		expect(a).not.toBe(b);
	});

	it("respects the JOLLI_VAULT_LOCK_DIR override (matches JOLLI_SYNC_LOCK_DIR convention)", () => {
		// The acceptance suite needs to redirect lock state away from the
		// developer's real ~/.jolli/jollimemory/locks/. Without the override
		// path being honored, parallel tests collide on the shared lockfile.
		vi.stubEnv("JOLLI_VAULT_LOCK_DIR", tmpRoot);
		const out = getVaultWriteLockPath("/some/vault");
		expect(out.startsWith(tmpRoot)).toBe(true);
		expect(out.endsWith(".lock")).toBe(true);
	});

	it("ignores an empty JOLLI_VAULT_LOCK_DIR override (treats as unset)", () => {
		// Mirrors `getSyncLockPath`'s handling: an explicitly-set-but-empty
		// env var falls through to the default ~/.jolli/jollimemory/locks/.
		// Otherwise an accidental `JOLLI_VAULT_LOCK_DIR=` in a shell rc would
		// stash locks in the cwd as ".lock" files — confusing failure mode.
		vi.stubEnv("JOLLI_VAULT_LOCK_DIR", "");
		const out = getVaultWriteLockPath("/some/vault");
		expect(out).toContain(".jolli");
		expect(out).toContain("jollimemory");
		expect(out).toContain("locks");
	});

	it("uses a hashed filename so exotic localFolder paths produce printable lock names", () => {
		const exotic = "/some/path with spaces/and/中文/and/very/long/name".repeat(3);
		const out = getVaultWriteLockPath(exotic);
		// Lock filename is "vault-<64 hex chars>.lock" regardless of input length.
		const filename = out.split(sep).pop() ?? "";
		expect(filename).toMatch(/^vault-[0-9a-f]{64}\.lock$/);
	});

	it("symlink-equivalent inputs produce the same lock path (canonical-realpath in path)", () => {
		// Same scenario as the canonicaliseLocalFolder symlink test, but
		// asserted at the lock-path level. This is the load-bearing property
		// for the Hotfix: sync and worker must compute the same hash even if
		// one of them was passed the symlink and the other the real path.
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(tmpRoot, "real"), { recursive: true });
		symlinkSync(join(tmpRoot, "real"), join(tmpRoot, "link"), "dir");
		expect(getVaultWriteLockPath(join(tmpRoot, "real"))).toBe(getVaultWriteLockPath(join(tmpRoot, "link")));
	});
});
