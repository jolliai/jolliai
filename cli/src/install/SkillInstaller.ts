/**
 * Skill Installer
 *
 * Writes one byte-identical SKILL.md per skill into the cross-platform target:
 *
 *   - `<projectDir>/.agents/skills/<name>/SKILL.md`  — the cross-platform
 *     Agent Skills standard, picked up by Codex CLI, Cursor 2.4+, Windsurf,
 *     OpenCode, Gemini CLI, GitHub Copilot.
 *
 * **Claude Code (`.claude/skills/`) is deliberately NOT a write target.** The
 * Claude Code plugin owns Claude Code skills as namespaced `/jolli:*`, so a full
 * `jolli enable` writing unnamespaced `.claude/skills/jolli-*` here would only
 * duplicate them in the `/` menu. The only thing that touches `.claude/skills/`
 * now is the plugin bootstrap ({@link installPluginJolliMenu} writes the bare
 * `/jolli` umbrella; {@link removeClaudeLegacySkills} deletes pre-plugin
 * unnamespaced copies) — see {@link CLAUDE_SKILLS_DIR}.
 *
 * Frontmatter is spec-compliant only (`name`, `description`, `metadata`) —
 * no Claude-private fields (`argument-hint`, `user-invocable`) — so the same
 * file passes `skills-ref validate` and runs on every host.
 *
 * **SECURITY — shell injection defense**: skill templates instruct the host
 * LLM to invoke `jolli recall --arg-stdin` / `jolli search --arg-stdin` and
 * feed the user's argument through a here-doc with a **fresh, LLM-generated
 * 16-char hex delimiter** per invocation. The single-quoted delimiter token
 * (`<<'JOLLI_ARG_<DELIM>_END'`) is POSIX's only here-doc form that suppresses
 * every metacharacter (`$()`, backticks, `${VAR}`, `\`). Per-invocation high-
 * entropy delimiters defeat prompt-injection attempts that pre-compute the
 * delimiter into a payload. Known residual risks (the LLM not following the
 * recipe, a 1-in-2^64 delimiter collision, a host that strips here-docs from
 * the command before execution) are accepted trade-offs of this design.
 *
 * Each skill is upserted **independently** by its content revision
 * (`metadata.revision`). This avoids the trap where a single skill's match
 * short-circuits the whole installer and prevents a newer skill (e.g.
 * `jolli-search`) from ever being installed on projects whose `jolli-recall`
 * is already current.
 *
 * **Cross-tool idempotency — `metadata.revision`.** The write guard keys on a
 * monotonic integer that is DECOUPLED from any tool's release version (npm
 * package version / IntelliJ plugin version) and kept in **lockstep across CLI,
 * VS Code, and IntelliJ** — bumped whenever a skill's body changes. Using a
 * shared, comparable revision (rather than each tool's own version string) is
 * what stops two tools that co-manage the same `SKILL.md` from endlessly
 * rewriting each other's file. Precedence: disk revision greater than ours →
 * skip (a newer tool wrote it, never downgrade); equal → skip (same content by
 * the lockstep contract); less → overwrite (we're newer); absent/unparseable
 * (legacy `jolli-skill-version:` files) → treated as {@link PREHISTORIC_REVISION}
 * so it upgrades once and then converges. A content hash was rejected: it would
 * make churn-freedom depend on byte-identical content across tools, so one stray
 * byte would reignite the rewrite war. **When you change a skill's body, bump its
 * `revision` in ALL THREE implementations in the same change** (same lockstep
 * rule as `parseJolliApiKey`). The Kotlin port lives at
 * `intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/SkillInstaller.kt`.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { createLogger } from "../Logger.js";

const log = createLogger("SkillInstaller");

/**
 * Skill template version — derived from the package version so that every
 * npm release automatically triggers a SKILL.md rewrite on `jolli enable`.
 * Falls back to "dev" in test / non-bundled environments.
 */
/* v8 ignore start -- compile-time ternary: always "dev" in tests */
const SKILL_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
/* v8 ignore stop */

/** Legacy skill directory names from previous versions (v1 and v2) */
const LEGACY_SKILL_DIRS = ["jollimemory-recall", "jolli-memory-recall"];

/**
 * A Skill registration: directory name + template builder. Template content is
 * host-agnostic — the same string is written into every target directory.
 */
interface SkillRegistration {
	readonly name: string;
	readonly build: () => string;
}

/**
 * A target directory family for skill writes.
 *
 * - `host` is a stable identifier used in logs / tests.
 * - `relativeDir` is the path under `<projectDir>` where SKILL.md files live.
 * - `enabled` decides whether to write into this target for the given config.
 *   The one shipped target (`.agents/skills/`) is unconditional today — splitting
 *   it across a per-host detector list (`isCodexInstalled || isGeminiInstalled
 *   || …`) would miss Cursor / OpenCode / Copilot-only users, and the cost is
 *   ~10 KB of SKILL.md files that `.git/info/exclude` keeps out of `git status`.
 *   The `enabled`/config plumbing is retained as an extension point for a future
 *   re-gated target.
 */
export interface SkillTarget {
	readonly host: "agents-std";
	readonly relativeDir: ReadonlyArray<string>;
	readonly enabled: (config: { claudeEnabled?: boolean }) => boolean;
}

/**
 * Where `jolli enable` writes SKILL.md files. Only the cross-platform
 * `.agents/skills/` target ships — Claude Code (`.claude/skills/`) is owned by the
 * plugin now (see the module header and {@link CLAUDE_SKILLS_DIR}), so it is
 * intentionally absent here.
 */
export const SKILL_TARGETS: ReadonlyArray<SkillTarget> = [
	{
		host: "agents-std",
		relativeDir: [".agents", "skills"],
		// Always-on. See SkillTarget JSDoc for the rationale.
		enabled: () => true,
	},
];

/**
 * The Claude Code project-skills dir. No longer a full-`jolli enable` write target
 * (the Claude Code plugin owns `/jolli:*`), but still the slot the plugin bootstrap
 * writes the bare `/jolli` umbrella into ({@link installPluginJolliMenu}), removes
 * it from on uninstall ({@link removePluginJolliMenu}), and cleans legacy
 * unnamespaced CLI-written skills out of ({@link removeClaudeLegacySkills}).
 */
export const CLAUDE_SKILLS_DIR: ReadonlyArray<string> = [".claude", "skills"];

/**
 * Registry of skills installed by `jolli enable`. Adding a new skill is
 * append-only — order in this array determines install order on first run.
 */
const SKILLS: ReadonlyArray<SkillRegistration> = [
	{ name: "jolli-recall", build: buildRecallSkillTemplate },
	{ name: "jolli-search", build: buildSearchSkillTemplate },
	{ name: "jolli-local-run", build: buildLocalRunSkillTemplate },
	{ name: "jolli-remote-run", build: buildRemoteRunSkillTemplate },
	{ name: "jolli", build: buildJolliMenuSkillTemplate },
];

/**
 * Skill directory names Jolli USED to ship but no longer does. On every
 * `jolli enable` these are removed from the write targets so an upgrade doesn't
 * strand a dead skill in the user's repo. Removal is guarded by the Jolli
 * ownership marker (see {@link isJolliOwnedSkill}), so a user's own same-named
 * skill is never deleted. `jolli-pr` was retired once PR authoring moved off a
 * dedicated skill; the `get_pr_description` MCP tool / `pr-description` CLI
 * command that backed it remain.
 */
const REMOVED_SKILL_NAMES: ReadonlyArray<string> = ["jolli-pr"];

/**
 * Skill paths recorded in `.git/info/exclude` so they don't pollute
 * `git status` in user repositories. Derived as {@link SKILLS} × {@link SKILL_TARGETS},
 * so the count tracks those two lists automatically (one entry per skill per target).
 * With `.claude/skills/` gone from {@link SKILL_TARGETS}, this now covers only the
 * `.agents/skills/` entries a full `jolli enable` actually writes — a fresh enable
 * REPLACES the managed block with this set, so any stale `.claude/skills/*` lines a
 * pre-upgrade enable wrote are dropped automatically. Path format follows git's
 * gitignore syntax — leading `/` anchors to the repo root, trailing `/` matches the
 * directory and its contents.
 */
export const SKILL_GIT_EXCLUDE_PATHS: ReadonlyArray<string> = SKILL_TARGETS.flatMap((target) =>
	SKILLS.map((skill) => `/${target.relativeDir.join("/")}/${skill.name}/`),
);

/**
 * Git-exclude path for the bare `/jolli` umbrella that the Claude Code plugin's
 * PluginBootstrapHook writes (Claude Code target only — see
 * {@link installPluginJolliMenu}). Registered by the caller so the generated
 * skill never shows up in the user's `git status`.
 */
export const PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS: ReadonlyArray<string> = ["/.claude/skills/jolli/"];

/**
 * Exclude paths for the bare `/jolli` umbrella that uninstall must drop. The
 * umbrella can land in `.agents/skills/jolli/` (written by a full `jolli enable`
 * for every {@link SKILL_TARGETS} entry) AND in `.claude/skills/jolli/` (written by
 * the plugin bootstrap, {@link PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS}). Since
 * `.claude/skills/` is no longer a {@link SKILL_TARGETS} entry, the Claude-Code line
 * is unioned in explicitly rather than derived. The `jolli-*` sibling entries in the
 * same managed block are intentionally left behind — see {@link removePluginJolliMenu}
 * and the uninstall skill policy.
 */
export const JOLLI_MENU_GIT_EXCLUDE_PATHS: ReadonlyArray<string> = [
	...SKILL_TARGETS.map((target) => `/${target.relativeDir.join("/")}/jolli/`),
	...PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS,
];

/**
 * Installs or updates Jolli skill files. The same byte-identical SKILL.md is
 * written into each enabled target directory under {@link SKILL_TARGETS} — today
 * only the cross-platform `.agents/skills/` target (Claude Code's `.claude/skills/`
 * is owned by the plugin now, see the module header). The `config` argument is
 * retained for the {@link SkillTarget} `enabled` gate extension point.
 *
 * Cleans up legacy directory names from prior versions. Each skill is checked
 * and upserted independently, so installing a new skill (or updating one of
 * several) is not blocked by another skill's version matching the running CLI.
 */
