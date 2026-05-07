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
		expect(search).toMatch(/"auth" --since 2w/);
		// And the search template still uses double-quoted bash strings around the
		// query portion in the worked examples.
		expect(search).toMatch(/search "auth" --format json/);
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

	it("search template forbids programmatic processing (temp files / scoring scripts)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Compressed wording vs earlier 4-bullet list, but covers the same two
		// failure modes: writing to /tmp and running scoring shell scripts.
		expect(search).toMatch(/DO NOT\*\* process programmatically/);
		expect(search).toMatch(/no temp files/);
		expect(search).toMatch(/jq\/python\/grep/);
		// Semantic picking is the affirmative side.
		expect(search).toMatch(/Semantic picking/);
	});

	it("search template tells the LLM to retry with bigger budget before bothering the user", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/--budget 50000/);
	});

	// ── Schema documentation in Step 5 ──
	// The skill template now hands LLM the full SearchHit schema and lets it
	// pick the output shape. These tests pin that the schema doc is present
	// and complete, so any future SearchHit-shape change in Search.ts must be
	// mirrored in the template.

	it("search template documents every SearchHit identity / provenance field", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Each top-level SearchHit field appears in the schema list. Some are
		// self-explanatory and have no em-dash description (e.g. `branch`); we
		// just assert the field name appears in `backticks` form.
		expect(search).toMatch(/`hash` —/);
		expect(search).toMatch(/`fullHash` —/);
		expect(search).toMatch(/`commitMessage` —/);
		expect(search).toMatch(/`commitAuthor` —/);
		expect(search).toMatch(/`commitDate` —/);
		expect(search).toMatch(/- `branch`/);
		expect(search).toMatch(/`commitType\?` —/);
		expect(search).toMatch(/`ticketId\?` —/);
		expect(search).toMatch(/`diffStats\?` —/);
		expect(search).toMatch(/`recap\?` —/);
	});

	it("search template marks `decisions` as the star field with explicit emphasis", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Decisions is the highest-signal topic field; the template must call
		// it out so the LLM leans on it for "why" / "rationale" queries.
		expect(search).toMatch(/`decisions` ★ \*\*THE STAR FIELD\*\*/);
		// And a usage hint anchoring the LLM to the right query types.
		expect(search).toMatch(/why did we choose X/);
	});

	it("search template documents every per-topic field", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/`title` —/);
		expect(search).toMatch(/`trigger` —/);
		expect(search).toMatch(/`response` —/);
		expect(search).toMatch(/`decisions` ★/);
		expect(search).toMatch(/`todo\?` —/);
		expect(search).toMatch(/`filesAffected\?` —/);
		expect(search).toMatch(/`category\?` —/);
		expect(search).toMatch(/`importance\?` —/);
	});

	// ── Universal principles ──
	// The principles encode lessons from past dogfood failures and are the only
	// hard constraints (the output shape itself is up to the LLM). These tests
	// pin each principle so a careless edit can't silently drop one.

	it("search template lists Lead-with-the-answer principle and forbids Found-N-out-of-M opener", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/Lead with the answer/);
		// Negative rationale must be present so future contributors don't add the
		// "Found N out of M" opener back as helpful coverage info.
		expect(search).toMatch(/Found N relevant commits out of M/);
	});

	it("search template requires file paths as markdown links and forbids backtick-only", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/\[cli\/src\/Types\.ts\]\(cli\/src\/Types\.ts\)/);
		// Negative-rationale prose is split across two lines after the markdown
		// example, so use \s+ for whitespace tolerance.
		expect(search).toMatch(/Never wrap\s+file paths in backticks alone/);
	});

	it("search template forbids snippet dumps but ENCOURAGES short bold verbatim quotes from recap/decisions", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Synthesize-don't-dump is still in (no wall-of-fragments).
		expect(search).toMatch(/Synthesize, don't dump/);
		expect(search).toMatch(/wall-of-fragments/);
		// New: bold verbatim quotes are explicitly encouraged. This is the principle
		// that makes "the answer came from real stored data" visually obvious to the
		// user — bolding signals "this came from `recap` or `decisions` verbatim".
		expect(search).toMatch(/short verbatim quotes/);
		// The bold convention is reserved for verbatim — not generic emphasis.
		expect(search).toMatch(/Bold in this skill means "verbatim from stored data"/);
		// And a worked example anchoring the format the LLM should emit.
		expect(search).toMatch(/\*\*"stateless, scales horizontally"\*\*/);
	});

	it("search template forbids exposing search machinery (Phase 1 / Phase 2 / catalog)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).toMatch(/Don't expose search machinery/);
	});

	it("search template forbids Open-in-IDE / vscode:// links and points at jolli view as fallback", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Earlier iterations rendered [Open in IDE](vscode://...) — chat webview
		// silently strips the click. Don't resurrect.
		expect(search).toMatch(/No `\[Open in IDE\]\(vscode:\/\/\.\.\.\)`/);
		// The replacement open action — works in any chat surface via Bash tool.
		expect(search).toMatch(/jolli view --commit <hash>/);
	});

	// ── Free-shape rendering (the central design point) ──

	it("search template explicitly tells the LLM the output shape is its call", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// The whole point of the rewrite — pin the language that liberates the
		// LLM from a fixed template. If a future edit adds back "Section 1 / 2 / 3"
		// rigidity, this test catches it.
		expect(search).toMatch(/Output shape is entirely your call/);
		// And the negative: no Section-N rigidity left over.
		expect(search).not.toMatch(/Section 1 — Top-line summary/);
		expect(search).not.toMatch(/Section 2 — Core commits table/);
		expect(search).not.toMatch(/Section 3 — Grouped synthesis/);
		// Don't even suggest specific shapes — earlier iterations had a 5-row
		// "what is X → prose, compare A vs B → side-by-side, …" suggestion
		// table that contradicted the "completely free shape" intent. Catch
		// any future re-introduction.
		expect(search).not.toMatch(/"compare A vs B".*side-by-side/);
	});

	it("search template tightens the Step 3 picks limit from 5-15 to 5-10", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		// Phase 2 now carries full topic content per hit — picking 15 risks
		// blowing the chat context budget. 5-10 is the new band.
		expect(search).toMatch(/Pick \*\*5-10\*\*/);
		expect(search).not.toMatch(/Pick 5-15/);
	});

	// Skill templates ship to international users — they must stay English-only
	// (the LLM is told to translate replies into the user's language). Lock this
	// in: any future template edit that slips CJK / Hiragana / Katakana / Hangul
	// chars into either SKILL.md is a regression caught here.
	const CJK_AND_OTHER_NON_LATIN = /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/u;

	it("recall template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), "utf-8");
		expect(recall).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});

	it("search template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readFileSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"), "utf-8");
		expect(search).not.toMatch(CJK_AND_OTHER_NON_LATIN);
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
