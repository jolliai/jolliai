/**
 * Unit tests for the vault-marker module (plan §P1#1). Covers:
 *
 *   - `normalizeGitUrl` shape: auth-stripping, `.git` trim, host lowercase,
 *     non-https passthrough.
 *   - `write/read` round-trip (incl. malformed file rejection).
 *   - `verifyVaultMarker` verdicts: ok, missing_marker, url_mismatch,
 *     null-origin treated as mismatch.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitCredentials } from "./SyncTypes.js";
import {
	normalizeGitUrl,
	readVaultMarker,
	VAULT_MARKER_REL_PATH,
	verifyVaultMarker,
	writeVaultMarker,
} from "./VaultMarker.js";

const CREDS: GitCredentials = {
	gitUrl: "https://github.com/jolli-vaults/foo-abc.git",
	token: "ghs_test",
	expiresAt: Date.now() + 3600_000,
	repoFullName: "jolli-vaults/foo-abc",
	defaultBranch: "main",
	githubRepoCreated: false,
	alreadyVaultBound: true,
	lockOwnerToken: "test-lock-owner-token",
};

let rootTempDir: string;
let memoryBankRoot: string;

beforeAll(async () => {
	rootTempDir = await mkdtemp(join(tmpdir(), "vaultmarker-"));
});

afterAll(async () => {
	await rm(rootTempDir, { recursive: true, force: true });
});

beforeEach(async () => {
	memoryBankRoot = await mkdtemp(join(rootTempDir, "vault-"));
	// The marker lives inside `.git/` — create that dir so write doesn't
	// have to bootstrap it (matches the real engine flow where the marker
	// is written AFTER clone / init).
	await mkdir(join(memoryBankRoot, ".git"), { recursive: true });
});

describe("normalizeGitUrl", () => {
	it("strips x-access-token@ auth and trailing .git", () => {
		expect(normalizeGitUrl("https://x-access-token@github.com/jolli-vaults/foo.git")).toBe(
			"https://github.com/jolli-vaults/foo",
		);
	});

	it("strips user:password@ auth too", () => {
		expect(normalizeGitUrl("https://user:pwd@github.com/jolli-vaults/foo.git")).toBe(
			"https://github.com/jolli-vaults/foo",
		);
	});

	it("lowercases host AND path for GitHub-style case-insensitive hosts", () => {
		// GitHub/GitLab/Bitbucket treat owner/repo as case-insensitive and the
		// backend may emit either case form. Folding the path here keeps
		// `vault_mismatch` from triggering when the backend's stored casing
		// differs from a marker's stored casing (regression fixed by 541d00e
		// + the verify-side re-normalization in this commit).
		expect(normalizeGitUrl("https://GitHub.com/Jolli-Vaults/Foo")).toBe("https://github.com/jolli-vaults/foo");
	});

	it("preserves path case for hosts NOT in the case-insensitive set", () => {
		// Self-hosted Gitea/Gogs paths CAN be case-sensitive depending on
		// filesystem — preserve case there as the safe default.
		expect(normalizeGitUrl("https://Git.Example.Com/Org/Repo")).toBe("https://git.example.com/Org/Repo");
	});

	it("drops trailing slash", () => {
		expect(normalizeGitUrl("https://github.com/jolli-vaults/foo/")).toBe("https://github.com/jolli-vaults/foo");
	});

	it("returns trimmed input unchanged for non-https URLs", () => {
		expect(normalizeGitUrl("  ssh://git@github.com/foo/bar.git  ")).toBe("ssh://git@github.com/foo/bar.git");
	});

	it("idempotent on an already-normalized URL", () => {
		const canonical = "https://github.com/jolli-vaults/foo";
		expect(normalizeGitUrl(canonical)).toBe(canonical);
	});
});

describe("writeVaultMarker / readVaultMarker round-trip", () => {
	it("writes a parseable marker that readVaultMarker round-trips", async () => {
		await writeVaultMarker(memoryBankRoot, CREDS);
		const marker = await readVaultMarker(memoryBankRoot);
		expect(marker).not.toBeNull();
		expect(marker?.kind).toBe("jolli-memory-bank");
		expect(marker?.version).toBe(1);
		// gitUrl is stored ALREADY normalized so subsequent verify calls
		// don't have to re-derive the comparison form on each round.
		expect(marker?.gitUrl).toBe("https://github.com/jolli-vaults/foo-abc");
		expect(marker?.repoFullName).toBe("jolli-vaults/foo-abc");
		expect(marker?.defaultBranch).toBe("main");
		expect(marker?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("returns null when the marker file is missing", async () => {
		expect(await readVaultMarker(memoryBankRoot)).toBeNull();
	});

	it("returns null when the marker JSON has the wrong kind", async () => {
		await writeFile(
			join(memoryBankRoot, VAULT_MARKER_REL_PATH),
			JSON.stringify({ kind: "something-else", version: 1, gitUrl: "x" }),
		);
		expect(await readVaultMarker(memoryBankRoot)).toBeNull();
	});

	it("returns null when the marker JSON has the wrong version", async () => {
		await writeFile(
			join(memoryBankRoot, VAULT_MARKER_REL_PATH),
			JSON.stringify({ kind: "jolli-memory-bank", version: 99, gitUrl: "x" }),
		);
		expect(await readVaultMarker(memoryBankRoot)).toBeNull();
	});

	it("returns null when the marker JSON is malformed", async () => {
		await writeFile(join(memoryBankRoot, VAULT_MARKER_REL_PATH), "{ not valid json");
		expect(await readVaultMarker(memoryBankRoot)).toBeNull();
	});

	it("returns null when gitUrl is missing or empty (corrupted marker)", async () => {
		await writeFile(
			join(memoryBankRoot, VAULT_MARKER_REL_PATH),
			JSON.stringify({ kind: "jolli-memory-bank", version: 1, gitUrl: "" }),
		);
		expect(await readVaultMarker(memoryBankRoot)).toBeNull();
	});

	it("tolerates a marker missing the informational fields (older shape)", async () => {
		// Pre-§P1#1 forward-compat: gitUrl is the only field that gates
		// verification. A marker written by a future/older variant might
		// omit createdAt/repoFullName/defaultBranch — readVaultMarker
		// should still parse and coerce them to safe empty strings.
		await writeFile(
			join(memoryBankRoot, VAULT_MARKER_REL_PATH),
			JSON.stringify({
				kind: "jolli-memory-bank",
				version: 1,
				gitUrl: "https://github.com/jolli-vaults/foo-abc",
			}),
		);
		const marker = await readVaultMarker(memoryBankRoot);
		expect(marker).not.toBeNull();
		expect(marker?.gitUrl).toBe("https://github.com/jolli-vaults/foo-abc");
		expect(marker?.createdAt).toBe("");
		expect(marker?.repoFullName).toBe("");
		expect(marker?.defaultBranch).toBe("");
	});

	it("overwrite is safe (idempotent across rounds)", async () => {
		await writeVaultMarker(memoryBankRoot, CREDS);
		const first = await readVaultMarker(memoryBankRoot);
		// Write again with the same creds — the `createdAt` stamp will
		// move (intentionally — easier than comparing only the immutable
		// fields), but the URL/branch invariants must hold.
		await writeVaultMarker(memoryBankRoot, CREDS);
		const second = await readVaultMarker(memoryBankRoot);
		expect(second?.gitUrl).toBe(first?.gitUrl);
		expect(second?.defaultBranch).toBe(first?.defaultBranch);
	});
});

describe("verifyVaultMarker", () => {
	it("returns ok when marker present, origin matches creds, and URLs normalize equal", async () => {
		await writeVaultMarker(memoryBankRoot, CREDS);
		// Live origin URL still carries the auth username — must still match
		// after normalization.
		const verdict = await verifyVaultMarker(
			memoryBankRoot,
			"https://x-access-token@github.com/jolli-vaults/foo-abc.git",
			CREDS,
		);
		expect(verdict.ok).toBe(true);
	});

	it("returns missing_marker when no marker file exists", async () => {
		const verdict = await verifyVaultMarker(memoryBankRoot, "https://github.com/jolli-vaults/foo-abc.git", CREDS);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toBe("missing_marker");
			expect(verdict.message).toContain("no Jolli vault marker");
		}
	});

	it("returns url_mismatch when marker remembers a different URL", async () => {
		// Marker says vault was bound to `foo-abc`; live creds now point at
		// `bar-xyz`. Origin URL matches creds, but marker doesn't — this is
		// the stale-marker case (e.g. user re-pointed the personal space).
		await writeVaultMarker(memoryBankRoot, CREDS);
		const otherCreds: GitCredentials = {
			...CREDS,
			gitUrl: "https://github.com/jolli-vaults/bar-xyz.git",
			repoFullName: "jolli-vaults/bar-xyz",
		};
		const verdict = await verifyVaultMarker(
			memoryBankRoot,
			"https://github.com/jolli-vaults/bar-xyz.git",
			otherCreds,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toBe("url_mismatch");
		}
	});

	it("returns url_mismatch when originUrl is null (no remote configured)", async () => {
		await writeVaultMarker(memoryBankRoot, CREDS);
		const verdict = await verifyVaultMarker(memoryBankRoot, null, CREDS);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toBe("url_mismatch");
			expect(verdict.message).toContain("no origin remote");
		}
	});

	it("returns url_mismatch when live origin disagrees with marker even though marker matches creds", async () => {
		// Marker matches creds, but the .git/config remote was tampered with
		// (or never set). This catches the "marker stayed but origin moved"
		// drift — without this check, we'd happily push to a foreign URL.
		await writeVaultMarker(memoryBankRoot, CREDS);
		const verdict = await verifyVaultMarker(memoryBankRoot, "https://github.com/someone-else/different.git", CREDS);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toBe("url_mismatch");
		}
	});

	it("accepts an old-format marker (mixed-case path) with needsRewrite=true", async () => {
		// Pre-541d00e clients wrote markers without lowering the GitHub path
		// segment. Re-normalizing on read MUST treat that as a match — the
		// asymmetry is the exact field bug this commit fixes. The verdict
		// also flags `needsRewrite` so the engine migrates the marker to
		// canonical form on the next round.
		await writeFile(
			join(memoryBankRoot, VAULT_MARKER_REL_PATH),
			JSON.stringify({
				kind: "jolli-memory-bank",
				version: 1,
				createdAt: "2026-05-22T05:25:32.760Z",
				gitUrl: "https://github.com/JolliSync/personal-space-wdyzxt1",
				repoFullName: "JolliSync/personal-space-wdyzxt1",
				defaultBranch: "main",
			}),
		);
		const newCaseCreds: GitCredentials = {
			...CREDS,
			gitUrl: "https://github.com/jollisync/personal-space-wdyzxt1",
			repoFullName: "jollisync/personal-space-wdyzxt1",
		};
		const verdict = await verifyVaultMarker(
			memoryBankRoot,
			"https://github.com/jollisync/personal-space-wdyzxt1.git",
			newCaseCreds,
		);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.needsRewrite).toBe(true);
		}
	});

	it("does NOT set needsRewrite when the on-disk marker is already canonical", async () => {
		// Sanity check the inverse: a freshly-written canonical marker must
		// NOT trigger an unnecessary rewrite on every round.
		await writeVaultMarker(memoryBankRoot, CREDS);
		const verdict = await verifyVaultMarker(memoryBankRoot, "https://github.com/jolli-vaults/foo-abc.git", CREDS);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.needsRewrite).toBeUndefined();
		}
	});
});
