/**
 * Tests for FrameworkDetector — detects documentation framework config files.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-framework-test-"));
}

describe("FrameworkDetector.detectFramework", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns null when no framework config is found", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		expect(detectFramework(tempDir)).toBeNull();
	});

	it("detects Docusaurus by sidebars.js in source root", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "sidebars.js"), "module.exports = {}", "utf-8");

		const result = detectFramework(tempDir);

		expect(result).not.toBeNull();
		expect(result?.name).toBe("docusaurus");
		expect(result?.sidebarPath).toContain("sidebars.js");
	});

	it("detects Docusaurus by docusaurus.config.ts in parent", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		const docsDir = join(tempDir, "docs");
		await mkdir(docsDir, { recursive: true });
		await writeFile(join(tempDir, "docusaurus.config.ts"), "export default {}", "utf-8");
		await writeFile(join(tempDir, "sidebars.js"), "module.exports = {}", "utf-8");

		const result = detectFramework(docsDir);

		expect(result?.name).toBe("docusaurus");
		expect(result?.sidebarPath).toContain("sidebars.js");
	});

	it("detects Mintlify by mint.json", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "mint.json"), "{}", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("mintlify");
	});

	it("detects MkDocs by mkdocs.yml", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "mkdocs.yml"), "site_name: test", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("mkdocs");
	});

	it("detects GitBook by SUMMARY.md", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "SUMMARY.md"), "# Summary", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("gitbook");
	});

	it("detects VitePress by .vitepress/config.ts", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await mkdir(join(tempDir, ".vitepress"), { recursive: true });
		await writeFile(join(tempDir, ".vitepress", "config.ts"), "export default {}", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("vitepress");
	});

	it("detects MkDocs by mkdocs.yaml", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "mkdocs.yaml"), "site_name: test", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("mkdocs");
	});

	it("detects GitBook by .gitbook.yaml", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, ".gitbook.yaml"), "root: ./", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("gitbook");
	});

	it("detects Docusaurus by docusaurus.config.js in source root", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		await writeFile(join(tempDir, "docusaurus.config.js"), "module.exports = {}", "utf-8");

		const result = detectFramework(tempDir);

		expect(result?.name).toBe("docusaurus");
	});

	it("finds sidebar in parent directory when config is in parent", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		const docsDir = join(tempDir, "docs");
		await mkdir(docsDir, { recursive: true });
		await writeFile(join(tempDir, "docusaurus.config.js"), "module.exports = {}", "utf-8");
		await writeFile(join(tempDir, "sidebars.ts"), "module.exports = {}", "utf-8");

		const result = detectFramework(docsDir);

		expect(result?.name).toBe("docusaurus");
		expect(result?.sidebarPath).toContain("sidebars.ts");
	});

	it("returns sidebarPath from source root over parent when both exist", async () => {
		const { detectFramework } = await import("./FrameworkDetector.js");
		const docsDir = join(tempDir, "docs");
		await mkdir(docsDir, { recursive: true });
		await writeFile(join(docsDir, "sidebars.js"), "module.exports = {}", "utf-8");
		await writeFile(join(tempDir, "docusaurus.config.ts"), "export default {}", "utf-8");
		await writeFile(join(tempDir, "sidebars.js"), "module.exports = {}", "utf-8");

		const result = detectFramework(docsDir);

		expect(result?.sidebarPath).toContain(join("docs", "sidebars.js"));
	});
});

// ─── Mock readline (must be top-level for vi.hoisted) ───────────────────────

const { mockCreateInterfaceForPrompt } = vi.hoisted(() => ({
	mockCreateInterfaceForPrompt: vi.fn(),
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterfaceForPrompt,
}));

function mockPromptAnswer(answer: string): void {
	mockCreateInterfaceForPrompt.mockReturnValue({
		question: (_prompt: string, cb: (answer: string) => void) => cb(answer),
		close: vi.fn(),
	});
}

// ─── promptMigration ─────────────────────────────────────────────────────────

describe("FrameworkDetector.promptMigration", () => {
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		process.stdin.isTTY = true;
	});

	afterEach(() => {
		process.stdin.isTTY = originalIsTTY;
		vi.restoreAllMocks();
	});

	it("returns true when user answers Y", async () => {
		mockPromptAnswer("Y");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(true);
	});

	it("returns true when user answers yes", async () => {
		mockPromptAnswer("yes");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(true);
	});

	it("returns true when user presses Enter (empty)", async () => {
		mockPromptAnswer("");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(true);
	});

	it("returns false when user answers n", async () => {
		mockPromptAnswer("n");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(false);
	});

	it("returns false when user answers no", async () => {
		mockPromptAnswer("no");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(false);
	});

	it("returns true without prompting when stdin is not a TTY", async () => {
		process.stdin.isTTY = undefined as unknown as true;
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(true);
	});

	it("returns false for random input", async () => {
		mockPromptAnswer("maybe");
		const { promptMigration } = await import("./FrameworkDetector.js");

		const result = await promptMigration({ name: "docusaurus", configPath: "/test" });

		expect(result).toBe(false);
	});
});
