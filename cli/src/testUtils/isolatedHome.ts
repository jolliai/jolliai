/**
 * Point every home-directory lookup at a scratch directory for the duration of
 * a test, and restore the previous environment exactly.
 *
 * `process.env.HOME = …` on its own is NOT isolation — it is isolation on POSIX
 * and a no-op on Windows. Machine-global paths resolve through `os.homedir()`
 * (`getGlobalConfigDir()` in `core/SessionTracker.ts`), and libuv's
 * `uv_os_homedir` reads `HOME` only on POSIX; on win32 it reads `USERPROFILE`
 * and falls back to the Win32 profile API. So a test that sets `HOME` alone
 * writes into the DEVELOPER'S REAL `~/.jolli/jollimemory/` when the suite runs
 * on Windows.
 *
 * That is not hypothetical damage. `dashboard-repos.json` is append-only by
 * design (no TTL, no cap, and `deregisterRepo` must run from inside the repo it
 * removes — impossible once the temp directory is gone), and a remote-less repo
 * gets a `local:<path hash>` identity, so every `mkdtemp` run is a brand-new
 * entry that can never merge with an old one. One `npm run test` on Windows
 * therefore added one permanent, dead registry row per test case that registers
 * a repo, and every later `jolli dashboard` re-swept them and logged three
 * warnings apiece.
 *
 * `HOMEDRIVE`/`HOMEPATH` are deliberately NOT touched: libuv ignores them, and
 * clearing them would diverge from what the process would see for real.
 */

/** Restores the environment captured by {@link setIsolatedHome}. Idempotent. */
export type RestoreHome = () => void;

const HOME_VARS = ["HOME", "USERPROFILE"] as const;

/**
 * Redirects home-directory resolution to `home` and returns the restore
 * function. A variable that was absent before is deleted again rather than set
 * to `"undefined"` — assigning `undefined` to a `process.env` slot stringifies
 * it, which would make `os.homedir()` resolve to a literal `undefined` path.
 */
export function setIsolatedHome(home: string): RestoreHome {
	const previous = HOME_VARS.map((name) => [name, process.env[name]] as const);
	for (const name of HOME_VARS) process.env[name] = home;
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/**
 * Scoped form of {@link setIsolatedHome} for a single block. Supports sync and
 * async `fn`; the environment is restored even when `fn` throws or rejects.
 */
export async function withIsolatedHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
	const restore = setIsolatedHome(home);
	try {
		return await fn();
	} finally {
		restore();
	}
}