export async function updateSkillsIfNeeded(
	projectDir: string,
	config: { claudeEnabled?: boolean } = {},
): Promise<void> {
	// Clean up legacy skill directories from previous versions. These only
	// ever lived under `.claude/skills/` — `.agents/skills/` is a new target.
	for (const legacyName of LEGACY_SKILL_DIRS) {
		const legacyDir = join(projectDir, ".claude", "skills", legacyName);
		try {
			await rm(legacyDir, { recursive: true, force: true });
			/* v8 ignore start -- defensive: rm with force:true rarely throws */
		} catch {
			// Ignore — directory may not exist or already removed
		}
		/* v8 ignore stop */
	}

	for (const target of SKILL_TARGETS) {
		// The one shipped target (`.agents/skills/`) is unconditional, so this guard
		// never short-circuits today; it is retained as the re-gating extension point.
		/* v8 ignore next -- single always-on target; the disabled branch is unreachable now */
		if (!target.enabled(config)) continue;
		const targetDir = join(projectDir, ...target.relativeDir);
		// Sweep away skills Jolli has retired before writing the current set, so an
		// upgrade doesn't strand a dead skill (e.g. a pre-removal `jolli-pr`) in the
		// user's repo. Marker-guarded so a user's own same-named skill survives.
		for (const name of REMOVED_SKILL_NAMES) {
			await removeRetiredSkill(join(targetDir, name));
		}
		for (const skill of SKILLS) {
			await upsertSkill(targetDir, skill.name, skill.build());
		}
	}
}

/**
 * Deletes a single retired-skill directory, but only when its SKILL.md carries a
 * Jolli ownership marker — so a user's own hand-authored skill of the same name
 * is never removed. A missing directory is a no-op. Fail-soft: a read/remove
 * error is logged and swallowed, never thrown (mirrors {@link removeClaudeLegacySkills}).
 */
async function removeRetiredSkill(skillDir: string): Promise<void> {
	const skillPath = join(skillDir, "SKILL.md");
	let content: string;
	try {
		content = await readFile(skillPath, "utf-8");
	} catch {
		return; // Not present — nothing to remove.
	}
	if (!isJolliOwnedSkill(content)) {
		log.info("Keeping %s — no Jolli ownership marker (user-owned)", skillDir);
		return;
	}
	try {
		await rm(skillDir, { recursive: true, force: true });
		log.info("Removed retired Jolli skill at %s", skillDir);
		/* v8 ignore start -- defensive: rm with force:true rarely throws */
	} catch (error: unknown) {
		log.warn("Failed to remove retired skill at %s: %s", skillDir, (error as Error).message);
	}
	/* v8 ignore stop */
}

/**
 * Backward-compatible alias for callers that still import the old name.
 *
 * Existing installer code calls `updateSkillIfNeeded(projectDir)` (singular).
 * Newly written code should call {@link updateSkillsIfNeeded} (plural). The
 * old name is kept as a thin wrapper to avoid touching every call site in
 * one PR.
 */
export async function updateSkillIfNeeded(projectDir: string, config: { claudeEnabled?: boolean } = {}): Promise<void> {
	return updateSkillsIfNeeded(projectDir, config);
}

/**
 * Writes ONLY the bare `/jolli` umbrella menu into the Claude Code target
 * (`<projectDir>/.claude/skills/jolli/SKILL.md`). Called by the Claude Code
 * plugin bootstrap so a plugin-only user still gets a
 * bare `/jolli` front door: a plugin skill can only ever be invoked as
 * `/jolli:<name>` (Claude Code namespaces plugin skills), so the BARE form has to
 * come from this non-plugin project skill.
 *
 * Written ONLY to the Claude Code target — the umbrella routes to the plugin's
 * own `jolli:*` skills, which the cross-platform `.agents/skills/` hosts (Codex,
 * Cursor, Gemini, Copilot, OpenCode) don't have. Unlike a full `jolli enable`
 * this writes just the umbrella, NOT the unnamespaced `jolli-recall|search`
 * siblings, so the Claude `/` menu shows a single clean `/jolli` alongside the
 * plugin's `/jolli:*`. Fail-soft (delegates to the version-aware upsertSkill).
 */
export async function installPluginJolliMenu(projectDir: string): Promise<void> {
	const skillsDir = join(projectDir, ...CLAUDE_SKILLS_DIR);
	const skillPath = join(skillsDir, "jolli", "SKILL.md");

	// Guard: if a SKILL.md already exists at this path but does NOT carry our
	// vendor marker, it belongs to the user — never overwrite it. Mirrors the
	// symmetric check in removePluginJolliMenu.
	try {
		const existing = await readFile(skillPath, "utf-8");
		if (!existing.includes('vendor: "jolli.ai"')) {
			log.info("Skipping umbrella write — existing %s lacks vendor marker (user-owned)", skillPath);
			return;
		}
	} catch {
		// File doesn't exist — safe to create.
	}

	await upsertSkill(skillsDir, "jolli", buildPluginJolliMenuSkillTemplate());
}

export async function isPluginJolliMenuCanonical(projectDir: string): Promise<boolean> {
	try {
		const skillPath = join(projectDir, ...CLAUDE_SKILLS_DIR, "jolli", "SKILL.md");
		return (await readFile(skillPath, "utf-8")) === buildPluginJolliMenuSkillTemplate();
	} catch {
		return false;
	}
}

/**
 * Removes the bare `/jolli` umbrella menu from `.claude/skills/jolli/` and every
 * {@link SKILL_TARGETS} dir on uninstall.
 *
 * The umbrella is written OUTSIDE the Claude Code plugin (into the user repo's
 * `.claude/skills/jolli/`, and — after a full `jolli enable` — `.agents/skills/
 * jolli/`), because a plugin skill can only ever be invoked as `/jolli:<name>`
 * (see {@link installPluginJolliMenu}). That placement means Claude Code's
 * plugin-manager uninstall never reaches it: without this cleanup the umbrella
 * lingers as a broken menu that routes to `/jolli:*` skills that no longer
 * exist. So a code-driven `jolli uninstall` removes it here.
 *
 * TARGETED exception to the conservative "leave `jolli-*` skills alone" policy:
 * the bare `jolli` dir is unambiguously Jolli's, so it is safe to delete — but
 * only after confirming the on-disk SKILL.md carries our `vendor: "jolli.ai"`
 * marker, so a user's own hand-authored `.claude/skills/jolli/` is never
 * touched. Fail-soft: any per-target read/remove error is logged, never thrown.
 */
export async function removePluginJolliMenu(projectDir: string): Promise<void> {
	// The umbrella can live in `.claude/skills/jolli/` (plugin bootstrap) and in
	// `.agents/skills/jolli/` (a full `jolli enable`). `.claude/skills/` is no longer
	// a SKILL_TARGETS entry, so union it in explicitly.
	const umbrellaDirs = [...SKILL_TARGETS.map((target) => target.relativeDir), CLAUDE_SKILLS_DIR];
	for (const relativeDir of umbrellaDirs) {
		const skillDir = join(projectDir, ...relativeDir, "jolli");
		const skillPath = join(skillDir, "SKILL.md");
		let content: string;
		try {
			content = await readFile(skillPath, "utf-8");
		} catch {
			continue; // No umbrella in this target — nothing to remove.
		}
		// Only remove a menu we generated. A coincidental user skill named `jolli`
		// lacks our vendor marker and is left untouched.
		if (!content.includes('vendor: "jolli.ai"')) continue;
		try {
			await rm(skillDir, { recursive: true, force: true });
			log.info("Removed Jolli umbrella menu at %s", skillDir);
			/* v8 ignore start -- defensive: rm with force:true rarely throws */
		} catch (error: unknown) {
			log.warn("Failed to remove umbrella at %s: %s", skillDir, (error as Error).message);
		}
		/* v8 ignore stop */
	}
}

/**
 * The unnamespaced Claude Code skill dirs a pre-plugin `jolli enable` used to write
 * into `.claude/skills/`. Tracks {@link SKILLS} automatically (minus the bare
 * `jolli` umbrella, which {@link installPluginJolliMenu} overwrites in place rather
 * than deleting), plus the ancient {@link LEGACY_SKILL_DIRS}.
 */
const CLAUDE_LEGACY_SKILL_DIRS: ReadonlyArray<string> = [
	...SKILLS.filter((skill) => skill.name !== "jolli").map((skill) => skill.name),
	...REMOVED_SKILL_NAMES,
	...LEGACY_SKILL_DIRS,
];

/**
 * Deletes the legacy unnamespaced Jolli skills from the Claude Code target
 * (`.claude/skills/jolli-*`). Called by the Claude Code plugin's `enable
 * bootstrap: the plugin ships these as namespaced `/jolli:*`
 * skills, so the CLI-written unnamespaced copies are redundant duplicates in the
 * `/` menu. Only removes a dir whose SKILL.md carries a Jolli ownership marker
 * (modern `vendor` or legacy `jolli-skill-version`) — a user's own hand-authored
 * skill of the same name is never touched (mirrors {@link removePluginJolliMenu}).
 *
 * The bare `/jolli` umbrella is NOT removed here — {@link installPluginJolliMenu}
 * overwrites it in place with the plugin variant (whose revision outranks the
 * standalone menu's), so a pre-upgrade umbrella can never linger pointing at one of
 * the `jolli-*` skills this just deleted. Fail-soft per dir.
 */
export async function removeClaudeLegacySkills(projectDir: string): Promise<void> {
	for (const name of CLAUDE_LEGACY_SKILL_DIRS) {
		const skillDir = join(projectDir, ...CLAUDE_SKILLS_DIR, name);
		const skillPath = join(skillDir, "SKILL.md");
		let content: string;
		try {
			content = await readFile(skillPath, "utf-8");
		} catch {
			continue; // Not present in this repo — nothing to remove.
		}
		// Never delete a user's own same-named skill — it lacks the ownership marker.
		if (!isJolliOwnedSkill(content)) {
			log.info("Keeping %s — no Jolli ownership marker (user-owned)", skillDir);
			continue;
		}
		try {
			await rm(skillDir, { recursive: true, force: true });
			log.info("Removed legacy Jolli skill at %s", skillDir);
			/* v8 ignore start -- defensive: rm with force:true rarely throws */
		} catch (error: unknown) {
			log.warn("Failed to remove legacy skill at %s: %s", skillDir, (error as Error).message);
		}
		/* v8 ignore stop */
	}
}

