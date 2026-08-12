/**
 * Skill text shared across the surfaces that write SKILL.md files — the installed
 * copies `SkillInstaller` upserts and the STATIC copies the plugin bundles commit
 * (`CodexPluginSkills`, `CursorPluginSkills`).
 *
 * Two kinds of thing live here. The frontmatter transforms are extracted rather
 * than duplicated because both plugin hosts need the identical adaptations and both
 * are covered by a drift test that compares a builder's output against a committed
 * file — so a divergence between two copies would surface as an unexplained diff in
 * one plugin's `SKILL.md` and nowhere else. {@link SHELL_PREREQUISITE_BLOCK} is here
 * for a structural reason instead: `SkillInstaller` imports `CursorPluginSkills` (for
 * the umbrella the Cursor mirror writes), so the block could not live in either of
 * them without closing a cycle. This module imports nothing, which is what makes it
 * a safe home.
 *
 * The transforms are line-based rather than a YAML round-trip: the templates have a
 * fixed generated shape, and re-serializing risks reflowing the long `description`
 * values in ways that fail those drift tests for purely cosmetic reasons.
 */

/**
 * The Windows shell-prerequisite block shared by every shell-backed skill. It
 * pins Git Bash on Windows because the `run-cli` entry script is written via
 * Windows Node's `os.homedir()` to `%USERPROFILE%\\.jolli\\jollimemory\\run-cli`,
 * and only Git Bash's `$HOME` aligns with `%USERPROFILE%` — PowerShell / WSL bash
 * see a different home and won't find the script.
 *
 * **The trigger is shelling `run-cli`, not the here-doc.** Easy to get backwards,
 * because the block was written for the arg-carrying here-doc skills and mentions
 * their security recipe — but the local-run recipe (fixed `run-cli` subcommands, no
 * here-doc) carries it for the same reason, and so do the Cursor plugin's
 * setup/account skills. A skill that only calls MCP tools does not need it; a skill
 * that shells this path does, whatever it passes.
 *
 * PowerShell is the case worth stating, since it looks like it should work: it
 * defines `$HOME` too, so the path expands to something real and the failure is a
 * plain "not recognized" on an extensionless bash script rather than an unset
 * variable.
 */
export const SHELL_PREREQUISITE_BLOCK = `### Shell prerequisite

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
 * Strips the `metadata:` block from a canonical template's frontmatter, leaving
 * `name` and `description` — the two fields both hosts document as required.
 *
 * The block exists for SkillInstaller's on-disk upsert, which compares revisions
 * before overwriting a user's file. Plugin-bundled skills are never upserted, so it
 * is inert here — and its `version` is a build-time define, so committing it would
 * either bake in a stale string or churn these files on every release. Both hosts
 * tolerate extra frontmatter keys, so this is about not shipping meaningless
 * content, not compatibility.
 */
export function stripMetadataBlock(template: string): string {
	const lines = template.split("\n");
	if (lines[0] !== "---") return template;
	const end = lines.indexOf("---", 1);
	if (end === -1) return template;

	const frontmatter: string[] = [];
	let skipping = false;
	for (const line of lines.slice(1, end)) {
		if (line === "metadata:") {
			skipping = true;
			continue;
		}
		// Entries under `metadata:` are indented; the next unindented key ends the block.
		if (skipping && /^\s+\S/u.test(line)) continue;
		skipping = false;
		frontmatter.push(line);
	}
	return ["---", ...frontmatter, "---", ...lines.slice(end + 1)].join("\n");
}

/**
 * Rewrites the frontmatter `name` so it equals the plugin's bundle directory.
 *
 * Kept equal on purpose: both hosts document `name` as required, and which of the
 * two seeds the model-visible invocation name is not specified anywhere we can rely
 * on, so a mismatch would be a guess. A no-op when the template already agrees —
 * which is the normal case for the Cursor bundle, whose directories keep the
 * canonical `jolli-` prefix.
 */
export function setFrontmatterName(template: string, name: string): string {
	const lines = template.split("\n");
	if (lines[0] !== "---") return template;
	const end = lines.indexOf("---", 1);
	if (end === -1) return template;
	const index = lines.findIndex((line, i) => i > 0 && i < end && line.startsWith("name: "));
	if (index === -1) return template;
	lines[index] = `name: ${name}`;
	return lines.join("\n");
}
