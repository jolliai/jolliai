import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealResult, StorageProvider } from "../core/StorageProvider.js";
import { registerHealFolderCommand } from "./HealFolderCommand.js";

// Mock the storage factory so the command never touches a real ~/.jolli config
// or a real git repo. Each test installs its own implementation via mockResolvedValue.
const { mockCreateStorage, mockLoadConfig } = vi.hoisted(() => ({
	mockCreateStorage: vi.fn(),
	mockLoadConfig: vi.fn(),
}));

vi.mock("../core/StorageFactory.js", () => ({
	createStorage: mockCreateStorage,
}));

vi.mock("../core/SessionTracker.js", async () => ({
	loadConfig: mockLoadConfig,
}));

// Logger writes to disk in setLogDir; skip that path so tests don't create files.
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return {
		...actual,
		setLogDir: vi.fn(),
		createLogger: () => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		}),
	};
});

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerHealFolderCommand(program);
	return program;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", "heal-folder", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

function makeStorageWith(result: HealResult | null): StorageProvider {
	const base: StorageProvider = {
		readFile: vi.fn(),
		writeFiles: vi.fn(),
		listFiles: vi.fn(),
		exists: vi.fn().mockResolvedValue(true),
		ensure: vi.fn(),
	};
	if (result !== null) {
		return {
			...base,
			healMissingVisibleMarkdown: vi.fn().mockResolvedValue(result),
		};
	}
	return base;
}

describe("registerHealFolderCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfig.mockResolvedValue({ storageMode: "dual-write" });
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("prints 'Heal not available' when the active storage lacks the heal method", async () => {
		mockCreateStorage.mockResolvedValue(makeStorageWith(null));
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-orphan"]);
		expect(stdout).toContain("Heal not available");
		expect(stdout).toContain("storageMode=dual-write");
	});

	it("prints 'Manifest is empty' when the manifest had no entries", async () => {
		mockCreateStorage.mockResolvedValue(makeStorageWith({ healed: 0, skipped: 0, failed: 0 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-empty"]);
		expect(stdout).toContain("Manifest is empty");
	});

	it("prints 'No heal needed' when entries exist but everything is on disk", async () => {
		mockCreateStorage.mockResolvedValue(makeStorageWith({ healed: 0, skipped: 5, failed: 0 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-clean"]);
		expect(stdout).toContain("No heal needed");
		expect(stdout).toContain("Skipped: 5");
	});

	it("reports healed counts and skipped files when files were regenerated", async () => {
		mockCreateStorage.mockResolvedValue(makeStorageWith({ healed: 3, skipped: 18, failed: 0 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-success"]);
		expect(stdout).toContain("Healed:   3");
		expect(stdout).toContain("Skipped:  18");
		expect(stdout).not.toContain("Failed:");
		expect(stdout).not.toContain("Re-run `jolli enable`");
	});

	it("reports failed entries with dropped IDs when manifest rows were dropped", async () => {
		mockCreateStorage.mockResolvedValue(
			makeStorageWith({
				healed: 0,
				skipped: 4,
				failed: 2,
				droppedIds: ["aabbccdd00112233", "eeff445566778899"],
			}),
		);
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-partial"]);
		// Heal line is omitted when 0 — the CLI only prints non-zero counts.
		expect(stdout).not.toMatch(/Healed:\s+0/);
		expect(stdout).toContain("Failed:   2");
		expect(stdout).toContain("Dropped from manifest: 2");
		expect(stdout).toContain("aabbccdd, eeff4455");
		expect(stdout).toContain("Re-run `jolli enable`");
	});

	it("folder-only mode keeps failed entries and tells the user not to expect orphan repopulation", async () => {
		mockLoadConfig.mockResolvedValue({ storageMode: "folder" });
		mockCreateStorage.mockResolvedValue(makeStorageWith({ healed: 0, skipped: 4, failed: 2 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-folder-only"]);
		expect(stdout).toContain("Failed:   2");
		expect(stdout).not.toContain("Dropped from manifest");
		expect(stdout).toContain("folder-only mode has no truth source");
		expect(stdout).not.toContain("Re-run `jolli enable`");
	});

	it("reports both healed and failed counts together", async () => {
		mockCreateStorage.mockResolvedValue(
			makeStorageWith({ healed: 5, skipped: 10, failed: 1, droppedIds: ["dead00000000beef"] }),
		);
		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-heal-test-mixed"]);
		expect(stdout).toContain("Healed:   5");
		expect(stdout).toContain("Skipped:  10");
		expect(stdout).toContain("Failed:   1");
	});

	// When DualWriteStorage swallows a shadow exception it surfaces it via
	// HealResult.error. The CLI must NOT report "No heal needed" in that case —
	// the user explicitly ran a recovery command and deserves a true status.
	it("prints an explicit error message when the heal pass aborted with an exception", async () => {
		mockCreateStorage.mockResolvedValue(
			makeStorageWith({ healed: 0, skipped: 0, failed: 0, error: "shadow storage manifest write failed" }),
		);
		const { stdout, stderr } = await runCommand(["--cwd", "/tmp/jolli-heal-test-errored"]);
		expect(stderr).toContain("Heal errored");
		expect(stderr).toContain("shadow storage manifest write failed");
		expect(stdout).not.toContain("No heal needed");
		expect(process.exitCode).toBe(1);
	});

	it("aborts with exit 1 when createStorage throws", async () => {
		mockCreateStorage.mockRejectedValue(new Error("config.json corrupted"));
		const { stderr } = await runCommand(["--cwd", "/tmp/jolli-heal-test-config-error"]);
		expect(stderr).toContain("Heal aborted");
		expect(stderr).toContain("config.json corrupted");
		expect(stderr).toContain("jolli doctor");
		expect(process.exitCode).toBe(1);
	});

	// Folder-only mode talks directly to FolderStorage which does NOT
	// self-catch its manifest read/replace/regenerate throws. The CLI must
	// wrap that path so a corrupted manifest / EACCES / ENOSPC becomes the
	// same "Heal errored:" exit-1 path as a DualWriteStorage-surfaced error,
	// instead of bubbling up as an uncaught promise rejection.
	it("catches a synchronous throw from healMissingVisibleMarkdown (folder-only path)", async () => {
		mockLoadConfig.mockResolvedValue({ storageMode: "folder" });
		const base: StorageProvider = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		};
		mockCreateStorage.mockResolvedValue({
			...base,
			healMissingVisibleMarkdown: vi.fn().mockRejectedValue(new Error("manifest.json is unreadable")),
		});
		const { stderr } = await runCommand(["--cwd", "/tmp/jolli-heal-test-folder-throw"]);
		expect(stderr).toContain("Heal errored");
		expect(stderr).toContain("manifest.json is unreadable");
		expect(process.exitCode).toBe(1);
	});

	// When the underlying error carries an errno code (EACCES / ENOSPC / ...)
	// the CLI must surface it so operators see the failure category, not just
	// a bare message.
	it("prepends the errno to the message when the thrown error has a `code`", async () => {
		mockLoadConfig.mockResolvedValue({ storageMode: "folder" });
		const eaccesError = Object.assign(new Error("permission denied opening manifest"), { code: "EACCES" });
		const base: StorageProvider = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
		};
		mockCreateStorage.mockResolvedValue({
			...base,
			healMissingVisibleMarkdown: vi.fn().mockRejectedValue(eaccesError),
		});
		const { stderr } = await runCommand(["--cwd", "/tmp/jolli-heal-test-eacces"]);
		expect(stderr).toContain("Heal errored: [EACCES] permission denied opening manifest");
		expect(process.exitCode).toBe(1);
	});
});
