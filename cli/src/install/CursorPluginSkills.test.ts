/**
 * Anti-drift for the Cursor plugin's shipped skills.
 *
 * The design constraint this enforces: a plugin user and a CLI user must read the
 * SAME instructions. The plugin ships static copies (a marketplace publishes a
 * directory tree, not a build product), so nothing structural stops the two from
 * diverging — only this test does. It is what makes `generate-skills.ts` get re-run
 * after a template edit rather than the copies quietly going stale.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";
import { CODEX_PLUGIN_SKILL_NAMES } from "./CodexPluginSkills.js";
import {
	appendCursorDispatcherRecovery,
	buildCursorJolliSkillTemplate,
	buildCursorLogoutSkillTemplate,
	CURSOR_DISPATCHER_MISSING_BLOCK,
	CURSOR_DISPATCHER_RECOVERY_SECTION,
	CURSOR_PLUGIN_SKILL_NAMES,
	CURSOR_PLUGIN_SKILLS,
	CURSOR_RESTART_PHRASE,
	type CursorPluginSkill,
	removeCursorGlobalMenu,
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

/*
 * The first-install window this bundle inherited by shipping the four host-neutral
 * skills: their bodies are `.agents/skills/` text, where "Jolli not installed — install
 * `@jolli.ai/cli` globally or the VS Code extension" is the right answer. Inside a
 * plugin it is not: Jolli IS installed, and the dispatcher those bodies test for is
 * written by a `sessionStart` hook that has not run yet.
 *
 * Asserted on the RENDERED text, since the transform is the renderer's — a builder
 * assertion would pass while the committed SKILL.md carries none of it.
 */
describe("the Cursor render appends a dispatcher recovery note where the body has none", () => {
	for (const skill of CURSOR_PLUGIN_SKILLS) {
		const body = skill.build();
		const shellsRunCli = body.includes(".jolli/jollimemory/run-cli");
		const alreadyHandled = body.includes(CURSOR_RESTART_PHRASE);
		const wants = shellsRunCli && !alreadyHandled;

		it(`${skill.name}: ${wants ? "gets the note" : "already answers for this host"}`, () => {
			const rendered = renderCursorPluginSkill(skill);
			expect(rendered.includes(CURSOR_DISPATCHER_RECOVERY_SECTION)).toBe(wants);
			// Either way the rendered copy must name the one remedy that works here —
			// that is the whole point, and it is what a bare append could get wrong by
			// landing on a body that never mentions the dispatcher.
			if (shellsRunCli) expect(rendered).toContain(CURSOR_RESTART_PHRASE);
		});
	}

	// The four host-neutral bodies are the reason this exists. Pin that they really do
	// carry the advice being overridden, so the override cannot quietly become dead text
	// if a shared builder is reworded.
	for (const name of ["jolli-recall", "jolli-search"]) {
		it(`${name}: the note overrides advice that is actually present`, () => {
			const skill = CURSOR_PLUGIN_SKILLS.find((s) => s.name === name);
			expect(skill).toBeDefined();
			expect(skill?.build()).toContain("install the Jolli VS Code extension");
			expect(renderCursorPluginSkill(skill as CursorPluginSkill)).toContain(CURSOR_DISPATCHER_RECOVERY_SECTION);
		});
	}

	// The predicate is a shared phrase, not three spellings. A body that answers for this
	// host in its own words must use it, or it silently collects a duplicate section.
	it("the shared remedy block uses the same phrase the predicate looks for", () => {
		expect(CURSOR_DISPATCHER_MISSING_BLOCK).toContain(CURSOR_RESTART_PHRASE);
		expect(buildCursorJolliSkillTemplate()).toContain(CURSOR_RESTART_PHRASE);
	});

	// The section carries the marker it is selected by, which makes the append
	// idempotent: re-rendering an already-noted body adds nothing.
	it("is idempotent, because the section carries its own marker", () => {
		expect(CURSOR_DISPATCHER_RECOVERY_SECTION).toContain(CURSOR_RESTART_PHRASE);
		const recall = CURSOR_PLUGIN_SKILLS.find((skill) => skill.name === "jolli-recall") as CursorPluginSkill;
		const once = renderCursorPluginSkill(recall);
		expect(appendCursorDispatcherRecovery(once)).toBe(once);
	});

	// The remedy is the HOST's. Codex gates its hook on trust rather than on a restart,
	// so borrowing that sentence here would send a Cursor user to a panel Cursor has not
	// got.
	it("gives Cursor's remedy and never Codex's", () => {
		expect(CURSOR_DISPATCHER_RECOVERY_SECTION).not.toContain("/hooks");
	});
});

