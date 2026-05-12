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
import { SKILL_GIT_EXCLUDE_PATHS, updateSkillIfNeeded, updateSkillsIfNeeded } from "./SkillInstaller.js";

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

// ─── Dual-target write ──────────────────────────────────────────────────────

describe("updateSkillsIfNeeded — target dimension", () => {
	it("writes both skills into both .claude/skills/ and .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("writes byte-identical SKILL.md to .claude/skills/ and .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall("claude")).toBe(readRecall("agents"));
		expect(readSearch("claude")).toBe(readSearch("agents"));
	});

	it("with claudeEnabled=false, skips .claude/skills/ but still writes .agents/skills/", async () => {
		await updateSkillsIfNeeded(tempDir, { claudeEnabled: false });
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(false);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("with claudeEnabled=undefined (default), writes both targets", async () => {
		await updateSkillsIfNeeded(tempDir, {});
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
	});

	it("exports the 4 git-exclude paths for the two skills × two targets", () => {
		expect(SKILL_GIT_EXCLUDE_PATHS).toEqual([
			"/.claude/skills/jolli-recall/",
			"/.claude/skills/jolli-search/",
			"/.agents/skills/jolli-recall/",
			"/.agents/skills/jolli-search/",
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

// ─── Search-template content pins (carried over from prior versions) ────────

describe("search template content", () => {
	it("instructs the LLM to split the input into query + flags", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Parse the user input into query \+ flags/);
		// Worked-example table shows where flags go on argv (not in the here-doc body).
		expect(search).toMatch(/--since 2w/);
	});

	it("includes stale-CLI detection (older install missing the search command)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/unknown command 'search'/);
		expect(search).toMatch(/npm update -g @jolli\.ai\/cli/);
	});

	it("explains catalog is not pre-filtered by query", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/catalog is NOT pre-filtered by the user's query/);
	});

	it("forbids programmatic processing (temp files / scoring scripts)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/DO NOT\*\* process programmatically/);
		expect(search).toMatch(/no temp files/);
		expect(search).toMatch(/jq\/python\/grep/);
		expect(search).toMatch(/Semantic picking/);
	});

	it("tells the LLM to retry with bigger budget before bothering the user", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/--budget 50000/);
	});

	it("documents every SearchHit identity / provenance field", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
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

	it("marks `decisions` as the star field with explicit emphasis", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/`decisions` ★ \*\*THE STAR FIELD\*\*/);
		expect(search).toMatch(/why did we choose X/);
	});

	it("documents every per-topic field", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/`title` —/);
		expect(search).toMatch(/`trigger\?` —/);
		expect(search).toMatch(/`response\?` —/);
		expect(search).toMatch(/`decisions` ★/);
		expect(search).toMatch(/`todo\?` —/);
		expect(search).toMatch(/`filesAffected\?` —/);
		expect(search).toMatch(/`category\?` —/);
		expect(search).toMatch(/`importance\?` —/);
	});

	it("uses correct diffStats field name (filesChanged, not files)", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/`diffStats\?` — `\{ filesChanged, insertions, deletions \}`/);
		expect(search).not.toMatch(/`diffStats\?` — `\{ files,/);
	});

	it("documents plan/note stubs and forbids navigation promises", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/`plans\?` — `\{ slug, title \}\[\]`/);
		expect(search).toMatch(/`notes\?` — `\{ id, title \}\[\]`/);
		expect(search).toMatch(/Do NOT promise the user they can navigate to the plan body/);
	});

	it("lists Lead-with-the-answer principle and forbids preamble openers", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Lead with the answer/);
		expect(search).toMatch(/No "Let me analyze\.\.\." or "Found N commits\.\.\." preamble/);
	});

	it("requires file paths as markdown links", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/\[cli\/src\/Types\.ts\]\(cli\/src\/Types\.ts\)/);
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

	it("forbids exposing machinery", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Don't expose machinery/);
		expect(search).toMatch(/"Phase 1"/);
		expect(search).toMatch(/"Phase 2"/);
		expect(search).toMatch(/"catalog"/);
		expect(search).toMatch(/"SearchHit"/);
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

	it("tightens the Step 3 picks limit to 5-10", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).toMatch(/Pick \*\*5-10\*\*/);
		expect(search).not.toMatch(/Pick 5-15/);
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

	it("backward-compat alias updateSkillIfNeeded installs both skills into both targets", async () => {
		await updateSkillIfNeeded(tempDir);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
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
});
