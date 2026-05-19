import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DualWriteStorage } from "./DualWriteStorage.js";
import { FolderStorage } from "./FolderStorage.js";
import { MetadataManager } from "./MetadataManager.js";
import type { StorageProvider } from "./StorageProvider.js";

// Mock SummaryMarkdownBuilder
vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: vi.fn().mockReturnValue("# Mock Markdown"),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

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

/** Simple in-memory StorageProvider for testing primary. */
class InMemoryStorage implements StorageProvider {
	private files = new Map<string, string>();

	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async writeFiles(files: { path: string; content: string; delete?: boolean }[], _message: string): Promise<void> {
		for (const f of files) {
			if (f.delete) this.files.delete(f.path);
			else this.files.set(f.path, f.content);
		}
	}

	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
	}

	async exists(): Promise<boolean> {
		return true;
	}
	async ensure(): Promise<void> {}
}

describe("DualWriteStorage", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTmpDir();
	});

	afterEach(() => {
		rmrf(tempDir);
	});

	it("reads from primary", async () => {
		const primary = new InMemoryStorage();
		const shadowRoot = join(tempDir, "shadow");
		const shadow = new FolderStorage(shadowRoot, new MetadataManager(join(shadowRoot, ".jolli")));

		await primary.writeFiles([{ path: "test.txt", content: "primary data" }], "write");

		const dual = new DualWriteStorage(primary, shadow);
		expect(await dual.readFile("test.txt")).toBe("primary data");
	});

	it("writes to both primary and shadow", async () => {
		const primary = new InMemoryStorage();
		const shadowRoot = join(tempDir, "shadow");
		const shadow = new FolderStorage(shadowRoot, new MetadataManager(join(shadowRoot, ".jolli")));

		const dual = new DualWriteStorage(primary, shadow);
		await dual.writeFiles([{ path: "test.txt", content: "hello" }], "dual write");

		expect(await primary.readFile("test.txt")).toBe("hello");
		expect(await shadow.readFile("test.txt")).toBe("hello");
	});

	it("primary succeeds even when shadow fails", async () => {
		const primary = new InMemoryStorage();
		const brokenShadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn().mockRejectedValue(new Error("shadow broken")),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, brokenShadow);
		await dual.writeFiles([{ path: "ok.txt", content: "data" }], "write");

		expect(await primary.readFile("ok.txt")).toBe("data");
	});

	it("does not attempt shadow write when primary write fails", async () => {
		const brokenPrimary = {
			readFile: vi.fn(),
			writeFiles: vi.fn().mockRejectedValue(new Error("primary broken")),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		} as unknown as StorageProvider;

		const shadowWrite = vi.fn();
		const shadow = {
			readFile: vi.fn(),
			writeFiles: shadowWrite,
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(brokenPrimary, shadow);
		await expect(dual.writeFiles([{ path: "fail.txt", content: "data" }], "write")).rejects.toThrow(
			"primary broken",
		);
		expect(shadowWrite).not.toHaveBeenCalled();
	});

	it("listFiles comes from primary", async () => {
		const primary = new InMemoryStorage();
		const shadowRoot = join(tempDir, "shadow");
		const shadow = new FolderStorage(shadowRoot, new MetadataManager(join(shadowRoot, ".jolli")));

		await primary.writeFiles(
			[
				{ path: "dir/a.txt", content: "a" },
				{ path: "dir/b.txt", content: "b" },
			],
			"write",
		);

		const dual = new DualWriteStorage(primary, shadow);
		expect(await dual.listFiles("dir/")).toHaveLength(2);
	});

	it("exists reflects the primary backend", async () => {
		const primary = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(false),
			ensure: vi.fn(),
		} as unknown as StorageProvider;
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		expect(await dual.exists()).toBe(false);
		expect(primary.exists).toHaveBeenCalled();
		expect(shadow.exists).not.toHaveBeenCalled();
	});

	it("ensure runs both backends when shadow succeeds", async () => {
		const primaryEnsure = vi.fn();
		const shadowEnsure = vi.fn();
		const primary = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: primaryEnsure,
		} as unknown as StorageProvider;
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: shadowEnsure,
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await dual.ensure();
		expect(primaryEnsure).toHaveBeenCalled();
		expect(shadowEnsure).toHaveBeenCalled();
	});

	it("ensure swallows shadow failures", async () => {
		const primary = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: vi.fn().mockResolvedValue(undefined),
		} as unknown as StorageProvider;
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: vi.fn().mockRejectedValue(new Error("shadow ensure broken")),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await expect(dual.ensure()).resolves.toBeUndefined();
	});

	it("ensure swallows shadow failure raised as a non-Error value", async () => {
		const primary = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: vi.fn().mockResolvedValue(undefined),
		} as unknown as StorageProvider;
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn(),
			ensure: vi.fn().mockRejectedValue("ensure boom"),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await expect(dual.ensure()).resolves.toBeUndefined();
	});

	it("marks shadow dirty and skips clearDirty when shadow write fails", async () => {
		const primary = new InMemoryStorage();
		const markDirty = vi.fn();
		const clearDirty = vi.fn();
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn().mockRejectedValue(new Error("disk full")),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
			markDirty,
			clearDirty,
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await dual.writeFiles([{ path: "ok.txt", content: "data" }], "write");
		expect(markDirty).toHaveBeenCalledWith("write");
		expect(clearDirty).not.toHaveBeenCalled();
	});

	it("clears dirty marker after a successful shadow write", async () => {
		const primary = new InMemoryStorage();
		const markDirty = vi.fn();
		const clearDirty = vi.fn();
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
			markDirty,
			clearDirty,
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await dual.writeFiles([{ path: "ok.txt", content: "data" }], "write");
		expect(clearDirty).toHaveBeenCalled();
		expect(markDirty).not.toHaveBeenCalled();
	});

	it("logs a non-Error shadow write failure via String(err)", async () => {
		const primary = new InMemoryStorage();
		const shadow = {
			readFile: vi.fn(),
			writeFiles: vi.fn().mockRejectedValue("string failure"),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		} as unknown as StorageProvider;

		const dual = new DualWriteStorage(primary, shadow);
		await expect(dual.writeFiles([{ path: "ok.txt", content: "data" }], "write")).resolves.toBeUndefined();
	});

	describe("deleteVisibleMarkdown delegation", () => {
		it("delegates to the folder-side provider", async () => {
			const folderDelete = vi.fn().mockResolvedValue(undefined);
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deleteVisibleMarkdown: folderDelete,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			const entry = {
				commitHash: "deadbeef",
				parentCommitHash: null,
				commitMessage: "Add login",
				commitDate: "2026-05-12T00:00:00Z",
				branch: "main",
				generatedAt: "2026-05-12T00:00:00Z",
			};
			await dual.deleteVisibleMarkdown(entry);
			expect(folderDelete).toHaveBeenCalledWith(entry);
		});

		it("is a no-op when the folder side lacks the method", async () => {
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			await expect(
				dual.deleteVisibleMarkdown({
					commitHash: "deadbeef",
					parentCommitHash: null,
					commitMessage: "x",
					commitDate: "2026-05-12T00:00:00Z",
					branch: "main",
					generatedAt: "2026-05-12T00:00:00Z",
				}),
			).resolves.toBeUndefined();
		});

		it("marks dirty when the folder side throws", async () => {
			const folderDelete = vi.fn().mockRejectedValue(new Error("disk gone"));
			const markDirty = vi.fn();
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deleteVisibleMarkdown: folderDelete,
				markDirty,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			await dual.deleteVisibleMarkdown({
				commitHash: "deadbeef",
				parentCommitHash: null,
				commitMessage: "x",
				commitDate: "2026-05-12T00:00:00Z",
				branch: "main",
				generatedAt: "2026-05-12T00:00:00Z",
			});
			expect(markDirty).toHaveBeenCalled();
		});
	});

	describe("regenerateVisibleMarkdown delegation", () => {
		const entry = {
			commitHash: "deadbeef",
			parentCommitHash: null,
			commitMessage: "Restore me",
			commitDate: "2026-05-12T00:00:00Z",
			branch: "main",
			generatedAt: "2026-05-12T00:00:00Z",
		};

		it("delegates to the folder-side provider and propagates the boolean result", async () => {
			const folderRegen = vi.fn().mockResolvedValue(true);
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				regenerateVisibleMarkdown: folderRegen,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			const ok = await dual.regenerateVisibleMarkdown(entry);
			expect(folderRegen).toHaveBeenCalledWith(entry);
			expect(ok).toBe(true);
		});

		it("returns false when the folder side lacks the method (no visible layer)", async () => {
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			await expect(dual.regenerateVisibleMarkdown(entry)).resolves.toBe(false);
		});

		it("marks dirty and returns false when the folder side throws", async () => {
			const folderRegen = vi.fn().mockRejectedValue(new Error("disk gone"));
			const markDirty = vi.fn();
			const orphan = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				regenerateVisibleMarkdown: folderRegen,
				markDirty,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphan, folder);
			const ok = await dual.regenerateVisibleMarkdown(entry);
			expect(ok).toBe(false);
			expect(markDirty).toHaveBeenCalled();
		});
	});

	describe("deletePlanVisible delegation", () => {
		const orphanStub = () =>
			({
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			}) as unknown as StorageProvider;

		it("delegates to the folder-side provider", async () => {
			const folderDelete = vi.fn().mockResolvedValue(undefined);
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deletePlanVisible: folderDelete,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await dual.deletePlanVisible("my-plan", "main");
			expect(folderDelete).toHaveBeenCalledWith("my-plan", "main");
		});

		it("is a no-op when the folder side lacks the method", async () => {
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await expect(dual.deletePlanVisible("my-plan", "main")).resolves.toBeUndefined();
		});

		it("marks dirty when the folder side throws", async () => {
			const folderDelete = vi.fn().mockRejectedValue(new Error("disk gone"));
			const markDirty = vi.fn();
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deletePlanVisible: folderDelete,
				markDirty,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await dual.deletePlanVisible("my-plan", "main");
			expect(markDirty).toHaveBeenCalled();
		});
	});

	describe("deleteNoteVisible delegation", () => {
		const orphanStub = () =>
			({
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			}) as unknown as StorageProvider;

		it("delegates to the folder-side provider", async () => {
			const folderDelete = vi.fn().mockResolvedValue(undefined);
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deleteNoteVisible: folderDelete,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await dual.deleteNoteVisible("note-123", "main");
			expect(folderDelete).toHaveBeenCalledWith("note-123", "main");
		});

		it("is a no-op when the folder side lacks the method", async () => {
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await expect(dual.deleteNoteVisible("note-123", "main")).resolves.toBeUndefined();
		});

		it("marks dirty when the folder side throws", async () => {
			const folderDelete = vi.fn().mockRejectedValue(new Error("disk gone"));
			const markDirty = vi.fn();
			const folder = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
				deleteNoteVisible: folderDelete,
				markDirty,
			} as unknown as StorageProvider;
			const dual = new DualWriteStorage(orphanStub(), folder);
			await dual.deleteNoteVisible("note-123", "main");
			expect(markDirty).toHaveBeenCalled();
		});
	});
});
