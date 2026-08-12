/**
 * Anti-drift for the Codex plugin's shipped skills.
 *
 * The design constraint this enforces: a plugin user and a CLI user must read the
 * SAME instructions. The plugin ships static copies (the marketplace publishes a
 * directory tree, not a build product), so nothing structural stops the two from
 * diverging — only this test does. It is what makes `generate-skills.ts` get re-run
 * after a template edit rather than the copies quietly going stale.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";
import {
	buildCodexInitSkillTemplate,
	buildCodexJolliSkillTemplate,
	buildCodexLogoutSkillTemplate,
	CODEX_PLUGIN_SKILL_NAMES,
	CODEX_PLUGIN_SKILLS,
	type CodexPluginSkill,
	renderCodexPluginSkill,
	stripMetadataBlock,
} from "./CodexPluginSkills.js";
import { SHELL_PREREQUISITE_BLOCK } from "./PluginSkillText.js";
import { buildPluginJolliMenuSkillTemplate } from "./SkillInstaller.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skillsDir = join(repoRoot, "codex-plugin", "plugins", "jolli", "skills");

describe("Codex plugin skills stay in lockstep with the canonical builders", () => {
	for (const skill of CODEX_PLUGIN_SKILLS) {
		it(`${skill.name} matches the builder output`, () => {
			const committed = readFileSync(join(skillsDir, skill.name, "SKILL.md"), "utf-8");
			expect(committed, "stale — re-run: npx tsx codex-plugin/plugins/jolli/scripts/generate-skills.ts").toBe(
				renderCodexPluginSkill(skill),
			);
		});
	}
});

/*
 * Same rule the Cursor bundle carries, derived from each body rather than from a
 * hand-kept list of skill names — a skill that grows a `run-cli` call later is
 * exactly what a list would miss.
 *
 * `run-cli` is an extensionless bash script under `%USERPROFILE%`, and only Git
 * Bash's `$HOME` points there. PowerShell defines `$HOME` too, so the path expands
 * to something real and the command fails as "not recognized" — and in the umbrella
 * that failure is read as a missing dispatcher, sending the user to re-trust a
 * SessionStart hook that was fine.
 */
describe("every Codex skill that shells run-cli carries the Windows shell prerequisite", () => {
	for (const skill of CODEX_PLUGIN_SKILLS) {
		const body = skill.build();
		const shellsRunCli = body.includes(".jolli/jollimemory/run-cli");
		it(`${skill.name}: ${shellsRunCli ? "shells run-cli, so it pins Git Bash" : "is MCP-only, so it stays lean"}`, () => {
			expect(body.includes(SHELL_PREREQUISITE_BLOCK)).toBe(shellsRunCli);
		});
	}

	// The block survives `renderCodexPluginSkill`'s substring rewrite untouched. That
	// rewrite is a plain `split().join()` over `jolli-recall` → `jolli:recall` and
	// friends, so any path-shaped `jolli-<name>` in shared text would be corrupted —
	// this is the assertion that keeps one from being added to it later.
	it("survives the sibling-reference rewrite unchanged", () => {
		const rendered = renderCodexPluginSkill({ name: "init", build: buildCodexInitSkillTemplate });
		expect(rendered).toContain(SHELL_PREREQUISITE_BLOCK);
	});
});

