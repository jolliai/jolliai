/**
 * Anti-drift for the Cursor plugin's shipped skills.
 *
 * The design constraint this enforces: a plugin user and a CLI user must read the
 * SAME instructions. The plugin ships static copies (a marketplace publishes a
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
import { CODEX_PLUGIN_SKILL_NAMES } from "./CodexPluginSkills.js";
import {
	buildCursorJolliSkillTemplate,
	buildCursorLogoutSkillTemplate,
	CURSOR_PLUGIN_SKILL_NAMES,
	CURSOR_PLUGIN_SKILLS,
	type CursorPluginSkill,
	renderCursorPluginSkill,
} from "./CursorPluginSkills.js";
import { SHELL_PREREQUISITE_BLOCK } from "./PluginSkillText.js";
import { buildLocalRunSkillTemplate, buildPluginJolliMenuSkillTemplate } from "./SkillInstaller.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skillsDir = join(repoRoot, "cursor-plugin", "plugins", "jolli", "skills");

describe("Cursor plugin skills stay in lockstep with the canonical builders", () => {
	for (const skill of CURSOR_PLUGIN_SKILLS) {
		it(`${skill.name} matches the builder output`, () => {
			const committed = readFileSync(join(skillsDir, skill.name, "SKILL.md"), "utf-8");
			expect(committed, "stale — re-run: npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts").toBe(
				renderCursorPluginSkill(skill),
			);
		});
	}
});

/*
 * The rule is derivable from the text, so assert it that way rather than listing
 * which skills happen to need it today — a skill that grows a `run-cli` call later
 * is exactly the case a hand-kept list would miss.
 *
 * Why it matters on this host specifically: `run-cli` is an extensionless bash
 * script under `%USERPROFILE%`, and only Git Bash's `$HOME` points there. PowerShell
 * defines `$HOME` too, so the path expands to something real and the command fails as
 * "not recognized" rather than as an obviously-unset variable — and in the umbrella
 * that failure is read as "Jolli is not installed", which offers to delete the menu.
 */
describe("every Cursor skill that shells run-cli carries the Windows shell prerequisite", () => {
	const bodies: ReadonlyArray<readonly [string, string]> = [
		["jolli", buildCursorJolliSkillTemplate()],
		...CURSOR_PLUGIN_SKILLS.map((skill) => [skill.name, skill.build()] as const),
	];

	for (const [name, body] of bodies) {
		const shellsRunCli = body.includes(".jolli/jollimemory/run-cli");
		it(`${name}: ${shellsRunCli ? "shells run-cli, so it pins Git Bash" : "is MCP-only, so it stays lean"}`, () => {
			expect(body.includes(SHELL_PREREQUISITE_BLOCK)).toBe(shellsRunCli);
		});
	}

	// The block reached both this bundle and SkillInstaller's own templates only after
	// it moved to a module neither imports — SkillInstaller imports CursorPluginSkills,
	// so a copy in either one could not be shared without closing a cycle. Restating it
	// per host is what this asserts against.
	it("is the same text the installed skills carry, not a second copy", () => {
		expect(buildLocalRunSkillTemplate()).toContain(SHELL_PREREQUISITE_BLOCK);
	});
});

