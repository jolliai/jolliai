/**
 * Shape tests for the Codex plugin distribution tree.
 *
 * These pin decisions that are easy to "clean up" into something Codex silently
 * refuses to load, and that no unit test elsewhere would catch — the manifest is
 * data, not code, so nothing type-checks it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODEX_PLUGIN_SKILL_NAMES } from "../install/CodexPluginSkills.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pluginRoot = join(repoRoot, "codex-plugin", "plugins", "jolli");

function readJson(...segments: string[]): Record<string, unknown> {
	return JSON.parse(readFileSync(join(...segments), "utf-8")) as Record<string, unknown>;
}

describe("Codex plugin manifest", () => {
	// `.codex-plugin/plugin.json` is the only manifest path the official docs
	// define. Codex's binary also tolerates `.claude-plugin/plugin.json` and
	// `.cursor-plugin/plugin.json`, but that tolerance is undocumented — shipping
	// against it would build the product on an unsupported contract.
	it("lives at .codex-plugin/plugin.json", () => {
		const manifest = readJson(pluginRoot, ".codex-plugin", "plugin.json");
		expect(manifest.name).toBe("jolli");
		// Shape, not value: the plugin carries its own version and every release bumps
		// it (`_publish-lib.sh` refuses a same-version publish), so pinning the literal
		// would make each release edit this test. The regex still catches a malformed or
		// missing version, which is what the manifest contract actually requires.
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(typeof manifest.description).toBe("string");
	});

	it("references every component by relative path", () => {
		const manifest = readJson(pluginRoot, ".codex-plugin", "plugin.json");
		expect(manifest.skills).toBe("./skills/");
		expect(manifest.hooks).toBe("./hooks/hooks.json");
	});

	it("declares the interface metadata the plugin directory renders", () => {
		const manifest = readJson(pluginRoot, ".codex-plugin", "plugin.json");
		const iface = manifest.interface as Record<string, unknown>;
		expect(iface.displayName).toBe("Jolli Memory");
		expect(Array.isArray(iface.defaultPrompt)).toBe(true);
		expect(iface.defaultPrompt).toHaveLength(3);
	});
});

describe("Codex plugin MCP config", () => {
	/*
	 * The load-bearing one, and it asserts an ABSENCE.
	 *
	 * A plugin MCP entry cannot work here. Codex does not expand `${PLUGIN_ROOT}` in
	 * MCP entries, so the command has to be relative with `cwd: "."` (the shape both
	 * stdio plugins OpenAI ships use) — and a relative cwd is resolved against the
	 * PLUGIN ROOT. Measured on codex-cli 0.146.0 with a probe plugin: the server's
	 * `process.cwd()` was its own version directory under `~/.codex/plugins/cache/`,
	 * never the session directory. Since every memory tool derives its repository from
	 * cwd, such a server answers `recall` / `search` / `status` for the plugin's cache
	 * directory — empty but successful — and roots a placeholder Memory Bank repo named
	 * after the version directory.
	 *
	 * Nothing recovers the workspace from inside that launch: 0.146.0 declares no
	 * `roots` capability (a server-initiated `roots/list` returned `{"roots": []}`) and
	 * passes MCP servers a 7-variable env allowlist (HOME, LOGNAME, PATH, SHELL,
	 * TMPDIR, USER, __CF_USER_TEXT_ENCODING) with nothing session-scoped in it.
	 *
	 * The same probe registered through `~/.codex/config.toml` — no cwd key — was
	 * launched with the SESSION cwd, which is why MCP goes there instead. The bootstrap
	 * writes that entry (see the codex branch of registerGlobalMcpHosts in
	 * Installer.ts), and `startMcpServer` refuses a plugin-bundle cwd as a backstop.
	 */
	it("ships no plugin MCP entry, so the server is never launched from the bundle", () => {
		expect(existsSync(join(pluginRoot, ".mcp.json"))).toBe(false);
		const manifest = readJson(pluginRoot, ".codex-plugin", "plugin.json");
		expect(manifest.mcpServers).toBeUndefined();
	});
});

describe("Codex plugin hooks", () => {
	// Exactly one SessionStart bootstrap, no business hooks: the Stop/SessionStart
	// capture hooks are repo-installed and dispatched through run-hook, so putting
	// them in the manifest would double-run them. Mirrors the same assertion the
	// Claude plugin's build makes about its own hooks.json.
	it("registers only the SessionStart bootstrap", () => {
		const manifest = readJson(pluginRoot, "hooks", "hooks.json");
		const hooks = manifest.hooks as Record<string, unknown>;
		expect(Object.keys(hooks)).toEqual(["SessionStart"]);
	});

	it("launches the Codex bootstrap through PLUGIN_ROOT", () => {
		const manifest = readJson(pluginRoot, "hooks", "hooks.json");
		const groups = (manifest.hooks as Record<string, Array<{ hooks: Array<Record<string, string>> }>>).SessionStart;
		const handlers = groups.flatMap((group) => group.hooks);
		const commands = handlers.map((handler) => handler.command);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("CodexPluginBootstrapHook.js");
		// Hooks — unlike MCP entries — DO get the plugin root expanded, and Codex
		// provides its own variable rather than only the Claude-compat alias. Matched
		// with a regex because the literal `${…}` reads as a template placeholder to
		// the linter, which it is not: it is a shell variable Codex substitutes.
		expect(commands[0]).toMatch(/\$\{PLUGIN_ROOT\}/u);
		expect(commands[0]).not.toContain("CLAUDE_PLUGIN_ROOT");
		expect(handlers[0].statusMessage).toBe("Initializing Jolli Memory");
	});
});

