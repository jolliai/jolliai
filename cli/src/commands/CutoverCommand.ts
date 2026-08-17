/**
 * CutoverCommand — `jolli cutover`: the user-facing entry to the phase-D
 * protocol. Plain `jolli cutover` runs (or resumes) the switch for the
 * current repo; `--status` answers with the four-state route; `--probe`
 * runs the post-cutover drift check UNTHROTTLED, which is the difference
 * between it and the copy `maybeAutoCutover` runs on its own — this one is
 * for someone actively hunting the writer, so it must not be suppressed by
 * a stamp an automatic probe left minutes ago.
 *
 * This command mostly reports: an unregistered repo or a missing orphan branch
 * is "not-ready" with the reason spelled out, and retry exhaustion leaves the
 * repo in legacy-fenced — a WORKING state (writes go to SQLite) whose CAS a
 * re-run finishes. A compare finding is NOT one of those refusals: the switch
 * goes ahead and the paths are printed as a note (see `reportUnreconciled`).
 */

import type { Command } from "commander";
import { NO_ORPHAN_TIP, probeCutoverDrift, readCutoverBlock, runCutover } from "../dashboard/CutoverEngine.js";
import { type CutoverRecord, resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

/**
 * The paths the frozen branch still has and the database does not, if any.
 *
 * Printed on BOTH the commit and `--status`, because it is the record's most
 * perishable content: the run that reported it may have been an automatic one
 * whose output nobody watched. Never an error — the switch is done and this is
 * what it cost.
 *
 * The recovery hint spells out the REAL tips, one `git -C <root> show` per
 * source, and that is the whole point of it: nothing else in the product ever
 * prints them. `--status` shows the version and the commit time, `--probe`
 * names a tip only when one has MOVED, and the paths carry no source
 * attribution — so the literal `<frozen tip>` placeholder this replaces left
 * the one recovery instruction there is unexecutable, with the tips reachable
 * only by hand-reading `repo_state` out of the database. With more than one
 * clone the user tries each line; a source with no branch is omitted, since
 * {@link NO_ORPHAN_TIP} froze nothing to read from.
 *
 * Takes the record type itself rather than a structural restatement of it: a
 * shape change would be caught either way, but this is the only place the
 * field is rendered, so a field ADDED to it should show up here as an
 * unhandled part of a known type rather than be silently dropped.
 */
function reportUnreconciled(record: Pick<CutoverRecord, "tips" | "unreconciled">, full?: ReadonlyArray<string>): void {
	const un = record.unreconciled;
	if (!un?.count) return;
	console.log(
		`note: ${un.count} path(s) on the frozen branch are not reproduced by the database and are no longer served here.`,
	);
	// `full` when the cutover just ran (the whole set is still in memory), the
	// record's capped sample when this is `--status` reading it back.
	const paths = full ?? un.sample;
	for (const path of paths) console.log(`  ${path}`);
	if (un.count > paths.length) {
		// NOT "see debug.log". That line is rendered through the same 50-path cap,
		// so beyond it the remainder was in no output, no log and no stored row —
		// the recovery instruction below needs a path, and the user had no way to
		// obtain one. Say what is actually true instead, and do not promise the
		// remainder was ever shown: only THIS command prints the uncapped set, and
		// most cutovers are committed by an automatic caller (the dashboard sweep,
		// the post-commit drain) that prints nothing at all.
		console.log(
			`  … and ${un.count - paths.length} more that were not recorded — only the run that commits the cutover has the full set, and only 'jolli cutover' prints it.`,
		);
	}
	const frozen = Object.entries(record.tips).filter(([, tip]) => tip !== NO_ORPHAN_TIP);
	if (frozen.length === 0) return;
	console.log("  The branch is frozen, not deleted — read one with:");
	for (const [root, tip] of frozen) console.log(`    git -C "${root}" show ${tip}:<path>`);
}

/**
 * Prints the recorded refusal, if one still applies.
 *
 * Only for the two states an attempt could still move. Without it `uncutover` is
 * the same sentence for a repo nothing has tried yet and for one the engine has
 * already refused on grounds no retry can change — and this command is where a
 * user sent by the sweep's warning arrives to ask why.
 */
async function reportBlock(cwd: string): Promise<void> {
	const block = await readCutoverBlock(cwd);
	if (!block) return;
	console.log(`blocked: ${block.reason}`);
	console.log(
		`  (${block.code}, recorded ${new Date(block.at).toISOString()}; automatic attempts are skipped while the orphan branch is unchanged — 'jolli cutover' still runs one)`,
	);
}

async function showStatus(cwd: string): Promise<void> {
	const route = await resolveCutoverRoute(cwd);
	switch (route.state) {
		case "uncutover":
			console.log("state: uncutover — the orphan branch is this repo's source of truth");
			if (route.warning) console.log(`warning: ${route.warning}`);
			await reportBlock(cwd);
			break;
		case "legacy-fenced":
			console.log(
				"state: legacy-fenced — the orphan branch is frozen; writes go to SQLite. Run 'jolli cutover' to finish the commit.",
			);
			await reportBlock(cwd);
			break;
		case "cutover":
			console.log(
				`state: cutover (version ${route.record.cutoverVersion}, committed ${route.record.committedAt}) — SQLite is the source of truth`,
			);
			reportUnreconciled(route.record);
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
					// The uncapped list, not `record.unreconciled.sample`: this is the one
					// run that has it, and every path here is one the user may need to
					// read back off the frozen tip.
					reportUnreconciled(outcome.record, outcome.unreconciled);
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
