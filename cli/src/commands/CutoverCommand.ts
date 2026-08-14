/**
 * CutoverCommand — `jolli cutover`: the user-facing entry to the phase-D
 * protocol. Plain `jolli cutover` runs (or resumes) the switch for the
 * current repo; `--status` answers with the four-state route; `--probe`
 * runs the post-cutover drift check UNTHROTTLED, which is the difference
 * between it and the copy `maybeAutoCutover` runs on its own — this one is
 * for someone actively hunting the writer, so it must not be suppressed by
 * a stamp an automatic probe left minutes ago.
 *
 * The engine is deliberately conservative, so this command mostly reports:
 * an unregistered repo, a missing orphan branch or a failing compare are all
 * "not-ready" with the reason spelled out, and retry exhaustion leaves the
 * repo in legacy-fenced — a WORKING state (writes go to SQLite) whose CAS a
 * re-run finishes.
 */

import type { Command } from "commander";
import { probeCutoverDrift, runCutover } from "../dashboard/CutoverEngine.js";
import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

async function showStatus(cwd: string): Promise<void> {
	const route = await resolveCutoverRoute(cwd);
	switch (route.state) {
		case "uncutover":
			console.log("state: uncutover — the orphan branch is this repo's source of truth");
			if (route.warning) console.log(`warning: ${route.warning}`);
			break;
		case "legacy-fenced":
			console.log(
				"state: legacy-fenced — the orphan branch is frozen; writes go to SQLite. Run 'jolli cutover' to finish the commit.",
			);
			break;
		case "cutover":
			console.log(
				`state: cutover (version ${route.record.cutoverVersion}, committed ${route.record.committedAt}) — SQLite is the source of truth`,
			);
			break;
		case "blocked":
			console.log(`state: BLOCKED — ${route.reason}`);
			process.exitCode = 1;
			break;
	}
}

async function runProbe(cwd: string): Promise<void> {
	const drift = await probeCutoverDrift(cwd);
	if (drift.length === 0) {
		console.log("no drift: every frozen orphan tip matches the cutover record");
		return;
	}
	for (const d of drift) {
		console.log(`DRIFT in ${d.root}: tip ${d.currentTip ?? "(unresolvable)"} != recorded ${d.recordedTip}`);
	}
	console.log(
		`${drift.length} source(s) drifted — something bypassed the fence (an old client or an un-restarted IDE). ` +
			"The stranded memories were imported; find and stop the writer. This keeps being reported until the tips stop moving.",
	);
	process.exitCode = 1;
}

/** Registers the `cutover` sub-command on the given Commander program. */
export function registerCutoverCommand(program: Command): void {
	program
		.command("cutover")
		.description("Make SQLite this repo's source of truth (freeze the orphan branch)")
		.option("--status", "Show the repo's cutover state without changing anything")
		.option("--probe", "Check the frozen orphan branches for post-cutover drift")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string; status?: boolean; probe?: boolean }) => {
			setLogDir(options.cwd);
			if (options.status) return showStatus(options.cwd);
			if (options.probe) return runProbe(options.cwd);
			const outcome = await runCutover(options.cwd);
			switch (outcome.status) {
				case "committed":
					console.log(
						`cutover committed (version ${outcome.record.cutoverVersion}). SQLite is now this repo's source of truth. ` +
							"Restart IDEs/long-running processes so cached storage objects are rebuilt.",
					);
					break;
				case "already-cutover":
					console.log("already cut over — nothing to do");
					break;
				case "not-ready":
					console.log(`not ready: ${outcome.reason}`);
					process.exitCode = 1;
					break;
				case "retry-exhausted":
					console.log(`retry exhausted: ${outcome.reason}`);
					process.exitCode = 1;
					break;
			}
		});
}
