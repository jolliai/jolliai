import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const {
	TreeItem,
	ThemeIcon,
	ThemeColor,
	EventEmitter,
	MarkdownString,
	Uri,
	RelativePattern,
	workspace,
	commands,
} = vi.hoisted(() => {
	class TreeItem {
		label: string;
		collapsibleState: number;
		id?: string;
		description?: string;
		iconPath?: unknown;
		contextValue?: string;
		tooltip?: unknown;
		command?: unknown;
		fsPath?: string;
		manifestEntry?: unknown;
		constructor(label: string, collapsibleState: number) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	}
	class ThemeIcon {
		readonly id: string;
		static Folder = new ThemeIcon("folder");
		constructor(id: string) {
			this.id = id;
		}
	}
	class EventEmitter {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	}
	class MarkdownString {
		value: string;
		isTrusted?: boolean;
		constructor(value: string) {
			this.value = value;
		}
	}
	const Uri = {
		file: (path: string) => ({ fsPath: path, scheme: "file" }),
	};
	class ThemeColor {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	class RelativePattern {
		constructor(
			public base: unknown,
			public pattern: string,
		) {}
	}
	const mockWatcher = {
		onDidCreate: vi.fn(),
		onDidChange: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn(),
	};
	const workspace = {
		createFileSystemWatcher: vi.fn().mockReturnValue(mockWatcher),
	};
	const commands = {
		executeCommand: vi.fn(),
	};
	return {
		TreeItem,
		ThemeIcon,
		ThemeColor,
		EventEmitter,
		MarkdownString,
		Uri,
		RelativePattern,
		workspace,
		commands,
	};
});

vi.mock("vscode", () => ({
	TreeItem,
	ThemeIcon,
	ThemeColor,
	EventEmitter,
	MarkdownString,
	Uri,
	RelativePattern,
	workspace,
	commands,
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}));

import {
	KBFileItem,
	KBFolderItem,
	KnowledgeBaseTreeProvider,
} from "./KnowledgeBaseTreeProvider.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`kb-tree-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
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

function writeManifest(
	kbRoot: string,
	files: Array<{
		path: string;
		fileId: string;
		type: string;
		title?: string;
	}>,
): void {
	const jolliDir = join(kbRoot, ".jolli");
	mkdirSync(jolliDir, { recursive: true });
	const manifest = {
		version: 1,
		files: files.map((f) => ({
			path: f.path,
			fileId: f.fileId,
			type: f.type,
			fingerprint: "test",
			source: { commitHash: f.fileId, branch: "main" },
			title: f.title,
		})),
	};
	writeFileSync(join(jolliDir, "manifest.json"), JSON.stringify(manifest));
}

function createKBStructure(
	kbRoot: string,
	structure: Record<string, string[]>,
): void {
	for (const [folder, files] of Object.entries(structure)) {
		const dir = join(kbRoot, folder);
		mkdirSync(dir, { recursive: true });
		for (const file of files) {
			writeFileSync(join(dir, file), `# ${file}`);
		}
	}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("KnowledgeBaseTreeProvider", () => {
	let kbRoot: string;
	let provider: KnowledgeBaseTreeProvider;

	beforeEach(() => {
		kbRoot = makeTmpDir();
		provider = new KnowledgeBaseTreeProvider();
	});

	afterEach(() => {
		provider.dispose();
		rmrf(kbRoot);
	});

	describe("getChildren — no kbRoot set", () => {
		it("returns empty array when kbRoot is not set", () => {
			expect(provider.getChildren()).toEqual([]);
		});
	});

	describe("getChildren — empty folder", () => {
		it("returns empty array for empty KB folder", () => {
			provider.setKBRoot(kbRoot);
			expect(provider.getChildren()).toEqual([]);
		});
	});

	describe("getChildren — with branch folders and files", () => {
		beforeEach(() => {
			createKBStructure(kbRoot, {
				main: ["commit-abc12345.md"],
				"feature-login": ["add-oauth-def45678.md", "notes.md"],
			});
			provider.setKBRoot(kbRoot);
		});

		it("returns folder items at root level", () => {
			const children = provider.getChildren();
			expect(children).toHaveLength(2);
			expect(children[0]).toBeInstanceOf(KBFolderItem);
			expect(children[1]).toBeInstanceOf(KBFolderItem);
		});

		it("sorts folders alphabetically", () => {
			const children = provider.getChildren();
			const names = children.map((c) => c.label);
			expect(names).toEqual(["feature-login", "main"]);
		});

		it("returns file items inside folders", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const mainFiles = provider.getChildren(mainFolder);
			expect(mainFiles).toHaveLength(1);
			expect(mainFiles[0]).toBeInstanceOf(KBFileItem);
		});

		it("returns multiple files in a folder", () => {
			const folders = provider.getChildren();
			const loginFolder = folders.find(
				(f) => f.label === "feature-login",
			) as KBFolderItem;
			const files = provider.getChildren(loginFolder);
			expect(files).toHaveLength(2);
		});
	});

	describe("hidden directories", () => {
		beforeEach(() => {
			createKBStructure(kbRoot, {
				main: ["file.md"],
				".jolli": ["manifest.json"],
				summaries: ["abc.json"],
				transcripts: ["abc.json"],
				"plan-progress": ["plan.json"],
			});
			provider.setKBRoot(kbRoot);
		});

		it("hides .jolli directory", () => {
			const names = provider.getChildren().map((c) => c.label);
			expect(names).not.toContain(".jolli");
		});

		it("hides summaries directory", () => {
			const names = provider.getChildren().map((c) => c.label);
			expect(names).not.toContain("summaries");
		});

		it("hides transcripts directory", () => {
			const names = provider.getChildren().map((c) => c.label);
			expect(names).not.toContain("transcripts");
		});

		it("hides plan-progress directory", () => {
			const names = provider.getChildren().map((c) => c.label);
			expect(names).not.toContain("plan-progress");
		});

		it("hides dotfiles", () => {
			writeFileSync(join(kbRoot, ".DS_Store"), "");
			const root = provider.getChildren();
			const names = root.map((c) => c.label);
			expect(names).not.toContain(".DS_Store");
		});

		it("hides index.json at root", () => {
			writeFileSync(join(kbRoot, "index.json"), "{}");
			const root = provider.getChildren();
			const fileNames = root
				.filter((c) => c instanceof KBFileItem)
				.map((c) => (c as KBFileItem).fsPath);
			expect(fileNames.some((p) => (p as string).includes("index.json"))).toBe(
				false,
			);
		});
	});

	describe("manifest badges and titles", () => {
		beforeEach(() => {
			createKBStructure(kbRoot, {
				main: ["add-login-abc12345.md", "my-plan.md", "user-doc.md"],
			});
			writeManifest(kbRoot, [
				{
					path: "main/add-login-abc12345.md",
					fileId: "abc12345",
					type: "commit",
					title: "Add login feature",
				},
				{
					path: "main/my-plan.md",
					fileId: "plan1",
					type: "plan",
					title: "Auth Plan",
				},
			]);
			provider.setKBRoot(kbRoot);
		});

		it("shows readable title for commit files", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			const commitFile = files.find((f) => f.label === "Add login feature");
			expect(commitFile).toBeDefined();
		});

		it("shows C badge for commit files", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			const commitFile = files.find(
				(f) => f.label === "Add login feature",
			) as KBFileItem;
			expect(commitFile.description).toBe("C");
		});

		it("shows P badge for plan files", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			const planFile = files.find((f) => f.label === "Auth Plan") as KBFileItem;
			expect(planFile.description).toBe("P");
		});

		it("shows no badge for user files", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			const userFile = files.find(
				(f) => f.label === "user-doc.md",
			) as KBFileItem;
			expect(userFile.description).toBeUndefined();
		});

		it("falls back to filename when no title in manifest", () => {
			const folders = provider.getChildren();
			const mainFolder = folders.find(
				(f) => f.label === "main",
			) as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			const userFile = files.find((f) => f.label === "user-doc.md");
			expect(userFile).toBeDefined();
		});
	});

	describe("KBFileItem commands", () => {
		it("commit file has openKBCommitSummary command", () => {
			const entry = {
				path: "main/test.md",
				fileId: "abc",
				type: "commit",
				fingerprint: "fp",
				source: {},
			};
			const item = new KBFileItem("test.md", "/path/test.md", entry);
			expect(item.command?.command).toBe("jollimemory.openKBCommitSummary");
		});

		it("markdown file has markdown.showPreview command", () => {
			const item = new KBFileItem("notes.md", "/path/notes.md");
			expect(item.command?.command).toBe("markdown.showPreview");
		});

		it("plan file has markdown.showPreview command", () => {
			const entry = {
				path: "main/plan.md",
				fileId: "p1",
				type: "plan",
				fingerprint: "fp",
				source: {},
			};
			const item = new KBFileItem("plan.md", "/path/plan.md", entry);
			expect(item.command?.command).toBe("markdown.showPreview");
		});
	});

	describe("KBFolderItem", () => {
		it("has correct contextValue", () => {
			const item = new KBFolderItem("main", "/path/main");
			expect(item.contextValue).toBe("kbFolder");
		});

		it("is expanded by default", () => {
			const item = new KBFolderItem("main", "/path/main");
			expect(item.collapsibleState).toBe(2); // Expanded
		});
	});

	describe("refresh", () => {
		it("picks up new files after refresh", () => {
			provider.setKBRoot(kbRoot);
			expect(provider.getChildren()).toHaveLength(0);

			// Add a folder with a file
			createKBStructure(kbRoot, { main: ["new-file.md"] });
			provider.refresh();

			expect(provider.getChildren()).toHaveLength(1);
		});
	});

	describe("dispose", () => {
		it("disposes watchers and emitter", () => {
			provider.setKBRoot(kbRoot);
			provider.dispose();
			// No error thrown — watchers and emitter cleaned up
		});
	});

	describe("nested folders", () => {
		beforeEach(() => {
			createKBStructure(kbRoot, {
				"feature-login": [],
				"feature-login/commits": ["a.md", "b.md"],
			});
			provider.setKBRoot(kbRoot);
		});

		it("shows nested subfolders", () => {
			const root = provider.getChildren();
			const loginFolder = root.find(
				(f) => f.label === "feature-login",
			) as KBFolderItem;
			const children = provider.getChildren(loginFolder);
			const subFolder = children.find(
				(f) => f.label === "commits",
			) as KBFolderItem;
			expect(subFolder).toBeDefined();
			expect(subFolder).toBeInstanceOf(KBFolderItem);
		});

		it("shows files inside nested folders", () => {
			const root = provider.getChildren();
			const loginFolder = root.find(
				(f) => f.label === "feature-login",
			) as KBFolderItem;
			const children = provider.getChildren(loginFolder);
			const commitsFolder = children.find(
				(f) => f.label === "commits",
			) as KBFolderItem;
			const files = provider.getChildren(commitsFolder);
			expect(files).toHaveLength(2);
		});
	});

	describe("corrupt manifest", () => {
		it("handles corrupt manifest gracefully", () => {
			createKBStructure(kbRoot, { main: ["file.md"] });
			const jolliDir = join(kbRoot, ".jolli");
			mkdirSync(jolliDir, { recursive: true });
			writeFileSync(join(jolliDir, "manifest.json"), "not json!!!");
			provider.setKBRoot(kbRoot);

			const children = provider.getChildren();
			expect(children).toHaveLength(1);
			// File has no badge since manifest is corrupt
			const mainFolder = children[0] as KBFolderItem;
			const files = provider.getChildren(mainFolder);
			expect(files).toHaveLength(1);
			expect((files[0] as KBFileItem).description).toBeUndefined();
		});
	});

	describe("empty folders", () => {
		it("shows empty folders", () => {
			mkdirSync(join(kbRoot, "empty-branch"), { recursive: true });
			provider.setKBRoot(kbRoot);
			const children = provider.getChildren();
			expect(children).toHaveLength(1);
			expect(children[0].label).toBe("empty-branch");
		});
	});
});
