import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

import {
	applyInstructionsBlock,
	installGlobalInstructions,
	renderInstructionsBlock,
} from "./GlobalInstructionsInstaller.js";

const START = "<!-- >>> jolli memory instructions >>> -->";
const END = "<!-- <<< jolli memory instructions <<< -->";

describe("renderInstructionsBlock", () => {
	it("wraps all three skill names in a marker block ending with a newline", () => {
		const block = renderInstructionsBlock();
		expect(block.startsWith(START)).toBe(true);
		expect(block.endsWith(`${END}\n`)).toBe(true);
		expect(block).toContain("jolli-pr");
		expect(block).toContain("jolli-search");
		expect(block).toContain("jolli-recall");
	});
});

describe("applyInstructionsBlock", () => {
	const block = renderInstructionsBlock();

	it("returns the block alone for empty input", () => {
		expect(applyInstructionsBlock("", block)).toBe(block);
	});

	it("appends the block after existing content with exactly one separating newline", () => {
		const result = applyInstructionsBlock("# My notes\n", block);
		expect(result).toBe(`# My notes\n${block}`);
	});

	it("adds a separating newline when existing content has no trailing newline", () => {
		const result = applyInstructionsBlock("# My notes", block);
		expect(result).toBe(`# My notes\n${block}`);
	});

	it("replaces an existing block in place, preserving surrounding content", () => {
		const stale = [START, "## Stale", END].join("\n");
		const existing = `# Top\n${stale}\n# Bottom\n`;
		const result = applyInstructionsBlock(existing, block);
		expect(result).toContain("# Top");
		expect(result).toContain("# Bottom");
		expect(result).toContain("jolli-recall");
		expect(result).not.toContain("## Stale");
	});

	it("is idempotent — applying twice changes nothing", () => {
		const once = applyInstructionsBlock("# Top\n", block);
		expect(applyInstructionsBlock(once, block)).toBe(once);
	});

	it("ignores a marker-like substring that is not on its own line", () => {
		const prose = `Here is a mention of ${START} inside a sentence.\n`;
		const result = applyInstructionsBlock(prose, block);
		// No exact-line marker → block is appended, prose left intact.
		expect(result).toBe(`${prose}${block}`);
	});

	it("adopts an unmarked hand-pasted section instead of appending a duplicate", () => {
		const existing = "## Jolli Memory\n\nOld hand-written text.\n";
		const result = applyInstructionsBlock(existing, block);
		// Whole file was the section → replaced wholesale by the marked block.
		expect(result).toBe(block);
		expect(result).not.toContain("Old hand-written text.");
		// Exactly one heading — no duplicate.
		expect(result.split(START).length - 1).toBe(1);
	});

	it("adopts an unmarked section while preserving content before and after it", () => {
		const existing = "# Top\n\n## Jolli Memory\nold intro\n\n# Bottom\n";
		const result = applyInstructionsBlock(existing, block);
		expect(result).toBe(`# Top\n\n${block}# Bottom\n`);
		expect(result).toContain("jolli-recall");
		expect(result).not.toContain("old intro");
		expect(result.split(START).length - 1).toBe(1);
	});

	it("keeps `###` subsections inside the adopted section, stops at the next `#`/`##`", () => {
		const existing = "## Jolli Memory\nintro\n### Details\nmore\n# Next\ntail\n";
		const result = applyInstructionsBlock(existing, block);
		expect(result).toBe(`${block}# Next\ntail\n`);
		expect(result).not.toContain("### Details");
		expect(result).toContain("# Next");
	});

	it("is idempotent after adopting an unmarked section", () => {
		const once = applyInstructionsBlock("## Jolli Memory\nold\n", block);
		expect(applyInstructionsBlock(once, block)).toBe(once);
	});
});

describe("installGlobalInstructions", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "jolli-global-instr-"));
		mockHomedir.mockReturnValue(home);
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("creates all enabled hosts' global instruction files", async () => {
		await installGlobalInstructions({ claude: true, gemini: true, codex: true });

		const claude = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		const gemini = await readFile(join(home, ".gemini", "GEMINI.md"), "utf-8");
		const codex = await readFile(join(home, ".codex", "AGENTS.md"), "utf-8");
		for (const content of [claude, gemini, codex]) {
			expect(content).toContain(START);
			expect(content).toContain("jolli-pr");
		}
	});

	it("does not create a file for a disabled host", async () => {
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });

		expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")).toContain("jolli-pr");
		await expect(readFile(join(home, ".gemini", "GEMINI.md"), "utf-8")).rejects.toThrow();
		await expect(readFile(join(home, ".codex", "AGENTS.md"), "utf-8")).rejects.toThrow();
	});

	it("preserves pre-existing user content outside the block", async () => {
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(join(home, ".claude", "CLAUDE.md"), "# My global rules\n\nBe concise.\n", "utf-8");

		await installGlobalInstructions({ claude: true, gemini: false, codex: false });

		const content = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		expect(content).toContain("# My global rules");
		expect(content).toContain("Be concise.");
		expect(content).toContain("jolli-recall");
	});

	it("is idempotent — a second run does not change the file", async () => {
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });
		const first = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });
		const second = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		expect(second).toBe(first);
	});
});