// The bare front door now exists four times — CLI `runGuidedFrontDoor`, the Claude
// plugin's project skill, and both plugin bundles — and users move between hosts
// expecting the same onboarding. The CLI is the reference; these lock this variant to
// its ladder, because a static SKILL.md cannot import anything.
describe("the Cursor /jolli front door mirrors the CLI guided front door", () => {
	const tpl = buildCursorJolliSkillTemplate();

	it("derives generation provider-aware so a local-agent repo is not pushed into setup", () => {
		expect(tpl).toContain("can generate memories");
		expect(tpl).toContain("`local-agent` → **yes**");
		expect(tpl).toMatch(/`jolli` → yes if `account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		expect(tpl).toMatch(/`anthropic` → yes only if `account\.anthropicKeyConfigured`/);
		expect(tpl).toContain("OR memories can't be generated");
	});

	// The gap this closes: generation via the local Cursor login works with no Jolli
	// account, so a single-axis check would report a perfectly healthy repo and never
	// mention that nothing could be shared.
	it("treats sync as a second axis and nudges sign-in when it is missing", () => {
		expect(tpl).toContain("can sync memories");
		expect(tpl).toMatch(/= `account\.signedIn` OR `account\.jolliApiKeyConfigured`/);
		expect(tpl).toContain("Sign in to Jolli to sync memories to a Space?");
		// A nudge, never a gate — the menu still renders for a signed-out repo.
		expect(tpl).toContain("non-blocking");
		// Routes to the existing skill rather than re-running the login flow inline.
		expect(tpl).toContain("invoke the `jolli-login` skill");
		expect(tpl).toContain("never ask for a password, token, or callback URL");
	});

	// Cursor invokes a skill as `/skill-name`, so the menu has to name every shipped
	// skill in that form — this bundle's names carry the `jolli-` prefix.
	it("routes to every shipped skill by its slash-invocation name", () => {
		for (const name of CURSOR_PLUGIN_SKILL_NAMES) {
			if (name === "jolli") continue;
			expect(tpl).toContain(`\`/${name}\``);
		}
	});

	it("leads the menu with jolli-init on a fresh (0-memory) repo instead of empty recall/search", () => {
		expect(tpl).toMatch(/when\s+`storedMemories` is 0, lead with `jolli-init` as the FIRST option/);
		expect(tpl).toMatch(/demote\s+recall \/ search/);
	});

	/*
	 * Host-specific plumbing the other variants cannot share, and the wording is
	 * measured rather than guessed.
	 *
	 * On a live install Cursor noticed the freshly written `.cursor/mcp.json` within the
	 * same second (`Lease change event … project-0-<repo>-jollimemory`) but registered
	 * the server `none → disconnected` and never spawned it. So the correct instruction
	 * is "enable it in Customize", NOT "reload the window" — a reload is neither needed
	 * for discovery nor sufficient for connection, so telling the user to reload would
	 * send them to do something that changes nothing.
	 */
	it("keeps the Cursor-specific plumbing notes", () => {
		expect(tpl).toContain(".cursor/mcp.json");
		expect(tpl).toContain("Customize");
		expect(tpl).toContain("That is expected, not a fault.");
		expect(tpl).toMatch(/dispatcher alone is enough to run every step below/);
	});

	it("does not tell the user a reload turns the MCP tools on", () => {
		// The reload wording may legitimately appear for loading the PLUGIN itself; what
		// must not come back is pairing it with the MCP server, which a reload does not
		// connect.
		expect(tpl).not.toMatch(/mcp\.json[^.]*Reload Window/u);
		expect(tpl).not.toMatch(/Reload Window[^.]*mcp\.json/u);
	});

	// A briefing that names another host's skill sends the model to something that does
	// not exist on a Cursor-only install.
	it("never names the Codex namespace form", () => {
		expect(tpl).not.toContain("jolli:");
	});
});

describe("the three front doors stay aligned", () => {
	const cursor = buildCursorJolliSkillTemplate();
	const claude = buildPluginJolliMenuSkillTemplate();

	// Host-neutral rungs: the wording is copied from the CLI front door, so it must be
	// byte-identical in every variant. Host-specific text (skill naming, MCP recovery,
	// single-select support) is asserted per variant.
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
			expect(cursor).toContain(rung);
			expect(claude).toContain(rung);
		});
	}

	it("both offer the fresh-repo closer", () => {
		for (const tpl of [cursor, claude]) expect(tpl).toMatch(/your next commit is your\s+first memory/);
	});
});

