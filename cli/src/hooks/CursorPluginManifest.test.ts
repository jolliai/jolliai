/**
 * Shape tests for the Cursor plugin distribution tree.
 *
 * These pin decisions that are easy to "clean up" into something Cursor silently
 * refuses to load, and that no unit test elsewhere would catch — the manifest is
 * data, not code, so nothing type-checks it.
 *
 * Sibling of CodexPluginManifest.test.ts. Where the two hosts disagree, the
 * disagreement itself is what gets asserted: the manifest path, the hook event name
 * and casing, the flat hooks.json shape, and the plugin-root variable.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURSOR_PLUGIN_SKILL_NAMES } from "../install/CursorPluginSkills.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pluginRoot = join(repoRoot, "cursor-plugin", "plugins", "jolli");

function readJson(...segments: string[]): Record<string, unknown> {
	return JSON.parse(readFileSync(join(...segments), "utf-8")) as Record<string, unknown>;
}

describe("Cursor plugin manifest", () => {
	// `.cursor-plugin/plugin.json` is the Cursor Plugin format. The root `plugin.json`
	// of the open Agent Plugins standard would ALSO load, but that format supports
	// only skills and MCP — no rules, agents, commands or hooks — so a plugin whose
	// bootstrap is a hook cannot use it.
	it("lives at .cursor-plugin/plugin.json", () => {
		const manifest = readJson(pluginRoot, ".cursor-plugin", "plugin.json");
		expect(manifest.name).toBe("jolli");
		// Shape, not value: the plugin carries its own version and every release bumps
		// it (`_publish-lib.sh` refuses a same-version publish), so pinning the literal
		// would make each release edit this test.
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(typeof manifest.description).toBe("string");
	});

	it("uses the lowercase kebab-case name Cursor requires", () => {
		const manifest = readJson(pluginRoot, ".cursor-plugin", "plugin.json");
		expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
	});

	it("references every component by relative path", () => {
		const manifest = readJson(pluginRoot, ".cursor-plugin", "plugin.json");
		expect(manifest.skills).toBe("./skills/");
		expect(manifest.hooks).toBe("./hooks/hooks.json");
	});
});

describe("Cursor plugin MCP config", () => {
	/*
	 * Asserts an ABSENCE, for the same reason the Codex plugin does.
	 *
	 * A plugin-declared MCP entry resolves its relative `cwd` against the PLUGIN root,
	 * and every memory tool derives the repository it serves from its cwd — so such a
	 * server answers `recall` / `search` / `status` for the plugin's own cache
	 * directory: empty but successful, plus a placeholder Memory Bank repo named after
	 * the bundle's version directory. `startMcpServer` refuses a plugin-cache cwd as
	 * the backstop.
	 *
	 * Cursor's own MCP config is REPO-scoped (`<worktree>/.cursor/mcp.json`), so unlike
	 * Codex this needs no exception to the global-host skip: the ordinary
	 * `cursorRegistrar` is already the right writer, and the bootstrap calls it through
	 * Installer's `pluginHost === "cursor"` branch.
	 */
	it("ships no plugin MCP entry, so the server is never launched from the bundle", () => {
		expect(existsSync(join(pluginRoot, "mcp.json"))).toBe(false);
		const manifest = readJson(pluginRoot, ".cursor-plugin", "plugin.json");
		expect(manifest.mcpServers).toBeUndefined();
	});
});