// The bare front door exists three times — CLI `runGuidedFrontDoor`, the Claude
// plugin's project skill, and this plugin's bundled skill — and users move between
// hosts expecting the same onboarding. The CLI is the reference; these lock the two
// skill variants to its ladder, because a static SKILL.md cannot import anything.
describe("the Codex /jolli front door mirrors the CLI guided front door", () => {
	const tpl = buildCodexJolliSkillTemplate();

	it("derives generation provider-aware so a local-agent repo is not pushed into setup", () => {
		expect(tpl).toContain("can generate memories");
		expect(tpl).toContain("`local-agent` → **yes**");
		expect(tpl).toMatch(/`jolli` → yes if `account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		expect(tpl).toMatch(/`anthropic` → yes only if `account\.anthropicKeyConfigured`/);
		expect(tpl).toContain("OR memories can't be generated");
	});

	// The gap this closes: generation via the local Codex login works with no Jolli
	// account, so the old single-axis check reported a perfectly healthy repo and
	// never mentioned that nothing could be shared.
	it("treats sync as a second axis and nudges sign-in when it is missing", () => {
		expect(tpl).toContain("can sync memories");
		expect(tpl).toMatch(/= `account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		expect(tpl).toContain("Sign in to Jolli to sync memories to a Space?");
		// A nudge, never a gate — the menu still renders for a signed-out repo.
		expect(tpl).toContain("non-blocking");
		// Routes to the existing skill rather than re-running the login flow inline.
		expect(tpl).toContain("invoke the `jolli:login` skill");
		expect(tpl).toContain("never ask for a password, token, or callback URL");
	});

	// The namespaced form is what the model sees in Codex's skill list, so the menu
	// has to name skills that way — a bare `init` would not resolve.
	it("routes to every shipped skill by its namespaced name, including the credential pair", () => {
		for (const name of CODEX_PLUGIN_SKILL_NAMES) {
			if (name === "jolli") continue;
			expect(tpl).toContain(`\`jolli:${name}\``);
		}
	});

	it("leads the menu with jolli:init on a fresh (0-memory) repo instead of empty recall/search", () => {
		expect(tpl).toMatch(/when `storedMemories` is 0, lead with `jolli:init` as\s+the FIRST option/);
		expect(tpl).toMatch(/demote recall \/ search/);
	});

	it("keeps the Codex-specific plumbing notes the Claude variant cannot share", () => {
		// Bare tool names in a namespace — a `mcp__jollimemory__` prefix match finds
		// nothing on this host.
		expect(tpl).toContain("`mcp__jollimemory` namespace");
		// No interactive single-select on this host.
		expect(tpl).toContain("Codex has no interactive single-select");
	});

	// The plugin ships no `.mcp.json` (a plugin MCP entry would pin cwd to the plugin
	// root and serve the wrong repository), so the SessionStart bootstrap is what
	// registers the server — and Codex only reads registrations at session start. The
	// first session after install therefore has skills but no MCP tools, which the menu
	// must present as expected rather than broken, and must be able to work through.
	it("explains that MCP arrives from the next session and the dispatcher suffices meanwhile", () => {
		expect(tpl).toMatch(/registers the Jolli Memory MCP server/);
		expect(tpl).toMatch(/appears from the NEXT session/);
		expect(tpl).toContain("That is expected, not a fault.");
		expect(tpl).toMatch(/dispatcher alone is enough to run every step below/);
	});
});

describe("the Codex and Claude front doors stay aligned", () => {
	const codex = buildCodexJolliSkillTemplate();
	const claude = buildPluginJolliMenuSkillTemplate();

	// Host-neutral rungs: the wording is copied from the CLI front door, so it must
	// be byte-identical in both variants. Host-specific text (skill naming, the
	// leftover-file self-check, single-select support) is asserted per variant.
	const SHARED_RUNGS = [
		"can generate memories",
		"can sync memories",
		"`local-agent` → **yes**",
		"Sign in to Jolli to sync memories to a Space?",
		"✓ enabled · <storedMemories> memories",
		'✓ syncing · Space "<space.name>"',
		"✓ local agent set (not signed in to Jolli)",
		"✓ Jolli API key set (not signed in to Jolli)",
		"✓ Anthropic API key set (not signed in to Jolli)",
		"Jolli is listening — last memory saved.",
	];

	for (const rung of SHARED_RUNGS) {
		it(`both carry: ${rung}`, () => {
			expect(codex).toContain(rung);
			expect(claude).toContain(rung);
		});
	}

	it("both offer the fresh-repo closer", () => {
		for (const tpl of [codex, claude]) expect(tpl).toMatch(/your next commit is your\s+first memory/);
	});
});

describe("stripMetadataBlock", () => {
	it("drops the metadata block and keeps the documented fields", () => {
		const input = [
			"---",
			"name: x",
			"description: d",
			"metadata:",
			'  version: "dev"',
			"  revision: 2",
			"---",
			"",
			"# Body",
		].join("\n");
		expect(stripMetadataBlock(input)).toBe(["---", "name: x", "description: d", "---", "", "# Body"].join("\n"));
	});

	it("leaves a template with no metadata block untouched", () => {
		const input = ["---", "name: x", "description: d", "---", "", "# Body"].join("\n");
		expect(stripMetadataBlock(input)).toBe(input);
	});

	// A `---` inside the body must not be mistaken for the frontmatter terminator,
	// and content after it must survive.
	it("keeps horizontal rules in the body", () => {
		const input = ["---", "name: x", "metadata:", "  revision: 1", "---", "", "intro", "", "---", "", "outro"].join(
			"\n",
		);
		expect(stripMetadataBlock(input)).toBe(
			["---", "name: x", "---", "", "intro", "", "---", "", "outro"].join("\n"),
		);
	});

	it("returns input unchanged when there is no frontmatter at all", () => {
		expect(stripMetadataBlock("# Just a body")).toBe("# Just a body");
	});
});

describe("Codex plugin skill inventory", () => {
	it("tracks every committed plugin skill directory", () => {
		const committedNames = readdirSync(skillsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect([...CODEX_PLUGIN_SKILL_NAMES].sort()).toEqual(committedNames);
	});

	// Codex prefixes a plugin's skills with the plugin name (`jolli:recall`), so the
	// bundle name must NOT carry its own `jolli-` prefix — that only produced
	// stuttering `jolli:jolli-recall`. The umbrella is the one legitimate `jolli`.
	it("ships bare names so the jolli: namespace does not stutter", () => {
		for (const skill of CODEX_PLUGIN_SKILLS) {
			expect(skill.name.startsWith("jolli-")).toBe(false);
		}
	});

	it("declares the two fields Codex requires, headed with the bundle directory name", () => {
		for (const skill of CODEX_PLUGIN_SKILLS) {
			const committed = readFileSync(join(skillsDir, skill.name, "SKILL.md"), "utf-8");
			expect(committed).toMatch(new RegExp(`^name: ${skill.name}$`, "mu"));
			expect(committed).toMatch(/^description: .+/mu);
		}
	});

	// The four shared builders declare the prefixed CLI name because `.agents/skills/`
	// has no namespace. If the renderer stopped re-heading them, the bundle would ship
	// `name: jolli-recall` in a directory called `recall`.
	it("re-heads a shared builder instead of shipping its .agents/skills name", () => {
		const recall = CODEX_PLUGIN_SKILLS.find((skill) => skill.name === "recall");
		expect(recall).toBeDefined();
		expect(recall?.build()).toMatch(/^name: jolli-recall$/mu);
		const rendered = renderCodexPluginSkill(recall as CodexPluginSkill);
		expect(rendered).toMatch(/^name: recall$/mu);
		expect(rendered).not.toContain("jolli-recall");
	});

	// A bundled copy telling the model to "run jolli-recall" would name a skill that
	// does not exist on a plugin-only install.
	it("re-points a shared builder's sibling references at their jolli: names", () => {
		const search = CODEX_PLUGIN_SKILLS.find((skill) => skill.name === "search");
		expect(search?.build()).toContain("use jolli-recall instead");
		expect(renderCodexPluginSkill(search as CodexPluginSkill)).toContain("use jolli:recall instead");
	});
});

// The drift test above cannot catch this class of staleness: it compares a builder
// against its committed copy, so a builder naming four of five tools matches a copy
// naming the same four and both are wrong together. `kimi` shipped that way — the
// logout skill told a Kimi user their generation would stop when it does not. This
// asserts against LOCAL_AGENT_TOOLS instead, so ADDING a tool fails here rather than
// silently narrowing what the skill claims.
describe("the logout skill accounts for every local-agent tool", () => {
	const tpl = buildCodexLogoutSkillTemplate();

	for (const id of Object.keys(LOCAL_AGENT_TOOLS) as ReadonlyArray<LocalAgentToolId>) {
		it(`names ${id} by its canonical label`, () => {
			expect(tpl).toContain(localAgentToolLabel(id));
		});
	}
});
