/**
 * SkillInstaller tests.
 *
 * Asserts the v5 spec-compliant cross-platform shape:
 *
 * - A full `jolli enable` writes one SKILL.md per skill into the cross-platform
 *   `.agents/skills/<name>/` target ONLY. Claude Code (`.claude/skills/`) is owned
 *   by the plugin now, so it is never a full-enable write target.
 * - Frontmatter contains only the spec-allowed fields (`name`, `description`,
 *   `metadata`) — no Claude-private fields like `argument-hint` or `user-invocable`.
 * - The invocation block uses a here-doc with an LLM-generated high-entropy
 *   delimiter (`JOLLI_ARG_<DELIM>_END`) and `--arg-stdin`, NOT a fixed string,
 *   NOT `$ARGUMENTS` argv interpolation, NOT a double-quoted argv string.
 * - The plugin bootstrap owns `.claude/skills/`: {@link installPluginJolliMenu}
 *   writes the bare `/jolli` umbrella there, {@link removeClaudeLegacySkills}
 *   deletes pre-plugin unnamespaced `jolli-*` copies.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `reconcileCursorRepoSkills` asks Cursor whether it will load the other hosts' skill
// roots. Left unmocked that reads the DEVELOPER's live Cursor database, so the same
// test would pass here, fail on a machine with the toggle off, and take a third path
// on CI where Cursor is not installed at all. Default to enabled (Cursor's own
// default) and let the cases that care override it.
const { thirdPartyEnabledMock } = vi.hoisted(() => ({ thirdPartyEnabledMock: vi.fn().mockResolvedValue(true) }));
vi.mock("./CursorSettings.js", () => ({ isThirdPartyExtensibilityEnabled: thirdPartyEnabledMock }));

// Same reasoning for the plugin-presence probe: unmocked it reads the DEVELOPER's real
// `~/.jolli/jollimemory/dist-paths/`, so whether the mirror is written would depend on
// whether that machine happens to have the Cursor plugin installed. Default to
// "installed"; the teardown cases flip it.
// The Cursor mirror is located through `~/.jolli/jollimemory/cursor-plugin-root`, a
// record only the plugin's own bootstrap can write truthfully — so these suites point
// HOME at a scratch dir and plant the record there. (`dist-paths` cannot answer the
// question: its slot is keyed by source tag alone, so a `run-cli` dispatch that lands
// in the CLI records the CLI's dist under the `cursor-plugin` tag.)
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn(() => "/nonexistent-home") }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: homedirMock };
});

import {
	buildJolliMenuSkillTemplate,
	buildLocalRunSkillTemplate,
	buildPluginJolliMenuSkillTemplate,
	buildRecallSkillTemplate,
	buildRemoteRunSkillTemplate,
	buildSearchSkillTemplate,
	CURSOR_MIRROR_SKILLS,
	CURSOR_REPO_SKILL_GIT_EXCLUDE_PATHS,
	ensureCursorGlobalMenu,
	installPluginJolliMenu,
	JOLLI_MENU_GIT_EXCLUDE_PATHS,
	PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS,
	reconcileCursorRepoSkills,
	removeClaudeLegacySkills,
	removeCursorGlobalMenu,
	removeCursorRepoSkills,
	removePluginJolliMenu,
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
	fakePluginDir = mkdtempSync(join(tmpdir(), "jolli-fake-bundle-"));
	fakeHome = mkdtempSync(join(tmpdir(), "jolli-fake-home-"));
	homedirMock.mockReturnValue(fakeHome);
	plantFakeBundle();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(fakePluginDir, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
});

// ─── Convenience readers ────────────────────────────────────────────────────

function readRecall(target: "claude" | "agents" = "agents"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-recall" : ".agents/skills/jolli-recall";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readSearch(target: "claude" | "agents" = "agents"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-search" : ".agents/skills/jolli-search";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readJolli(target: "claude" | "agents" = "agents"): string {
	const dir = target === "claude" ? ".claude/skills/jolli" : ".agents/skills/jolli";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readLocalRun(target: "claude" | "agents" = "agents"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-local-run" : ".agents/skills/jolli-local-run";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

function readRemoteRun(target: "claude" | "agents" = "agents"): string {
	const dir = target === "claude" ? ".claude/skills/jolli-remote-run" : ".agents/skills/jolli-remote-run";
	return readFileSync(join(tempDir, dir, "SKILL.md"), "utf-8");
}

// ─── Dual-target write ──────────────────────────────────────────────────────

describe("updateSkillsIfNeeded — target dimension", () => {
	it("writes all five skills into .agents/skills/ and NEVER into .claude/skills/", async () => {
		await updateSkillsIfNeeded(tempDir);
		// Cross-platform target: all five present.
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-local-run/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-remote-run/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli/SKILL.md"))).toBe(true);
		// Claude Code target: owned by the plugin now — a full enable writes nothing here.
		expect(existsSync(join(tempDir, ".claude/skills"))).toBe(false);
	});

	it("with claudeEnabled=false, still writes .agents/skills/ (Claude is no longer a target to gate)", async () => {
		await updateSkillsIfNeeded(tempDir, { claudeEnabled: false });
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-local-run/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-remote-run/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli/SKILL.md"))).toBe(true);
		// claudeEnabled=false never produced a .claude/skills/ write and still doesn't.
		expect(existsSync(join(tempDir, ".claude/skills"))).toBe(false);
	});

	it("with claudeEnabled=undefined (default), writes the .agents target for all skills", async () => {
		await updateSkillsIfNeeded(tempDir, {});
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills"))).toBe(false);
	});

	it("exports the 5 git-exclude paths for the five skills (agents target only)", () => {
		expect(SKILL_GIT_EXCLUDE_PATHS).toEqual([
			"/.agents/skills/jolli-recall/",
			"/.agents/skills/jolli-search/",
			"/.agents/skills/jolli-local-run/",
			"/.agents/skills/jolli-remote-run/",
			"/.agents/skills/jolli/",
		]);
		// No .claude/skills/ line — a full enable no longer writes there.
		expect(SKILL_GIT_EXCLUDE_PATHS.some((p) => p.startsWith("/.claude/"))).toBe(false);
	});

	it("renders a parseable metadata.revision for every installed skill", async () => {
		// A skill whose template omits `revision` parses as PREHISTORIC_REVISION (-1),
		// so the upsert guard (existing >= mine) freezes it after first install and a
		// later body fix never reaches existing installs. Every SKILLS template must
		// therefore carry a real, parseable revision.
		await updateSkillsIfNeeded(tempDir);
		const revisionLine = /\n {2}revision: \d+\n/;
		for (const read of [readRecall, readSearch, readLocalRun, readRemoteRun, readJolli]) {
			expect(read("agents")).toMatch(revisionLine);
		}
	});
});

// ─── Frontmatter spec compliance ────────────────────────────────────────────

describe("recall template frontmatter", () => {
	it("uses spec-compliant fields only — name, description, metadata.version, metadata.vendor", async () => {
		await updateSkillsIfNeeded(tempDir);
		const recall = readRecall();
		expect(recall).toMatch(/^---\nname: jolli-recall\n/);
		expect(recall).toMatch(/description: Recall prior development context/);
		expect(recall).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
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
		expect(search).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
	});

	it("does NOT contain Claude-private top-level frontmatter fields", async () => {
		await updateSkillsIfNeeded(tempDir);
		const search = readSearch();
		expect(search).not.toMatch(/^argument-hint:/m);
		expect(search).not.toMatch(/^user-invocable:/m);
		expect(search).not.toMatch(/^disable-model-invocation:/m);
	});
});

describe("jolli menu template frontmatter", () => {
	it("uses spec-compliant fields only — name, description, metadata.version, metadata.vendor", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).toMatch(/^---\nname: jolli\n/);
		expect(jolli).toMatch(/description: The Jolli action menu/);
		expect(jolli).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
	});

	it("does NOT contain Claude-private top-level frontmatter fields", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).not.toMatch(/^argument-hint:/m);
		expect(jolli).not.toMatch(/^user-invocable:/m);
		expect(jolli).not.toMatch(/^disable-model-invocation:/m);
	});

	it("routes to the sibling skills and the Jolli MCP tools without re-deriving backend curation", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		// Static local-skill menu entries.
		expect(jolli).toMatch(/jolli-recall/);
		expect(jolli).toMatch(/jolli-search/);
		expect(jolli).toMatch(/jolli-local-run/);
		expect(jolli).toMatch(/jolli-remote-run/);
		// The retired jolli-pr skill must not be listed as a routable action.
		expect(jolli).not.toMatch(/jolli-pr/);
		// Surfaces session-registered MCP tools, not a hardcoded manifest fetch.
		expect(jolli).toMatch(/mcp__jollimemory__/);
		expect(jolli).toMatch(/AskUserQuestion/);
	});

	it("run-a-workflow action asks local vs remote, defaulting to local, routing both to recipe skills", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).toMatch(/Run a workflow/);
		expect(jolli).toMatch(/local vs remote/i);
		// Default is local.
		expect(jolli).toMatch(/default.*local|local.*default/i);
		// Both paths route to a recipe skill — local to jolli-local-run, remote to
		// jolli-remote-run (which drives run_remote_workflow), not the raw tool.
		expect(jolli).toContain("jolli-local-run");
		expect(jolli).toContain("jolli-remote-run");
		expect(jolli).toContain("run_remote_workflow");
		expect(jolli).toMatch(/not by calling the raw tool/);
	});

	it("adds a Workflow history action that shells workflow runs and offers open-url", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).toMatch(/Workflow history/);
		expect(jolli).toContain('"$HOME/.jolli/jollimemory/run-cli" workflow runs <workflowId>');
		expect(jolli).toContain('"type": "runs"');
		// An empty history is a normal outcome, not an error.
		expect(jolli).toMatch(/no history yet/);
		// Offers to open any listed URL via the open-url helper.
		expect(jolli).toContain('"$HOME/.jolli/jollimemory/run-cli" open-url <url>');
		// The history action shells run-cli, so the menu carries the shell prerequisite.
		expect(jolli).toContain("### Shell prerequisite");
	});

	it("the Workflow history action handles the plugin-absent case with an install hint", async () => {
		// `workflow runs` hits the stub (prose + exit 1) when workflow-cli is
		// absent — the menu must steer the user to install it, not fall through.
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).toContain("@jolli.ai/workflow-cli");
		expect(jolli).toContain("npm i -g @jolli.ai/cli @jolli.ai/workflow-cli");
	});

	it("mentions canceling an in-flight remote run via cancel_remote_workflow", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		expect(jolli).toContain("cancel_remote_workflow");
		expect(jolli).toMatch(/cancel/i);
	});

	it("hides list_workflow_definitions and does not list the remote workflow tools raw", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		// list_workflow_definitions is plumbing — never a standalone menu item.
		expect(jolli).toContain("list_workflow_definitions");
		expect(jolli).toMatch(/Exclusions/);
		// The exclusion instruction must name it as excluded, not surface it.
		expect(jolli).toMatch(/do NOT surface/i);
	});

	it("uses the renamed remote_* backend tool names, not the old pre-rename names", async () => {
		await updateSkillsIfNeeded(tempDir);
		const jolli = readJolli();
		// No lingering old names in the menu template body.
		expect(jolli).not.toMatch(/\brun_workflow\b/);
		expect(jolli).not.toMatch(/`run_workflow`/);
	});
});

describe("jolli-local-run template", () => {
	it("uses spec-compliant frontmatter (name/description/metadata only)", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toMatch(/^---\nname: jolli-local-run\n/);
		expect(t).toMatch(/description: Run a Jolli workflow locally/);
		// Carries a parseable metadata.revision so a corrected body reaches existing
		// installs (a revision-less template is frozen at PREHISTORIC forever).
		expect(t).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
		expect(t).not.toMatch(/^argument-hint:/m);
		expect(t).not.toMatch(/^user-invocable:/m);
	});

	it("drives the run lifecycle tools", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("start_local_run");
		expect(t).toContain("report_local_run_progress");
		expect(t).toContain("complete_local_run");
		expect(t).toContain("abandon_local_run");
	});

	it("uses the eligibility helper and offers only runnable workflows, announcing auto-merge vs team review", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain('"$HOME/.jolli/jollimemory/run-cli" workflow local-run');
		expect(t).toMatch(/auto-merge/i);
		expect(t).toMatch(/team review/i);
	});

	it("handles the workflow_cli_required result (plugin absent) with an install hint", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("workflow_cli_required");
		expect(t).toContain("npm i -g @jolli.ai/cli @jolli.ai/workflow-cli");
	});

	it("pins docs pull to --branch and explicitly forbids the destructive --agent", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("docs pull --branch");
		expect(t).toContain("--agent");
		expect(t).toMatch(/NEVER `--agent`/);
		expect(t).toContain("git clean -fdx");
	});

	it("does NOT instruct the agent to call fetchSpaceBacking (docs pull fetches the token internally)", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).not.toContain("fetchSpaceBacking");
		expect(t).toMatch(/fetches the destination write token internally/);
	});

	it("brackets the blocking review with heartbeats (before and after, not during)", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toMatch(/immediately before/);
		expect(t).toMatch(/immediately after/);
		expect(t).toMatch(/explicitly approve/);
	});

	it("captures the docs publish {prNumber, prUrl} and passes them to complete_local_run", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("docs publish --json");
		expect(t).toContain("prNumber");
		expect(t).toContain("prUrl");
	});

	it("cross-checks the published headBranch against writeTarget.workBranch and stops on mismatch", () => {
		const t = buildLocalRunSkillTemplate();
		// Deterministic branch check via the CLI, not an LLM string comparison.
		expect(t).toContain(
			'"$HOME/.jolli/jollimemory/run-cli" space verify-publish-branch <writeTarget.workBranch> <headBranch>',
		);
		expect(t).toContain("headBranch");
		// On mismatch the recipe must fail loudly and NOT complete the run as success.
		expect(t).toMatch(/run-to-PR link is broken/);
		expect(t).toMatch(/do NOT call `complete_local_run` as if the run succeeded/);
	});

	it("completes a private Jolli-managed destination WITHOUT a PR reference", () => {
		const t = buildLocalRunSkillTemplate();
		// The publish JSON withholds prNumber/prUrl for private destinations
		// (`private: true`); the run must still complete, just without a PR ref.
		expect(t).toContain('"private": true');
		expect(t).toContain("WITHOUT a PR reference");
		// And it reads the completion result's `willAutoMerge` (not the offer's `autoMerges`).
		expect(t).toContain("willAutoMerge");
	});

	it("Step 6 surfaces the completion result URLs and offers to open each via open-url", () => {
		const t = buildLocalRunSkillTemplate();
		// Auto-apply ON reports the article URLs (writtenArticles); OFF reports the PR URL.
		expect(t).toContain("writtenArticles");
		expect(t).toMatch(/article URLs/);
		// `willAutoMerge: true` is framed as the destination's INTENT, not a confirmation the
		// merge completed — the recipe must not flatly claim the PR auto-merged (it can't
		// verify it, and for a private jolli-git dest the merge can silently not happen).
		expect(t).toMatch(/set to auto-merge/);
		expect(t).toMatch(/not a\s+confirmation/i);
		expect(t).toMatch(/PR left open for team review/);
		// Both the workflow and run deep-links are surfaced, read verbatim off the result.
		expect(t).toContain("workflowUrl");
		expect(t).toContain("runUrl");
		// Offers to open each reported URL via the open-url helper (Step 3 of JOLLI-1947).
		expect(t).toMatch(/open any reported URL/);
		expect(t).toContain('"$HOME/.jolli/jollimemory/run-cli" open-url <url>');
	});

	it("only offers an article URL when still openable (active + non-null url) and never fabricates one", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toMatch(/active: true/);
		expect(t).toMatch(/non-null/);
		expect(t).toMatch(/not yet available/);
		expect(t).toMatch(/never invent a URL/);
	});

	it("for a private Jolli-managed destination surfaces article URLs only, never a repo/PR link", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toMatch(/article URLs only/);
		expect(t).toContain("never surface a repo or PR link the result did not carry");
	});

	it("describes the destination by Space name/folder and never narrates the backing repo owner/name or work branch as the write target", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("Space name / folder");
		expect(t).toContain("Do **not** announce a backing repo");
		expect(t).toContain('do **not** present the `workBranch` as "the write target"');
		// An empty writeTarget.repo (private destinations) is normal, never an error.
		expect(t).toMatch(/may be\s+\*\*empty\*\* for a private Jolli-managed destination/);
	});

	it("surfaces the combined space-cli install hint when the plugin is missing", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("npm i -g @jolli.ai/cli @jolli.ai/space-cli");
	});

	it("prefers MCP tools but shells the jolli CLI (run-cli) for the helper and git ops", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("mcp__jollimemory__start_local_run");
		expect(t).toContain("$HOME/.jolli/jollimemory/run-cli");
	});

	it("shows the start_local_run id verbatim as an unquoted number (not a misleading quoted string)", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain('{ "id": <workflow id> }');
		expect(t).not.toContain('{ "id": "<workflow id>" }');
		expect(t).toMatch(/exactly as the helper returned it/);
	});

	it("presents workflows by name and shows the real numeric id shape in the Step 1 example", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain('"id": 7');
		expect(t).toContain('"name": "Impact Analysis"');
		expect(t).toMatch(/by its `name`/);
		expect(t).not.toContain('"id": "..."');
	});

	it("carries the Windows Git Bash shell prerequisite (its run-cli bash steps hit %USERPROFILE%)", () => {
		const t = buildLocalRunSkillTemplate();
		expect(t).toContain("### Shell prerequisite");
		expect(t).toMatch(/Git Bash/);
		expect(t).toContain("%USERPROFILE%");
	});
});

describe("jolli-remote-run template", () => {
	it("uses spec-compliant frontmatter (name/description/metadata, with a parseable revision)", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toMatch(/^---\nname: jolli-remote-run\n/);
		expect(t).toMatch(/description: Run a Jolli workflow remotely/);
		// Carries a parseable metadata.revision so a corrected body reaches existing
		// installs (a revision-less template is frozen at PREHISTORIC forever).
		expect(t).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
		expect(t).not.toMatch(/^argument-hint:/m);
		expect(t).not.toMatch(/^user-invocable:/m);
	});

	it("triggers the remote run via run_remote_workflow and captures the runId", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain("run_remote_workflow");
		expect(t).toContain("mcp__jollimemory__run_remote_workflow");
		expect(t).toContain("runId");
		// The workflow id is an unquoted number, matching the frozen tool contract.
		expect(t).toContain('{ "id": <workflow id> }');
	});

	it("offers workflow discovery via list_workflows when it is registered", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain("list_workflows");
		expect(t).toContain("mcp__jollimemory__list_workflows");
	});

	it("preflights the workflow-cli monitor via the local-run probe BEFORE triggering the run", () => {
		// The run trigger is a backend tool that spends budget even when the plugin
		// monitor is absent, so the recipe must confirm the plugin is installed
		// before calling run_remote_workflow — otherwise a missing monitor orphans a
		// live run. The presence probe reuses `workflow local-run`, whose stub emits
		// `workflow_cli_required` (the only signal that gates the run).
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain('"$HOME/.jolli/jollimemory/run-cli" workflow local-run');
		expect(t).toContain("workflow_cli_required");
		expect(t).toMatch(/Do \*\*not\*\* trigger the run/);
		// The probe must precede the trigger both in step order and in the text.
		const probeAt = t.indexOf('run-cli" workflow local-run');
		const triggerAt = t.indexOf("Call the `run_remote_workflow` tool");
		expect(probeAt).toBeGreaterThan(-1);
		expect(triggerAt).toBeGreaterThan(-1);
		expect(probeAt).toBeLessThan(triggerAt);
	});

	it("shells the deterministic workflow run-status monitor with the runId", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain('"$HOME/.jolli/jollimemory/run-cli" workflow run-status <runId>');
		// Documents the report shape the recipe parses.
		expect(t).toContain("openableUrls");
		expect(t).toMatch(/"succeeded"/);
		expect(t).toMatch(/"failed"/);
		expect(t).toMatch(/"cancelled"/);
	});

	it("handles the plugin-absent case for workflow run-status with an install hint", () => {
		// The run-status stub prints prose + exit 1 (not a JSON report) when
		// workflow-cli is absent — the recipe must steer the user to install it.
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain("@jolli.ai/workflow-cli");
		expect(t).toContain("npm i -g @jolli.ai/cli @jolli.ai/workflow-cli");
	});

	it("reports failed, cancelled, succeeded, and still-running outcomes", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toMatch(/troubleshooting/);
		expect(t).toMatch(/cancel\.by/);
		expect(t).toMatch(/article/);
		// A timed-out poll means the run is still progressing server-side, not failed.
		expect(t).toContain("timedOut");
		expect(t).toMatch(/still\s+running server-side/);
	});

	it("degrades cleanly when the monitor cannot reach the run", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain('{ "type": "error", "message": "..." }');
		expect(t).toMatch(/degraded outcome, not a\s+crash/);
	});

	it("never fabricates a withheld link and reads every URL verbatim off the report", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toMatch(/verbatim/);
		expect(t).toMatch(/never construct, guess, or\s+look/);
		expect(t).toMatch(/withheld/);
	});

	it("offers to open any reported URL via open-url with a headless-safe fallback", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain('"$HOME/.jolli/jollimemory/run-cli" open-url <url>');
		expect(t).toMatch(/headless/);
		expect(t).toContain("Only `https` URLs are accepted");
	});

	it("every open-url recipe/menu notes that an off-allowlist URL is refused-and-printed (Step 8)", () => {
		// The open-url origin-allowlist gate refuses (never launches) an off-allowlist
		// URL and prints it with `refused: true`; each template that shells open-url must
		// tell the agent to surface such a URL for manual opening, not treat it as an error.
		for (const build of [buildLocalRunSkillTemplate, buildRemoteRunSkillTemplate, buildJolliMenuSkillTemplate]) {
			const t = build();
			expect(t).toMatch(/off Jolli's allowlist is refused/);
			expect(t).toContain('"refused": true');
			expect(t).toMatch(/open manually/);
		}
	});

	it("notes that an in-flight remote run can be cancelled via cancel_remote_workflow", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain("cancel_remote_workflow");
		expect(t).toContain("mcp__jollimemory__cancel_remote_workflow");
	});

	it("prefers the MCP run tools but shells the jolli CLI (run-cli) for the monitor and open", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toMatch(/no CLI\s+mirror/);
		expect(t).toContain("$HOME/.jolli/jollimemory/run-cli");
	});

	it("carries the Windows Git Bash shell prerequisite (its run-cli bash steps hit %USERPROFILE%)", () => {
		const t = buildRemoteRunSkillTemplate();
		expect(t).toContain("### Shell prerequisite");
		expect(t).toMatch(/Git Bash/);
		expect(t).toContain("%USERPROFILE%");
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

// ─── Per-host tool naming ────────────────────────────────────────────────────
// One skill file serves every host (`.agents/skills/` is the only write target),
// so it has to carry BOTH spellings. Codex models a local MCP server as a
// namespace of bare tool names — `mcp__jollimemory__search` does not exist there
// — and the templates used to gate the MCP branch on that Claude-only spelling
// being "available", which sent Codex down the CLI fallback instead. These pin
// both spellings so neither can be cleaned away as redundant.

describe("skill templates name the MCP tool for every host", () => {
	for (const [label, build, tool] of [
		["recall", buildRecallSkillTemplate, "recall"],
		["search", buildSearchSkillTemplate, "search"],
	] as const) {
		it(`${label} template carries the Claude spelling, the Codex namespace, and the bare tool`, () => {
			const t = build();
			expect(t).toContain(`mcp__jollimemory__${tool}`);
			// The namespace, WITHOUT a trailing tool segment — that is the form Codex
			// actually presents in its tool list.
			expect(t).toMatch(/`mcp__jollimemory`/);
			expect(t).toContain("Codex");
			// Lazy loading is why "I don't see the tool" must not be read as "absent".
			expect(t).toMatch(/lazil|lazy/i);
		});

		it(`${label} template gates the CLI fallback on the server, not on one tool spelling`, () => {
			const t = build();
			expect(t).toContain("not registered at all");
			// The old wording keyed the fallback off a missing tool NAME, which is exactly
			// what mis-fired on Codex.
			expect(t).not.toContain("If no such tool is available");
		});
	}

	it("the jolli menu explains tool DISCOVERY for both hosts, not just the prefix", () => {
		// This one enumerates tools rather than calling a named one, so its failure mode
		// is different: a plain `mcp__jollimemory__` prefix scan finds ZERO tools on
		// Codex, where they are bare names inside the namespace — the menu would render
		// empty and read as "Jolli MCP is not set up".
		const t = buildJolliMenuSkillTemplate();
		expect(t).toContain("mcp__jollimemory__"); // Claude: prefix match
		expect(t).toMatch(/`mcp__jollimemory`/); // Codex: namespace, no tool segment
		expect(t).toContain("Codex");
		expect(t).toMatch(/lazil|lazy/i);
		expect(t).not.toContain("Surface every tool whose name starts with");
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

	it("local-run template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readLocalRun()).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});

	it("remote-run template contains no CJK characters", async () => {
		await updateSkillsIfNeeded(tempDir);
		expect(readRemoteRun()).not.toMatch(CJK_AND_OTHER_NON_LATIN);
	});
});

// ─── Legacy cleanup + idempotency ───────────────────────────────────────────

describe("legacy directories", () => {
	// The marker is required now: this cleanup used to `rm -rf` the legacy names
	// unconditionally. `jolli-skill-version:` is the ancient form, which is what an
	// install old enough to carry these directory names would actually have written.
	it("removes legacy skill directories from previous versions", async () => {
		const fs = await import("node:fs");
		fs.mkdirSync(join(tempDir, ".claude/skills/jollimemory-recall"), { recursive: true });
		fs.writeFileSync(
			join(tempDir, ".claude/skills/jollimemory-recall/SKILL.md"),
			"---\nname: jollimemory-recall\njolli-skill-version: 0.1.0\n---\nold",
		);
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".claude/skills/jollimemory-recall"))).toBe(false);
	});

	// `jollimemory-recall` / `jolli-memory-recall` are ordinary enough names that a
	// user could own one. This path runs on every full `jolli enable`, so an
	// unguarded delete would silently eat their work — the same ownership rule every
	// other removal in SkillInstaller already follows.
	it("keeps a same-named skill the user owns (no Jolli marker)", async () => {
		const fs = await import("node:fs");
		for (const name of ["jollimemory-recall", "jolli-memory-recall"]) {
			const dir = join(tempDir, ".claude", "skills", name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nmy own skill`);
		}

		await updateSkillsIfNeeded(tempDir);

		for (const name of ["jollimemory-recall", "jolli-memory-recall"]) {
			expect(fs.existsSync(join(tempDir, ".claude", "skills", name, "SKILL.md")), name).toBe(true);
		}
	});

	it("upserts search even when recall already exists at the current version", async () => {
		await updateSkillsIfNeeded(tempDir);
		const fs = await import("node:fs");
		fs.rmSync(join(tempDir, ".agents/skills/jolli-search"), { recursive: true, force: true });
		await updateSkillsIfNeeded(tempDir);
		expect(fs.existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("backward-compat alias updateSkillIfNeeded installs all skills into the .agents target", async () => {
		await updateSkillIfNeeded(tempDir);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
		// Never writes the Claude Code target (plugin owns it).
		expect(existsSync(join(tempDir, ".claude/skills"))).toBe(false);
	});

	it("backward-compat alias writes the .agents target regardless of claudeEnabled", async () => {
		await updateSkillIfNeeded(tempDir, { claudeEnabled: false });
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".claude/skills"))).toBe(false);
	});
});

// ─── Retired-skill cleanup ──────────────────────────────────────────────────

describe("retired-skill cleanup (jolli-pr)", () => {
	it("sweeps a Jolli-owned jolli-pr out of .agents/skills/ on enable", async () => {
		const dir = join(tempDir, ".agents/skills/jolli-pr");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			'---\nname: jolli-pr\nmetadata:\n  vendor: "jolli.ai"\n---\nretired pr skill\n',
			"utf-8",
		);

		await updateSkillsIfNeeded(tempDir);

		// The retired skill is gone; the current skills are still written.
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
	});

	it("leaves a user's own jolli-pr skill (no Jolli ownership marker) untouched", async () => {
		const dir = join(tempDir, ".agents/skills/jolli-pr");
		mkdirSync(dir, { recursive: true });
		const userContent = "---\nname: jolli-pr\n---\n\n# my own PR helper (nothing to do with Jolli)\n";
		writeFileSync(join(dir, "SKILL.md"), userContent, "utf-8");

		await updateSkillsIfNeeded(tempDir);

		// Preserved verbatim — it lacks the vendor marker.
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe(userContent);
	});
});

// ─── Revision-based idempotency (cross-tool churn guard) ────────────────────

describe("revision-based idempotency", () => {
	it("is idempotent — a second install at the same revision does not rewrite", async () => {
		await updateSkillsIfNeeded(tempDir);
		const first = readRecall();
		await updateSkillsIfNeeded(tempDir);
		// Same revision on disk (equal) → skipped, content unchanged.
		expect(readRecall()).toBe(first);
	});

	it("upgrades a legacy `jolli-skill-version` file (no revision → prehistoric)", async () => {
		// Even at the CURRENT release version, a legacy file has no `metadata.revision`,
		// so it is treated as prehistoric and upgraded once to gain a revision. This is
		// the one-time migration onto revision-based tracking.
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\njolli-skill-version: ${CURRENT_VERSION}\n---\nlegacy body`;
		fs.mkdirSync(join(tempDir, ".agents/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall()).not.toBe(planted);
		expect(readRecall()).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+/);
	});

	it("overwrites a file whose revision is lower than ours", async () => {
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\nmetadata:\n  version: "0.0.0"\n  revision: 0\n  vendor: "jolli.ai"\n---\nold body`;
		fs.mkdirSync(join(tempDir, ".agents/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		expect(readRecall()).not.toBe(planted);
		expect(readRecall()).toMatch(/Every commit deserves a Memory/);
	});

	it("does NOT downgrade a file whose revision is higher than ours (newer tool wins)", async () => {
		const fs = await import("node:fs");
		const planted = `---\nname: jolli-recall\nmetadata:\n  version: "9.9.9"\n  revision: 999\n  vendor: "jolli.ai"\n---\ncontent from a newer tool`;
		fs.mkdirSync(join(tempDir, ".agents/skills/jolli-recall"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		// Left untouched — never downgrade a newer revision.
		expect(readRecall()).toBe(planted);
	});

	it("does NOT overwrite a user-authored SKILL.md that carries no Jolli ownership marker", async () => {
		// A user who happens to name a skill `jolli` (or any Jolli name) in the
		// `.agents/skills/` target has neither the modern `vendor: "jolli.ai"` metadata
		// nor the legacy `jolli-skill-version:` marker, and no revision line — so without
		// the ownership guard the downgrade path (PREHISTORIC < ours) would clobber it. It
		// must be left byte-for-byte intact. (This full-enable path runs on every VS Code /
		// IntelliJ session start, so this is the data-loss it prevents.)
		const fs = await import("node:fs");
		const planted = `---\nname: jolli\ndescription: my own jolli command\n---\nuser body, not Jolli's`;
		fs.mkdirSync(join(tempDir, ".agents/skills/jolli"), { recursive: true });
		fs.writeFileSync(join(tempDir, ".agents/skills/jolli/SKILL.md"), planted, "utf-8");
		await updateSkillsIfNeeded(tempDir);
		expect(readJolli("agents")).toBe(planted);
	});
});

// ─── Plugin bare /jolli umbrella ────────────────────────────────────────────

describe("buildPluginJolliMenuSkillTemplate", () => {
	it("is spec-compliant and routes to the plugin's namespaced /jolli:* skills", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		expect(tpl).toMatch(/^---\nname: jolli\n/);
		expect(tpl).toMatch(/metadata:\n {2}version: "[^"]+"\n {2}revision: \d+\n {2}vendor: "jolli\.ai"/);
		// Routes to the namespaced plugin skills, not the unnamespaced siblings.
		for (const s of ["jolli:init", "jolli:recall", "jolli:search", "jolli:push"]) {
			expect(tpl).toContain(s);
		}
		// The plugin no longer ships a /jolli:pr skill — the menu must not route to it.
		expect(tpl).not.toContain("jolli:pr");
		// No Claude-private frontmatter fields.
		expect(tpl).not.toMatch(/^argument-hint:/m);
		expect(tpl).not.toMatch(/^user-invocable:/m);
	});

	it("leads the menu with /jolli:init on a fresh (0-memory) repo instead of empty recall/search", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		// The 0-memory ordering rule must name storedMemories, put /jolli:init first,
		// and justify demoting recall/search (they would only return empty).
		expect(tpl).toMatch(/when\s+`storedMemories`\s+is 0, lead with `\/jolli:init` as the FIRST/);
		expect(tpl).toMatch(/demote recall \/ search/);
	});

	it("renders the CLI-style snapshot: syncing · Space line (gated on `space`) + a listening closer", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		// Reads the new `space` status field and renders the sync line from it.
		expect(tpl).toContain("`space`");
		expect(tpl).toContain('✓ syncing · Space "<space.name>"');
		// The sync line is gated on a non-null space (unbound → drop the line, no "not bound").
		expect(tpl).toMatch(/only when `space` is\s+non-null/);
		// The closer mirrors the CLI front door, both phrasings present.
		expect(tpl).toContain("Jolli is listening — last memory saved.");
		expect(tpl).toMatch(/your next commit is your\s+first memory/);
	});

	it("derives 'can generate' provider-aware so a local-agent repo is not pushed into setup", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		// Must honor the local-agent default (generation with no key / no sign-in),
		// not the old blind signedIn||jolliKey||anthropicKey OR that shoved a fresh
		// plugin repo into /jolli:init even though it can already generate.
		expect(tpl).toContain("can generate memories");
		expect(tpl).toContain("`local-agent` → **yes**");
		// The Jolli proxy is satisfied by a sign-in (which mints a Jolli key) OR a
		// stored key — jolliApiKeyConfigured is omitted once signed in.
		expect(tpl).toMatch(/`jolli` → yes if\s+`account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		// Anthropic is satisfied only by its own credential.
		expect(tpl).toMatch(/`anthropic` → yes only if `account\.anthropicKeyConfigured`/);
		// For the Anthropic provider a bare OAuth token is a sync credential, not a generation one.
		expect(tpl).toMatch(/sign-in alone does NOT count/);
		// The setup branch keys off generation capability, not "no credential".
		expect(tpl).toContain("OR memories can't be generated");
	});

	// Generation and sync are separate axes in the CLI front door: the default
	// local-agent repo generates memories through the user's own subscription while
	// holding no Jolli credential, so it can capture but not share. Checking only
	// generation reported that repo as fully healthy and never mentioned sign-in.
	it("treats sync as a second axis and nudges sign-in when it is missing", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		expect(tpl).toContain("can sync memories");
		expect(tpl).toMatch(/= `account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		// An Anthropic key generates but can never bind a Space.
		expect(tpl).toMatch(/an Anthropic key never satisfies it/);
		expect(tpl).toContain("Sign in to Jolli to sync memories to a Space?");
		// A nudge, never a gate — an unsigned repo still gets the whole menu.
		expect(tpl).toContain("non-blocking");
		// Hands off to the existing command instead of re-running the login flow.
		expect(tpl).toMatch(/tell them to run\s+`\/jolli:login`/);
		expect(tpl).toMatch(/Do NOT run\s+`auth login` yourself here/);
	});

	it("surfaces the login / logout commands the old menu left unreachable", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		for (const command of ["/jolli:login", "/jolli:logout", "/jolli:status", "/jolli:timeline"]) {
			expect(tpl).toContain(command);
		}
		// A skill cannot invoke a slash command, so the menu must say how to route one.
		expect(tpl).toContain("a skill cannot invoke a command");
	});

	it("names the local-agent engine in the snapshot instead of only key/sign-in states", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		expect(tpl).toContain("`account.localAgentTool`");
		expect(tpl).toContain("summaries via <account.localAgentTool>");
		expect(tpl).toContain("✓ local agent set (not signed in to Jolli)");
	});
});

describe("installPluginJolliMenu", () => {
	it("writes the bare /jolli umbrella to the Claude target only", async () => {
		await installPluginJolliMenu(tempDir);
		const umbrella = join(tempDir, ".claude", "skills", "jolli", "SKILL.md");
		expect(existsSync(umbrella)).toBe(true);
		expect(readFileSync(umbrella, "utf-8")).toContain("jolli:recall");
		// NOT written to the cross-platform target (those hosts lack `jolli:*`).
		expect(existsSync(join(tempDir, ".agents", "skills", "jolli", "SKILL.md"))).toBe(false);
		// And it writes ONLY the umbrella — not the unnamespaced sibling skills.
		expect(existsSync(join(tempDir, ".claude", "skills", "jolli-recall", "SKILL.md"))).toBe(false);
	});

	it("leaves a user's own `jolli` skill (no vendor marker) untouched", async () => {
		// A user who happens to name a skill `jolli` must not have it clobbered by
		// the plugin's every-SessionStart bootstrap. Mirrors the symmetric guard in
		// removePluginJolliMenu.
		const dir = join(tempDir, ".claude", "skills", "jolli");
		mkdirSync(dir, { recursive: true });
		const userContent = "---\nname: jolli\n---\n\n# my own jolli skill (nothing to do with Jolli Memory)\n";
		writeFileSync(join(dir, "SKILL.md"), userContent, "utf-8");

		await installPluginJolliMenu(tempDir);

		// The write is skipped — the user's file is preserved verbatim.
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe(userContent);
	});

	it("refreshes an existing umbrella that carries our vendor marker", async () => {
		// A stale Jolli-authored umbrella (vendor marker present, older/placeholder
		// body) is ours to rewrite — the guard lets it through to upsertSkill.
		const dir = join(tempDir, ".claude", "skills", "jolli");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), '---\nmetadata:\n  vendor: "jolli.ai"\n---\n\nstale\n', "utf-8");

		await installPluginJolliMenu(tempDir);

		// Overwritten with the current template (routes to jolli:recall).
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("jolli:recall");
	});

	it("RECLAIMS a legacy standalone umbrella (higher-revision plugin variant wins the slot)", async () => {
		// Pre-upgrade a full `jolli enable` wrote the standalone menu (routes to the
		// unnamespaced jolli-* siblings) into .claude/skills/jolli/. After the plugin
		// deletes those siblings (removeClaudeLegacySkills), that standalone umbrella
		// would point at nothing — so the plugin variant's revision must outrank it and
		// overwrite it in place. Both carry the same vendor marker, so the ownership
		// guard can't distinguish them; only the revision bump does.
		const dir = join(tempDir, ".claude", "skills", "jolli");
		mkdirSync(dir, { recursive: true });
		const standalone = buildJolliMenuSkillTemplate();
		writeFileSync(join(dir, "SKILL.md"), standalone, "utf-8");
		// Sanity: the standalone menu routes to the unnamespaced sibling, not /jolli:*.
		expect(standalone).toContain("jolli-recall");
		expect(standalone).not.toContain("jolli:recall");

		await installPluginJolliMenu(tempDir);

		// Reclaimed: now the plugin variant (routes to the namespaced /jolli:* skills).
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("jolli:recall");
	});

	it("exports a single Claude-target git-exclude path for the umbrella", () => {
		expect(PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS).toEqual(["/.claude/skills/jolli/"]);
	});
});

describe("buildPluginJolliMenuSkillTemplate self-guard", () => {
	it("instructs the model to verify a routing target exists before routing", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		// A Step 0 gate must exist and mention self-removal for the leftover case.
		expect(tpl).toContain("Step 0");
		expect(tpl).toContain("rm -rf .claude/skills/jolli");
		// The old "always present" claim (which routed to now-missing skills) is gone.
		expect(tpl).not.toContain("Jolli plugin skills (always present)");
	});

	it("distinguishes a still-working CLI from a full uninstall (no false 'uninstalled')", () => {
		const tpl = buildPluginJolliMenuSkillTemplate();
		// Must probe the bundled CLI so a working CLI is never mis-reported as gone
		// just because the plugin's menu isn't loaded in this session.
		expect(tpl).toContain("$HOME/.jolli/jollimemory/run-cli");
		// Both branches are spelled out explicitly.
		expect(tpl).toContain("CLI present");
		expect(tpl).toContain("CLI absent");
	});
});

describe("removePluginJolliMenu", () => {
	it("removes the umbrella from every target when it carries our vendor marker", async () => {
		// A full `jolli enable` writes the umbrella to BOTH targets.
		for (const dir of [".claude/skills/jolli", ".agents/skills/jolli"]) {
			mkdirSync(join(tempDir, dir), { recursive: true });
			writeFileSync(join(tempDir, dir, "SKILL.md"), 'metadata:\n  vendor: "jolli.ai"\n', "utf-8");
		}

		await removePluginJolliMenu(tempDir);

		expect(existsSync(join(tempDir, ".claude", "skills", "jolli"))).toBe(false);
		expect(existsSync(join(tempDir, ".agents", "skills", "jolli"))).toBe(false);
	});

	it("leaves a user's own `jolli` skill (no vendor marker) untouched", async () => {
		const dir = join(tempDir, ".claude", "skills", "jolli");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "# my own jolli skill\n", "utf-8");

		await removePluginJolliMenu(tempDir);

		expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
	});

	it("is a no-op when no umbrella is present", async () => {
		await expect(removePluginJolliMenu(tempDir)).resolves.toBeUndefined();
	});

	it("exports the umbrella exclude paths for the .agents target and the Claude Code slot", () => {
		expect(JOLLI_MENU_GIT_EXCLUDE_PATHS).toEqual(["/.agents/skills/jolli/", "/.claude/skills/jolli/"]);
	});
});

// ─── Plugin cleanup of legacy unnamespaced .claude/skills/jolli-* ────────────

describe("removeClaudeLegacySkills", () => {
	/** Plants a Jolli-owned SKILL.md (vendor marker) at .claude/skills/<name>/. */
	function plantClaudeSkill(name: string, extra = ""): void {
		const dir = join(tempDir, ".claude", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: ${name}\nmetadata:\n  vendor: "jolli.ai"\n---\n${extra}`,
			"utf-8",
		);
	}

	it("deletes the Jolli-owned unnamespaced jolli-* skills from .claude/skills/", async () => {
		for (const name of ["jolli-recall", "jolli-search", "jolli-pr", "jolli-local-run", "jolli-remote-run"]) {
			plantClaudeSkill(name);
		}
		await removeClaudeLegacySkills(tempDir);
		for (const name of ["jolli-recall", "jolli-search", "jolli-pr", "jolli-local-run", "jolli-remote-run"]) {
			expect(existsSync(join(tempDir, ".claude", "skills", name))).toBe(false);
		}
	});

	it("deletes an ancient legacy dir recognized by its jolli-skill-version marker", async () => {
		const dir = join(tempDir, ".claude", "skills", "jollimemory-recall");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\nname: jollimemory-recall\njolli-skill-version: 0.1.0\n---\nold",
			"utf-8",
		);
		await removeClaudeLegacySkills(tempDir);
		expect(existsSync(dir)).toBe(false);
	});

	it("NEVER deletes the bare /jolli umbrella (the plugin overwrites it in place)", async () => {
		plantClaudeSkill("jolli-recall");
		plantClaudeSkill("jolli"); // the umbrella slot
		await removeClaudeLegacySkills(tempDir);
		expect(existsSync(join(tempDir, ".claude", "skills", "jolli-recall"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude", "skills", "jolli", "SKILL.md"))).toBe(true);
	});

	it("leaves a user-authored jolli-recall (no ownership marker) untouched", async () => {
		const dir = join(tempDir, ".claude", "skills", "jolli-recall");
		mkdirSync(dir, { recursive: true });
		const userContent = "---\nname: jolli-recall\ndescription: my own thing\n---\nuser body";
		writeFileSync(join(dir, "SKILL.md"), userContent, "utf-8");
		await removeClaudeLegacySkills(tempDir);
		expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe(userContent);
	});

	it("never touches the cross-platform .agents/skills/ target", async () => {
		await updateSkillsIfNeeded(tempDir); // writes .agents/skills/jolli-*
		await removeClaudeLegacySkills(tempDir);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, ".agents/skills/jolli-search/SKILL.md"))).toBe(true);
	});

	it("is a no-op when nothing is present", async () => {
		await expect(removeClaudeLegacySkills(tempDir)).resolves.toBeUndefined();
	});
});

// ─── Revision / body lockstep ────────────────────────────────────────────────

describe("skill revision is kept in lockstep with the body", () => {
	// The installer skips a write when the disk revision EQUALS ours (see the
	// SkillInstaller header: equal → skip, by the cross-tool lockstep contract). So
	// editing a body WITHOUT bumping its revision ships nothing — every existing
	// install keeps the old text forever, silently. That happened: three commits
	// changed the recall/search/menu bodies and none of them reached disk.
	//
	// A content hash was rejected for the write GUARD, because byte-identical content
	// across CLI/VS Code/IntelliJ is not something to depend on. Using one HERE is a
	// different job: it only has to notice that a body moved, so whoever moved it is
	// reminded to bump. The release-version line is stripped so a version bump alone
	// does not trip it.
	// Strips the frontmatter's `version: "<SKILL_VERSION>"` line so a routine release bump
	// doesn't churn every fingerprint below — the point of these is to catch a BODY edit
	// that forgot its `revision` bump.
	//
	// Deliberately un-anchored to the frontmatter block and NOT global: it removes the
	// first line of that shape anywhere in the template. That is exact today (each
	// template interpolates SKILL_VERSION once, in its frontmatter). If a body ever grows
	// a second line of the same shape — e.g. a skill that documents its own version in
	// prose — the first would be stripped and the second would keep the release version
	// in the hash, so an unrelated version bump would start failing these tests. Make the
	// match frontmatter-scoped at that point rather than adding /g, which would also strip
	// the body's line and hide a real body change.
	const stableFingerprint = (t: string): string =>
		createHash("sha256")
			.update(t.replace(/^[ \t]*version: "[^"]*"[ \t]*$/m, ""))
			.digest("hex")
			.slice(0, 12);

	// When a body legitimately changes: bump `revision`, then update `fingerprint`
	// here. Both, in the same change.
	const EXPECTED = {
		recall: { build: buildRecallSkillTemplate, revision: 2, fingerprint: "5baf6ab3b7ce" },
		search: { build: buildSearchSkillTemplate, revision: 2, fingerprint: "2fa504d6745f" },
		localRun: { build: buildLocalRunSkillTemplate, revision: 5, fingerprint: "81db78096bb6" },
		remoteRun: { build: buildRemoteRunSkillTemplate, revision: 4, fingerprint: "9fd34e36c20e" },
		menu: { build: buildJolliMenuSkillTemplate, revision: 7, fingerprint: "d49640721415" },
		pluginMenu: { build: buildPluginJolliMenuSkillTemplate, revision: 8, fingerprint: "cf37465fecac" },
	} as const;

	for (const [name, want] of Object.entries(EXPECTED)) {
		it(`${name}: body fingerprint still matches revision ${want.revision}`, () => {
			const body = want.build();
			expect(body.match(/revision:\s*(\d+)/)?.[1]).toBe(String(want.revision));
			expect(stableFingerprint(body)).toBe(want.fingerprint);
		});
	}

	it("the plugin menu variant outranks the standalone menu", () => {
		// installPluginJolliMenu overwrites the bare `/jolli` umbrella in place and
		// relies on its revision being STRICTLY greater — otherwise a pre-upgrade
		// umbrella lingers, still pointing at the `jolli-*` skills the plugin deletes.
		// Bumping the standalone menu without bumping this one silently breaks that.
		const revOf = (t: string) => Number(t.match(/revision:\s*(\d+)/)?.[1]);
		expect(revOf(buildPluginJolliMenuSkillTemplate())).toBeGreaterThan(revOf(buildJolliMenuSkillTemplate()));
	});
});

// ─── Cursor per-repo skill mirror ───────────────────────────────────────────
//
// The rule these pin: Cursor reads `.agents/skills/` and a plugin bundle's own
// `skills/` into ONE flat, un-namespaced pool and collapses neither, so the bundle
// ships only Cursor-specific skills and the four host-neutral ones are mirrored per
// repo — but only when `.agents/` has not already supplied them.

// `jolli` is NOT here. The umbrella is the front door and has to be reachable from
// Cursor's chat-first window, which starts conversations without naming a workspace —
// so it is written machine-global by `ensureCursorGlobalMenu` instead of mirrored per
// repo. See its own suite below.
const CURSOR_MIRRORED = ["jolli-recall", "jolli-search", "jolli-local-run", "jolli-remote-run"];

/**
 * A stand-in plugin bundle. The mirror is a SYMLINK into this directory, so the tests
 * need a real target — pointing at a path that does not exist would produce a broken
 * link, which is indistinguishable from "not written" through `existsSync`. Torn down
 * per test, and `plantFakeBundle`/`removeFakeBundle` model install and uninstall.
 */
let fakePluginDir: string;
let fakeHome: string;

function plantFakeBundle(): void {
	for (const skill of CURSOR_MIRROR_SKILLS) {
		const dir = join(fakePluginDir, "mirror", skill.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), skill.build(), "utf-8");
	}
	writeCursorPluginRootRecord(fakePluginDir);
}

/**
 * Uninstall, as Cursor's own plugin manager performs it: the bundle simply vanishes.
 *
 * The RECORD is deliberately left behind — it lives under `~/.jolli/`, which an
 * uninstall never touches, so this is what a real teardown looks like. Noticing the
 * uninstall therefore depends on the resolver checking that `mirror/` still exists
 * rather than trusting the recorded path.
 */
function removeFakeBundle(): void {
	rmSync(fakePluginDir, { recursive: true, force: true });
}

function writeCursorPluginRootRecord(root: string): void {
	const dir = join(fakeHome, ".jolli", "jollimemory");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "cursor-plugin-root"), `${root}\n`, "utf-8");
}

/** No plugin has ever bootstrapped on this machine — nothing recorded the bundle. */
function clearCursorPluginRootRecord(): void {
	rmSync(join(fakeHome, ".jolli", "jollimemory", "cursor-plugin-root"), { force: true });
}

const cursorSkill = (name: string) => join(tempDir, ".cursor/skills", name, "SKILL.md");
const agentsSkill = (name: string) => join(tempDir, ".agents/skills", name, "SKILL.md");

function plantAgentsSkill(name: string, content = '---\nname: x\nmetadata:\n  vendor: "jolli.ai"\n---\nbody\n'): void {
	mkdirSync(join(tempDir, ".agents/skills", name), { recursive: true });
	writeFileSync(agentsSkill(name), content, "utf-8");
}

describe("reconcileCursorRepoSkills", () => {
	it("writes the four host-neutral skills when .agents/skills/ has none of them", async () => {
		await reconcileCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(true);
	});

	it("never plants the umbrella per repo — that one is machine-global", async () => {
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli"))).toBe(false);
	});

	it("writes nothing when .agents/skills/ already provides the skill", async () => {
		for (const name of CURSOR_MIRRORED) plantAgentsSkill(name);
		await reconcileCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(false);
	});

	// The transition that makes this a reconcile rather than a one-shot install: a
	// plugin-only repo later runs a full `jolli enable`, and the copy written earlier
	// becomes the duplicate. Removing `.cursor/` is safe precisely because no other
	// host reads it — the reverse (deleting from `.agents/`) would take the only copy
	// Codex, Gemini, OpenCode, Windsurf and Copilot have.
	it("removes its own copy once .agents/skills/ starts providing the skill", async () => {
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(true);
		plantAgentsSkill("jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false);
	});

	it("leaves a user-authored .cursor/skills entry alone in both directions", async () => {
		const mine = "---\nname: jolli-recall\ndescription: mine\n---\nhand written\n";
		mkdirSync(join(tempDir, ".cursor/skills/jolli-recall"), { recursive: true });
		writeFileSync(cursorSkill("jolli-recall"), mine, "utf-8");

		// Write direction: no vendor marker means it is not ours to overwrite.
		await reconcileCursorRepoSkills(tempDir);
		expect(readFileSync(cursorSkill("jolli-recall"), "utf-8")).toBe(mine);

		// Remove direction: still not ours to delete once `.agents/` provides one.
		plantAgentsSkill("jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(readFileSync(cursorSkill("jolli-recall"), "utf-8")).toBe(mine);
	});

	it("is idempotent — a second run leaves the same content", async () => {
		await reconcileCursorRepoSkills(tempDir);
		const first = readFileSync(cursorSkill("jolli-search"), "utf-8");
		await reconcileCursorRepoSkills(tempDir);
		expect(readFileSync(cursorSkill("jolli-search"), "utf-8")).toBe(first);
	});

	/*
	 * The WINDOWS FALLBACK's copy, which is a real directory rather than a symlink.
	 *
	 * Symlinks there need Developer Mode, so `linkMirroredSkill` writes a plain copy —
	 * and an ownership test that accepted only symlinks made that copy permanently
	 * invisible to this reconcile. Two consequences, one per direction, and both are
	 * asserted below: an upgrade never refreshed the text, and the copy was never
	 * removed once `.agents/skills/` began supplying the same name, leaving a duplicate
	 * in Cursor's flat menu that only an explicit uninstall could clear.
	 *
	 * Reproduced by planting the directory directly rather than by faking a symlink
	 * failure: what makes it ours is the vendor marker in the SKILL.md, which the
	 * bundle's `mirror/` copies carry (unlike the bundle's own `skills/`, whose
	 * `metadata:` block the generator strips), so the fallback reproduces it verbatim.
	 */
	function plantWindowsFallbackCopy(name: string, body = "stale\n"): void {
		mkdirSync(join(tempDir, ".cursor/skills", name), { recursive: true });
		writeFileSync(cursorSkill(name), `---\nname: ${name}\nmetadata:\n  vendor: "jolli.ai"\n---\n${body}`, "utf-8");
	}

	it("refreshes the Windows fallback's copy instead of skipping it forever", async () => {
		plantWindowsFallbackCopy("jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(readFileSync(cursorSkill("jolli-recall"), "utf-8")).not.toContain("stale");
	});

	/*
	 * Steady state, and the reason `linkMirroredSkill` looks before it writes.
	 *
	 * This reconcile runs per session, per worktree, times four, from EVERY host's
	 * bootstrap — and it used to `rm` and recreate all four links each time. `rm` +
	 * `symlink` is not atomic, and Cursor's own skill provider scans these very
	 * directories at that same moment, so a scan landing in the gap sees no skill at
	 * all. Same class of churn `upsertJsonMcpServer` stopped emitting into
	 * `.cursor/mcp.json`.
	 *
	 * Asserted by inode, because a rebuilt link is indistinguishable by content: that is
	 * exactly what kept the churn invisible.
	 */
	it("does not rebuild a link that already points at the current bundle", async () => {
		await reconcileCursorRepoSkills(tempDir);
		const inodes = () => CURSOR_MIRRORED.map((n) => lstatSync(join(tempDir, ".cursor/skills", n)).ino);
		const before = inodes();
		await reconcileCursorRepoSkills(tempDir);
		expect(inodes()).toEqual(before);
	});

	/*
	 * The property the unconditional rebuild was there to guarantee, and it survives the
	 * check: the bundle directory is version-stamped, so an upgrade leaves a link that is
	 * ours, intact, and pointing at a version that is gone. Compared by the link's
	 * RECORDED target rather than by following it — following a link into a deleted
	 * bundle throws, while `readlink` answers fine, and "broken" and "stale" have to
	 * reach the same rebuild.
	 */
	it("rebuilds a link left pointing at a previous bundle", async () => {
		await reconcileCursorRepoSkills(tempDir);
		const link = join(tempDir, ".cursor/skills", "jolli-recall");
		rmSync(link, { recursive: true, force: true });
		symlinkSync(join(fakePluginDir, "1.0.0", "mirror", "jolli-recall"), link, "dir");

		await reconcileCursorRepoSkills(tempDir);

		expect(readlinkSync(link)).toBe(join(fakePluginDir, "mirror", "jolli-recall"));
	});

	/*
	 * The Windows fallback's copy is a real directory, so it is compared by CONTENT — it
	 * has the same non-atomic rewrite to avoid, on the one platform where it is the only
	 * placement available. Planted directly (as the suite above explains) rather than by
	 * faking a symlink failure.
	 */
	it("does not rewrite the Windows fallback's copy when it is already current", async () => {
		const current = readFileSync(join(fakePluginDir, "mirror", "jolli-recall", "SKILL.md"), "utf-8");
		plantWindowsFallbackCopy("jolli-recall");
		writeFileSync(cursorSkill("jolli-recall"), current, "utf-8");
		const before = lstatSync(cursorSkill("jolli-recall")).mtimeMs;
		// A coarse clock could tie two genuinely separate writes.
		await new Promise((r) => setTimeout(r, 25));

		await reconcileCursorRepoSkills(tempDir);

		expect(lstatSync(cursorSkill("jolli-recall")).mtimeMs).toBe(before);
		// And it stays a copy: converting it back to a symlink would only fail again on
		// the machine that produced it.
		expect(lstatSync(join(tempDir, ".cursor/skills", "jolli-recall")).isDirectory()).toBe(true);
	});

	it("removes the Windows fallback's copy once .agents/skills/ provides the skill", async () => {
		plantWindowsFallbackCopy("jolli-recall");
		plantAgentsSkill("jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false);
	});

	// A real directory with no marker is a user's own skill even on Windows, where ours
	// is also a real directory — the marker is the only thing separating the two.
	it("still leaves an unmarked real directory alone", async () => {
		mkdirSync(join(tempDir, ".cursor/skills/jolli-recall"), { recursive: true });
		writeFileSync(cursorSkill("jolli-recall"), "---\nname: jolli-recall\n---\nmine\n", "utf-8");
		await reconcileCursorRepoSkills(tempDir);
		expect(readFileSync(cursorSkill("jolli-recall"), "utf-8")).toContain("mine");
	});

	// Neither of the three states this module produces, so neither is ours: a directory
	// with no SKILL.md has no marker to read, and a plain FILE at a skill's path is not
	// something any placement of ours could have created.
	it("leaves a marker-less directory and a plain file at the skill path alone", async () => {
		mkdirSync(join(tempDir, ".cursor/skills/jolli-recall"), { recursive: true });
		mkdirSync(join(tempDir, ".cursor/skills"), { recursive: true });
		writeFileSync(join(tempDir, ".cursor/skills", "jolli-search"), "not a directory\n", "utf-8");

		await reconcileCursorRepoSkills(tempDir);

		expect(existsSync(join(tempDir, ".cursor/skills/jolli-recall"))).toBe(true);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false); // still empty — untouched
		expect(readFileSync(join(tempDir, ".cursor/skills", "jolli-search"), "utf-8")).toBe("not a directory\n");
	});

	/*
	 * With no bundle there is nothing to link against, so the question the roots answer
	 * ("does some other root already provide this?") does not arise — and answering it
	 * anyway costs a read of Cursor's private `state.vscdb`. This reconcile is
	 * host-neutral, so that read landed on EVERY Claude and Codex session start, to
	 * produce a value the no-bundle path discards.
	 */
	it("does not read Cursor's settings database when no bundle is present", async () => {
		clearCursorPluginRootRecord();
		thirdPartyEnabledMock.mockClear();
		await reconcileCursorRepoSkills(tempDir);
		expect(thirdPartyEnabledMock).not.toHaveBeenCalled();
	});

	// Registered unconditionally, so the exclude block does not flap as `.agents/`
	// appears and disappears; an exclude line for an absent path is inert.
	/*
	 * The containing directory carries its own line, and the per-skill ones do NOT make
	 * it redundant: git reports an untracked DIRECTORY as one `?? .cursor/` entry rather
	 * than descending into it, so excluding only the four leaves left the whole thing
	 * visible in `git status` after a real `/jolli-init`.
	 *
	 * `.cursor/skills/` and not `.cursor/` — the parent is the user's own configuration
	 * directory (rules, settings, mcp.json), and hiding all of it would hide their work
	 * along with ours.
	 */
	it("declares an exclude path for every mirrored skill, plus the directory holding them", () => {
		expect([...CURSOR_REPO_SKILL_GIT_EXCLUDE_PATHS].sort()).toEqual(
			["/.cursor/skills/", ...CURSOR_MIRRORED.map((name) => `/.cursor/skills/${name}/`)].sort(),
		);
		expect(CURSOR_REPO_SKILL_GIT_EXCLUDE_PATHS).not.toContain("/.cursor/");
	});
});

// ─── Cursor mirror: every source Cursor would load from ─────────────────────
//
// Cursor takes a skill's invocation name from the parent directory of its SKILL.md
// and pools six roots flat, matching by `includes` so the `~` variants count too. A
// copy in ANY of them occupies the name, so writing ours beside it is the duplicate
// this mechanism exists to remove — checking only `.agents/skills/` left the rest.

describe("reconcileCursorRepoSkills — source coverage", () => {
	function plantAt(root: string, name: string): void {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, "SKILL.md"), "---\nname: x\n---\nbody\n", "utf-8");
	}

	it("skips a skill provided by the repo's .claude/skills (a pre-upgrade enable's leftovers)", async () => {
		// Cleaned up only by `removeClaudeLegacySkills`, which runs from the CLAUDE
		// plugin bootstrap — a Cursor-only user never reaches it, so this really does
		// sit there.
		plantAt(join(tempDir, ".claude/skills"), "jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false);
		// The others are unaffected — the decision is per skill, not per repo.
		expect(existsSync(cursorSkill("jolli-search"))).toBe(true);
	});

	it("skips a skill provided by the repo's .codex/skills", async () => {
		plantAt(join(tempDir, ".codex/skills"), "jolli-search");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-search"))).toBe(false);
	});

	/*
	 * The toggle. With third-party extensibility OFF, Cursor's provider does not load
	 * the `.claude` / `.codex` groups at all — so a copy there is invisible, and
	 * treating it as "already provided" would leave the user with no recall whatsoever.
	 * Failing toward a duplicate is acceptable here; failing toward nothing is not.
	 */
	it("still writes when the only other copy sits in a root Cursor is not loading", async () => {
		thirdPartyEnabledMock.mockResolvedValue(false);
		plantAt(join(tempDir, ".claude/skills"), "jolli-recall");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(true);
		thirdPartyEnabledMock.mockResolvedValue(true);
	});

	// `.agents/skills/` is in the always-on group, so the toggle must not reach it.
	it("skips an .agents copy regardless of the toggle", async () => {
		thirdPartyEnabledMock.mockResolvedValue(false);
		plantAgentsSkill("jolli-local-run");
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-local-run"))).toBe(false);
		thirdPartyEnabledMock.mockResolvedValue(true);
	});

	// Ownership is deliberately not consulted: a user's own same-named skill occupies
	// the menu entry just as completely, and theirs is the one they chose.
	it("skips a user-authored copy that carries no Jolli marker", async () => {
		mkdirSync(join(tempDir, ".agents/skills/jolli-remote-run"), { recursive: true });
		writeFileSync(
			join(tempDir, ".agents/skills/jolli-remote-run/SKILL.md"),
			"---\nname: jolli-remote-run\n---\nhand written\n",
			"utf-8",
		);
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-remote-run"))).toBe(false);
	});
});

// ─── Cursor mirror teardown ─────────────────────────────────────────────────

describe("removeCursorRepoSkills", () => {
	it("removes every mirrored skill it wrote", async () => {
		await reconcileCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(true);

		await removeCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(false);
	});

	// Same guard as the write direction. Uninstall is exactly when a user is least
	// likely to expect their own file to disappear.
	it("leaves a user-authored copy in place", async () => {
		const mine = "---\nname: jolli-recall\ndescription: mine\n---\nhand written\n";
		mkdirSync(join(tempDir, ".cursor/skills/jolli-recall"), { recursive: true });
		writeFileSync(cursorSkill("jolli-recall"), mine, "utf-8");

		await removeCursorRepoSkills(tempDir);

		expect(readFileSync(cursorSkill("jolli-recall"), "utf-8")).toBe(mine);
	});

	it("is a no-op on a repo that never received the mirror", async () => {
		await expect(removeCursorRepoSkills(tempDir)).resolves.toBeUndefined();
		expect(existsSync(join(tempDir, ".cursor/skills"))).toBe(false);
	});
});

/*
 * The case no code can react to at the moment it happens: the user removes the plugin
 * through Cursor's own UI. Nothing of ours runs then, so the mirror would sit in the
 * slash menu of a repo whose plugin is gone. The reconcile is therefore convergent —
 * it leads with "does the plugin still exist" and cleans up when it does not, on
 * whichever install path runs next.
 */
/*
 * The machine-global umbrella. It is not a variant of the per-repo mirror — it exists
 * because Cursor's chat-first window starts conversations with `workspace_roots: []`,
 * so the surface that most needs a front door is the one surface a per-repo copy can
 * never reach.
 */
describe("ensureCursorGlobalMenu", () => {
	const globalSkill = (home: string) => join(home, ".cursor", "skills", "jolli", "SKILL.md");

	it("writes the state-aware Cursor variant, not the host-neutral menu", async () => {
		await ensureCursorGlobalMenu(tempDir);
		const written = readFileSync(globalSkill(tempDir), "utf-8");
		expect(written).toMatch(/^name: jolli$/mu);
		// Cursor-only plumbing the host-neutral menu does not carry.
		expect(written).toContain("Customize");
		expect(written).toContain("can generate memories");
	});

	it("needs no repository — the whole point of it being global", async () => {
		// No worktree, no `.agents/`, nothing planted. It still lands.
		await ensureCursorGlobalMenu(tempDir);
		expect(existsSync(globalSkill(tempDir))).toBe(true);
	});

	it("is idempotent across sessions", async () => {
		await ensureCursorGlobalMenu(tempDir);
		const first = readFileSync(globalSkill(tempDir), "utf-8");
		await ensureCursorGlobalMenu(tempDir);
		expect(readFileSync(globalSkill(tempDir), "utf-8")).toBe(first);
	});

	it("never overwrites a skill the user wrote themselves", async () => {
		const path = globalSkill(tempDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "---\nname: jolli\n---\n\nmine, hands off\n");

		await ensureCursorGlobalMenu(tempDir);

		expect(readFileSync(path, "utf-8")).toContain("mine, hands off");
	});

	it("removeCursorGlobalMenu reclaims ours and spares theirs", async () => {
		await ensureCursorGlobalMenu(tempDir);
		await removeCursorGlobalMenu(tempDir);
		expect(existsSync(globalSkill(tempDir))).toBe(false);

		const path = globalSkill(tempDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "---\nname: jolli\n---\n\nmine\n");
		await removeCursorGlobalMenu(tempDir);
		expect(existsSync(path)).toBe(true);
	});
});

describe("reconcileCursorRepoSkills — plugin removed outside our control", () => {
	it("removes the mirror when the recorded bundle has disappeared", async () => {
		await reconcileCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(true);

		// The record SURVIVES the uninstall — it lives under `~/.jolli/`. Only the check
		// that `mirror/` still exists can notice, which is why the resolver verifies
		// instead of trusting the recorded path.
		removeFakeBundle();
		await reconcileCursorRepoSkills(tempDir);

		for (const name of CURSOR_MIRRORED) expect(existsSync(cursorSkill(name))).toBe(false);
	});

	// A machine where no plugin ever bootstrapped reads the same as a stale record, and
	// is equally safe: a repo that never received the mirror has nothing to remove.
	it("is a no-op when the plugin was never installed", async () => {
		clearCursorPluginRootRecord();
		await expect(reconcileCursorRepoSkills(tempDir)).resolves.toBeUndefined();
		expect(existsSync(join(tempDir, ".cursor/skills"))).toBe(false);
	});

	// The convergence point that matters in practice: `jolli enable` still runs after
	// the plugin is gone, and it is what a user who keeps using the CLI will run.
	it("cleans up from a full enable, not just from the Cursor bootstrap", async () => {
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(true);

		removeFakeBundle();
		await updateSkillsIfNeeded(tempDir);

		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false);
		// …and the cross-platform copies it just wrote are of course untouched.
		expect(existsSync(join(tempDir, ".agents/skills/jolli-recall/SKILL.md"))).toBe(true);
	});

	/*
	 * The case that produced dangling links in production, kept as a regression: the
	 * mirror used to be derived from `dist-paths/cursor-plugin`, whose slot is keyed by
	 * SOURCE TAG ALONE. `/jolli-init` runs `run-cli enable --source-tag cursor-plugin`,
	 * `run-cli` resolves to the highest-version dist — the CLI at a tie — and the CLI
	 * recorded its own dist under that tag. Every planted link then pointed at
	 * `<cli>/mirror`, which does not exist, and Cursor silently dropped all four skills.
	 */
	it("never plants against a recorded root whose mirror is absent", async () => {
		writeCursorPluginRootRecord(join(tmpdir(), "jolli-not-a-bundle"));

		await reconcileCursorRepoSkills(tempDir);

		for (const name of CURSOR_MIRRORED) expect(existsSync(join(tempDir, ".cursor/skills", name))).toBe(false);
	});
});

/*
 * The property the whole design rests on, and it is a property of the FILESYSTEM
 * rather than of any code path: the mirror is a symlink into the bundle, so removing
 * the plugin makes the skill unreadable at that instant — with nothing of ours running.
 *
 * Measured on Cursor 3.15.6 before this was built: with `.cursor/skills/jolli-recall`
 * symlinked into the bundle and the other four written as real directories, deleting
 * the bundle removed exactly the symlinked entry from the slash menu and left the four
 * real ones behind. That experiment is what these assert in code.
 */
describe("the Cursor mirror disappears with the plugin", () => {
	it("plants symlinks, not copies", async () => {
		await reconcileCursorRepoSkills(tempDir);
		for (const name of CURSOR_MIRRORED) {
			const link = join(tempDir, ".cursor/skills", name);
			expect(lstatSync(link).isSymbolicLink(), `${name} must be a symlink`).toBe(true);
			// …and it resolves to the bundle's copy while the bundle is there.
			expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toContain("name: ");
		}
	});

	// The point. No reconcile, no uninstall, no hook — the bundle simply goes away.
	it("becomes unreadable the moment the bundle is deleted, with no code running", async () => {
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(true);

		removeFakeBundle();

		// The link is still listed in the directory, but nothing can be read through
		// it — which is exactly why Cursor drops the skill from its menu.
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(false);
		expect(() => readFileSync(cursorSkill("jolli-recall"), "utf-8")).toThrow();
	});

	// An upgrade moves a marketplace bundle to a version-stamped path, stranding every
	// existing link. Rebuilding unconditionally is what makes that self-heal on the
	// next session rather than needing its own migration.
	it("re-points the links after the bundle moves", async () => {
		await reconcileCursorRepoSkills(tempDir);
		const before = readlinkSync(join(tempDir, ".cursor/skills/jolli-recall"));

		rmSync(fakePluginDir, { recursive: true, force: true });
		fakePluginDir = mkdtempSync(join(tmpdir(), "jolli-fake-bundle-v2-"));
		plantFakeBundle();
		await reconcileCursorRepoSkills(tempDir);

		const after = readlinkSync(join(tempDir, ".cursor/skills/jolli-recall"));
		expect(after).not.toBe(before);
		expect(existsSync(cursorSkill("jolli-recall"))).toBe(true);
	});

	// Nothing to point at: leave nothing behind rather than a link into the void.
	it("plants nothing when no bundle is registered", async () => {
		removeFakeBundle();
		await reconcileCursorRepoSkills(tempDir);
		expect(existsSync(join(tempDir, ".cursor/skills/jolli-recall"))).toBe(false);
	});
});