/**
 * Matches the shared content revision in a SKILL.md frontmatter
 * (`metadata.revision`, a two-space-indented integer). The whole-file match is
 * safe because no shipped skill body contains a `revision:` line, so the first
 * match is the frontmatter's.
 */
const SKILL_REVISION_LINE = /(?:^|\n)[ \t]*revision:\s*(\d+)/;

/**
 * Revision assigned to a SKILL.md that carries no parseable `revision` (a legacy
 * `jolli-skill-version:` file, or a hand-broken frontmatter). Lower than any real
 * revision, so such a file is always upgraded once (then it has a revision and
 * converges).
 */
const PREHISTORIC_REVISION = -1;

/** Parses the shared `metadata.revision` integer, or {@link PREHISTORIC_REVISION} when absent. */
function parseRevision(content: string): number {
	const match = content.match(SKILL_REVISION_LINE);
	const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : PREHISTORIC_REVISION;
}

/**
 * True when an on-disk SKILL.md was written by Jolli (any version) rather than
 * hand-authored by the user. Recognizes both the modern `vendor: "jolli.ai"`
 * metadata and the legacy pre-revision `jolli-skill-version:` frontmatter, so a
 * one-time legacy→revision migration is still allowed while a user's own skill
 * (which carries neither marker) is never overwritten.
 */
function isJolliOwnedSkill(content: string): boolean {
	return content.includes('vendor: "jolli.ai"') || content.includes("jolli-skill-version:");
}

/**
 * Writes one skill's SKILL.md when this tool's revision is newer than what's on
 * disk. Idempotent; never downgrades a file a newer tool wrote. See the module
 * header for the precedence rule.
 */
async function upsertSkill(skillsDir: string, name: string, content: string): Promise<void> {
	const skillDir = join(skillsDir, name);
	const skillPath = join(skillDir, "SKILL.md");

	// "My revision" is the literal baked into the rendered template — the file is
	// the single source of truth, so there is no separate constant to keep in sync.
	const myRevision = parseRevision(content);

	try {
		const existing = await readFile(skillPath, "utf-8");
		// Never overwrite a SKILL.md that carries no Jolli ownership marker — it is
		// the user's own hand-authored skill, not ours (the realistic collision is a
		// user's bare `.claude/skills/jolli/`). A file Jolli wrote is recognizable
		// either by the modern `vendor: "jolli.ai"` metadata or by the legacy
		// pre-revision `jolli-skill-version:` frontmatter; a user's file has neither
		// and — lacking a revision line — would otherwise be clobbered by the
		// downgrade guard below (PREHISTORIC < ours). Mirrors the symmetric guard in
		// installPluginJolliMenu / removePluginJolliMenu (which need only the modern
		// marker; here the legacy marker is also honored so a one-time legacy→revision
		// migration of `jolli-recall` etc. still reaches existing installs).
		if (!isJolliOwnedSkill(existing)) {
			log.info("Skipping %s SKILL.md — no Jolli ownership marker (user-owned)", name);
			return;
		}
		if (parseRevision(existing) >= myRevision) {
			// Equal → same content by contract; greater → a newer tool wrote it.
			// Either way, leave it untouched (never downgrade).
			return;
		}
	} catch {
		// File doesn't exist — will create
	}

	try {
		await mkdir(skillDir, { recursive: true });
		await atomicWriteFile(skillPath, content);
		log.info("Wrote SKILL.md (revision %d) to %s", myRevision, skillPath);
		/* v8 ignore start - defensive: mkdir/writeFile failure on read-only filesystem */
	} catch (error: unknown) {
		log.warn("Failed to write %s SKILL.md: %s", name, (error as Error).message);
	}
	/* v8 ignore stop */
}

// ─── Skill Templates ────────────────────────────────────────────────────────

/**
 * The Windows shell-prerequisite block shared by every shell-backed skill. It
 * pins Git Bash on Windows because the `run-cli` entry script is written via
 * Windows Node's `os.homedir()` to `%USERPROFILE%\\.jolli\\jollimemory\\run-cli`,
 * and only Git Bash's `$HOME` aligns with `%USERPROFILE%` — PowerShell / WSL bash
 * see a different home and won't find the script. Reused verbatim by both the
 * arg-carrying here-doc skills ({@link heredocInvocation}) and the local-run
 * recipe (fixed `run-cli` subcommands, no here-doc), so the guidance lives in one
 * place instead of drifting per skill.
 */
const SHELL_PREREQUISITE_BLOCK = `### Shell prerequisite

This block requires a POSIX bash shell. On Linux/macOS the system bash works.
**On Windows, use Git Bash** (the bash bundled with Git for Windows). Other
Windows "bash" options — \`C:\\Windows\\System32\\bash.exe\`, the WindowsApps
alias, or any WSL bash — see a separate Linux home directory and will not
find the Jolli entry script that lives under \`%USERPROFILE%\`.

If Git Bash is not available on Windows, STOP and tell the user:
"Jolli skill needs Git Bash on Windows. Install Git for Windows from
https://git-scm.com/download/win and retry."

Do NOT fall back to \`npm run\`, \`npx\`, \`node\` directly, PowerShell-native
commands, WSL bash, or any workspace-local script — those bypass the
security recipe and the dist resolver and will not produce valid output.`;

/**
 * Shared Step-1 preamble — instructs the LLM to invoke the CLI via a here-doc
 * with a freshly-generated 16-char hex delimiter, and to STOP if the host
 * can't support that recipe rather than fall back to an `argv` interpolation
 * that would re-open the shell-injection door.
 *
 * Also pins the shell choice on Windows: Git Bash, not WSL bash and not
 * PowerShell. The Jolli entry script is written via Windows Node's
 * `os.homedir()` to `%USERPROFILE%\\.jolli\\jollimemory\\run-cli`. Only Git
 * Bash's `$HOME` aligns with `%USERPROFILE%`; WSL bash sees a separate Linux
 * home and would miss the script even when it is correctly installed.
 *
 * The literal `<DELIM>` placeholder is intentional: the LLM is the one that
 * generates the random value each invocation, which is what makes pre-computed
 * prompt-injection payloads useless.
 */
function heredocInvocation(subcommand: "recall" | "search", flagSuffix: string): string {
	return `${SHELL_PREREQUISITE_BLOCK}

### Invocation

Generate a fresh random 16-character hex string (the "delimiter token") for
this invocation — e.g. \`3f8a9b2c5d7e1f4a\`. Quickly scan the user's argument:
if the argument text contains a line that is exactly \`JOLLI_ARG_<delimiter
token>_END\`, regenerate the delimiter token and re-check.

Then run this Bash, replacing the two \`<DELIM>\` occurrences with your
delimiter token and replacing \`<user-arg>\` with the user's input verbatim:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" ${subcommand} --arg-stdin${flagSuffix} <<'JOLLI_ARG_<DELIM>_END'
<user-arg>
JOLLI_ARG_<DELIM>_END
\`\`\`

If you cannot follow the above structure (e.g., your environment doesn't
support here-docs), STOP and tell the user "Jolli skill cannot run safely
in this environment." DO NOT attempt to interpolate the argument into argv
or any double-quoted shell string — that path has a known shell injection
vector.`;
}

/**
 * Recall skill template — describes the multi-step recall workflow to the
 * host LLM. Byte-identical across every {@link SKILL_TARGETS} entry, so the
 * file passes `skills-ref validate` and works on Claude Code, Codex, Cursor,
 * Windsurf, OpenCode, and Gemini without per-host divergence.
 */
