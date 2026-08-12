/**
 * Reads the one Cursor setting that changes which skill roots Cursor will load.
 *
 * `thirdPartyExtensibilityEnabled` gates the OTHER hosts' directories — Cursor's
 * provider re-scans on `onDidChangeThirdPartyExtensibilityEnabled`, and its own
 * classifier splits skill sources into `builtin` / `plugin` / `claude` / `workspace`
 * (verified in `extensions/cursor-agent-exec/dist/main.js`). With it off, a
 * `.claude/skills/jolli-recall` is invisible to Cursor, so treating it as "already
 * provided" would leave the user with no recall at all.
 *
 * **Everything here is best-effort, and every failure answers `true`** — the default,
 * and the same answer as not reading at all. That is what makes consulting a foreign
 * IDE's private SQLite acceptable: a missing library, a renamed key, a moved path, a
 * locked database and an old Cursor all degrade to today's behaviour rather than to a
 * wrong one.
 *
 * Measured contract (Cursor 3.15.6, macOS):
 *
 * | | |
 * |---|---|
 * | store | `<userDataDir>/User/globalStorage/state.vscdb`, **global** — the four per-workspace `state.vscdb` files stay untouched when the toggle flips |
 * | key | `cursor/thirdPartyExtensibilityEnabled` |
 * | value | sqlite `text`, the bare 5 characters `false` — NOT JSON, so `JSON.parse` is not what reads it |
 * | default | the row does not exist at all (flipping the toggle took the table from 183 to 184 rows), so ABSENT MEANS ENABLED |
 *
 * The absent-means-enabled rule is the load-bearing half. Reading "no row" as
 * "disabled" would flip every default install onto the narrow branch.
 */

import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("CursorSettings");

/** The storage key, verified by flipping the toggle and diffing the table. */
const THIRD_PARTY_KEY = "cursor/thirdPartyExtensibilityEnabled";

/**
 * An env-supplied base directory, or `undefined` when the variable is unset, blank, or
 * relative — the three values that must all fall back to the platform default.
 *
 * `??` alone is the trap, and it is a quiet one. A variable that is SET BUT EMPTY passes
 * straight through it, and `join("", "Cursor", …)` is a RELATIVE path, resolved against
 * whatever cwd the caller happens to have — for a plugin hook, the bundle. The open then
 * fails on every call, the reader answers its documented default forever, and the setting
 * this module exists to honour is silently never read on that machine. Nothing surfaces:
 * failing to `true` is indistinguishable from a genuine "enabled".
 *
 * Both rejections match what actually resolves this path inside Cursor. The XDG spec
 * defines an empty `XDG_CONFIG_HOME` as equivalent to unset, and Chromium's
 * `base::nix::GetXDGDirectory` — Electron's implementation of it — additionally ignores a
 * relative value, so Cursor lands on `~/.config` in both cases and so must we, or we would
 * be reading a different file than the one it writes. `isAbsolute` is judged by the RUNNING
 * platform, which is the right one in production — a Windows `C:\…` is only ever read on
 * Windows. (The platform is injectable below so both branches can be exercised from one
 * machine; that only moves which branch runs, never which rules `isAbsolute` applies, so a
 * test crossing the two must use a pathspec its own OS calls absolute.)
 *
 * Same empty-string trap `resolveCursorProjectDir` guards with `trim().length === 0`,
 * reached through a different door.
 */
function envDir(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed !== "" && isAbsolute(trimmed) ? trimmed : undefined;
}

/**
 * Cursor's user-data directory per platform — the same layout VS Code uses, which is
 * what Cursor forked. Exported for the test; callers want {@link isThirdPartyExtensibilityEnabled}.
 *
 * `os` takes the platform as a parameter for the same reason `dbPath` is injected below:
 * two of the three branches read an environment variable, and each is reachable on
 * exactly one platform — so on any given machine the other two are untestable, and the
 * empty-string guard in {@link envDir} would be asserted only by whichever OS CI happens
 * to run. That is how it shipped wrong in the first place.
 */
export function cursorGlobalStorageDb(env: NodeJS.ProcessEnv = process.env, os: string = platform()): string {
	const home = homedir();
	if (os === "win32") {
		const appData = envDir(env.APPDATA) ?? join(home, "AppData", "Roaming");
		return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
	}
	if (os === "darwin") {
		return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
	}
	return join(envDir(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * Whether Cursor will load skills from the other hosts' directories (`.claude/…`,
 * `.codex/…`). Defaults to `true`, including on every error path.
 *
 * `node:sqlite` is imported lazily so a runtime below the 22.13 floor — or one where
 * the module was compiled out — degrades to the default instead of throwing at module
 * load. Opened read-only: this is another application's live database, and Cursor is
 * usually running while we read it (WAL makes the concurrent read safe, but only a
 * reader is safe to be).
 */
export async function isThirdPartyExtensibilityEnabled(
	env: NodeJS.ProcessEnv = process.env,
	// Injected rather than spied: these are ES modules, so a `vi.spyOn` on the exported
	// path resolver does not rebind what this function already closed over — the test
	// would silently read the DEVELOPER's live Cursor database instead of its fixture,
	// and pass or fail depending on that machine's toggle.
	dbPath: string = cursorGlobalStorageDb(env),
): Promise<boolean> {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(THIRD_PARTY_KEY) as
				| { value?: unknown }
				| undefined;
			// Absent row = never changed = Cursor's own default, which is ON.
			if (row?.value === undefined) return true;
			// Stored as bare text, not JSON. Compare loosely so a future build that
			// switches to `"false"` (quoted) or `0` still reads as disabled.
			const raw = String(row.value).trim().replace(/^"|"$/gu, "");
			return raw !== "false" && raw !== "0";
		} finally {
			db.close();
		}
	} catch (error: unknown) {
		log.info(
			"Could not read Cursor's third-party-extensibility setting (assuming enabled): %s",
			(error as Error).message,
		);
		return true;
	}
}
