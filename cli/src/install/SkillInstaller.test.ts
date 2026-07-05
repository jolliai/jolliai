/**
 * SkillInstaller tests.
 *
 * Asserts the v5 spec-compliant cross-platform shape:
 *
 * - One byte-identical SKILL.md written to both `.claude/skills/<name>/` and
 *   `.agents/skills/<name>/` per skill.
 * - Frontmatter contains only the spec-allowed fields (`name`, `description`,
 *   `metadata`) — no Claude-private fields like `argument-hint` or `user-invocable`.
 * - The invocation block uses a here-doc with an LLM-generated high-entropy
 *   delimiter (`JOLLI_ARG_<DELIM>_END`) and `--arg-stdin`, NOT a fixed string,
 *   NOT `$ARGUMENTS` argv interpolation, NOT a double-quoted argv string.
 * - The Claude-target gate (`config.claudeEnabled === false`) skips
 *   `.claude/skills/` but still writes `.agents/skills/`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildRecallSkillTemplate,
	buildSearchSkillTemplate,
	SKILL_GIT_EXCLUDE_PATHS,
	updateSkillIfNeeded,
	updateSkillsIfNeeded,
} from "./SkillInstaller.js";

// Vitest reuses vite's `define` config, so `__PKG_VERSION__` is the real
// package.json version in tests. Use that value when planting legacy SKILL.md
// fixtures so the version-up-to-date short-circuit can fire.
const CURRENT_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jolli-skill-installer-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ─── Convenience readers ────────────────────────────────────────────────────

function readRecall(target: "claude" | "agents" = "claude"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-recall" : ".agents/skills/jolli-recall";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readSearch(target: "claude" | "agents" = "claude"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-search" : ".agents/skills/jolli-search";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readPr(target: "claude" | "agents" = "claude"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-pr" : ".agents/skills/jolli-pr";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

// ─── Dual-target write ──────────────────────────────────────────────────────

describe("updateSkillsIfNeeded — target dimension", () => {
	it("writes all three skills into both .claude/skills/ and .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-pr/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-pr/SKILL.md"))).toBe(true);
	});

	it("writes byte-identical SKILL.md to .claude/skills/ and .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall("claude")).toBe(readRecall("agents"));
		expect(readSearch("claude")).toBe(readSearch("agents"));
		expect(readPr("claude")).toBe(readPr("agents"));
	});

	it("with claudeEnabled=false, skips .claude/skills/ but still writes .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir, { claudeEnabled: false });
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-pr/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-pr/SKILL.md"))).toBe(true);
	});

	it("with claudeEnabled=undefined (default), writes both targets for all skills", async () => {
		await updateSkillsIfNeeded(tempDir, {});
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-pr/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-pr/SKILL.md"))).toBe(true);
	});

	it("exports the 6 git-exclude paths for the three skills × two targets", () => {
		expect(SKILL_GIT_EXCLUDE_PATHS).toEqual([
			"/.claude/skills/jolli-recall/",
			"/.claude/skills/jolli-search/",
			"/.claude/skills/jolli-pr/",
			"/.agents/skills/jolli-recall/",
			"/.agents/skills/jolli-search/",
			"/.agents/skills/jolli-pr/",
		]);
	});
});

// ─── Frontmatter spec compliance ────────────────────────────────────────────

describe("recall template frontmatter", () => {
	it("uses spec-compliant fields only — name, description, metadata.version, metadata.vendor", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/^---\nname: jolli-recall\n/);
		expect(recall).toMatch(/description: Recall prior development context/);
		expect(recall).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}vendor: "jolli\.ai"/);
	});

	it("does NOT contain Claude-private top-level frontmatter fields", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		// argument-hint / user-invocable / disable-model-invocation were Claude-only
		// extensions. agentskills.io spec rejects them; Claude.ai App rejects them.
		expect(recall).not.toMatch(/^argument-hint:/m);
		expect(recall).not.toMatch(/^user-invocable:/m);
		expect(recall).not.toMatch(/^disable-model-invocation:/m);
	});

	it("does NOT carry the legacy top-level jolli-skill-version key", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		// New templates put the version under `metadata.version`. The legacy
		// top-level key is still RECOGNIZED on read (so an existing SKILL.md
		// from an older Jolli isn't needlessly rewritten), but new writes use
		// the nested form only.
		expect(recall).not.toMatch(/^jolli-skill-version:/m);
		expect(recall).not.toMatch(/^jollimemory-version:/m);
	});
});

describe("search template frontmatter", () => {
	it("uses spec-compliant fields only", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/^---\nname: jolli-search\n/);
		expect(search).toMatch(/description: Search structured commit memories/);
		expect(search).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}vendor: "jolli\.ai"/);
	});

	it("does NOT contain Claude-private top-level frontmatter fields", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/^argument-hint:/m);
		expect(search).not.toMatch(/^user-invocable:/m);
		expect(search).not.toMatch(/^disable-model-invocation:/m);
	});
});

describe("pr template frontmatter", () => {
	it("uses spec-compliant fields only — name, description, metadata.version, metadata.vendor", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/^---\nname: jolli-pr\n/);
		expect(pr).toMatch(/description: Create or update a pull request using a Jolli Memory-generated description/);
		expect(pr).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}vendor: "jolli\.ai"/);
	});

	it("does NOT contain Claude-private top-level frontmatter fields", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).not.toMatch(/^argument-hint:/m);
		expect(pr).not.toMatch(/^user-invocable:/m);
		expect(pr).not.toMatch(/^disable-model-invocation:/m);
	});
});

// ─── Shell-injection defense — here-doc + high-entropy delimiter ────────────

describe("here-doc invocation pattern (security)", () => {
	it("recall template uses --arg-stdin + here-doc with <DELIM> placeholder", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/run-cli" recall --arg-stdin --format json <<'JOLLI_ARG_<DELIM>_END'/);
		expect(recall).toMatch(/^JOLLI_ARG_<DELIM>_END$/m);
	});

	it("search template uses --arg-stdin + here-doc with <DELIM> placeholder", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/run-cli" search --arg-stdin .*<<'JOLLI_ARG_<DELIM>_END'/);
		expect(search).toMatch(/^JOLLI_ARG_<DELIM>_END$/m);
	});

	it("recall template requires LLM to generate a fresh 16-char hex delimiter per invocation", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/Generate a fresh random 16-character hex string/);
		expect(recall).toMatch(/Quickly scan the user's argument/);
		expect(recall).toMatch(/regenerate the delimiter token and re-check/);
	});

	it("recall template has a STOP-if-unsafe instruction (refuses to interpolate into argv)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/STOP and tell the user/);
		expect(recall).toMatch(/DO NOT attempt to interpolate the argument into argv/);
		// Phrase wraps over a line break in the template, so allow whitespace
		// between "injection" and "vector".
		expect(recall).toMatch(/known shell injection\s+vector/);
	});

	it("search template has the same STOP-if-unsafe instruction", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/STOP and tell the user/);
		expect(search).toMatch(/DO NOT attempt to interpolate the argument into argv/);
	});

	// ── Shell-prerequisite pin: Git Bash on Windows ─────────────────────────
	// Without this guidance, hosts whose default shell is WSL bash
	// (`C:\Windows\System32\bash.exe`) miss the Jolli entry script because
	// WSL's `$HOME` points to a separate Linux home, not `%USERPROFILE%`.
	it("recall template pins the shell to Git Bash on Windows", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/Git Bash/);
		expect(recall).toMatch(/git-scm\.com\/download\/win/);
		expect(recall).toMatch(/Install Git for Windows/);
		// Must call out WSL bash specifically as not-supported.
		expect(recall).toMatch(/WSL bash/);
	});

	it("search template pins the shell to Git Bash on Windows", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Git Bash/);
		expect(search).toMatch(/git-scm\.com\/download\/win/);
		expect(search).toMatch(/Install Git for Windows/);
		expect(search).toMatch(/WSL bash/);
	});

	it("recall template forbids npm/npx/PowerShell fallback shortcuts", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		// The "Do NOT fall back" line names the specific shortcuts a host LLM
		// is most likely to invent when bash here-doc fails. All must be listed.
		expect(recall).toMatch(/Do NOT fall back/);
		expect(recall).toMatch(/`npm run`/);
		expect(recall).toMatch(/`npx`/);
		expect(recall).toMatch(/PowerShell-native/);
	});

	it("search template forbids npm/npx/PowerShell fallback shortcuts", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Do NOT fall back/);
		expect(search).toMatch(/`npm run`/);
		expect(search).toMatch(/`npx`/);
		expect(search).toMatch(/PowerShell-native/);
	});

	// ── Regression guards: residue from v3/v4 must NOT slip back in ──
	it("recall template carries no $ARGUMENTS residue", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		// Legacy bash placeholders `${ARGUMENTS}` and `$ARGUMENTS` must be
		// gone — the v5 template uses a here-doc instead.
		expect(recall).not.toMatch(/\$\{ARGUMENTS\}/);
		expect(recall).not.toMatch(/"\$ARGUMENTS"/);
		expect(recall).not.toMatch(/'\$ARGUMENTS'/);
	});

	it("search template carries no $ARGUMENTS residue", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/\$\{ARGUMENTS\}/);
		expect(search).not.toMatch(/"\$ARGUMENTS"/);
		expect(search).not.toMatch(/'\$ARGUMENTS'/);
	});

	it("recall template does NOT use a fixed delimiter (must be <DELIM> placeholder, not JOLLI_ARG_EOF)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		// v3 used a fixed delimiter (`JOLLI_ARG_EOF`). v5 requires the delimiter
		// to be a per-invocation LLM-generated random hex value so prompt-injection
		// attacks can't predict it. The marker has to remain a literal `<DELIM>`
		// placeholder in the template so the LLM is told to substitute it.
		expect(recall).not.toMatch(/<<'JOLLI_ARG_EOF'/);
		expect(recall).not.toMatch(/^JOLLI_ARG_EOF$/m);
	});

	it("search template does NOT use a fixed delimiter", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/<<'JOLLI_ARG_EOF'/);
		expect(search).not.toMatch(/^JOLLI_ARG_EOF$/m);
	});
});

// ─── Recall-template content pins (carried over from prior versions) ────────

describe("recall template content", () => {
	it("documents plan stubs (slug+title) and note stubs (id+title) distinctly", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/`plans\?` — `\{ slug, title \}\[\]`/);
		expect(recall).toMatch(/`notes\?` — `\{ id, title \}\[\]`/);
		expect(recall).not.toMatch(/`notes\?`[^.]*slug \+ title/);
	});

	it("conditionally guides quoting based on whether content is present", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/If the entry has `content`/);
		expect(recall).toMatch(/If `content` is absent/);
		expect(recall).toMatch(/never fabricate a quote/);
	});

	it("Part A renders as `### Loaded` heading + bullet block", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/### Loaded `feature\/auth`/);
		expect(recall).toMatch(/\*\*Period:\*\*/);
		expect(recall).toMatch(/\*\*Commits:\*\*/);
		expect(recall).toMatch(/\*\*Captured:\*\*/);
		expect(recall).toMatch(/heading \+ bullet shape is required/);
		expect(recall).toMatch(/### Loaded `feature\/auth`\n\n- \*\*Period:/);
	});

	it("encourages brevity but never at the cost of section structure (principle #6)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/Brief by default/);
		expect(recall).toMatch(/aim for ~500 words/);
		expect(recall).not.toMatch(/~500 words at most/);
		expect(recall).toMatch(/inline-bold paragraph prefixes/);
		expect(recall).toMatch(/may\s+legitimately run longer/);
		expect(recall).toMatch(/deep dive/);
		expect(recall).not.toMatch(/Group commits by theme/);
		expect(recall).not.toMatch(/3-5 key decisions max/);
		expect(recall).not.toMatch(/No subsection headings/);
	});
});