export function buildRecallSkillTemplate(): string {
	return `---
name: jolli-recall
description: Recall prior development context from Jolli for the current branch. Use when the user wants to recall, remember, or resume prior work on a branch.
metadata:
  version: "${SKILL_VERSION}"
  revision: 1
  vendor: "jolli.ai"
---

# Jolli Recall

> Every commit deserves a Memory. Every memory deserves a Recall.

Load the structured development context for a branch — commits with their
distilled topics (trigger / response / decisions / files), plus any plans
and notes that the work referenced. Synthesize a grounded answer to the
user's prompt about that branch.

## Step 1: Load the recall result

\`<user-arg>\` is a branch name (exact or fragment) or empty (current branch).

### Preferred: MCP tool

If \`mcp__jollimemory__recall\` is available, call it with \`{ "branch": "<user-arg>" }\`
(omit \`branch\` when \`<user-arg>\` is empty). It returns a \`type\`-tagged object —
\`recall\` / \`catalog\` / \`error\` — identical to the CLI fallback below.

### Fallback: CLI here-doc

If no such tool is available, use:

${heredocInvocation("recall", " --format json")}

If \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\` or install the Jolli VS Code extension."
Do not attempt further processing.

Both the MCP tool and the CLI fallback return the same \`type\`-tagged union.
Handle the result using Step 2 regardless of which path was used.

## Step 2: Handle the result by \`type\`

The result (from either the MCP tool or the CLI) is a \`type\`-tagged object:

- \`type:"recall"\` → render Part A + Part B below.
- \`type:"catalog"\` → semantic-match \`<user-arg>\` against \`branches[].branch\` /
  \`commitMessages\` / \`topicTitles\`. One match → repeat Step 1 with that branch.
  Many → list and ask. None → show catalog, ask to clarify.
- \`type:"error"\` → surface \`message\` verbatim (translated); for "no records",
  suggest \`jolli enable\`. Never fabricate.

### type: "recall" — full payload returned

You have a \`RecallPayload\` with these fields:

- \`branch\`, \`period: { start, end }\`, \`commitCount\`, \`totalFilesChanged\`,
  \`totalInsertions\`, \`totalDeletions\` — branch-level facts.
- \`commits[]\` — per-commit projection. Each carries:
  - identity (always present): \`hash\` (8-char display), \`fullHash\`, \`branch\`,
    \`commitDate\`, \`commitAuthor\`, \`commitMessage\`; optional \`commitType?\`,
    \`ticketId?\`.
  - \`diffStats?\` — \`{ filesChanged, insertions, deletions }\`.
  - \`recap?\` — 1-3 paragraphs of plain-English narrative.
  - \`topics[]\` — each with **always present**: \`title\`, **\`decisions\` (★)**;
    **may be absent**: \`trigger?\`, \`response?\`, \`todo?\`, \`filesAffected?\`,
    \`category?\`, \`importance?\`. Trimming rules differ by field:
    - \`response\` is **policy-trimmed unconditionally** when the branch
      ships more than 8 kept commits — raising \`--budget\` will not bring
      it back. Additionally, on tight budgets it may be dropped
      oldest-first on shorter branches.
    - \`trigger\` is only dropped by \`--budget\` (oldest-first); raising
      \`--budget\` can restore it.
    - \`decisions\` is never dropped from a kept commit (if the budget
      can't fit it, the whole commit is omitted from \`commits[]\`).
  - \`plans?\` — \`{ slug, title }[]\` refs only; \`slug\` is the **normalized
    base slug** that always resolves to an entry in payload-level \`plans\`.
  - \`notes?\` — \`{ id, title }[]\` refs only; \`id\` always resolves to an
    entry in payload-level \`notes\`. (Notes use \`id\`, not \`slug\` — they
    have no archive-suffix mechanism.)
- \`plans[]\` — branch-deduplicated plan bodies: \`{ slug, title, content? }\`.
  \`content\` may be absent under tight budget — when absent, the entry is
  still a valid grounding anchor but you can't quote from it.
- \`notes[]\` — same shape and trimming rule as plans.
- \`stats\`, \`estimatedTokens\`, \`truncated?\`.

Render in two parts (in order):

#### Part A — Forced fact opener (no paraphrase, no interpretation)

Render the loaded confirmation as a heading + bullet block (not a prose
line). **Facts only — do not interpret what the branch is "about" here.**
The mandated shape:

\`\`\`markdown
### Loaded \`feature/auth\`

- **Period:** 2026-04-10 → 2026-04-15 (5 days)
- **Commits:** 8 (+312 −89, 24 files)
- **Captured:** 12 topics, 5 key decisions, 2 plans, 3 notes
\`\`\`

The heading + bullet shape is required — a single prose line blends into
the synthesis below and the user loses the visual anchor for verification.
Save interpretation for Part B.

#### Part B — Free-form synthesis

Pick whatever shape best serves the user's prompt: prose narrative,
chronological timeline, decision-focused bullet list, per-theme
\`###\` sections, side-by-side comparison, mixed. When multiple
distinct themes emerge across the commits, prefer \`###\` per theme —
inline-bold paragraph prefixes blend into a wall under markdown
rendering. The principles below are the only constraints.

#### Universal principles (apply regardless of shape)

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..."
   preamble.

2. **Ground every concrete claim** to a hash and/or file. Use \`(abc12345)\`
   for hashes and \`[middleware/auth.ts](middleware/auth.ts)\` for files.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored
   data.** Read everything; fold into coherent prose or bullets.
   Whenever a phrase from \`decisions\` / \`recap\` / \`plans[].content\` /
   \`notes[].content\` captures the answer more compactly than your
   paraphrase, quote it verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word
   fragments that depend on your surrounding paraphrase to mean
   anything. The reader should be able to skim the bold quote alone
   and understand its claim. Format, embedded in narrative:

   *The design chose JWT because* **"the stateless model lets us scale
   horizontally without a shared session store across regions"**
   *(decisions, abc12345)*; *per the auth-redesign plan,* **"all session
   tokens must be opaque, with no client-readable claims, so rotation
   never breaks the API"** *(plan: auth-redesign)*.

   **Bold = verbatim from stored data.** Never use bold for general
   emphasis. Quotes belong inside running prose or bullets that carry
   their own narrative — never as bare bullets stripped of context.
   Stringing bare quotes is the wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible
   output matches the user.

5. **Don't expose machinery.** No "RecallPayload" / "commits array" /
   "JSON field" / "SearchHit" mentions.

6. **Brief by default — synthesize, don't dump every commit.** Skip
   routine commits and merge overlapping themes; aim for ~500 words
   on a typical branch, but favor section structure over compression.
   Never collapse \`###\` themes into inline-bold paragraph prefixes
   just to hit a word count — that produces a wall and defeats the
   structure's purpose. Branches with many distinct themes may
   legitimately run longer; a "deep dive" on a specific theme is
   opt-in.

#### Plan / note stubs on commits

When a commit carries \`plans?\` / \`notes?\` stubs, use the stub title as a
grounding anchor for narrative ("the auth-redesign plan guides this work").

**To quote from a plan or note body**, look up the matching entry in the
top-level \`plans\` / \`notes\` array by its \`slug\` (plans) or \`id\` (notes):

- If the entry has \`content\`: quote verbatim with \`(plan: <slug>)\` /
  \`(note: <id>)\` attribution if relevant to the user's prompt.
- If \`content\` is absent (budget trimming dropped the body): use **only**
  the title as a citation anchor — never fabricate a quote from a body
  you cannot see.

#### Empty / partial handling

- Empty \`commits\`: tell the user no records were found; suggest running
  \`jolli enable\` if they expected records.
- \`truncated: true\`: policy trims or budget enforcement dropped fields
  or commits. Policy trims drop \`importance: "minor"\` topics (and any
  commit whose every topic is minor) and drop \`topic.response\` when the
  branch ships more than 8 commits; budget trims drop oldest-first
  \`response\` / \`trigger\` / plan / note content. Mention it with a
  one-liner if the user asks for deeper detail; otherwise stay silent.

### type: "catalog" — branch lookup needed

Returned when no exact branch match was found. Has a \`branches[]\` array
with \`branch\`, \`commitCount\`, \`period\`, \`commitMessages\`, \`topicTitles?\`.
If a \`query\` field is present, semantic-match the user's input against
\`branch\`, \`commitMessages\`, and \`topicTitles\` (the highest-signal source);
support cross-language matching and time-relative queries.

- One match: re-run Step 1 with the chosen branch as the user-arg and
  continue from Step 2.
- Multiple matches: list candidates, ask user to choose.
- No matches: show the catalog, ask user to clarify.

### type: "error" — CLI returned a hard error

Has a \`message\` string. Common cases:

- Branch matched but its summaries failed to load.
- No records in the repo at all.
- Invalid argument or internal failure.

Surface the message verbatim to the user (translated into their language if
non-English). For "no records in this repo" specifically, suggest running
\`jolli enable\` if they expected records. Do NOT retry or fabricate a recall
payload from nothing.
`;
}

/**
 * Search skill template — describes the single-phase lightweight BM25 search
 * workflow to the host LLM. Byte-identical across every {@link SKILL_TARGETS}
 * entry, same spec-compliant frontmatter as recall.
 *
 * Preferred path: call \`mcp__jollimemory__search\` directly (returns lightweight
 * \`{ hits }\` — no two-phase catalog/detail load). Fallback: CLI here-doc with
 * the same \`{ hits }\` envelope.
 */
export function buildSearchSkillTemplate(): string {
	return `---
name: jolli-search
description: Search structured commit memories across all branches — decisions, topics, files. Use when the user wants to find prior decisions, related commits, or how a topic was handled before.
metadata:
  version: "${SKILL_VERSION}"
  revision: 1
  vendor: "jolli.ai"
---

# Jolli Search

Search structured commit memories across every branch in this repo.
Lightweight BM25 index returns relevance-ranked hits — no two-phase catalog
scan required. For full context of a known branch, use jolli-recall instead.

## When to use

- "Has anyone dealt with X before?" / "How have we handled Y previously?"
- Looking for a past decision: "why did we choose X over Y?"
- Finding the commit related to a half-remembered ticket / file / topic.

## When NOT to use

- Need full context of a known branch → run jolli-recall.
- Looking at the current code → grep / read files directly.
- Need deep rationale/decisions for a specific branch → run jolli-recall on
  that branch (search hits are lightweight; full decisions live in recall).

## Step 1: Parse the query

Extract the natural-language query (any language). Optional: \`limit\` (integer,
default 20). Note: time/budget filters (\`--since\`, \`--budget\`) are not supported
on the search path — point users at jolli-recall for a full branch when they
need depth.

## Step 2: Get hits

### Preferred: MCP tool

If \`mcp__jollimemory__search\` is available, call it with:

\`\`\`json
{ "query": "<query>", "limit": 20 }
\`\`\`

Returns \`{ "hits": [ { type, title, snippet, branch, commitDate, slug, hash, score } ] }\`,
relevance-ranked (BM25). Proceed to Step 3 with these hits.

### Fallback: CLI here-doc

If no such tool is available, use:

${heredocInvocation("search", " --format json")}

The CLI returns the same \`{ hits }\` envelope as the MCP tool.

**Failure handling**:
- If \`~/.jolli/jollimemory/run-cli\` does not exist: tell the user
  "Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\`
  or install the Jolli VS Code extension." Do not attempt further processing.
- If the command output starts with \`error:\` or contains \`unknown command 'search'\`:
  the installed CLI is older than this skill. Tell the user
  "Your installed Jolli CLI is older than this skill — please run
  \`npm update -g @jolli.ai/cli\` (or update your VS Code extension), then retry."
  Do not attempt further processing.

Both paths produce the same \`{ hits }\` shape. Proceed to Step 3 regardless of
which path was used.

## Step 3: Render

\`hits\` are lightweight — no full decisions/recap per hit. For each relevant
hit you have:

- \`type\` — \`"commit"\` or \`"topic"\`
- \`title\` — one-sentence label
- \`snippet\` — short excerpt from the matching content
- \`branch\` — branch the hit belongs to
- \`commitDate\` — ISO 8601 date
- \`slug\` — human-readable identifier (for topics)
- \`hash\` — 8-char short SHA (for commits)
- \`score\` — BM25 relevance score (internal; do not expose to the user)

**Universal principles** (apply regardless of shape):

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..." preamble.

2. **Ground every concrete claim** to its \`hash\` (commit hits) or \`slug\` +
   \`branch\` (topic hits). Use \`(abc12345)\` for hashes.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored data.**
   Read everything; fold into coherent prose or bullets. Whenever a phrase from
   \`snippet\` captures the answer more compactly than your paraphrase, quote it
   verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word fragments
   that depend on your surrounding paraphrase to mean anything. The reader
   should be able to skim the bold quote alone and understand its claim.
   Format, embedded in narrative: *the design chose JWT because*
   **"the stateless model lets us scale horizontally without a shared session store across regions"**
   *(snippet, abc12345)*.

   **Bold = verbatim from stored data.** Never use bold for general emphasis.
   Quotes belong inside running prose or bullets that carry their own narrative
   — never as bare bullets stripped of context. Stringing bare quotes is the
   wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible output
   matches the user.

5. **Don't expose machinery.** No "BM25" / "SearchHit" / "hits array" / "score"
   mentions. Don't expose \`slug\` or internal field names either.

6. **Output shape is entirely your call.** Prose, compact list, timeline,
   per-theme sections — pick whatever serves the query. Every concrete claim
   must be groundable to a hash or branch.

7. **If the user needs the full decisions/rationale behind a hit**, tell them
   to run jolli-recall on that hit's \`branch\`.

**Empty hits** → tell the user nothing matched; suggest broader keywords or a
different phrasing. Do NOT mention BM25 or index internals.
`;
}

