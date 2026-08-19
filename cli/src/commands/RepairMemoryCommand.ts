/**
 * RepairMemoryCommand — `jolli repair-memory`: the user-facing entry to
 * reattaching memory trees an amend, rebase or squash stranded under a commit
 * hash the branch no longer has. Mirrors `jolli cutover` / `--status` (repair
 * by default, `--status` inspects without writing) rather than
 * `doctor` / `--fix`.
 *
 * `buildRepairPlan` does the detection and pairing; `executeRepairs` does the
 * writes. This module is presentation only: render the plan, honor
 * `--status`, and refuse to run against a manually-disabled repo.
 */

import type { Command } from "commander";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { executeRepairs } from "../core/repair/RepairExecutor.js";
import type { RepairAction } from "../core/repair/RepairPlan.js";
import { buildRepairPlan } from "../core/repair/RepairPlan.js";
import type { StrandedTree } from "../core/repair/StrandedTrees.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

const SUBJECT_WIDTH = 64;

/** First line of a commit message, trimmed to one terminal-friendly column. */
function oneLine(text: string | null | undefined): string {
	const first = (text ?? "").split("\n")[0]?.trim() ?? "";
	if (first.length === 0) return "(no commit message)";
	return first.length > SUBJECT_WIDTH ? `${first.substring(0, SUBJECT_WIDTH - 1)}…` : first;
}

/**
 * A source's own line. The subject comes from the STORED summary rather than
 * from git: a stranded hash is unreachable by definition and may have been
 * gc'd, and what the memory says about itself is the thing being moved anyway.
 */
function sourceLine(source: StrandedTree): string {
	return `    ← ${source.oldHash.substring(0, 8)}  ${oneLine(source.root.commitMessage)}`;
}

/**
 * Renders one action, over several lines where it has sources to name.
 *
 * Every `RepairAction` kind must render here — a branch silently falling
 * through to the previous arm's text (or to `undefined`) is exactly the
 * blank-or-wrong-line failure this command exists to avoid for the one case
 * (`unsupported`) that is telling the user something they cannot otherwise
 * discover.
 *
 * Both ends of a pairing carry their commit subject, and that is not
 * decoration. `--status` is the only review a proposed pairing gets before it
 * is written, and this tool's one failure mode is grafting a tree onto the
 * wrong commit — twice, on real data. As two hashes that is invisible; as
 * `Fix transcript token stats` under `chore(deps): bump actions/setup-java` it
 * is obvious. `migrate` in particular used to print only a source COUNT, so
 * the reviewable fact was the one fact withheld.
 */
function describeAction(action: RepairAction): string {
	if (action.kind === "unpaired") {
		return `${action.source.oldHash.substring(0, 8)}: no target (${action.reason}) — pass --from/--to  ${oneLine(action.source.root.commitMessage)}`;
	}
	const target = `${action.targetHash.substring(0, 8)}  ${oneLine(action.targetSubject)}`;
	if (action.kind === "remount") {
		const { conversationCount, skillCount } = action.source;
		return [
			`remount → ${target}`,
			sourceLine(action.source),
			`      restores ${conversationCount} conversation(s), ${skillCount} skill(s)`,
		].join("\n");
	}
	if (action.kind === "unsupported") {
		// `reason` is already a complete sentence — render it, don't paraphrase.
		return [`unsupported → ${target}`, ...action.sources.map(sourceLine), `      ${action.reason}`].join("\n");
	}
	const conversations = action.sources.reduce((n, s) => n + s.conversationCount, 0);
	const skills = action.sources.reduce((n, s) => n + s.skillCount, 0);
	const llm = action.needsLlm ? " [calls the LLM]" : "";
	return [
		`migrate → ${target}`,
		...action.sources.map(sourceLine),
		`      restores ${conversations} conversation(s), ${skills} skill(s)${llm}`,
	].join("\n");
}

/** Registers the `repair-memory` sub-command on the given Commander program. */
export function registerRepairMemoryCommand(program: Command): void {
	program
		.command("repair-memory")
		.description("Reattach memory trees stranded by an amend, rebase or squash")
		.option("--status", "Show what would be repaired without changing anything")
		.option("--from <hash>", "Stranded commit hash (when the reflog cannot pair it)")
		.option("--to <hash>", "Target commit hash to reattach it under")
		.option("--no-llm", "Merge squashed sources mechanically instead of calling the LLM")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (opts) => {
			const cwd = opts.cwd as string;
			setLogDir(cwd);
			if ((opts.from === undefined) !== (opts.to === undefined)) {
				console.error("--from and --to must be given together");
				process.exitCode = 1;
				return;
			}

			// `--status` is read-only and may still report on a manually-disabled
			// repo; the actual repair path must not, since `remountStrandedTree`
			// (and every other write path) no-ops under a manual disable —
			// without this guard the command would run, claim `ok: true` for
			// every action, and change nothing, the exact silent-success shape
			// this feature exists to remove.
			if (!opts.status) {
				const disabled = await readManualDisableFlag(cwd);
				if (disabled) {
					console.error(
						"Jolli Memory is manually disabled for this repo — run `jolli enable` to re-enable before repairing.",
					);
					process.exitCode = 1;
					return;
				}
			}

			const override = opts.from ? { from: opts.from as string, to: opts.to as string } : undefined;
			// Two things throw here, and both are rejected preconditions rather
			// than faults, so neither may reach `Cli.ts`'s top-level handler,
			// which prints `Fatal error: Error: <message>` with a stack trace.
			//
			// `createStorage` throws for a `blocked` cutover state. Establishing
			// the configured backend is not optional: every store call below is
			// made without threading `storage`, so without this they fall through
			// `resolveStorage` to the system of record, bypassing
			// `DualWriteStorage` — on an uncutover repo each repaired tree lands
			// on the orphan branch while the Memory Bank copy silently misses it,
			// with only one WARN per write to say so.
			//
			// `buildRepairPlan`'s override branch throws on bad user input — a
			// `--from` matching no stranded tree, a `--to` git cannot resolve or
			// one that is itself unreachable.
			let plan: ReadonlyArray<RepairAction>;
			try {
				setActiveStorage(await createStorage(cwd, cwd));
				plan = await buildRepairPlan(cwd, override);
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
				return;
			}

			if (plan.length === 0) {
				console.log("No stranded memory trees.");
				return;
			}
			for (const action of plan) console.log(describeAction(action));

			if (opts.status) return;

			// `--no-llm` arrives from commander as `opts.llm === false`, not `opts.noLlm`.
			const outcomes = await executeRepairs(plan, cwd, { useLlm: opts.llm !== false });
			for (const outcome of outcomes) {
				console.log(outcome.ok ? `✓ ${describeAction(outcome.action)}` : `✗ ${outcome.error}`);
			}
			if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
		});
}
