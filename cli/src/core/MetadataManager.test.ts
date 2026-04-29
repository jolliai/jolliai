import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";

function makeTmpDir(): string {
	const dir = join(tmpdir(), `kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		path: "main/test-abc12345.md",
		fileId: "abc12345",
		type: "commit",
		fingerprint: "sha256:deadbeef",
		source: { commitHash: "abc12345", branch: "main" },
		...overrides,
	};
}

function rmrf(dir: string): void {
	const { rmSync } = require("node:fs");
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("MetadataManager", () => {
	let jolliDir: string;
	let manager: MetadataManager;

	beforeEach(() => {
		jolliDir = join(makeTmpDir(), ".jolli");
		manager = new MetadataManager(jolliDir);
	});

	afterEach(() => {
		rmrf(join(jolliDir, ".."));
	});

	describe("ensure", () => {
		it("creates jolli dir and default files", () => {
			manager.ensure();
			expect(existsSync(jolliDir)).toBe(true);
			expect(existsSync(join(jolliDir, "manifest.json"))).toBe(true);
			expect(existsSync(join(jolliDir, "branches.json"))).toBe(true);
			expect(existsSync(join(jolliDir, "config.json"))).toBe(true);
		});

		it("is idempotent", () => {
			manager.ensure();
			manager.ensure();
			expect(existsSync(jolliDir)).toBe(true);
		});

		it("does not overwrite existing files", () => {
			manager.ensure();
			manager.updateManifest(makeEntry());
			manager.ensure();
			expect(manager.readManifest().files).toHaveLength(1);
		});
	});

	describe("manifest", () => {
		beforeEach(() => manager.ensure());

		it("reads empty manifest when fresh", () => {
			const manifest = manager.readManifest();
			expect(manifest.version).toBe(1);
			expect(manifest.files).toHaveLength(0);
		});

		it("adds new entry", () => {
			manager.updateManifest(makeEntry());
			expect(manager.readManifest().files).toHaveLength(1);
			expect(manager.readManifest().files[0].fileId).toBe("abc12345");
		});

		it("replaces entry with same fileId", () => {
			manager.updateManifest(makeEntry({ path: "main/old.md" }));
			manager.updateManifest(makeEntry({ path: "main/new.md" }));
			const files = manager.readManifest().files;
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("main/new.md");
		});

		it("keeps entries with different fileId", () => {
			manager.updateManifest(makeEntry({ fileId: "aaa" }));
			manager.updateManifest(makeEntry({ fileId: "bbb" }));
			expect(manager.readManifest().files).toHaveLength(2);
		});

		it("removes entry by fileId", () => {
			manager.updateManifest(makeEntry({ fileId: "aaa" }));
			manager.updateManifest(makeEntry({ fileId: "bbb" }));
			expect(manager.removeFromManifest("aaa")).toBe(true);
			expect(manager.readManifest().files).toHaveLength(1);
		});

		it("returns false when removing nonexistent fileId", () => {
			expect(manager.removeFromManifest("nonexistent")).toBe(false);
		});

		it("findByPath returns matching entry", () => {
			manager.updateManifest(makeEntry({ path: "main/test.md", fileId: "abc" }));
			expect(manager.findByPath("main/test.md")?.fileId).toBe("abc");
		});

		it("findById returns matching entry", () => {
			manager.updateManifest(makeEntry({ fileId: "xyz" }));
			expect(manager.findById("xyz")).toBeDefined();
		});

		it("updatePath changes path", () => {
			manager.updateManifest(makeEntry({ path: "old/path.md", fileId: "abc" }));
			expect(manager.updatePath("abc", "new/path.md")).toBe(true);
			expect(manager.findById("abc")?.path).toBe("new/path.md");
		});
	});

	describe("branch mapping", () => {
		beforeEach(() => manager.ensure());

		it("creates new mapping", () => {
			const folder = manager.resolveFolderForBranch("feature/login");
			expect(folder).toBe("feature-login");
			expect(manager.listBranchMappings()).toHaveLength(1);
		});

		it("returns existing mapping on second call", () => {
			manager.resolveFolderForBranch("feature/foo");
			manager.resolveFolderForBranch("feature/foo");
			expect(manager.listBranchMappings()).toHaveLength(1);
		});

		it("renames branch folder and updates manifest", () => {
			manager.resolveFolderForBranch("feature/old");
			manager.updateManifest(makeEntry({ path: "feature-old/a.md", fileId: "a" }));
			manager.updateManifest(makeEntry({ path: "feature-old/b.md", fileId: "b" }));

			const count = manager.renameBranchFolder("feature-old", "feature-new");
			expect(count).toBe(2);
			expect(manager.findById("a")?.path).toBe("feature-new/a.md");
			expect(manager.findById("b")?.path).toBe("feature-new/b.md");
		});

		it("removes branch folder from manifest and branches", () => {
			manager.resolveFolderForBranch("feature/delete-me");
			manager.updateManifest(makeEntry({ path: "feature-delete-me/a.md", fileId: "a" }));
			manager.updateManifest(makeEntry({ path: "main/b.md", fileId: "b" }));

			const removed = manager.removeBranchFolder("feature-delete-me");
			expect(removed).toBe(1);
			expect(manager.readManifest().files).toHaveLength(1);
			expect(manager.findById("b")).toBeDefined();
		});
	});

	describe("transcodeBranchName", () => {
		it("replaces forward slash", () => {
			expect(MetadataManager.transcodeBranchName("feature/login")).toBe("feature-login");
		});

		it("replaces backslash", () => {
			expect(MetadataManager.transcodeBranchName("user\\foo")).toBe("user-foo");
		});

		it("replaces double dot with double dash", () => {
			expect(MetadataManager.transcodeBranchName("refs..heads")).toBe("refs--heads");
		});

		it("collapses consecutive dashes", () => {
			expect(MetadataManager.transcodeBranchName("a///b")).toBe("a-b");
		});

		it("trims leading/trailing dots and dashes", () => {
			expect(MetadataManager.transcodeBranchName(".leading")).toBe("leading");
			expect(MetadataManager.transcodeBranchName("trailing-")).toBe("trailing");
		});

		it("returns default for empty result", () => {
			expect(MetadataManager.transcodeBranchName("/")).toBe("default");
		});

		it("simple names pass through", () => {
			expect(MetadataManager.transcodeBranchName("main")).toBe("main");
		});
	});

	describe("config", () => {
		beforeEach(() => manager.ensure());

		it("reads defaults", () => {
			const config = manager.readConfig();
			expect(config.version).toBe(1);
			expect(config.sortOrder).toBe("date");
		});

		it("saves and reads back", () => {
			manager.saveConfig({ version: 1, sortOrder: "name" });
			expect(manager.readConfig().sortOrder).toBe("name");
		});
	});

	describe("migration state", () => {
		beforeEach(() => manager.ensure());

		it("returns null when no migration", () => {
			expect(manager.readMigrationState()).toBeNull();
		});

		it("saves and reads back", () => {
			manager.saveMigrationState({ status: "completed", totalEntries: 5, migratedEntries: 5 });
			const state = manager.readMigrationState();
			expect(state?.status).toBe("completed");
			expect(state?.migratedEntries).toBe(5);
		});
	});

	describe("reconcile", () => {
		beforeEach(() => manager.ensure());

		it("keeps manifest entry when file is deleted (avoids data loss from transient errors)", () => {
			const kbRoot = join(jolliDir, "..");
			mkdirSync(join(kbRoot, "main"), { recursive: true });
			writeFileSync(join(kbRoot, "main/test.md"), "# Test");
			manager.updateManifest(makeEntry({ path: "main/test.md", fileId: "abc", fingerprint: "fp1" }));

			// Delete the file
			require("node:fs").unlinkSync(join(kbRoot, "main/test.md"));

			const fixed = manager.reconcile(kbRoot);
			expect(fixed).toBe(0);
			// Entry is preserved to avoid data loss from transient filesystem errors
			expect(manager.findById("abc")).toBeDefined();
		});

		it("updates path when file is moved (fingerprint match)", () => {
			const kbRoot = join(jolliDir, "..");
			mkdirSync(join(kbRoot, "other"), { recursive: true });
			const content = "# Moved file content";
			const fp = MetadataManager.sha256(content);

			manager.updateManifest(makeEntry({ path: "main/test.md", fileId: "abc", fingerprint: fp }));
			writeFileSync(join(kbRoot, "other/test.md"), content);

			const fixed = manager.reconcile(kbRoot);
			expect(fixed).toBe(1);
			expect(manager.findById("abc")?.path).toBe("other/test.md");
		});

		it("no changes when files are in place", () => {
			const kbRoot = join(jolliDir, "..");
			mkdirSync(join(kbRoot, "main"), { recursive: true });
			writeFileSync(join(kbRoot, "main/test.md"), "# Test");
			manager.updateManifest(makeEntry({ path: "main/test.md", fileId: "abc" }));

			expect(manager.reconcile(kbRoot)).toBe(0);
		});
	});

	describe("resilience", () => {
		it("reads empty manifest on corrupted file", () => {
			mkdirSync(jolliDir, { recursive: true });
			writeFileSync(join(jolliDir, "manifest.json"), "not json!!!");
			expect(manager.readManifest().files).toHaveLength(0);
		});

		it("reads defaults on corrupted config", () => {
			mkdirSync(jolliDir, { recursive: true });
			writeFileSync(join(jolliDir, "config.json"), "{bad json");
			expect(manager.readConfig().sortOrder).toBe("date");
		});
	});
});