/**
 * Local-workflow-run recipe skill — walks the calling agent through running a
 * Jolli workflow locally: discover the runnable workflows via the eligibility CLI
 * helper, start the run and drive the destination clone through the `docs`
 * (space-cli) commands, gate on a human review with lease heartbeats bracketing
 * the blocking approval, then publish + complete (or abandon). Prefers the Jolli
 * MCP platform tools for the run lifecycle; the eligibility check and the git
 * operations go through the `jolli` CLI (run-cli entry script), matching the
 * sibling skills. Byte-identical across every {@link SKILL_TARGETS} entry,
 * spec-compliant frontmatter only.
 */
export function buildLocalRunSkillTemplate(): string {
	return `---
name: jolli-local-run
description: Run a Jolli workflow locally — your own agent executes the workflow's recipe (no Jolli LLM budget) and its file writes land in a git-backed Jolli Space via a branch and pull request that space-cli opens on this machine. Use when the user wants to run a Jolli workflow locally.
metadata:
  version: "${SKILL_VERSION}"
  revision: 5
  vendor: "jolli.ai"
---

# Jolli Local Run

Run a Jolli **workflow** locally: *your* agent executes the workflow's recipe on
this machine (so it spends no Jolli LLM budget), Jolli supplies the recipe and
tracks the run, and the workflow's file writes are published to a git-backed
Jolli Space through an agent branch + pull request that space-cli commits and
pushes locally.

A workflow can be run locally only when its destination Space is **git-backed**
AND already **cloned** on this machine. Before starting, the user is told whether
the resulting PR will **auto-merge** or **open for team review**.

Drive the steps below in order. Prefer the Jolli MCP tools for the run lifecycle;
the eligibility check and the git operations go through the \`jolli\` CLI (via the
run-cli entry script the sibling skills also use).

${SHELL_PREREQUISITE_BLOCK}

## Step 1 — discover the runnable workflows

Run the eligibility helper and read its JSON:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" workflow local-run
\`\`\`

- \`{ "type": "workflows", "workflows": [ { "id": 7, "name": "Impact Analysis", "autoMerges": true|false }, ... ] }\`
  — the workflows runnable right now. **Offer only these.** Present each one to
  the user by its \`name\` (fall back to the \`id\` when \`name\` is absent), and tell
  them up front whether it will **auto-merge** the PR (\`autoMerges: true\`) or
  **open the PR for team review** (\`autoMerges: false\`). If the array is empty,
  tell the user there are no locally-runnable workflows (a workflow's destination
  must be a git-backed, already-cloned Space) and stop.
- \`{ "type": "workflow_cli_required", "installHint": "..." }\` — the workflow-cli
  plugin is missing. Tell the user to install it (run the \`installHint\`) and stop:

  \`\`\`bash
  npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
  \`\`\`

- \`{ "type": "space_cli_required", ... }\` — the space-cli plugin is missing. Tell
  the user to install it and stop:

  \`\`\`bash
  npm i -g @jolli.ai/cli @jolli.ai/space-cli
  \`\`\`

- \`{ "type": "error", "message": "..." }\` — report the message and stop.

Have the user pick one workflow — list them by \`name\` (use your host's
interactive single-select tool if it has one — e.g. AskUserQuestion on Claude
Code — otherwise list them as text). Keep the chosen workflow's \`id\` for Step 2.

## Step 2 — start the run

Call the \`start_local_run\` tool (on Claude Code
\`mcp__jollimemory__start_local_run\`) with the chosen workflow's id, passed
**exactly as the helper returned it** — the backend's id is a number, so it stays
an unquoted number: \`{ "id": <workflow id> }\` (a string id/slug stays quoted).
Capture from its result:

- \`runId\` — the run handle for every later call.
- \`plan\` — the recipe steps your agent will execute.
- \`writeTarget\` — carries the server-derived \`workBranch\`, the destination Space,
  and the destination folder. Refer to the destination in user-facing prose by its
  **Space name / folder** only. Do **not** announce a backing repo \`owner/name\`, and
  do **not** present the \`workBranch\` as "the write target" — those are internal
  plumbing, not the destination's identity. The \`workBranch\` is passed verbatim to
  \`docs pull --branch\` in Step 3, but keep it framed as an internal detail. Do not
  inspect the clone's git remotes to name the destination. \`writeTarget.repo\` may be
  **empty** for a private Jolli-managed destination — that is normal, never an error,
  and never something to look up or narrate.

## Step 3 — check out the agent branch

Pull the destination clone onto the server-derived work branch:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" docs pull --branch <writeTarget.workBranch>
\`\`\`

**Always \`--branch\`. NEVER \`--agent\`.** The \`--agent\` mode runs a destructive
\`git clean -fdx\` that wipes untracked files; \`--branch\` checks out the
server-derived branch without cleaning. Do not substitute \`--agent\` under any
circumstances. \`docs pull\` fetches the destination write token internally — you
do **not** fetch or handle any token yourself.

## Step 4 — write the workflow's output

Execute the workflow's \`plan\` from Step 2, writing the output files under the
destination folder from \`writeTarget\`, inside the checked-out clone.

## Step 5 — local review gate (with heartbeats)

Nothing is committed or pushed until the human explicitly approves.

1. Send a heartbeat so the run's lease stays alive while the human reviews: call
   \`report_local_run_progress\` (on Claude Code
   \`mcp__jollimemory__report_local_run_progress\`) with \`{ "runId": "<runId>" }\`.
2. Show the working-tree diff of what the workflow wrote, and ask the user to
   review, edit if needed, and **explicitly approve** (or cancel).
3. When the user answers, send \`report_local_run_progress\` again.

Send the heartbeat **immediately before** asking and **immediately after** the
answer. Your turn is blocked while you wait for the human, so you cannot
heartbeat *during* the review — bracketing the approval prompt keeps the lease
fresh across the wait.

## Step 6 — on approval: publish and complete

1. Publish the branch as a pull request and capture the machine-readable result:

   \`\`\`bash
   "$HOME/.jolli/jollimemory/run-cli" docs publish --json
   \`\`\`

   \`--json\` prints exactly one JSON object on stdout (all human-readable progress
   goes to stderr) — parse that object; never scrape the human log for a PR number.
2. Verify the pull request landed on the server-derived work branch. \`docs publish\`
   reports the branch the PR was actually opened on as \`headBranch\` (present on both
   the public and the private/withheld paths); the run's server work branch is
   \`writeTarget.workBranch\` from Step 2. **When \`pushed\` is true, cross-check them
   deterministically** — do not eyeball it yourself:

   \`\`\`bash
   "$HOME/.jolli/jollimemory/run-cli" space verify-publish-branch <writeTarget.workBranch> <headBranch>
   \`\`\`

   It prints \`{ "match": true|false, "expected": "...", "actual": "..." }\` and exits
   non-zero when the branches differ or \`headBranch\` is missing. **If \`match\` is
   false, STOP** — the PR was opened on the wrong branch (usually because \`docs pull
   --branch <workBranch>\` in Step 3 was skipped, so space-cli generated its own
   \`jolli-<hex>\` branch). The backend cannot link the run to that PR, so it will
   **not** auto-merge and the articles will **never** publish. Tell the user the
   run-to-PR link is broken (published on \`<actual>\` instead of the expected
   \`<expected>\`) and **do NOT call \`complete_local_run\` as if the run succeeded** —
   release the run with \`abandon_local_run\` (Step 7) or ask the user how to proceed.
   Skip this check only when \`pushed\` is false (nothing was published).
3. Call \`complete_local_run\` (on Claude Code
   \`mcp__jollimemory__complete_local_run\`), branching on what the publish JSON
   contained:
   - **PR refs present** (the JSON has a \`prNumber\` — a user-accessible
     destination): pass them through —
     \`{ "runId": "<runId>", "prNumber": <prNumber>, "prUrl": "<prUrl>" }\`.
   - **PR refs withheld** (the JSON is \`"private": true\` with no \`prNumber\` — a
     private Jolli-managed destination whose backing repo the user cannot access):
     complete WITHOUT a PR reference — \`{ "runId": "<runId>" }\`. Do not invent,
     guess, or look up a \`prNumber\`; the run already knows its destination is private.
   - **Nothing published** (\`"pushed": false\`, e.g. \`"reason": "no-changes"\`): no PR
     was opened, so there is nothing to complete — tell the user the workflow produced
     no changes and release the run with \`abandon_local_run\` (Step 7).
4. Read the outcome and its links off \`complete_local_run\`'s result and report them.
   Every URL is read **verbatim** off the result — never construct, guess, or look up
   one. The result carries \`willAutoMerge\`, \`workflowUrl\`, \`runUrl\`, and (auto-apply
   ON only) a \`writtenArticles\` list of \`{ operation, path, url, active, ... }\`.
   - **Auto-apply on** (\`willAutoMerge: true\`): the destination auto-applies, so the PR
     is **set to auto-merge** and — once it does — the created/edited **articles are the
     artifact**. Treat \`willAutoMerge: true\` as the destination's *intent*, NOT a
     confirmation that the merge already completed — so do **not** flatly tell the user
     "PR auto-merged". Report what actually published, judged by each article's own state:
     for every \`writtenArticles\` entry that is still openable (\`active: true\` **and** a
     non-null \`url\`), present its URL as a published article. If an article is
     \`active: false\` or has \`url: null\`, publishing has **not** completed yet (the
     auto-merge and reindex may still be in progress) — tell the user that article is
     **not yet available**, never invent a URL, and note they can re-check shortly via the
     run URL or by re-running \`workflow run-status <runId>\`. Then present the workflow URL
     (\`workflowUrl\`) and the run URL (\`runUrl\`).
   - **PR left open for team review** (\`willAutoMerge: false\` — auto-apply off): the
     open **PR is the artifact**. Tell the user "PR left open for team review" and
     present the PR URL (\`prUrl\`), the workflow URL (\`workflowUrl\`), and the run URL
     (\`runUrl\`).
   - **Private Jolli-managed destination** (the result carries no \`prUrl\`): present the
     **article URLs only** (same \`active: true\` + non-null \`url\` rule) plus the workflow
     URL and run URL — never surface a repo or PR link the result did not carry. As with
     any auto-apply run, an article that is not yet \`active\` / lacks a \`url\` is **not yet
     available** (publishing still completing), not an error — say it will appear once
     published and offer the run URL to re-check.
5. Offer to open any reported URL in the user's default browser. For each URL the user
   chooses, shell:

   \`\`\`bash
   "$HOME/.jolli/jollimemory/run-cli" open-url <url>
   \`\`\`

   It prints one JSON line \`{ "opened": true|false, "url": "..." }\`. When \`opened\` is
   \`false\` (headless / no browser available) the URL is printed for the user to copy
   instead — that is normal, not a failure. Only \`https\` URLs are accepted. A URL
   whose origin is off Jolli's allowlist is refused (never launched) and printed
   instead — the result carries \`"refused": true\`; surface that URL for the user to
   open manually, not as an error.

## Step 7 — on cancel: abandon

If the user cancels at the review gate (or you must abort), release the run: call
\`abandon_local_run\` (on Claude Code \`mcp__jollimemory__abandon_local_run\`) with
\`{ "runId": "<runId>" }\`.

## If space-cli is missing at any point

Any \`docs\` command that prints an install hint (or the eligibility helper's
\`space_cli_required\` result) means the space-cli plugin is not installed. Tell the
user to install it and stop:

\`\`\`bash
npm i -g @jolli.ai/cli @jolli.ai/space-cli
\`\`\`
`;
}