describe("Cursor plugin hooks", () => {
	// Exactly one sessionStart bootstrap, no business hooks: the capture hooks are
	// repo-installed and dispatched through run-hook, so a manifest-registered `stop`
	// hook would double-run against the repo one.
	it("registers only the sessionStart bootstrap", () => {
		const manifest = readJson(pluginRoot, "hooks", "hooks.json");
		const hooks = manifest.hooks as Record<string, unknown>;
		expect(Object.keys(hooks)).toEqual(["sessionStart"]);
	});

	// Cursor's event names are camelCase (`sessionStart`), NOT Claude's and Codex's
	// PascalCase `SessionStart`. A wrong-cased key is not an error — it is an event
	// that never fires.
	it("uses Cursor's camelCase event name, not the PascalCase other hosts use", () => {
		const hooks = readJson(pluginRoot, "hooks", "hooks.json").hooks as Record<string, unknown>;
		expect(hooks).toHaveProperty("sessionStart");
		expect(hooks).not.toHaveProperty("SessionStart");
	});

	it("declares the schema version Cursor's hooks.json carries", () => {
		expect(readJson(pluginRoot, "hooks", "hooks.json").version).toBe(1);
	});

	/*
	 * Every key must be an event Cursor actually publishes, and this is a HARDER rule
	 * than the casing one above — measured, not inferred.
	 *
	 * A wrong-cased key costs you that one event. An UNRECOGNISED key costs you the
	 * whole file: a throwaway probe registering four valid events plus `activeBranchChange`
	 * (a string that appears in Cursor's bundle but is not a hook event) had NONE of its
	 * five hooks executed, and Cursor logged nothing about rejecting it — the plugin's
	 * hooks were simply absent from the executed list. The official docs do not state
	 * what happens for an invalid identifier, so this list is the only guard there is.
	 *
	 * Source: https://cursor.com/docs/hooks. Add a name here only after finding it in
	 * that reference — never from grepping the app bundle, which is what produced the
	 * bad name above.
	 */
	it("registers only event names Cursor documents", () => {
		const documented = new Set([
			"sessionStart",
			"sessionEnd",
			"preToolUse",
			"postToolUse",
			"postToolUseFailure",
			"subagentStart",
			"subagentStop",
			"beforeShellExecution",
			"afterShellExecution",
			"beforeMCPExecution",
			"afterMCPExecution",
			"beforeReadFile",
			"afterFileEdit",
			"beforeSubmitPrompt",
			"preCompact",
			"stop",
			"afterAgentResponse",
			"afterAgentThought",
			"beforeTabFileRead",
			"afterTabFileEdit",
			"workspaceOpen",
		]);
		const hooks = readJson(pluginRoot, "hooks", "hooks.json").hooks as Record<string, unknown>;
		expect(Object.keys(hooks).filter((name) => !documented.has(name))).toEqual([]);
	});

	/*
	 * Cursor's hooks.json is FLATTER than Claude's and Codex's: an event maps straight
	 * to an array of `{ command, … }`. Reusing the other hosts' intermediate
	 * `{ hooks: [...] }` group would parse as one entry with no `command` at all.
	 */
	it("maps the event straight to command entries, with no nested hooks group", () => {
		const hooks = readJson(pluginRoot, "hooks", "hooks.json").hooks as Record<
			string,
			Array<Record<string, unknown>>
		>;
		const entries = hooks.sessionStart;
		expect(entries).toHaveLength(1);
		expect(entries[0]).not.toHaveProperty("hooks");
		expect(typeof entries[0].command).toBe("string");
	});

	it("launches the Cursor bootstrap through CURSOR_PLUGIN_ROOT", () => {
		const hooks = readJson(pluginRoot, "hooks", "hooks.json").hooks as Record<
			string,
			Array<Record<string, string>>
		>;
		const command = hooks.sessionStart[0].command;
		expect(command).toContain("CursorPluginBootstrapHook.js");
		// Cursor provides its own plugin-root variable; the other hosts' names are not
		// aliases here, so an unexpanded `${PLUGIN_ROOT}` would produce a command that
		// fails silently on every session. Matched with a regex because the literal
		// `${…}` reads as a template placeholder to the linter, which it is not.
		expect(command).toMatch(/\$\{CURSOR_PLUGIN_ROOT\}/u);
		expect(command).not.toContain("CLAUDE_PLUGIN_ROOT");
		expect(command).not.toMatch(/\$\{PLUGIN_ROOT\}/u);
	});
});

