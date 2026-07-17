/**
 * `verify-publish-branch <expected> [actual]` — deterministically confirm a
 * local-run publish landed on the server-derived work branch. `<expected>` is the
 * run's `writeTarget.workBranch`; `[actual]` is the `headBranch` that `docs publish
 * --json` reported (the branch the PR was actually opened on). The `jolli-local-run`
 * recipe shells this between publish and complete so the branch comparison does not
 * rely on the LLM — the same actor whose dropped branch causes the mismatch.
 *
 * Output (always JSON on stdout, one line): `{ match, expected, actual }`.
 * Exit 0 when the branches match; exit 1 when they differ (or `headBranch` is
 * missing/empty — an unverifiable publish is treated as a mismatch, never a
 * silent success).
 */

import type { Command } from "commander";
import { checkPublishBranch } from "../core/WorkBranchCheck.js";

/** Registers the `verify-publish-branch` command on the given Commander program. */
export function registerVerifyPublishBranchCommand(program: Command): void {
	program
		.command("verify-publish-branch <expected> [actual]")
		.description(
			"Verify a local-run publish landed on the server work branch (compares expected workBranch to the published headBranch); prints { match, expected, actual }, exits non-zero on mismatch",
		)
		.action((expected: string, actual?: string) => {
			const result = checkPublishBranch(expected, actual ?? "");
			console.log(JSON.stringify(result));
			if (!result.match) {
				process.exitCode = 1;
			}
		});
}