/*
 * A freshly installed plugin's hooks are not registered until Cursor has been quit and
 * reopened — measured on 3.16.29, where a window reload plus a new chat both left the
 * `sessionStart` hook unrun and `~/.jolli/jollimemory/` untouched. The dispatcher is
 * what that hook writes, so on a first install "Developer: Reload Window" is not a
 * weaker fix, it is not a fix: the user retries it, sees the same failure, and never
 * gets past setup. Three skills shipped that advice.
 *
 * Derived from the bodies rather than from a list of skill names, so a skill that grows
 * a dispatcher-missing branch later cannot slip past — and asserted as a NEGATIVE per
 * paragraph, because the reload wording is legitimate elsewhere (the umbrella's
 * dispatcher-PRESENT branch, where a reload really does re-run the hook of a plugin
 * that is already registered).
 */
describe("no Cursor skill offers a window reload as the remedy for a missing dispatcher", () => {
	const bodies: ReadonlyArray<readonly [string, string]> = [
		["jolli", buildCursorJolliSkillTemplate()],
		...CURSOR_PLUGIN_SKILLS.map((skill) => [skill.name, skill.build()] as const),
	];

	for (const [name, body] of bodies) {
		it(`${name}: never pairs an absent dispatcher with a reload`, () => {
			// The shared remedy is exempt by construction, not by wording: it NAMES the
			// reload in order to rule it out. Removing it first is what keeps this a test
			// about stray advice rather than about how the good paragraph is phrased.
			const offenders = body
				.split(CURSOR_DISPATCHER_MISSING_BLOCK)
				.join("\n\n")
				.split(/\n\s*\n/u)
				.filter((para) => /Reload Window/u.test(para))
				.filter((para) => /does not exist|is missing|has not run|not been written/u.test(para));
			expect(offenders).toEqual([]);
		});

		// The positive half: a skill that DOES tell the user the dispatcher may be absent
		// carries the one shared sentence, so the remedy cannot drift per skill.
		const claimsAbsence = body.includes("does not exist, the plugin's `sessionStart`");
		it(`${name}: ${claimsAbsence ? "carries the shared remedy" : "has no dispatcher-absent branch"}`, () => {
			expect(body.includes(CURSOR_DISPATCHER_MISSING_BLOCK)).toBe(claimsAbsence);
		});
	}
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
	 * session. A cosmetic duplicate beats a functional hole.
	 *
	 * It was tried anyway, as a per-repo mirror into `.cursor/skills/` written only when
	 * no other root supplied the name, and it failed for precisely that reason: the
	 * mirror was planted by the sessionStart bootstrap, whose opt-in gate is false in a
	 * repo that has not been set up, so a Cursor-only user got no recall and no search
	 * at all — absent from the store page and absent from the menu. See
	 * cursor-plugin/DEVELOPMENT.md.
	 */
	// This bundle is the Codex one MINUS the `jolli` umbrella alone. Asserting the exact
	// difference (rather than plain equality) keeps both halves honest in both
	// directions: adding a Cursor-specific skill without a Codex counterpart fails here,
	// and so does dropping a shared one back out of the bundle.
	// Now an exact match, umbrella included — the two bundles ship the same capability
	// set, differing only in how each host names the directories.
	it("is the Codex capability set exactly", () => {
		const bare = (names: ReadonlyArray<string>) => [...names].map((name) => name.replace(/^jolli-/u, "")).sort();
		expect(bare(CURSOR_PLUGIN_SKILL_NAMES)).toEqual(bare(CODEX_PLUGIN_SKILL_NAMES));
	});

	// The decided trade-off above, asserted per name so a re-prune fails with the reason
	// attached rather than as an opaque set mismatch. A Cursor-only user reaches these
	// four ONLY through the bundle: `install(..., { repoHooksOnly: true })` returns
	// before `updateSkillIfNeeded`, so no plugin bootstrap ever writes `.agents/skills/`,
	// and the retired per-repo mirror was planted by a bootstrap gated on the repo being
	// set up already. Dropping one to tidy a multi-host user's picker takes recall or
	// search away from the audience this bundle exists for.
	it("bundles every shared skill a Cursor-only user needs", () => {
		for (const name of ["jolli-recall", "jolli-search", "jolli-local-run", "jolli-remote-run"]) {
			expect(CURSOR_PLUGIN_SKILL_NAMES, "a Cursor-only user has no other source for this skill").toContain(name);
		}
	});

	/*
	 * The umbrella is bundled, and this is the assertion that keeps it that way.
	 *
	 * It was machine-global (`~/.cursor/skills/jolli/`, written by the bootstrap) on the
	 * theory that Cursor's chat-first Agents Window could not load a bundled skill.
	 * Measured on 3.16.29 against Cursor's own slash-menu cache: every bundled skill
	 * appears in both no-repository contexts, and the install is recorded under a
	 * `no-workspace` key. The machine-global copy also could not survive its own first
	 * install — a fresh plugin's hooks are not registered until Cursor fully restarts, so
	 * the write never happened and the user had every skill except the front door.
	 */
	it("bundles the umbrella, so it exists the instant the plugin does", () => {
		expect(CURSOR_PLUGIN_SKILL_NAMES).toContain("jolli");
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

// ─── Retiring the machine-global `/jolli` umbrella ──────────────────────────
//
// The umbrella ships in the bundle now. What is left at `~/.cursor/skills/jolli/` is a
// leftover from an earlier version, and the bootstrap sweeps it so the flat menu does not
// show the same document twice.

describe("removeCursorGlobalMenu", () => {
	let home: string;
	const menu = () => join(home, ".cursor", "skills", "jolli", "SKILL.md");
	const plant = (body: string) => {
		mkdirSync(join(home, ".cursor", "skills", "jolli"), { recursive: true });
		writeFileSync(menu(), body, "utf-8");
	};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "jolli-cursor-home-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	// The old copy is recognisable by the `vendor` marker in the metadata block that
	// `buildCursorJolliSkillTemplate` still carries — which is exactly why that block is
	// kept even though the bundled render strips it.
	it("removes a copy an earlier version wrote", async () => {
		plant(buildCursorJolliSkillTemplate());
		await removeCursorGlobalMenu(home);
		expect(existsSync(menu())).toBe(false);
	});

	it("spares a skill the user wrote themselves", async () => {
		plant("---\nname: jolli\n---\nmine\n");
		await removeCursorGlobalMenu(home);
		expect(existsSync(menu())).toBe(true);
	});

	it("is a no-op when there is nothing there", async () => {
		await expect(removeCursorGlobalMenu(home)).resolves.toBeUndefined();
	});

	// The bundled copy is the same document, minus the block the renderer strips — so the
	// sweep cannot leave the user worse off than before it ran.
	it("the bundled copy carries the same body the leftover did", () => {
		const bundled = renderCursorPluginSkill({ name: "jolli", build: buildCursorJolliSkillTemplate });
		expect(bundled).toContain("# Jolli Memory");
		expect(bundled).not.toMatch(/^metadata:$/mu);
		expect(bundled).toMatch(/^name: jolli$/mu);
	});
});