// ─── Search-template content pins (single-phase lightweight) ─────────────────

describe("search template content", () => {
	it("includes stale-CLI detection (older install missing the search command)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/unknown command 'search'/);
		expect(search).toMatch(/npm update -g @jolli\.ai\/cli/);
	});

	it("documents the lightweight hit schema (type/title/snippet/branch/commitDate/slug/hash)", async () => {
		// Single-phase hits are lightweight — no fullHash, no decisions star field,
		// no per-topic fields. Template must document only what the tool returns.
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/`type`/);
		expect(search).toMatch(/`title`/);
		expect(search).toMatch(/`snippet`/);
		expect(search).toMatch(/`branch`/);
		expect(search).toMatch(/`commitDate`/);
		expect(search).toMatch(/`slug`/);
		expect(search).toMatch(/`hash`/);
	});

	it("does NOT promise rich SearchHit fields that are absent from lightweight hits", async () => {
		// The old two-phase template documented fullHash, commitAuthor, diffStats,
		// recap, trigger/response/decisions per-topic, filesAffected, etc. These
		// fields are not in a lightweight hit — template must NOT promise them.
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/`fullHash`/);
		expect(search).not.toMatch(/`commitAuthor`/);
		expect(search).not.toMatch(/`recap\?`/);
		expect(search).not.toMatch(/`trigger\?`/);
		expect(search).not.toMatch(/`response\?`/);
		expect(search).not.toMatch(/decisions ★ \*\*THE STAR FIELD\*\*/);
		expect(search).not.toMatch(/`filesAffected\?`/);
		expect(search).not.toMatch(/`diffStats\?`/);
	});

	it("does NOT contain two-phase machinery (--hashes, load_commits, catalog scan)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toContain("--hashes");
		expect(search).not.toContain("load_commits");
		expect(search).not.toMatch(/catalog is NOT pre-filtered/);
		expect(search).not.toMatch(/--budget 50000/);
		expect(search).not.toMatch(/Phase 2/);
	});

	it("tells the user to use jolli-recall for full decisions/rationale", async () => {
		// Single-phase search can't deliver full decisions — template must redirect.
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/jolli-recall/);
		expect(search).toMatch(/full decisions\/rationale/);
	});

	it("lists Lead-with-the-answer principle and forbids preamble openers", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Lead with the answer/);
		expect(search).toMatch(/No "Let me analyze\.\.\." or "Found N commits\.\.\." preamble/);
	});

	it("forbids snippet dumps and demands complete verbatim clauses", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Synthesize, don't dump/);
		expect(search).toMatch(/wall-of-fragments/);
		expect(search).toMatch(/verbatim quotes from stored data/);
		expect(search).toMatch(/complete clauses \(typically 10-30 words\)/);
		expect(search).toMatch(/not 2-3 word fragments/);
		expect(search).toMatch(/skim the bold quote alone and understand its claim/);
		expect(search).toMatch(
			/\*\*"the stateless model lets us scale horizontally without a shared session store across regions"\*\*/,
		);
		expect(search).toMatch(/Bold = verbatim from stored data/);
		expect(search).toMatch(/Never use bold for general emphasis/);
		expect(search).not.toMatch(/Use sparingly \(1-3 quotes per answer\)/);
	});

	it("forbids exposing machinery (BM25, score, SearchHit)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Don't expose machinery/);
		// New template explicitly bans BM25 and score (lightweight-specific)
		expect(search).toMatch(/"BM25"/);
		expect(search).toMatch(/"SearchHit"/);
		// Old two-phase machinery labels must NOT bleed back in
		expect(search).not.toMatch(/"Phase 1"/);
		expect(search).not.toMatch(/"Phase 2"/);
		expect(search).not.toMatch(/"catalog"/);
	});

	it("does NOT carry the legacy vscode:// principle", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/Open in IDE/);
		expect(search).not.toMatch(/vscode:\/\//);
	});

	it("does NOT carry the legacy near-duplicate principle", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/Skip near-duplicates/);
	});

	it("explicitly tells the LLM the output shape is its call", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Output shape is entirely your call/);
		expect(search).not.toMatch(/Section 1 — Top-line summary/);
	});

	it("handles empty hits gracefully (suggest broader keywords)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/broader keywords/);
		// Must NOT mention BM25 or index internals in the empty-hits path
		expect(search).toMatch(/Do NOT mention BM25/);
	});
});