/**
 * Remote-workflow-run recipe skill — walks the calling agent through running a
 * Jolli workflow on the Jolli backend: identify the workflow, trigger the run via
 * the `run_remote_workflow` platform tool, then shell the deterministic
 * `workflow run-status` monitor (host code polls to a terminal state) and report
 * the outcome — failed (troubleshooting + workflow URL), cancelled (who/when +
 * workflow URL), or succeeded (still-active article URLs + workflow URL) — and
 * offer to open any reported URL. Prefers the Jolli MCP platform tools for the run
 * lifecycle (there is no CLI mirror for them); the monitor and the browser-open
 * primitive go through the `jolli` CLI (run-cli entry script). Byte-identical
 * across every {@link SKILL_TARGETS} entry, spec-compliant frontmatter only.
 */
export function buildRemoteRunSkillTemplate(): string {
	return `---
name: jolli-remote-run
description: Run a Jolli workflow remotely — the Jolli backend executes the workflow server-side; this recipe triggers the run, monitors it to completion, reports the outcome (failed / cancelled / succeeded) with its article, PR, and workflow links, and offers to open any in your browser. Use when the user wants to run a Jolli workflow remotely (on the Jolli backend).
metadata:
  version: "${SKILL_VERSION}"
  revision: 4
  vendor: "jolli.ai"
---

# Jolli Remote Run

Run a Jolli **workflow** remotely: the Jolli backend executes the workflow
server-side (it spends Jolli LLM budget, unlike a local run), and this recipe
triggers the run, monitors it to a terminal state, and reports what it produced —
the still-active article URLs, the pull-request URL when the destination is
git-backed, and the workflow/run deep-links — then offers to open any of them.

Drive the steps below in order. Prefer the Jolli MCP tools for the run lifecycle —
the run tools (\`run_remote_workflow\`, \`cancel_remote_workflow\`) have **no CLI
mirror** — and shell the \`jolli\` CLI (via the run-cli entry script the sibling
skills also use) only for the deterministic monitor and the browser-open helper.

Every URL is read **verbatim** off the run report — never construct, guess, or
look one up. A link that is not in the report was withheld on purpose (for
example, a private Jolli-managed destination omits the PR link but keeps the
article URLs); treat its absence as normal, never an error.

${SHELL_PREREQUISITE_BLOCK}

## Step 1 — identify the workflow to run

Determine which workflow the user wants to run and keep its numeric \`id\`.

- If the \`list_workflows\` tool is registered this session (on Claude Code
  \`mcp__jollimemory__list_workflows\`), call it to list the available workflows and
  present them to the user by \`name\` (use your host's interactive single-select
  tool if it has one — e.g. AskUserQuestion on Claude Code — otherwise list them as
  text). Keep the chosen workflow's \`id\`.
- Otherwise, ask the user which workflow to run and get its numeric \`id\`.

## Step 2 — confirm the run monitor is installed (before triggering)

The run trigger (\`run_remote_workflow\`) is a Jolli **backend** tool: it creates a
real, budget-spending run **even when the deterministic monitor is not installed**.
The monitor (\`workflow run-status\`, Step 4) is provided by the
\`@jolli.ai/workflow-cli\` plugin. So confirm that plugin is present **before**
triggering — otherwise a missing monitor would leave the run you are about to
create orphaned (still running server-side, with no way for this recipe to report
its outcome).

Run the plugin's eligibility helper purely as a presence probe and read its JSON:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" workflow local-run
\`\`\`

- \`{ "type": "workflow_cli_required", "installHint": "..." }\` — the workflow-cli
  plugin is **not installed**. Do **not** trigger the run. Tell the user to install
  it (run the \`installHint\`) and stop:

  \`\`\`bash
  npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
  \`\`\`

- **any other result** (\`workflows\`, \`space_cli_required\`, or \`error\`) — the plugin
  **is** installed (only its stub ever emits \`workflow_cli_required\`), so the monitor
  is available. Ignore the rest of this probe's output — it reports *local*-run
  eligibility, which does not gate a remote run — and proceed to Step 3.

## Step 3 — trigger the remote run

Call the \`run_remote_workflow\` tool (on Claude Code
\`mcp__jollimemory__run_remote_workflow\`) with the chosen workflow's id, passed as
an **unquoted number**: \`{ "id": <workflow id> }\` (add \`templateVariables\` only if
the workflow needs them). Capture \`runId\` from its result (\`{ "runId": "..." }\`) —
that handle drives the monitor in Step 4.

## Step 4 — monitor the run to completion

Shell the deterministic monitor with the captured \`runId\`:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" workflow run-status <runId>
\`\`\`

It polls the run to a terminal state (with backoff, so you do not drive the poll
loop yourself) and prints exactly one JSON line — the run report. Parse it:

- \`status\` — one of \`"succeeded"\`, \`"failed"\`, \`"cancelled"\`, \`"running"\`.
- \`openableUrls\` — an array of \`{ "kind": "workflow" | "run" | "article" | "pr", "url": "...", "label": "..." }\`.
  Only openable URLs appear here (active articles with a non-null url, a PR only
  when the payload carried one) — present exactly these, nothing more.
- \`cancel\` (cancelled runs) — \`{ "by": "...", "at": "..." }\` when known.
- \`troubleshooting\` (failed runs) — the actionable error detail.
- \`timedOut\` — \`true\` when the monitor stopped polling before the run reached a
  terminal state (see the "still running" case below).

If the command instead prints \`{ "type": "error", "message": "..." }\` (the run
could not be reached — platform tools off, or a transport failure), tell the user
the run status could not be retrieved and stop. That is a degraded outcome, not a
crash — the run may still be progressing server-side.

If instead the command exits non-zero and prints a prose install hint naming
\`@jolli.ai/workflow-cli\` (rather than a JSON report line), the workflow-cli plugin
is not installed. Tell the user to install it and stop:

\`\`\`bash
npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
\`\`\`

## Step 5 — report the outcome

Report based on \`status\`:

- **succeeded** (\`status: "succeeded"\`): the run finished. Present the \`article\`
  URLs from \`openableUrls\` (each by its \`label\`), the \`pr\` URL if one is present,
  and the \`workflow\` and \`run\` deep-links. Never surface a link that is not in
  \`openableUrls\` — a missing PR link means the destination withheld it (a private
  Jolli-managed destination), which is normal.
- **failed** (\`status: "failed"\`): the run failed. Present the \`troubleshooting\`
  detail (the actionable error) and the \`workflow\` URL.
- **cancelled** (\`status: "cancelled"\`): the run was cancelled. Report who
  (\`cancel.by\`) and when (\`cancel.at\`) when present, plus the \`workflow\` URL.
- **still running** (\`status: "running"\` with \`timedOut: true\`): the monitor
  stopped polling before the run reached a terminal state — the run is **still
  running server-side**, not failed. Tell the user it is still in progress, present
  the \`workflow\` URL so they can watch it, and note they can re-check later by
  re-running \`workflow run-status <runId>\`.

## Step 6 — offer to open any reported URL

Offer to open any URL from the report in the user's default browser. For each URL
the user chooses, shell:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" open-url <url>
\`\`\`

It prints one JSON line \`{ "opened": true|false, "url": "..." }\`. When \`opened\` is
\`false\` (headless / no browser available) the URL is printed for the user to copy
instead — that is normal, not a failure. Only \`https\` URLs are accepted. A URL whose
origin is off Jolli's allowlist is refused (never launched) and printed instead — the
result carries \`"refused": true\`; surface that URL for the user to open manually, not
as an error.

## Cancelling an in-flight run

While a remote run is still in progress, the user can stop it: call
\`cancel_remote_workflow\` (on Claude Code
\`mcp__jollimemory__cancel_remote_workflow\`) with the workflow's numeric id —
\`{ "id": <workflow id> }\`. After cancelling, re-run \`workflow run-status <runId>\`
to report the cancelled outcome (who/when + workflow URL).
`;
}

