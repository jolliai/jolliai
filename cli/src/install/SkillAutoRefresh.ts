/**
 * SkillAutoRefresh — version-guarded, fail-soft refresh of the on-disk Jolli
 * skill recipes on every `jolli` CLI startup.
 *
 * Why this exists
 * ----------------
 * `updateSkillsIfNeeded` (SkillInstaller) runs only inside `jolli enable` and
 * IDE activation (see `Installer.ts`). A CLI-only user who upgrades the global
 * package (`npm i -g @jolli.ai/cli`) WITHOUT re-running `jolli enable` keeps
 * whatever recipe revisions were on disk at their last enable. When a release
 * renames or relocates a command a recipe shells — e.g. the workflow-run surface
 * moving to the `@jolli.ai/workflow-cli` plugin (`local-run-workflows` →
 * `workflow local-run`) — those stale recipes call a name the upgraded host no
 * longer provides and break immediately, with no re-enable in sight.
 *
 * This closes that gap: on every invocation we cheaply compare a per-repo version
 * marker against the running CLI version; only when they differ do we re-run the
 * revision-keyed `updateSkillsIfNeeded` once and stamp the marker. The common
 * (already-current) path is a single small file read — comparable to the existing
 * `checkVersionMismatch` startup read — so it adds no meaningful hot-path latency.
 *
 * Gates (ALL must hold, else it is a no-op):
 *   - the running version is a real published version, not `"dev"` — the same
 *     dev-guard `checkVersionMismatch` uses, so a `tsx`/test/dev build never
 *     rewrites skills (developers iterate via `jolli enable`), and unit tests
 *     drive the real path by injecting a version;
 *   - walking up from the invocation cwd finds a worktree root that already has an
 *     installed Jolli skill, so a plain `jolli` in an un-enabled repo never
 *     CREATES skills;
 *   - the marker's version differs from the running version.
 *
 * The invoked command's own lifecycle guard (skip `enable` / `disable` /
 * `uninstall`, which own skills themselves) lives at the call site in `Api.ts`.
 *
 * Never throws: any failure is swallowed (logged at debug) so a refresh problem
 * can't break the command the user actually ran.
 */

import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION } from "../commands/CliUtils.js";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import { updateSkillsIfNeeded } from "./SkillInstaller.js";

const log = createLogger("SkillAutoRefresh");

/** Marker file (in the per-project `.jolli/jollimemory/`) recording the CLI version whose skills we last reconciled. */
const SKILLS_REFRESH_MARKER = "skills-refresh.json";

/**
 * Relative path of a skill that a full `jolli enable` always installs. Its
 * presence at a worktree root is the "Jolli is enabled here" signal that gates
 * the whole refresh — chosen because `jolli-recall` is the first entry in the
 * skill registry and is written to the cross-platform `.agents/skills/` target
 * on every enable.
 */
const ENABLED_SKILL_PROBE = join(".agents", "skills", "jolli-recall", "SKILL.md");

/** Injectable seams so unit tests can drive the real path without a global install. */
export interface AutoRefreshDeps {
	/** Running CLI version. Defaults to the build-stamped {@link VERSION}. */
	readonly version?: string;
	/** Global-config reader (for `claudeEnabled`). Defaults to {@link loadConfig}. */
	readonly loadConfig?: () => Promise<{ claudeEnabled?: boolean }>;
	/** Skill upsert. Defaults to {@link updateSkillsIfNeeded}. */
	readonly updateSkills?: (root: string, config: { claudeEnabled?: boolean }) => Promise<void>;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Walks up from `startDir` looking for a worktree root that already has an
 * installed Jolli skill. Returns that root, or `null` if none is found before
 * the filesystem root. Stat-only (a handful of `access` calls) — no subprocess.
 */
async function findEnabledSkillsRoot(startDir: string): Promise<string | null> {
	let dir = startDir;
	for (;;) {
		if (await pathExists(join(dir, ENABLED_SKILL_PROBE))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null; // reached the filesystem root
		dir = parent;
	}
}

/** Reads the marker's recorded version, or `null` when absent/unparseable. */
async function readMarkerVersion(markerPath: string): Promise<string | null> {
	try {
		const parsed = JSON.parse(await readFile(markerPath, "utf-8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

/**
 * Refresh the on-disk Jolli skill recipes for the current repo if they were last
 * reconciled for a different CLI version. See the module header for the rationale
 * and gates. Fail-soft — never throws.
 */
export async function autoRefreshSkillsIfStale(cwd: string, deps: AutoRefreshDeps = {}): Promise<void> {
	const version = deps.version ?? VERSION;
	// Dev/test/tsx builds never self-heal — developers iterate via `jolli enable`,
	// and a "dev" marker would make the guard meaningless. Mirrors checkVersionMismatch.
	if (version === "dev") return;

	try {
		const root = await findEnabledSkillsRoot(cwd);
		if (root === null) return; // Jolli not enabled in this repo — never create skills here.

		const markerDir = getJolliMemoryDir(root);
		const markerPath = join(markerDir, SKILLS_REFRESH_MARKER);
		if ((await readMarkerVersion(markerPath)) === version) return; // already reconciled for this version

		const config = await (deps.loadConfig ?? loadConfig)();
		await (deps.updateSkills ?? updateSkillsIfNeeded)(root, { claudeEnabled: config.claudeEnabled });

		await mkdir(markerDir, { recursive: true });
		await atomicWriteFile(markerPath, `${JSON.stringify({ version }, null, "\t")}\n`);
		log.info("Refreshed Jolli skills at %s for version %s", root, version);
	} catch (error: unknown) {
		// Fail-soft: a refresh problem must never break the command the user ran.
		log.debug("Skill auto-refresh skipped: %s", (error as Error).message);
	}
}
