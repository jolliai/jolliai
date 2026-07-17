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
	GLOBAL_INSTRUCTIONS_PROMPT,
	installGlobalInstructions,
	removeGlobalInstructions,
	removeInstructionsBlock,
	renderInstructionsBlock,
	resolveGlobalInstructionsDecision,
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

	it("includes the memory-routing heuristic (consult memory first for why/history questions)", () => {
		const block = renderInstructionsBlock();
		expect(block).toContain("memory-shaped");
		// Biases toward using memory (high recall) ...
		expect(block).toContain("lean toward consulting memory");
		expect(block).toContain("run a quick `jolli-search` first");
		// ... while excluding pure code/mechanical questions (precision).
		expect(block).toContain("answer those from the code directly");
		// A whole-feature "how does it work / how is it designed" question is
		// design-shaped, so it must route TO memory, not be swallowed by the
		// current-state exclusion (the gap that skipped memory on a design question).
		expect(block).toContain("How it works / design");
		expect(block).toContain("design-shaped");
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

describe("GLOBAL_INSTRUCTIONS_PROMPT", () => {
	it("leads with the benefit and names the target files", () => {
		expect(GLOBAL_INSTRUCTIONS_PROMPT).toContain("use Jolli's memory automatically");
		expect(GLOBAL_INSTRUCTIONS_PROMPT).toContain("~/.claude/CLAUDE.md");
		expect(GLOBAL_INSTRUCTIONS_PROMPT).not.toContain("[Y/n]");
	});
});

describe("resolveGlobalInstructionsDecision", () => {
	it("writes when the switch is enabled", () => {
		expect(resolveGlobalInstructionsDecision("enabled")).toEqual({ write: true });
	});

	it("removes when the switch is disabled", () => {
		expect(resolveGlobalInstructionsDecision("disabled")).toEqual({ write: false, remove: true });
	});

	it("skips when the switch is undecided — the block is never written on the user's behalf", () => {
		expect(resolveGlobalInstructionsDecision(undefined)).toEqual({ write: false });
	});
});

describe("removeInstructionsBlock", () => {
	const block = renderInstructionsBlock();

	it("returns the input unchanged when no block is present", () => {
		const existing = "# My global rules\n\nBe concise.\n";
		expect(removeInstructionsBlock(existing)).toBe(existing);
	});

	it("strips a marker block and the blank separator it was appended after", () => {
		const existing = applyInstructionsBlock("# My global rules\n\nBe concise.\n", block);
		expect(existing).toContain(START);
		const removed = removeInstructionsBlock(existing);
		expect(removed).not.toContain(START);
		expect(removed).not.toContain(END);
		expect(removed).not.toContain("jolli-pr");
		// Surrounding user content survives; no dangling blank line at EOF.
		expect(removed).toContain("# My global rules");
		expect(removed).toContain("Be concise.");
		expect(removed.endsWith("\n\n")).toBe(false);
	});

	it("round-trips: apply then remove restores content around the block", () => {
		const original = "# Rules\n\nline one\n";
		const withBlock = applyInstructionsBlock(original, block);
		expect(removeInstructionsBlock(withBlock)).toContain("line one");
	});
});

describe("removeGlobalInstructions", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "jolli-global-instr-rm-"));
		mockHomedir.mockReturnValue(home);
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("removes the block from every host, ungated, and leaves other content", async () => {
		// Pre-existing user content around a written block in two hosts.
		await installGlobalInstructions({ claude: true, gemini: true, codex: false });
		await mkdir(join(home, ".claude"), { recursive: true });

		await removeGlobalInstructions();

		const claude = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		const gemini = await readFile(join(home, ".gemini", "GEMINI.md"), "utf-8");
		expect(claude).not.toContain("jolli-pr");
		expect(gemini).not.toContain("jolli-pr");
	});

	it("is a fail-soft no-op when a host file does not exist", async () => {
		// No files written; removal must not throw or create files.
		await expect(removeGlobalInstructions()).resolves.toBeUndefined();
		await expect(readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")).rejects.toThrow();
	});
});
