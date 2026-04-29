import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractRepoName, initializeKBFolder, resolveKBPath } from "./KBPathResolver.js";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});

function makeTmpDir(): string {
	const dir = join(tmpdir(), `kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function rmrf(dir: string): void {
	const { rmSync } = require("node:fs");
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("KBPathResolver", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTmpDir();
	});

	afterEach(() => {
		rmrf(tempDir);
	});

	describe("extractRepoName", () => {
		it("extracts directory name", () => {
			expect(extractRepoName("/Users/alice/projects/myrepo")).toBe("myrepo");
		});

		it("handles nested paths", () => {
			expect(extractRepoName("/deep/nested/project-name")).toBe("project-name");
		});
	});

	describe("resolveKBPath", () => {
		it("uses custom path as parent with repoName appended", () => {
			const result = resolveKBPath("myrepo", "https://github.com/user/myrepo.git", tempDir);
			expect(result).toBe(join(tempDir, "myrepo"));
		});

		it("returns path when folder does not exist", () => {
			const result = resolveKBPath("newrepo", null, tempDir);
			expect(result).toBe(join(tempDir, "newrepo"));
		});

		it("reuses folder when repo identity matches", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");

			const result = resolveKBPath("myrepo", "https://github.com/user/myrepo.git", tempDir);
			expect(result).toBe(kbRoot);
		});

		it("adds suffix on collision with different remote", () => {
			const kbRoot = join(tempDir, "app");
			initializeKBFolder(kbRoot, "app", "https://github.com/user1/app.git");

			const result = resolveKBPath("app", "https://github.com/user2/app.git", tempDir);
			expect(result).toBe(join(tempDir, "app-2"));
		});

		it("matches local repos by name when both have no remote", () => {
			const kbRoot = join(tempDir, "localrepo");
			initializeKBFolder(kbRoot, "localrepo", null);

			const result = resolveKBPath("localrepo", null, tempDir);
			expect(result).toBe(kbRoot);
		});
	});

	describe("initializeKBFolder", () => {
		it("creates jolli dir and writes config", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");

			const configPath = join(kbRoot, ".jolli", "config.json");
			expect(existsSync(configPath)).toBe(true);

			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/user/myrepo.git");
			expect(config.repoName).toBe("myrepo");
		});

		it("works with null remote", () => {
			const kbRoot = join(tempDir, "local");
			initializeKBFolder(kbRoot, "local", null);

			const config = JSON.parse(readFileSync(join(kbRoot, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBeUndefined();
			expect(config.repoName).toBe("local");
		});

		it("is idempotent", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");
			expect(existsSync(join(kbRoot, ".jolli", "config.json"))).toBe(true);
		});
	});
});