describe("Cursor plugin skills", () => {
	/*
	 * The umbrella is NOT shipped, and that is the design rather than an omission.
	 * Cursor pools a bundle's `skills/` with `.agents/skills/` into one flat menu and
	 * collapses neither, so a bundled `jolli` was a second, identically-named entry in
	 * every repo that had run `jolli enable`. It is written to `.cursor/skills/jolli`
	 * per repo instead, and only where nothing else already provides it — see
	 * `reconcileCursorRepoSkills`. Re-adding it here silently restores the duplicate.
	 */
	it("does not ship the /jolli umbrella — it is mirrored per repo", () => {
		expect(existsSync(join(pluginRoot, "skills", "jolli"))).toBe(false);
	});

	// The one skill that must survive a bootstrap that never runs: with the mirror
	// unwritten there is no `/jolli` either, and typing `jolli` prefix-matches this.
	it("ships jolli-init with the required frontmatter", () => {
		const skill = readFileSync(join(pluginRoot, "skills", "jolli-init", "SKILL.md"), "utf-8");
		expect(skill.startsWith("---\n")).toBe(true);
		expect(skill).toMatch(/^name: jolli-init$/mu);
		expect(skill).toMatch(/^description: .+/mu);
	});

	it("ships the complete onboarding and management workflow set", () => {
		for (const name of ["init", "login", "logout", "status", "timeline", "push"]) {
			const skill = readFileSync(join(pluginRoot, "skills", `jolli-${name}`, "SKILL.md"), "utf-8");
			expect(skill).toMatch(new RegExp(`^name: jolli-${name}$`, "mu"));
		}
	});
});

describe("Cursor plugin dist entry set", () => {
	const buildScript = readFileSync(join(pluginRoot, "scripts", "build.mjs"), "utf-8");

	// Dist completeness is a machine-global contract: DistPathWriter refuses to
	// register a dist missing any REQUIRED_RUNTIME_FILE, and the shared repo hooks are
	// source-neutral, so whichever dist wins the version race must be able to serve all
	// of them. A required file added there but forgotten here would leave this plugin's
	// runtime unregistered — or, worse, registered and then unable to serve another
	// host's repo hooks, which BLOCKS a commit rather than degrading.
	it("bundles every file DistPathWriter requires for a complete runtime", () => {
		const writerText = readFileSync(join(repoRoot, "cli", "src", "install", "DistPathWriter.ts"), "utf-8");
		const block = writerText.split("const REQUIRED_RUNTIME_FILES = [")[1]?.split("]")[0] ?? "";
		const required = [...block.matchAll(/"([^"]+)\.js"/gu)].map((m) => m[1]);

		expect(required.length).toBeGreaterThan(0);
		for (const entry of required) {
			expect(buildScript, `${entry} missing from the Cursor plugin dist`).toContain(`out: "${entry}"`);
		}
	});

	// Launched straight from the manifest, so it never resolves through dist-paths/
	// and REQUIRED_RUNTIME_FILES does not cover it.
	it("bundles its own bootstrap entry", () => {
		expect(buildScript).toContain('out: "CursorPluginBootstrapHook"');
	});

	// Codex ships McpLauncher because it registers MCP into a global config.toml and
	// resolves the runtime per launch. Cursor's entry is repo-scoped and identical to
	// what every other surface writes, so promoting the launcher here would add a file
	// no path can reach.
	it("does not bundle the Codex-only MCP launcher", () => {
		expect(buildScript).not.toContain('out: "McpLauncher"');
	});

	it("stamps the cursor-plugin client kind so the surface is identifiable on the wire", () => {
		expect(buildScript).toContain('__JOLLI_CLIENT_KIND__: JSON.stringify("cursor-plugin")');
	});
});

