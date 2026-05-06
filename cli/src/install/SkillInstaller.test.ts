/**
 * Focused tests for the per-skill upsert refactor: ensures both jolli-recall
 * and jolli-search are installed, that the alias `updateSkillIfNeeded` still
 * works, and that templates carry the security-required quoted ARGUMENTS.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateSkillIfNeeded, updateSkillsIfNeeded } from "./SkillInstaller.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jolli-skill-installer-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("updateSkillsIfNeeded", () => {
	it("installs both jolli-recall and jolli-search SKILL.md files", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), "utf-8");
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(recall).toContain("name: jolli-recall");
		expect(search).toContain("name: jolli-search");
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal $\{ARGUMENTS} is the bash placeholder being asserted on
	it("recall template quotes ${ARGUMENTS} (shell-injection defense)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), "utf-8");
		// Recall takes the raw user input as branch/keyword; ${ARGUMENTS} must be
		// wrapped in double quotes when interpolated into bash.
		expect(recall).toMatch(/"\$\{ARGUMENTS\}"/);
		// And no unquoted variants slipped in.
		expect(recall).not.toMatch(/[^"]\$\{ARGUMENTS\}/);
	});

	it("search template instructs the LLM to split query and flags before invoking bash", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Search no longer interpolates ${ARGUMENTS} verbatim because that would
		// swallow flags like `--since 2w` into the query string. The template tells
		// the LLM to construct bash with the query quoted and flags as separate
		// unquoted tokens. Sanity-check that this guidance is present.
		expect(search).toMatch(/Parse \$\{ARGUMENTS\} into query \+ flags/);
		expect(search).toMatch(/"认证" --since 2w/);
		// And the search template still uses double-quoted bash strings around the
		// query portion in the worked examples.
		expect(search).toMatch(/search "认证" --format json/);
	});

	it("search template includes stale-CLI detection (older install missing the search command)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/unknown command 'search'/);
		expect(search).toMatch(/npm update -g @jolli\.ai\/cli/);
	});

	it("search template explains catalog is not pre-filtered by query", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/catalog is NOT pre-filtered by the user's query/);
	});

	it("search template forbids temp-file / shell-script processing of the catalog", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Three explicit DO-NOTs that nudge the LLM away from the failure mode where
		// it tries to "save and process" the JSON instead of reading it inline.
		expect(search).toMatch(/DO NOT write the JSON to a temp file/);
		expect(search).toMatch(/DO NOT run shell scripts/);
		expect(search).toMatch(/semantic picking/);
	});

	it("search template tells the LLM to retry with bigger budget before bothering the user", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/--budget 50000/);
	});

	it("search template includes term-translation guidance for non-technical queries", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/Term translation for non-technical queries/);
	});

	it("removes legacy skill directories from previous versions", async () => {
		const fs = await import("node:fs");
		fs.mkdirSync(join(tempDir, ".claude/skills/jollimemory-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".claude/skills/jollimemory-recall/SKILL.md"), "old");
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jollimemory-recall"))).toBe(false);
	});

	it("upserts search even when recall already exists at the current version", async () => {
		// Install once.
		await updateSkillsIfNeeded(tempDir);
		const fs = await import("node:fs");
		// Manually delete the search skill to simulate the legacy-installer scenario
		// (where only jolli-recall exists in .claude/skills/ on an older project).
		fs.rmSync(join(tempDir, ".claude/skills/jolli-search"), { recursive: true, force: true });
		// Re-run: search should be re-installed even though recall is at the current version.
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("backward-compat alias updateSkillIfNeeded still installs both skills", async () => {
		await updateSkillIfNeeded(tempDir);
		const fs = await import("node:fs");
		expect(fs.existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
	});
});