/**
 * The `jolli` umbrella-menu skill — surfaces as a bare `/jolli` and acts as the
 * single friendly front door over the sibling Jolli skills plus whatever
 * `mcp__jollimemory__*` tools are registered in the session. It only steers the
 * agent to invoke an already-existing skill or tool; it is never a second
 * execution path for any action, and it does NOT re-derive the backend's curated
 * `menu` metadata (a static SKILL.md cannot fetch the manifest — curation of which
 * platform tools belong in the menu stays authoritative in the server-side MCP
 * `jolli` prompt). Byte-identical across every {@link SKILL_TARGETS} entry, with
 * spec-compliant frontmatter only.
 *
 * The menu-interaction contract mirrors the MCP `jolli` prompt (see
 * `cli/src/mcp/JolliMenu.ts`): argument provided → match to one action and invoke
 * it directly, asking only when ambiguous or unmatched; argument absent → present
 * the menu via an interactive single-select tool where the host provides one (e.g.
 * Claude Code's AskUserQuestion), otherwise a plain-text list, then invoke the
 * chosen action. Host-agnostic by design — the AskUserQuestion mention is only an
 * example and the text-list fallback keeps `/jolli` usable on every host.
 *
 * Written by a full `jolli enable` to `.agents/skills/jolli/SKILL.md` only — the
 * Claude Code slot (`.claude/skills/jolli/`) is written by the plugin variant
 * {@link buildPluginJolliMenuSkillTemplate} instead. The two no longer share a
 * directory, but a pre-upgrade install may still have THIS template sitting in the
 * legacy `.claude/skills/jolli/` slot, which the plugin variant reclaims by revision
 * (see that docstring); keep the two `metadata.revision` literals in view together.
 */
export function buildJolliMenuSkillTemplate(): string {
	return `---
name: jolli
description: The Jolli action menu — a single front door that lists the Jolli skills (recall, search, run a workflow local or remote, workflow history) plus the Jolli MCP tools registered in this session, then routes your choice to the right one. Use when the user types /jolli or asks for the Jolli menu.
metadata:
  version: "${SKILL_VERSION}"
  revision: 5
  vendor: "jolli.ai"
---

# Jolli

The single umbrella action menu for Jolli. It ties together the standalone Jolli
skills and whatever Jolli MCP tools are registered in this session, and routes the
user's choice to the right one. It is a friendly front door — it **never**
re-implements any action, it only invokes an existing skill or an existing MCP
tool. The standalone \`/jolli-recall\`, \`/jolli-search\` commands and
the \`/mcp__jollimemory__jolli\` prompt all keep working unchanged; this is layered
on top of them, not a replacement.

The **Workflow history** action below shells the \`jolli\` CLI (via the run-cli
entry script), so the shell prerequisite applies when that action is used.

${SHELL_PREREQUISITE_BLOCK}

## Step 1 — build the unified menu

Assemble ONE combined list of actions from two sources.

### Local Jolli skills (always present)

- **jolli-recall** — Recall prior development context for the current branch.
  Route by invoking the \`jolli-recall\` skill.
- **jolli-search** — Search structured commit memories across branches
  (decisions, topics, files). Route by invoking the \`jolli-search\` skill.
- **Run a workflow** — Run a Jolli workflow. When the user picks this, ask them
  **local vs remote**, defaulting to **local**:
  - **local (default)** — your agent executes the workflow's recipe on this
    machine (no Jolli LLM budget); the writes land in a git-backed Space via a
    branch + PR. Route by invoking the \`jolli-local-run\` skill.
  - **remote** — the Jolli backend executes the workflow server-side, and the run
    is monitored to completion and its result reported. Route by invoking the
    \`jolli-remote-run\` skill (which drives the \`run_remote_workflow\` tool for
    you) — not by calling the raw tool.

  A running **remote** run can be canceled with the \`cancel_remote_workflow\` MCP
  tool (\`mcp__jollimemory__cancel_remote_workflow\`) — offer this if the user
  wants to stop an in-flight remote run.
- **Workflow history** — Show a workflow's past runs. When the user picks this,
  identify the workflow's numeric id (if the \`list_workflows\` tool is registered
  this session, use it to let the user pick one by name; otherwise ask for the
  id), then shell:

  \`\`\`bash
  "$HOME/.jolli/jollimemory/run-cli" workflow runs <workflowId>
  \`\`\`

  It prints \`{ "type": "runs", "runs": [ ... ] }\` — one entry per run with its
  \`status\`, \`timestamp\`, and any \`workflowUrl\` / \`runUrl\` / \`prUrl\` /
  \`articleUrls\`. An empty \`runs\` list is the normal "no history yet" outcome, not
  an error. If instead the command exits non-zero and prints an install hint naming
  \`@jolli.ai/workflow-cli\` (rather than the JSON above), the workflow-cli plugin is
  not installed — tell the user to install it (\`npm i -g @jolli.ai/cli @jolli.ai/workflow-cli\`)
  and stop. Offer to open any listed URL via the \`open-url\` helper:

  \`\`\`bash
  "$HOME/.jolli/jollimemory/run-cli" open-url <url>
  \`\`\`

  (\`{ "opened": true|false, "url": "..." }\`; \`opened: false\` on a headless host
  just prints the URL — normal, not a failure. Only \`https\` URLs are accepted. A URL
  whose origin is off Jolli's allowlist is refused (never launched) and printed — the
  result carries \`"refused": true\`; surface it for the user to open manually.)

Route a local, remote, or history choice by invoking that skill through your
host's skill-invocation mechanism (for example, the Skill tool in Claude Code);
the Workflow history action runs its \`run-cli\` commands directly as shown above.

### Jolli MCP tools (whatever is registered this session)

Surface every tool whose name starts with \`mcp__jollimemory__\` that is available
in the current session — for example \`recall\`, \`search\`, \`get_pr_description\`,
\`queue_status\`, and any manifest-driven platform tools (space, article, and the
like). Route a choice by calling the matching \`mcp__jollimemory__*\` tool.

**Exclusions — do NOT surface these as standalone menu items:**

- \`list_workflow_definitions\` — discovery/plumbing, not a human quick-action.
- \`run_remote_workflow\` and \`cancel_remote_workflow\` — these are already covered
  by the **Run a workflow** action above (its *remote* path and its cancellation
  option); don't list them again as raw tools.

Do NOT assume a fixed list — enumerate the Jolli MCP tools that are actually
registered right now, minus the exclusions above. Do NOT try to fetch or
re-derive any backend "menu" curation; a skill cannot read the manifest, so
simply surface the Jolli MCP tools present in the session. If no Jolli MCP tools
are registered, present just the local skills above.

## Step 2 — route the request

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one menu action and invoke that
  action directly (invoke the skill, or call the MCP tool). Only ask the user to
  choose if the request is ambiguous or matches no menu action.
- **Argument absent** → present the unified menu and let the user pick one, using
  an interactive single-select tool if your host provides one (for example
  AskUserQuestion in Claude Code); otherwise list the options as plain text and
  ask the user to choose. After the user selects, invoke the corresponding skill
  or MCP tool.

Host-agnostic by design: the AskUserQuestion mention is only an example; the
text-list fallback keeps \`/jolli\` usable on every host that loads skills.
`;
}

/**
 * The Claude-Code-plugin variant of the bare `/jolli` front door. Like
 * {@link buildJolliMenuSkillTemplate} it routes to the plugin's OWN namespaced
 * skills (`jolli:init` / `jolli:recall` / `jolli:search` / `jolli:push`) rather
 * than the unnamespaced `jolli-*` siblings, because in a plugin install those
 * namespaced skills are the ones that exist.
 *
 * Unlike the passive standalone menu, this variant is a **state-aware guided
 * front door** modelled on the CLI's `runGuidedFrontDoor` capability ladder
 * (`cli/src/commands/GuidedFrontDoor.ts`): it reads `mcp__jollimemory__status`
 * (falling back to `jolli status`), and if the repo isn't fully set up
 * (no generation credential, or git hooks not installed) it steers the user
 * into `/jolli:init` — which owns sign-in → enable → bind-Space — rather than
 * dumping a menu. Once set up it prints a short `✓` snapshot and only THEN
 * presents the action menu, biased by state. It still never re-implements an
 * action; it only reads status and invokes an existing skill or MCP tool. Space
 * binding is deliberately not gated on here — `status` doesn't report it (it
 * only surfaces via `/jolli:push`'s `binding_required`), so binding stays
 * `/jolli:init`'s / `/jolli:push`'s job.
 *
 * Written by {@link installPluginJolliMenu} to `<repo>/.claude/skills/jolli/`,
 * which is the only way to surface a BARE `/jolli` from a plugin (plugin skills
 * are always `/<plugin>:<skill>`). Frontmatter is spec-compliant (name /
 * description / metadata only) so it passes `skills-ref validate`.
 *
 * ⚠ Revision-ordering contract with {@link buildJolliMenuSkillTemplate}: a full
 * `jolli enable` no longer writes the standalone menu to `.claude/skills/jolli/`
 * (it targets `.agents/skills/` only), so in a fresh install the two no longer
 * collide. BUT a pre-upgrade install may still have the standalone menu (an
 * earlier revision) sitting in `.claude/skills/jolli/`, and both carry
 * `vendor: "jolli.ai"` so the ownership guard cannot tell them apart —
 * `upsertSkill` arbitrates purely by `metadata.revision`. This variant is
 * therefore revision **6** (above the standalone's current revision 5, and above
 * the ≤5 any legacy `.claude/` copy carries) so {@link installPluginJolliMenu}
 * RECLAIMS that legacy slot, replacing a stale standalone menu that would
 * otherwise route to the unnamespaced `jolli-*` skills
 * {@link removeClaudeLegacySkills} just deleted. Keep this note and both revision
 * literals in view when editing either template — this must stay strictly above
 * the standalone's revision, or the broken pre-upgrade menu is stranded.
 */