// ─── MCP-preferred invocation ────────────────────────────────────────────────

describe("recall template MCP-preferred invocation", () => {
	it("recall template prefers MCP recall and keeps the CLI fallback", () => {
		const t = buildRecallSkillTemplate();
		expect(t).toContain("mcp__jollimemory__recall");
		expect(t).toContain('type:"recall"'); // documents type:recall|catalog|error
		expect(t).toContain("$HOME/.jolli/jollimemory/run-cli"); // fallback retained
	});
});

// ─── Search template MCP-preferred invocation ────────────────────────────────

describe("search template MCP-preferred invocation (lightweight hits)", () => {
	it("search template uses MCP search (lightweight hits) + CLI fallback", () => {
		const t = buildSearchSkillTemplate();
		expect(t).toContain("mcp__jollimemory__search");
		expect(t).not.toContain("load_commits"); // no two-phase
		expect(t).not.toContain("--hashes");
		expect(t).toContain("$HOME/.jolli/jollimemory/run-cli"); // fallback retained
	});
});

// ─── PR-template content pins ────────────────────────────────────────────────────────────────────────────

describe("pr template content", () => {
	it("names the MCP tool and its Claude Code alias", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/get_pr_description/);
		expect(pr).toMatch(/mcp__jollimemory__get_pr_description/);
	});

	it("documents the tool return shape", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/"title"/);
		expect(pr).toMatch(/"body"/);
		expect(pr).toMatch(/"missingCount"/);
		expect(pr).toMatch(/"summaryCount"/);
		expect(pr).toMatch(/"commitCount"/);
	});

	it("documents the CLI fallback for hosts without the MCP tool", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// Common (default-base) case: plain invocation, no here-doc needed.
		expect(pr).toMatch(/run-cli" pr-description --format json/);
		// Non-default base rides the same injection-safe here-doc recipe.
		expect(pr).toMatch(/run-cli" pr-description --arg-stdin --format json <<'JOLLI_ARG_<DELIM>_END'/);
		expect(pr).toMatch(/unknown command 'pr-description'/);
	});

	it("instructs to STOP when tool errors with no summaries", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/No JolliMemory summaries/);
		expect(pr).toMatch(/STOP/);
	});

	it("instructs to warn user when missingCount > 0 then continue", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/missingCount/);
		expect(pr).toMatch(/footnote/);
	});

	it("uses --body-file for gh pr create", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/--body-file/);
	});

	it("keeps the temp-body write and the gh command in one shell block", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// A random `mktemp` path can't survive a separate shell invocation, so the
		// heredoc write and the `gh` call must live in the same fenced block.
		const block = pr.match(/JOLLI_PR_BODY_FILE=\$\(mktemp\)[\s\S]*?rm -f "\$JOLLI_PR_BODY_FILE"/)?.[0] ?? "";
		expect(block).toMatch(/gh pr create/);
		expect(block).not.toContain("```");
	});

	it("guards PR detection against a detached HEAD", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/detached HEAD/);
	});

	it("instructs to push the branch first", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/git push -u origin/);
	});

	it("uses plain `git push` when an upstream already exists (no unconditional -u origin)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// An existing upstream may track a non-origin remote; re-pointing it with
		// `-u origin` would push to the wrong place. The template must check for an
		// upstream and reserve `-u origin` for the no-upstream case only.
		expect(pr).toMatch(/@\{u\}/);
		// A line that is exactly `git push` (indented), distinct from the
		// `git push -u origin …` line which carries trailing args.
		expect(pr).toMatch(/\n\s*git push\n/);
	});

	it("forwards a non-default baseBranch to gh as --base", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/--base <baseBranch>/);
	});

	it("does NOT use a fixed here-doc delimiter for the PR body (must be a per-invocation <DELIM>)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// The body is user-controlled commit memory; a fixed delimiter lets a body
		// line close the here-doc early and inject shell. Mirror the recall/search
		// hardening: an LLM-generated per-invocation random hex token.
		expect(pr).not.toMatch(/<<'JOLLI_PR_BODY_END'/);
		expect(pr).not.toMatch(/^JOLLI_PR_BODY_END$/m);
		expect(pr).toMatch(/JOLLI_PR_BODY_<DELIM>_END/);
		expect(pr).toMatch(/regenerate the token and re-check/);
	});

	it("enforces the hard rule: do not rewrite body from diff", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/Do NOT rewrite/);
		expect(pr).toMatch(/body.*MUST come from/i);
	});

	it("forbids Co-Authored-By Claude footer", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/Do NOT add a[\s\S]*Co-Authored-By: Claude/);
	});

	it("preserves the Generated by Jolli Memory product signature", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/Generated by Jolli Memory/);
	});

	it("instructs to relay the PR URL from gh output", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/URL/);
		expect(pr).toMatch(/gh pr create/);
	});

	it("includes gh install hint when gh is missing", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toMatch(/cli\.github\.com/);
		expect(pr).toMatch(/gh auth login/);
	});

	it("Step 0: the jolli-pr template gates on queue-status before building the description", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 0: Wait for pending memory");
		expect(pr).toContain("queue-status");
		expect(pr).toContain("queue_status");
		// Step 0 must come before Step 1.
		expect(pr.indexOf("## Step 0")).toBeLessThan(pr.indexOf("## Step 1"));
	});

	it("Step 6 offers to push memory to Jolli and handles space binding", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 6: Push memory to Jolli");
		expect(pr).toContain("push_memory");
		expect(pr).toContain("binding_required");
		// Report-URL (Step 5) precedes push-memory (Step 6).
		expect(pr.indexOf("## Step 5")).toBeLessThan(pr.indexOf("## Step 6"));
	});

	it("Step 1 detects an existing open PR before building the description", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 1: Detect");
		expect(pr).toMatch(/gh pr list --head/);
		expect(pr).toMatch(/--state open/);
		// Detection (Step 1) must precede description generation (Step 2).
		expect(pr.indexOf("## Step 1")).toBeLessThan(pr.indexOf("## Step 2: Get the PR description"));
	});

	it("Step 4 creates a new PR or updates the existing one", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 4: Create or update the PR");
		// Create path still uses gh pr create; update path uses gh pr edit.
		expect(pr).toMatch(/gh pr create/);
		expect(pr).toMatch(/gh pr edit/);
	});

	it("update mode feeds the existing PR's base into the description", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// Step 1 captures baseRefName; Step 2 passes it so the diff range matches
		// the PR being updated.
		expect(pr).toMatch(/baseRefName/);
	});
});