describe("Codex plugin skills", () => {
	// Codex namespaces a plugin's skills by the plugin name (`jolli:recall`), so bundle
	// directories carry bare names. The front door and the Claude-command equivalents
	// ship here rather than being written into the user's repo.
	it("ships the $jolli umbrella with the required frontmatter", () => {
		const skill = readFileSync(join(pluginRoot, "skills", "jolli", "SKILL.md"), "utf-8");
		expect(skill.startsWith("---\n")).toBe(true);
		expect(skill).toMatch(/^name: jolli$/mu);
		expect(skill).toMatch(/^description: .+/mu);
	});

	it("ships the complete onboarding and management workflow set", () => {
		for (const name of ["init", "login", "logout", "status", "timeline", "push"]) {
			const skill = readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf-8");
			expect(skill).toMatch(new RegExp(`^name: ${name}$`, "mu"));
		}
	});
});

describe("Codex plugin dist entry set", () => {
	const buildScript = readFileSync(join(pluginRoot, "scripts", "build.mjs"), "utf-8");

	// The lockstep the Claude build only asserts in a comment. Dist completeness is a
	// machine-global contract: DistPathWriter refuses to register a dist missing any
	// REQUIRED_RUNTIME_FILE, and the shared repo hooks are source-neutral, so whichever
	// dist wins the version race must be able to serve all of them. A required file
	// added there but forgotten here would leave this plugin's runtime unregistered —
	// or, worse, registered and then unable to serve another host's repo hooks.
	it("bundles every file DistPathWriter requires for a complete runtime", () => {
		const writerText = readFileSync(join(repoRoot, "cli", "src", "install", "DistPathWriter.ts"), "utf-8");
		const block = writerText.split("const REQUIRED_RUNTIME_FILES = [")[1]?.split("]")[0] ?? "";
		const required = [...block.matchAll(/"([^"]+)\.js"/gu)].map((m) => m[1]);

		expect(required.length).toBeGreaterThan(0);
		for (const entry of required) {
			expect(buildScript, `${entry} missing from the Codex plugin dist`).toContain(`out: "${entry}"`);
		}
	});

	// Launched straight from the manifest, so it never resolves through dist-paths/
	// and REQUIRED_RUNTIME_FILES does not cover it.
	it("bundles its own bootstrap entry", () => {
		expect(buildScript).toContain('out: "CodexPluginBootstrapHook"');
	});

	it("stamps the codex-plugin client kind so the surface is identifiable on the wire", () => {
		expect(buildScript).toContain('__JOLLI_CLIENT_KIND__: JSON.stringify("codex-plugin")');
	});
});

// The publish scripts assert an EXACT skill count before shipping, so their list
// has to track the TypeScript inventory. It used to be synced by hand: adding a
// twelfth skill failed loudly in both places, but the publish-side failure only
// appeared at release time, in a shell script, with no pointer back to the array
// that moved. Same technique as the DistPathWriter check above — parse the shell
// array out of the source text rather than duplicating it a third time here.
describe("Codex publish inventory tracks the shipped skills", () => {
	it("PUBLISH_EXPECTED_SKILLS equals CODEX_PLUGIN_SKILL_NAMES", () => {
		const libText = readFileSync(join(repoRoot, "codex-plugin", "scripts", "_publish-lib.sh"), "utf-8");
		const block = libText.split("PUBLISH_EXPECTED_SKILLS=(")[1]?.split(")")[0] ?? "";
		const shellNames = block.split(/\s+/u).filter((entry) => entry.length > 0);

		expect(shellNames.length).toBeGreaterThan(0);
		expect(shellNames.sort()).toEqual([...CODEX_PLUGIN_SKILL_NAMES].sort());
	});
});

// The README's `marketplace add` argument differs per publish target, so the source
// copy carries a placeholder that each publish script resolves on the mirror. Two
// halves that can drift apart: the README could lose the token (the publish script
// fails loudly, but only at release time), or a script could pass the WRONG slug —
// and dev/prod are the same repository name in two orgs, so a swapped slug documents
// a marketplace the reader has no access to while every other check passes.
describe("Codex publish resolves the README install source", () => {
	const readReadme = () => readFileSync(join(repoRoot, "codex-plugin", "README.md"), "utf-8");
	const readScript = (name: string) => readFileSync(join(repoRoot, "codex-plugin", "scripts", name), "utf-8");

	it("keeps a single resolvable placeholder in the marketplace add command", () => {
		const readme = readReadme();
		const libText = readScript("_publish-lib.sh");
		const placeholder = libText.match(/^README_SOURCE_PLACEHOLDER='([^']+)'$/mu)?.[1] ?? "";

		expect(placeholder).toBe("<marketplace-source>");
		// One occurrence: publish_readme_source rewrites at most once per line.
		expect(readme.split(placeholder)).toHaveLength(2);
		expect(readme).toContain(`codex plugin marketplace add ${placeholder}`);
	});

	it("passes each target's own marketplace slug", () => {
		expect(readScript("publish-dev.sh")).toContain(
			'publish_git_repo "$DEST" "jolli-plugin-dev/jolli-chatgpt-plugin"',
		);
		expect(readScript("publish-prod.sh")).toContain('publish_git_repo "$DEST" "jolliai/jolli-chatgpt-plugin"');
	});
});

describe("Codex plugin marketplace", () => {
	it("is discoverable at .agents/plugins/marketplace.json", () => {
		const marketplace = readJson(repoRoot, "codex-plugin", ".agents", "plugins", "marketplace.json");
		const plugins = marketplace.plugins as Array<Record<string, unknown>>;
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("jolli");
		expect(plugins[0].source).toBe("./plugins/jolli");
	});
});
