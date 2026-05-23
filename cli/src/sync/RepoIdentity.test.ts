/**
 * Tests for RepoIdentity — source-repo identity + vault subdirectory naming.
 *
 * `getRemoteUrl` / `extractRepoName` from KBPathResolver are spied on so we
 * can fully control the fallback chain without touching real git.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kbResolver from "../core/KBPathResolver.js";
import {
	computeRepoFolderName,
	computeRepoIdentity,
	decodeBranchFolderName,
	encodeBranchFolderName,
} from "./RepoIdentity.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "repoidentity-"));
	await writeFile(join(tempDir, "marker"), ""); // give it some content so path exists
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(tempDir, { recursive: true, force: true });
});

describe("computeRepoIdentity", () => {
	it("uses normalized git remote URL when one is configured", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://github.com/foo/bar.git/");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/some/path");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
		expect(result.slug).toBe("bar");
	});

	it("falls back to basename(projectPath) when no remote is configured", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("my-notes");

		const result = computeRepoIdentity("/home/foo/my-notes");
		expect(result.repoIdentity).toBe("my-notes");
		expect(result.slug).toBe("my-notes");
	});

	it("strips https user-info from the remote URL", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://user:pass@github.com/foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
	});

	it("lowercases scheme and host but preserves path case", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("HTTPS://GITHUB.com/Foo/Bar");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://github.com/Foo/Bar");
	});

	it("leaves SCP-style URLs as-is (only schemed URLs are case-normalized)", () => {
		// SCP form: `git@github.com:foo/bar.git`. We strip `.git` and trim,
		// but `@` is not user-info so we don't touch it.
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("git@github.com:foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("git@github.com:foo/bar");
	});

	it("slugifies the repo name (NFKD + lowercase + non-[a-z0-9-] → -)", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Foster's Personal!");

		const result = computeRepoIdentity("/x");
		expect(result.slug).toBe("foster-s-personal");
	});

	it("falls back to 'repo' when the slug would be empty after sanitize", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("📝📝📝");

		const result = computeRepoIdentity("/x");
		expect(result.slug).toBe("repo");
	});
});

describe("computeFallbackHashSuffix", () => {
	it("returns a deterministic 6-hex-char digest derived from the input identity", async () => {
		const { computeFallbackHashSuffix } = await import("./RepoIdentity.js");
		const a = computeFallbackHashSuffix("https://github.com/foo/bar");
		const b = computeFallbackHashSuffix("https://github.com/foo/bar");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{6}$/);
		// Different inputs → different suffixes (birthday-collision is
		// negligible at the personal Memory Bank scale this function targets).
		const c = computeFallbackHashSuffix("https://gitlab.com/foo/bar");
		expect(c).not.toBe(a);
	});
});

describe("computeRepoFolderName", () => {
	it("returns the bare slug — collision handling lives in RepoMapping", () => {
		const name = computeRepoFolderName({ repoIdentity: "https://github.com/foo/bar", slug: "bar" });
		expect(name).toBe("bar");
	});

	it("is deterministic for the same identity", () => {
		const id = { repoIdentity: "https://github.com/foo/bar", slug: "bar" };
		expect(computeRepoFolderName(id)).toBe(computeRepoFolderName(id));
	});

	it("returns the same slug for two distinct repoIdentities (collision deferred to RepoMapping)", () => {
		// Two different remote hosts that slug-collapse to the same name —
		// `computeRepoFolderName` proposes `bar` for both; the engine then
		// calls `RepoMapping.resolveOrAssignFolder` which gives the second
		// caller a `bar-<hash6>` suffix.
		const a = computeRepoFolderName({ repoIdentity: "https://github.com/foo/bar", slug: "bar" });
		const b = computeRepoFolderName({ repoIdentity: "https://gitlab.com/foo/bar", slug: "bar" });
		expect(a).toBe("bar");
		expect(b).toBe("bar");
	});
});

describe("encodeBranchFolderName / decodeBranchFolderName", () => {
	it("substitutes `/` → `^`", () => {
		expect(encodeBranchFolderName("feature/JOLLI-1336")).toBe("feature^JOLLI-1336");
	});

	it("round-trips through encode + decode", () => {
		const raw = "feature/foo/bar/baz";
		expect(decodeBranchFolderName(encodeBranchFolderName(raw))).toBe(raw);
	});

	it("leaves branches without `/` unchanged", () => {
		expect(encodeBranchFolderName("main")).toBe("main");
		expect(decodeBranchFolderName("main")).toBe("main");
	});
});