// ─── No CJK leakage ─────────────────────────────────────────────────────────

describe("English-only", () => {
	const CJK_AND_OTHER_NON_LATIN = /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/u;

	it("recall template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall()).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});

	it("search template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readSearch()).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});

	it("pr template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readPr()).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});
});

// ─── Legacy cleanup + idempotency ───────────────────────────────────────────

describe("legacy directories", () => {
	it("removes legacy skill directories from previous versions", async () => {
		const fs = await import("node:fs");
		fs.mkdirSync(join(tempDir, ".claude/skills/jollimemory-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".claude/skills/jollimemory-recall/SKILL.md"), "old");
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jollimemory-recall"))).toBe(false);
	});

	it("upserts search even when recall already exists at the current version", async () => {
		await updateSkillsIfNeeded(tempDir);
		const fs = await import("node:fs");
		fs.rmSync(join(tempDir, ".claude/skills/jolli-search"), { recursive: true, force: true });
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("backward-compat alias updateSkillIfNeeded installs all skills into both targets", async () => {
		await updateSkillIfNeeded(tempDir);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-pr/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-pr/SKILL.md"))).toBe(true);
	});

	it("backward-compat alias respects claudeEnabled=false", async () => {
		await updateSkillIfNeeded(tempDir, { claudeEnabled: false });
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
	});
});

// ─── Version-line recognition (legacy keys still respected on read) ─────────

describe("version-line compatibility", () => {
	it("recognizes a SKILL.md with the legacy `jolli-skill-version` key as up-to-date if the version matches", async () => {
		// Plant a SKILL.md using the legacy top-level key at the CURRENT version.
		// The installer should treat it as already up-to-date and not rewrite,
		// even though the template now uses `metadata.version`. This protects
		// users from a needless rewrite on upgrade.
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\njolli-skill-version: ${CURRENT_VERSION}\n---\nlegacy body`;
		fs.mkdirSync(join(tempDir, ".claude/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		// .claude path was up-to-date: the legacy file was preserved verbatim.
		expect(readRecall()).toBe(planted);
		// .agents path didn't exist at all — installer creates it fresh.
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
	});

	it("rewrites when the file contains an unrecognized version line", async () => {
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\njolli-skill-version: 0.0.0-old\n---\nold body`;
		fs.mkdirSync(join(tempDir, ".claude/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		// Was rewritten — content no longer matches the plant.
		expect(readRecall()).not.toBe(planted);
		// And it now carries the new metadata.version form.
		expect(readRecall()).toMatch(/metadata:\n {2}version:/);
	});

	it("rewrites when the existing file has no recognizable version line at all", async () => {
		// No `version:` / `jolli-skill-version:` / `jollimemory-version:` anywhere
		// → the version-match regex returns null (the `if (versionMatch)` false
		// branch) and the installer falls through to a fresh write.
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\n---\nbody with no version key`;
		fs.mkdirSync(join(tempDir, ".claude/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall()).not.toBe(planted);
		expect(readRecall()).toMatch(/metadata:\n {2}version:/);
	});
});
