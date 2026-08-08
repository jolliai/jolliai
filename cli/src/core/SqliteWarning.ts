/**
 * Suppresses ONE warning: the `ExperimentalWarning` `node:sqlite` emits the
 * first time it is loaded.
 *
 * It is unavoidable and unactionable for the user. `node:sqlite` is a hard
 * dependency of the dashboard (see `SqliteHelpers`' Node floor), the flag that
 * would silence it globally (`--no-warnings`) cannot be added to every surface
 * that spawns us — the VS Code extension host and the flag-free git-hook
 * dispatchers are exactly the two that cannot pass flags — and it prints on
 * stderr in the middle of command output, two lines of it, on a command whose
 * whole job is to print a URL and a count.
 *
 * The rest of the warning channel is left intact on purpose: deprecations and
 * other experimental features are real signals, and a blanket
 * `process.removeAllListeners("warning")` (or `--no-warnings`) would hide the
 * next one too. Node's own default listener is captured and delegated to, so a
 * forwarded warning keeps its normal formatting and honours `--trace-warnings`.
 *
 * Idempotent, and safe to call before anything loads `node:sqlite` — which is
 * the only time it can work, since the warning fires on load.
 */
let installed = false;

export function silenceSqliteExperimentalWarning(): void {
	if (installed) return;
	installed = true;
	const defaults = process.listeners("warning");
	process.removeAllListeners("warning");
	process.on("warning", (warning) => {
		if (warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message)) return;
		for (const listener of defaults) listener.call(process, warning);
	});
}

/** Test seam: lets a suite re-install onto its own listener set. */
export function resetSqliteWarningFilterForTests(): void {
	installed = false;
}