export function buildPluginJolliMenuSkillTemplate(): string {
	return `---
name: jolli
description: The Jolli front door — checks how Jolli is set up in this repo, guides first-time setup through /jolli:init when something's missing, and otherwise shows a status snapshot and routes you to the right Jolli skill or MCP tool. Use when the user types /jolli or asks for Jolli / the Jolli menu.
metadata:
  version: "${SKILL_VERSION}"
  revision: 6
  vendor: "jolli.ai"
---

# Jolli

The single front door for Jolli. Rather than dumping a static list, it reads how
Jolli is set up in THIS repo and guides the next step: if setup is incomplete it
walks the user into \`/jolli:init\`; once everything is wired it shows a short
status snapshot and routes the user's choice to the right skill or Jolli MCP
tool. It is a friendly front door — it **never** re-implements any action, it
only reads status and invokes an existing skill or an existing MCP tool. The
standalone \`/jolli:init\`, \`/jolli:recall\`, \`/jolli:search\`, \`/jolli:push\`
commands all keep working unchanged; this is layered on top of them, not a
replacement.

## Step 0 — confirm this menu can route

This menu is a project skill written OUTSIDE the Jolli plugin (a plugin skill
could only ever be \`/jolli:<name>\`, never a bare \`/jolli\`), so it can linger
in \`.claude/skills/jolli/\` after the plugin has been uninstalled. It can only
route to targets that exist in THIS session, so before doing anything else
confirm at least one routing target is available. The menu can route if
**either** of these holds:

- one or more MCP tools whose name contains \`jollimemory\` are registered, **or**
- the plugin's own namespaced skills (\`jolli:init\` / \`jolli:recall\` /
  \`jolli:search\` / \`jolli:push\`) are invocable this session.

If **either** holds, proceed to Step 1.

If **neither** holds, do **not** build the menu and do **not** invoke any
\`/jolli:*\` skill — it is not registered and the call will fail. But this alone
does NOT mean Jolli is gone: the Jolli CLI installs a memory pipeline that runs
independently of this plugin (git hooks that generate memories on every commit).
So distinguish the two cases — check whether the bundled CLI dispatch exists by
running \`test -f "$HOME/.jolli/jollimemory/run-cli" && echo present\`:

- **CLI present** → Jolli still works; only the plugin's interactive menu is not
  loaded in this session. Tell the user plainly: the Jolli plugin menu isn't
  loaded here, but the Jolli CLI is still installed — commits still generate
  memories, and they can run \`jolli recall\` / \`jolli search\` directly. This
  \`/jolli\` file is a leftover from a previous plugin install; they can remove
  it with \`rm -rf .claude/skills/jolli\`, and reinstall the Jolli plugin to
  bring the menu back.
- **CLI absent** → Jolli is no longer installed at all. Tell the user this
  \`/jolli\` menu is a stale leftover; they can remove it with
  \`rm -rf .claude/skills/jolli\`, and (re)install Jolli to bring it back.

Either way, then stop — do not continue to Step 1.

## Step 1 — read how Jolli is set up

Before deciding what to show, read the current state so you can guide instead of
guessing. This is the state-aware front door — not a static list.

**Preferred (MCP):** call the \`status\` tool (on Claude Code
\`mcp__jollimemory__status\`) with no arguments. From its result read:

- \`enabled\` — are Jolli's git hooks installed in this repo (is memory
  generation on)?
- \`account.signedIn\` — is the user signed in to Jolli?
- \`account.jolliApiKeyConfigured\` / \`account.anthropicKeyConfigured\` — is a
  generation credential present?
- \`account.site\` — the Jolli site host, for the snapshot line.
- \`storedMemories\` — how many memories this repo already has.
- \`space\` — the bound Jolli Space (\`{ name }\`) this repo's memories sync to, or
  \`null\` when the repo isn't bound yet. Drives the \`syncing · Space\` snapshot line.

**Fallback (CLI):** if the \`status\` MCP tool is unavailable (an older Jolli),
run the bundled CLI through its stable dispatch script and read the same facts
from its printed output:

\`\`\`bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" status
\`\`\`

If neither the tool nor the CLI can be reached at all, skip the state-based
guidance and go straight to Step 3's menu (present it without a snapshot).

Note: \`status.space\` is display-only — it names the bound Space for the snapshot
but does NOT confirm push health. Full binding management (picking / re-binding a
Space) stays \`/jolli:init\`'s and \`/jolli:push\`'s job; do not try to (re)bind here.

## Step 2 — guide by state (the front door)

Derive two capabilities from Step 1, mirroring the CLI's guided front door:

- **can generate memories** — provider-AWARE, NOT a blind OR of every field.
  Read \`account.aiProvider\` and decide:
  - \`local-agent\` → **yes** (memories generate through the user's local Claude
    subscription — no API key and no Jolli sign-in required). This is the plugin's
    default, so a freshly-installed plugin repo can already generate.
  - \`jolli\` → yes only if \`account.jolliApiKeyConfigured\`.
  - \`anthropic\` → yes only if \`account.anthropicKeyConfigured\`.
  - \`null\` / unset → yes if \`account.jolliApiKeyConfigured\` OR
    \`account.anthropicKeyConfigured\`.

  (\`account.signedIn\` alone does NOT count — an OAuth token is a sync credential,
  not a generation one.)
- **enabled** = the \`enabled\` flag.

Then take exactly one branch:

- **Not fully set up** — \`enabled\` is false, OR memories can't be generated:
  memory generation isn't wired yet, so lead with SETUP, not the action menu.
  State in one line what's missing (for example "not signed in, and memory
  generation is off for this repo"), then invoke the \`jolli:init\` skill through
  the Skill tool — it walks sign-in → enable → bind a Space in one guided pass.
  Do NOT hand-roll those steps here; \`/jolli:init\` owns them. (Exception: if the
  user gave an argument in Step 3 that clearly names a different action, honor
  that instead — see Step 3.)

- **Fully set up** — enabled AND a credential present: print a short snapshot,
  then continue to Step 3 to present the action menu.

  \`\`\`
  ✓ signed in · <account.site>        (or "✓ Jolli key set" / "✓ Anthropic key set" when not signed in)
  ✓ enabled · <storedMemories> memories
  ✓ syncing · Space "<space.name>"    (ONLY when \`space\` is non-null; omit the whole line otherwise)

  Jolli is listening — last memory saved.
  \`\`\`

  Render the \`✓ syncing · Space "<space.name>"\` line **only when \`space\` is
  non-null** — it means a \`git push\` auto-publishes this branch's memories to that
  Space (the pre-push hook does it). When \`space\` is null, drop that line entirely;
  do not print a "not bound" line here (binding is \`/jolli:init\`'s job).

  The closing \`Jolli is listening — …\` line mirrors the CLI front door: use
  **"last memory saved."** when \`storedMemories\` > 0, or **"your next commit is your
  first memory"** when \`storedMemories\` is 0.

  If \`storedMemories\` is 0, still show the menu, but Step 3 leads it with
  \`/jolli:init\` (on a fresh repo recall / search would only return empty, so
  they must not be the default action).

## Step 3 — route the request / present the menu

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action below and invoke that
  action directly (invoke the skill, or call the Jolli MCP tool), regardless of
  the Step 2 state — a specific request wins over the setup nudge. The invoked
  skill handles its own preconditions (for example \`/jolli:push\` will offer to
  bind a Space if the repo isn't bound). Only ask the user to choose if the
  request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, present the action menu and
  let the user pick, using an interactive single-select tool if your host
  provides one (for example AskUserQuestion in Claude Code); otherwise list the
  options as plain text and ask. Bias the ordering to the state: when
  \`storedMemories\` is 0, lead with \`/jolli:init\` as the FIRST (default)
  option — finish setup / bind a Space, or just make the first commit — and
  demote recall / search below it, since on a fresh repo both would only
  return empty. When memories exist, lead instead with recall / search. Either
  way keep \`/jolli:init\` available for re-running setup or re-binding a Space.
  After the user selects, invoke the corresponding skill or MCP tool.

### Jolli plugin skills

List a plugin skill only if it was confirmed available in Step 0.

- **/jolli:init** — Set up Jolli for this repo: sign in if needed, enable memory
  generation, and bind the repo to a Jolli Space. Route by invoking the
  \`jolli:init\` skill.
- **/jolli:recall** — Recall prior development context for the current branch.
  Route by invoking the \`jolli:recall\` skill.
- **/jolli:search** — Search structured commit memories across branches
  (decisions, topics, files). Route by invoking the \`jolli:search\` skill.
- **/jolli:push** — Publish this branch's memories to a Jolli Space. Route by
  invoking the \`jolli:push\` skill.

Route a local choice by invoking that skill through the Skill tool.

### Jolli MCP tools (whatever is registered this session)

Surface every tool whose name contains \`jollimemory\` that is available in the
current session — for example \`recall\`, \`search\`, \`get_pr_description\`,
\`queue_status\`, \`status\`, and the Jolli Space tools (\`list_spaces\`,
\`bind_space\`, \`push_memory\`). Route a choice by calling the matching Jolli
MCP tool.

Do NOT assume a fixed list — enumerate the Jolli MCP tools that are actually
registered right now. If no Jolli MCP tools are registered, present just the
plugin skills above.
`;
}