describe("Cursor plugin skill inventory", () => {
	it("tracks every committed plugin skill directory", () => {
		const committedNames = readdirSync(skillsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect([...CURSOR_PLUGIN_SKILL_NAMES].sort()).toEqual(committedNames);
	});

	/*
	 * The opposite choice from the Codex bundle, and measured rather than assumed.
	 *
	 * Cursor 3.14.7 derives a skill's invocation name from the PARENT DIRECTORY of
	 * `SKILL.md` and prepends no plugin segment, so plugin skills share one flat pool
	 * with `.cursor/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/`
	 * and their `~` variants. Its slash-menu de-duplicator keys on
	 * `(pluginDisplayName, skillName)`, which collapses only the same plugin's
	 * duplicate — two different plugins with the same skill name coexist as two
	 * identically-named entries, distinguished only by a brand icon. A bare `/init` or
	 * `/status` here would be indistinguishable from anyone else's. See
	 * CursorPluginSkills' header for the function-level citations.
	 */
	it("ships prefixed names so a generic /init or /status cannot collide", () => {
		for (const skill of CURSOR_PLUGIN_SKILLS) {
			if (skill.name === "jolli") continue;
			expect(skill.name.startsWith("jolli-")).toBe(true);
		}
	});

	// Cursor's documented constraint, and the reason `renderCursorPluginSkill` re-heads
	// the frontmatter at all: `name` must equal the parent folder, using only lowercase
	// letters, digits and hyphens, max 64 chars. A mismatch is not an error — the slash
	// menu silently invokes the DIRECTORY name while `name` becomes only a label.
	it("keeps every name inside Cursor's charset and equal to its directory", () => {
		for (const skill of CURSOR_PLUGIN_SKILLS) {
			expect(skill.name).toMatch(/^[a-z0-9-]{1,64}$/u);
			const committed = readFileSync(join(skillsDir, skill.name, "SKILL.md"), "utf-8");
			expect(committed).toMatch(new RegExp(`^name: ${skill.name}$`, "mu"));
		}
	});

	/*
	 * Cursor caps a skill description at 1024 chars (docs) and HARD-TRUNCATES it to
	 * 1536 before the model sees it. Descriptions are how a model-invoked skill gets
	 * discovered at all, so a truncated one degrades triggering silently — nothing
	 * warns, and the drift test would happily pin the over-long text.
	 */
	it("keeps every description within Cursor's documented 1024-char cap", () => {
		for (const skill of CURSOR_PLUGIN_SKILLS) {
			const description = /^description: (.*)$/mu.exec(renderCursorPluginSkill(skill))?.[1] ?? "";
			expect(description.length, `${skill.name} description`).toBeGreaterThan(0);
			expect(description.length, `${skill.name} description`).toBeLessThanOrEqual(1024);
		}
	});

	// `alwaysApply: true` turns a skill into an always-injected global rule on this
	// host (`It(n)` in the agent-side loader classifies it as `case:"global"`), which
	// would put eleven long documents in every Cursor session's context.
	it("sets alwaysApply on no skill, so none becomes an always-injected global rule", () => {
		for (const skill of CURSOR_PLUGIN_SKILLS) {
			expect(renderCursorPluginSkill(skill)).not.toContain("alwaysApply");
		}
	});

	/*
	 * Also the guard on a DECIDED trade-off, not just a parity check.
	 *
	 * `.agents/skills/` is a first-class Cursor skill root, so a repo that also ran a
	 * full `jolli enable` shows a SECOND, identically-named entry for each of the four
	 * shared skills — the de-duplicator cannot collapse them (the `.agents/` copy has no
	 * plugin attribution) and Cursor adds no namespace, so they differ only by a brand
	 * icon. Pruning those four from the bundle to tidy the picker is the obvious-looking
	 * fix and is WRONG here: `install(..., { repoHooksOnly: true })` returns before
	 * `updateSkillIfNeeded`, so a plugin bootstrap never writes `.agents/skills/` at all
	 * — a plugin-only user would lose recall and search permanently, not until the next
	 * session. A cosmetic duplicate beats a functional hole. See
	 * cursor-plugin/DEVELOPMENT.md.
	 */
	// This bundle is the Codex one MINUS the four host-neutral skills, which Cursor
	// gets per-repo from `.agents/skills/` or `.cursor/skills/` instead. Asserting the
	// exact difference (rather than equality, which is what this used to assert) keeps
	// both halves honest: adding a Cursor-specific skill without a Codex counterpart
	// fails here, and so does quietly re-bundling a shared one.
	it("is the Codex capability set minus everything written on demand", () => {
		const bare = (names: ReadonlyArray<string>) => [...names].map((name) => name.replace(/^jolli-/u, "")).sort();
		// Written on demand rather than shipped — but at TWO different scopes, which is
		// why this is not "the per-repo mirror": the four host-neutral skills go per-repo
		// into `<repo>/.cursor/skills/` (`reconcileCursorRepoSkills`), while `jolli` goes
		// MACHINE-GLOBAL into `~/.cursor/skills/` (`ensureCursorGlobalMenu`), because the
		// chat-first window that most needs a front door never names a workspace.
		const writtenOnDemand = ["jolli", "local-run", "recall", "remote-run", "search"];
		expect(bare(CURSOR_PLUGIN_SKILL_NAMES)).toEqual(
			bare(CODEX_PLUGIN_SKILL_NAMES).filter((n) => !writtenOnDemand.includes(n)),
		);
	});

	// Named individually so a re-bundle fails with the reason attached rather than as
	// an opaque set mismatch. Cursor reads `.agents/skills/` and this bundle into ONE
	// flat pool and its de-duplicator collapses neither, so a bundled copy shows up as
	// a second, identically-named slash-menu entry in every repo that ran a full
	// `jolli enable`. The four host-neutral names are placed per-repo by
	// `reconcileCursorRepoSkills`; `jolli` is placed machine-global by
	// `ensureCursorGlobalMenu` — not by the mirror, which filters it out.
	it("does NOT bundle anything written on demand", () => {
		for (const name of ["jolli", "jolli-recall", "jolli-search", "jolli-local-run", "jolli-remote-run"]) {
			expect(
				CURSOR_PLUGIN_SKILL_NAMES,
				"bundling this duplicates the .agents/skills/ copy in Cursor's flat pool",
			).not.toContain(name);
		}
	});

	/*
	 * The counterpart of the rule above, and now the ONLY thing standing between a user
	 * and a dead end. The mirror runs from the sessionStart bootstrap, and Cursor drops
	 * every plugin hook silently when its plugins provider times out — so on that
	 * install nothing has been mirrored and `/jolli` does not exist either. Typing
	 * `jolli` still prefix-matches this skill, which is the manual route back. Removing
	 * it from the bundle would leave such a user with no reachable Jolli anything.
	 */
	it("always bundles jolli-init, the one route that survives a dead bootstrap", () => {
		expect(CURSOR_PLUGIN_SKILL_NAMES).toContain("jolli-init");
	});

	it("declares the two fields Cursor requires, headed with the bundle directory name", () => {
		for (const skill of CURSOR_PLUGIN_SKILLS) {
			const committed = readFileSync(join(skillsDir, skill.name, "SKILL.md"), "utf-8");
			expect(committed).toMatch(new RegExp(`^name: ${skill.name}$`, "mu"));
			expect(committed).toMatch(/^description: .+/mu);
		}
	});

	// The four shared builders are authored for `.agents/skills/`, which has no
	// namespace, so they already declare exactly the names this bundle exposes. That is
	// what makes the renderer a two-step no-op here — assert it rather than leave it as
	// a claim in a comment, since a rename on the SkillInstaller side would break it
	// silently.
	// The renderer's two transforms still have to hold for what IS bundled. These
	// builders are authored for this host and already declare their own directory
	// names, so `setFrontmatterName` is a no-op and only the metadata strip does work —
	// assert that rather than leave it as an unverified claim in the module header.
	it("renders a bundled skill with its own name and no metadata block", () => {
		const init = CURSOR_PLUGIN_SKILLS.find((skill) => skill.name === "jolli-init");
		expect(init).toBeDefined();
		expect(init?.build()).toMatch(/^name: jolli-init$/mu);
		expect(renderCursorPluginSkill(init as CursorPluginSkill)).toMatch(/^name: jolli-init$/mu);
	});

	// The umbrella routes to the four skills this bundle no longer ships. They are
	// reachable under exactly these names from `.agents/skills/` or `.cursor/skills/`,
	// so a rename on either side has to fail here — the front door pointing at a name
	// nothing provides is silent, and it is the one skill a stranded user reaches for.
	// The umbrella is no longer bundled, so it is read from its builder rather than the
	// shipped list — but it is still what a plugin-only repo receives (written to
	// `.cursor/skills/jolli`), and it still has to name the skills by the names the
	// mirror writes them under. A rename on either side is silent: the front door would
	// simply point at something nothing provides.
	it("routes the umbrella at the names the per-repo copies are written under", () => {
		const umbrella = buildCursorJolliSkillTemplate();
		for (const name of ["jolli-recall", "jolli-search", "jolli-local-run", "jolli-remote-run"]) {
			expect(umbrella).toContain(`/${name}`);
		}
	});
});

// The drift test above cannot catch this class of staleness: it compares a builder
// against its committed copy, so a builder naming four of five tools matches a copy
// naming the same four and both are wrong together. `kimi` shipped that way on the
// Codex side — the logout skill told a Kimi user their generation would stop when it
// does not. This asserts against LOCAL_AGENT_TOOLS instead, so ADDING a tool fails
// here rather than silently narrowing what the skill claims.
describe("the logout skill accounts for every local-agent tool", () => {
	const tpl = buildCursorLogoutSkillTemplate();

	for (const id of Object.keys(LOCAL_AGENT_TOOLS) as ReadonlyArray<LocalAgentToolId>) {
		it(`names ${id} by its canonical label`, () => {
			expect(tpl).toContain(localAgentToolLabel(id));
		});
	}
});
