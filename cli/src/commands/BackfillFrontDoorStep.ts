/**
 * Cold-start back-fill step delegated by the guided front door.
 *
 * When the repo is in cold start — no memories yet, or the local user's own recent
 * commits (last {@link COLD_START_WINDOW_MS}) lack a summary — this offers to build
 * memories from those commits by reusing the shared {@link runBackfill} engine (one
 * LLM call per commit, locally). It is the CLI counterpart of the VS Code sidebar's
 * cold-start card, and shares the engine, the cold-start scope constants, and the
 * repo-wide dismiss flag ({@link RepoProfile}) with it.
 *
 * Contract (mirrors SpaceSyncStep): the front door calls this once, only when the
 * repo is enabled and memories can be generated. Everything cold-start lives here.
 * It NEVER throws into the front door — detection failures are logged at debug and
 * swallowed; the run itself only fails the offer, never the whole `jolli`.
 *
 * Three-way prompt: `[Y] yes` builds now (blocking, live progress, Ctrl-C aware),
 * `[n] not now` skips this run WITHOUT recording anything (so the next `jolli` asks
 * again), and `[d] don't ask again` records a sticky, permanent opt-out in the
 * repo profile. Any unrecognized answer is treated as `not now` — the safe
 * non-action, so a typo never spends LLM budget or permanently silences the offer.
 *
 * Blocking, not backgrounded: the front door is inherently synchronous (the user is
 * at the TTY), the offer is bounded to {@link COLD_START_CAP} commits, and each
 * commit's summary is stored immediately — so Ctrl-C is always safe and a re-run
 * resumes with only the still-missing commits. Large / scripted back-fills stay in
 * the standalone `jolli backfill` command.
 */

import {
	listMissingCommits,
	type MissingCommitInfo,
	repoHasAnyMemory,
	runBackfill,
} from "../backfill/BackfillEngine.js";
import { COLD_START_CAP, COLD_START_WINDOW_MS } from "../backfill/ColdStart.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { readRepoProfile, updateRepoProfile } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger } from "../Logger.js";
import { promptText } from "./CliUtils.js";

const log = createLogger("BackfillFrontDoorStep");

/**
 * Max chars of a commit subject, used identically for the offer list and the
 * progress line. Git subjects are conventionally ≤72, so 100 shows them in full;
 * the rare longer one is clipped the same way in both places.
 */
const SUBJECT_MAX = 100;

type Choice = "yes" | "no" | "dismiss";

/** Runs the cold-start back-fill axis of the guided front door. See the module docstring. */
export async function runBackfillFrontDoorStep(cwd: string): Promise<void> {
	// 1. No LLM credential → the front door can't build memories; stay silent.
	//    Read config fresh: an in-place key fix earlier in the front door may have
	//    just made generation possible, and the caller's snapshot is stale.
	if (resolveLlmCredentialSource(await loadConfig()) === null) return;

	// 2. Sticky, explicit opt-out → never offer again.
	let dismissed = false;
	try {
		dismissed = (await readRepoProfile(cwd)).backfillDismissed === true;
	} catch (err) {
		log.debug(`repo profile read failed: ${errMsg(err)}`);
	}
	if (dismissed) return;

	// 3. Cold-start detection (cheap — git log + orphan-branch index, no transcript
	//    scan / LLM). Any failure is best-effort: skip the offer, never block.
	let missing: MissingCommitInfo[];
	let hasMemory: boolean;
	try {
		missing = await listMissingCommits(cwd, COLD_START_WINDOW_MS, COLD_START_CAP);
		if (missing.length === 0) return; // nothing to build (fresh repo with no commits, or no gaps)
		hasMemory = await repoHasAnyMemory(cwd);
	} catch (err) {
		log.debug(`cold-start detection skipped: ${errMsg(err)}`);
		return;
	}

	// 4. Show the offer + the concrete commit list (subjects are free from git log).
	printOffer(hasMemory ? "gaps" : "empty", missing);

	// 5. Three-way prompt.
	const choice = parseChoice(await promptText("\n  Build them now?  [Y] yes  [n] not now  [d] don't ask again: "));
	if (choice === "no") {
		console.log("\n  No problem — run `jolli` again anytime to build them.\n");
		return;
	}
	if (choice === "dismiss") {
		try {
			await updateRepoProfile(cwd, { backfillDismissed: true });
		} catch (err) {
			log.debug(`repo profile write failed: ${errMsg(err)}`);
		}
		console.log("\n  Got it — I won't ask again in this repo. Run `jolli backfill` anytime to build them.\n");
		return;
	}

	// 6. Build (choice === "yes").
	await buildWithProgress(
		cwd,
		missing.map((m) => m.commitHash),
	);
}