// The publish scripts assert an EXACT skill count before shipping, so their list has
// to track the TypeScript inventory. Parse the shell array out of the source text
// rather than duplicating it a third time here.
describe("Cursor publish inventory tracks the shipped skills", () => {
	it("PUBLISH_EXPECTED_SKILLS equals CURSOR_PLUGIN_SKILL_NAMES", () => {
		const libText = readFileSync(join(repoRoot, "cursor-plugin", "scripts", "_publish-lib.sh"), "utf-8");
		const block = libText.split("PUBLISH_EXPECTED_SKILLS=(")[1]?.split(")")[0] ?? "";
		const shellNames = block.split(/\s+/u).filter((entry) => entry.length > 0);

		expect(shellNames.length).toBeGreaterThan(0);
		expect(shellNames.sort()).toEqual([...CURSOR_PLUGIN_SKILL_NAMES].sort());
	});

	it("requires the dist entries build.mjs promises to emit", () => {
		const libText = readFileSync(join(repoRoot, "cursor-plugin", "scripts", "_publish-lib.sh"), "utf-8");
		const buildScript = readFileSync(join(pluginRoot, "scripts", "build.mjs"), "utf-8");
		const block = libText.split("PUBLISH_REQUIRED_DIST=(")[1]?.split(")")[0] ?? "";
		const jsEntries = block
			.split(/\s+/u)
			.filter((entry) => entry.endsWith(".js") && !entry.includes("/"))
			.map((entry) => entry.replace(/\.js$/u, ""));

		expect(jsEntries.length).toBeGreaterThan(0);
		for (const entry of jsEntries) {
			expect(buildScript, `${entry} required by publish but not built`).toContain(`out: "${entry}"`);
		}
	});
});

// The README's install instructions differ per publish target, so the source copy
// carries a placeholder that each publish script resolves on the mirror. Two halves
// that can drift apart: the README could lose the token (the publish script fails
// loudly, but only at release time), or a script could pass the WRONG slug — and
// dev/prod are the same repository name in two orgs, so a swapped slug documents a
// marketplace the reader has no access to while every other check passes.
describe("Cursor publish resolves the README install source", () => {
	const readScript = (name: string) => readFileSync(join(repoRoot, "cursor-plugin", "scripts", name), "utf-8");

	it("keeps every placeholder resolvable in the install instructions", () => {
		const readme = readFileSync(join(repoRoot, "cursor-plugin", "README.md"), "utf-8");
		const placeholder = readScript("_publish-lib.sh").match(/^README_SOURCE_PLACEHOLDER='([^']+)'$/mu)?.[1] ?? "";

		expect(placeholder).toBe("<marketplace-source>");
		const lines = readme.split("\n");
		// At least one, or publish_readme_source fails the release outright.
		expect(lines.filter((line) => line.includes(placeholder)).length).toBeGreaterThan(0);
		// The real constraint is PER LINE, not per file: publish_readme_source walks every
		// line and rewrites the first occurrence on each, then asserts none survive. So a
		// second placeholder on its OWN line resolves fine (the install line and the clone
		// command both need the slug), while two on ONE line would ship a literal
		// `<marketplace-source>` to users — the one shape that must fail here.
		for (const [index, line] of lines.entries()) {
			expect.soft(line.split(placeholder).length - 1, `line ${index + 1} has repeats`).toBeLessThan(2);
		}
	});

	it("passes each target's own marketplace slug", () => {
		expect(readScript("publish-dev.sh")).toContain(
			'publish_git_repo "$DEST" "jolli-plugin-dev/jolli-cursor-plugin"',
		);
		expect(readScript("publish-prod.sh")).toContain('publish_git_repo "$DEST" "jolliai/jolli-cursor-plugin"');
	});
});

describe("Cursor plugin marketplace", () => {
	it("is discoverable at .cursor-plugin/marketplace.json", () => {
		const marketplace = readJson(repoRoot, "cursor-plugin", ".cursor-plugin", "marketplace.json");
		const plugins = marketplace.plugins as Array<Record<string, unknown>>;
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("jolli");
		expect(plugins[0].source).toBe("./plugins/jolli");
	});

	// A marketplace entry naming a directory that does not exist is accepted by every
	// check here except this one, and then fails at install time for the user.
	it("points at a directory that actually holds a plugin manifest", () => {
		const marketplace = readJson(repoRoot, "cursor-plugin", ".cursor-plugin", "marketplace.json");
		const source = (marketplace.plugins as Array<Record<string, string>>)[0].source;
		expect(existsSync(join(repoRoot, "cursor-plugin", source, ".cursor-plugin", "plugin.json"))).toBe(true);
	});
});
