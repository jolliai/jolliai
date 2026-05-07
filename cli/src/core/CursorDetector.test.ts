import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

const { mockSqliteSupport } = vi.hoisted(() => ({
	mockSqliteSupport: vi.fn().mockReturnValue(true),
}));
vi.mock("./SqliteHelpers.js", async () => ({
	hasNodeSqliteSupport: mockSqliteSupport,
}));

import { getCursorGlobalDbPath, getCursorWorkspaceStorageDir, isCursorInstalled } from "./CursorDetector.js";

describe("isCursorInstalled (darwin)", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "cursor-detector-"));
		mockHomedir.mockReturnValue(tmpHome);
		mockPlatform.mockReturnValue("darwin");
		mockSqliteSupport.mockReturnValue(true);
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("returns false when neither app nor data dir exists", async () => {
		expect(await isCursorInstalled()).toBe(false);
	});

	it("returns false when data db does not exist", async () => {
		await mkdir(join(tmpHome, "Library/Application Support/Cursor/User/globalStorage"), { recursive: true });
		expect(await isCursorInstalled()).toBe(false);
	});

	it("returns true when data db exists and Node has SQLite support", async () => {
		const globalDir = join(tmpHome, "Library/Application Support/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		expect(await isCursorInstalled()).toBe(true);
	});

	it("returns false when Node lacks SQLite support, even if data exists", async () => {
		const globalDir = join(tmpHome, "Library/Application Support/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		mockSqliteSupport.mockReturnValue(false);
		expect(await isCursorInstalled()).toBe(false);
	});
});

describe("isCursorInstalled (linux)", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "cursor-detector-"));
		mockHomedir.mockReturnValue(tmpHome);
		mockPlatform.mockReturnValue("linux");
		mockSqliteSupport.mockReturnValue(true);
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("uses ~/.config/Cursor on linux", async () => {
		const globalDir = join(tmpHome, ".config/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		expect(await isCursorInstalled()).toBe(true);
	});
});

describe("getCursorGlobalDbPath", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/home/user");
	});

	it("returns the darwin path", () => {
		mockPlatform.mockReturnValue("darwin");
		expect(getCursorGlobalDbPath()).toBe(
			join("/home/user", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
		);
	});

	it("returns the linux path", () => {
		mockPlatform.mockReturnValue("linux");
		expect(getCursorGlobalDbPath()).toBe(
			join("/home/user", ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
		);
	});

	it("returns a Cursor-rooted path on win32", () => {
		mockPlatform.mockReturnValue("win32");
		const result = getCursorGlobalDbPath();
		const suffix = join("Cursor", "User", "globalStorage", "state.vscdb");
		expect(result.endsWith(suffix)).toBe(true);
	});
});

describe("getCursorWorkspaceStorageDir", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/home/user");
	});

	it("returns the darwin workspaceStorage path", () => {
		mockPlatform.mockReturnValue("darwin");
		expect(getCursorWorkspaceStorageDir()).toBe(
			join("/home/user", "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
		);
	});

	it("returns the linux workspaceStorage path", () => {
		mockPlatform.mockReturnValue("linux");
		expect(getCursorWorkspaceStorageDir()).toBe(
			join("/home/user", ".config", "Cursor", "User", "workspaceStorage"),
		);
	});

	it("honors an explicit home override (used by tests/installs not running as the real user)", () => {
		mockPlatform.mockReturnValue("darwin");
		expect(getCursorWorkspaceStorageDir("/tmp/sandbox")).toBe(
			join("/tmp/sandbox", "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
		);
	});
});