/** Prints the cold-start offer headline plus the concrete commit list. */
function printOffer(variant: "empty" | "gaps", missing: ReadonlyArray<MissingCommitInfo>): void {
	if (variant === "empty") {
		console.log("\n  ✨ This repo has no memories yet. These recent commits can become memories:\n");
	} else {
		const n = missing.length;
		console.log(
			`\n  ✨ ${n} commit${n === 1 ? "" : "s"} from the last month ${n === 1 ? "doesn't" : "don't"} have a memory yet:\n`,
		);
	}
	for (const m of missing) {
		console.log(`     ${m.commitHash.slice(0, 7)}  ${truncate(m.subject, SUBJECT_MAX)}`);
	}
	// `>= cap` is the standard "list was capped, there may be more" heuristic (an
	// uncapped count isn't computed). The wording is true either way.
	if (missing.length >= COLD_START_CAP) {
		console.log(`\n     (showing the ${COLD_START_CAP} most recent — run \`jolli backfill\` for the rest)`);
	}
}

/**
 * Maps a prompt answer to a choice. Enter / y / yes → build; d / don't / never →
 * permanent dismiss; everything else (including n / no and any typo) → not now,
 * the safe non-action.
 */
function parseChoice(answer: string): Choice {
	const a = answer.trim().toLowerCase();
	if (a === "" || a === "y" || a === "yes") return "yes";
	if (a === "d" || a === "dont" || a === "don't" || a === "never") return "dismiss";
	return "no";
}

/**
 * Runs `runBackfill` blocking, with a single-line live progress readout and a
 * Ctrl-C handler. First Ctrl-C aborts cooperatively at the next commit boundary
 * (the in-flight commit finishes + stores); a second forces a hard exit. Either
 * way already-built memories are saved and a re-run resumes the rest.
 */
async function buildWithProgress(cwd: string, hashes: string[]): Promise<void> {
	const controller = new AbortController();
	let interrupts = 0;
	const onSigint = (): void => {
		interrupts++;
		if (interrupts === 1) {
			controller.abort();
			process.stderr.write("\n  Stopping… (finishing the current commit, or press Ctrl-C again to force quit)\n");
		} else {
			process.off("SIGINT", onSigint);
			process.exit(130);
		}
	};
	process.on("SIGINT", onSigint);
	try {
		console.log("\n  Building memories… one AI call per commit, locally. This may take a while.");
		console.log("  Press Ctrl-C anytime to stop — progress is saved and you can resume later.\n");
		let generated: number;
		try {
			const report = await runBackfill({
				cwd,
				hashes,
				signal: controller.signal,
				// Fires BEFORE each commit's generation, so a line appears as work starts
				// (not after it finishes) — the first commit's slow LLM call is no longer
				// silent. One permanent line per commit (no in-place rewrite) so the run
				// leaves a readable log. `index` is 1-based over the commits being built.
				onCommitStart: (index, total, hash, subject) => {
					const label = subject ? truncate(subject, SUBJECT_MAX) : hash.slice(0, 7);
					console.log(`  Building memories… ${index}/${total}  ${label}`);
				},
			});
			generated = report.generated;
		} catch (err) {
			log.debug(`back-fill run failed: ${errMsg(err)}`);
			console.log("\n  Couldn't build memories right now — run `jolli backfill` to try again.\n");
			return;
		}
		const memories = `${generated} ${generated === 1 ? "memory" : "memories"}`;
		if (controller.signal.aborted) {
			console.log(`\n  Stopped — ${memories} built and saved. Run \`jolli\` again to build the rest.\n`);
		} else {
			console.log(`\n  ✓ Built ${memories} from your history.\n`);
		}
	} finally {
		process.off("SIGINT", onSigint);
	}
}

/** Truncates to `max` chars with a trailing ellipsis. */
function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
