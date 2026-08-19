/**
 * Executes a `RepairPlan`'s actions one at a time, backing up every root the
 * write is about to touch first — `storeSummary` overwrites and the SQLite
 * upsert replaces `summary_json`, so there is no second copy of what an
 * action is about to clobber otherwise.
 *
 * Each action's failure is isolated: one bad target must not stop the rest
 * of the repair from landing, so failures are collected into the returned
 * outcomes rather than thrown.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../../Logger.js";
import type { CommitInfo, CommitSummary } from "../../Types.js";
import { getCommitInfo } from "../GitOps.js";
import { type ConsolidationFailurePolicy, consolidateSquashSources } from "../SquashConsolidation.js";
import {
	type ConsolidatedTopics,
	getSummary,
	type MergeManyToOneOptions,
	mergeManyToOne,
	migrateOneToOne,
	remountStrandedTree,
} from "../SummaryStore.js";
import type { RepairAction } from "./RepairPlan.js";

export interface RepairOutcome {
	readonly action: RepairAction;
	readonly ok: boolean;
	readonly error?: string;
}

export interface ExecutorDeps {
	readonly useLlm: boolean;
	readonly remount?: (target: CommitSummary, stranded: CommitSummary, cwd: string) => Promise<void>;
	readonly readTarget?: (hash: string, cwd: string) => Promise<CommitSummary | undefined>;
	readonly getCommitInfo?: (hash: string, cwd: string) => Promise<CommitInfo>;
	readonly migrateOneToOne?: (oldSummary: CommitSummary, newCommitInfo: CommitInfo, cwd: string) => Promise<void>;
	readonly consolidateSquashSources?: (
		oldSummaries: ReadonlyArray<CommitSummary>,
		commitMessage: string,
		opts: { readonly onFailure: ConsolidationFailurePolicy; readonly useLlm: boolean },
	) => Promise<ConsolidatedTopics & { readonly status: "llm" | "mechanical" }>;
	readonly mergeManyToOne?: (
		oldSummaries: ReadonlyArray<CommitSummary>,
		newCommitInfo: CommitInfo,
		cwd: string,
		options?: MergeManyToOneOptions,
	) => Promise<{ orphanedDocIds: number[] }>;
}

async function defaultReadTarget(hash: string, cwd: string): Promise<CommitSummary | undefined> {
	const summary = await getSummary(hash, cwd);
	return summary ?? undefined;
}

/** `migrateOneToOne`'s real signature carries an optional metadata tail; repair always tags rebase. */
async function defaultMigrateOneToOne(
	oldSummary: CommitSummary,
	newCommitInfo: CommitInfo,
	cwd: string,
): Promise<void> {
	await migrateOneToOne(oldSummary, newCommitInfo, cwd, { commitType: "rebase" });
}

/**
 * Every commit hash in a stored tree, root included.
 */
function treeHashes(root: CommitSummary): Set<string> {
	const seen = new Set<string>();
	const visit = (node: CommitSummary): void => {
		seen.add(node.commitHash);
		for (const child of node.children ?? []) visit(child);
	};
	visit(root);
	return seen;
}

/**
 * Re-reads the target and confirms every source hash is now INSIDE its tree,
 * returning an error message when it is not.
 *
 * `ok: true` must mean "the write landed", never "no exception was thrown" —
 * this command exists precisely because nothing reported that a tree was
 * broken, so reporting a success without evidence is the wrong default here
 * specifically. Two write paths return silently with nothing to catch:
 * `migrateOneToOneLocked` skips whenever the target hash is already in the
 * index (routine after `git merge --squash`, where the source commits stay
 * reachable and are memory children), and `remountStrandedTree` returns under
 * `isManuallyDisabled()` — the command guards that, but `executeRepairs` is a
 * library entry point and the guard is not where the write is.
 *
 * This is also the idempotency property the spec claims: a repaired source is
 * no longer a root, so detection stops matching it.
 */
async function verifyLanded(
	targetHash: string,
	sourceHashes: ReadonlyArray<string>,
	cwd: string,
	readTarget: (hash: string, cwd: string) => Promise<CommitSummary | undefined>,
): Promise<string | null> {
	const after = await readTarget(targetHash, cwd);
	if (!after) {
		return `target ${targetHash.substring(0, 8)} still has no stored memory — the repair wrote nothing`;
	}
	const present = treeHashes(after);
	const missing = sourceHashes.filter((h) => !present.has(h));
	if (missing.length === 0) return null;
	return `${missing.map((h) => h.substring(0, 8)).join(", ")} still not attached under ${targetHash.substring(0, 8)} — the repair wrote nothing`;
}

/**
 * Writes every root this action is about to overwrite into `backupDir`,
 * as plain JSON files named by commit hash. Called BEFORE the action's own
 * write, one backup directory per `executeRepairs` call (not per action) so
 * a whole repair run's backups sit together.
 */
async function backupBeforeWrite(
	backupDir: string,
	roots: ReadonlyArray<CommitSummary>,
	target: CommitSummary | undefined,
): Promise<void> {
	await mkdir(backupDir, { recursive: true });
	const affected = target ? [...roots, target] : roots;
	for (const root of affected) {
		await writeFile(join(backupDir, `${root.commitHash}.json`), JSON.stringify(root, null, 2), "utf8");
	}
}

export async function executeRepairs(
	actions: ReadonlyArray<RepairAction>,
	cwd: string,
	opts: ExecutorDeps,
): Promise<ReadonlyArray<RepairOutcome>> {
	const remount = opts.remount ?? ((t, s, dir) => remountStrandedTree(t, s, dir));
	const readTarget = opts.readTarget ?? defaultReadTarget;
	const backupDir = join(getJolliMemoryDir(cwd), "repair-backups", new Date().toISOString().replace(/[:.]/g, "-"));
	const outcomes: RepairOutcome[] = [];

	// NO outer lock here: every write path below (remountStrandedTree,
	// migrateOneToOne, mergeManyToOne) takes withRequiredOrphanWriteLock
	// itself. The lock refuses even its own PID, so an outer acquisition
	// would make each inner acquire poll out its full 30s budget and then
	// report contention -- a log line indistinguishable from real
	// contention -- while the write silently never lands.
	for (const action of actions) {
		if (action.kind === "unpaired") {
			outcomes.push({
				action,
				ok: false,
				error: `no repair target for ${action.source.oldHash.substring(0, 8)} (${action.reason})`,
			});
			continue;
		}
		// A target that already has its own memory can only take ONE stranded
		// source (see RepairPlan's `unsupported` docs). Nothing to write, nothing
		// to back up -- report the reason the plan already worked out.
		if (action.kind === "unsupported") {
			outcomes.push({ action, ok: false, error: action.reason });
			continue;
		}
		try {
			const roots = action.kind === "remount" ? [action.source.root] : action.sources.map((s) => s.root);
			const target = await readTarget(action.targetHash, cwd);
			await backupBeforeWrite(backupDir, roots, target);
			if (action.kind === "remount") {
				if (!target) throw new Error(`target ${action.targetHash.substring(0, 8)} has no stored memory`);
				await remount(target, action.source.root, cwd);
			} else {
				await executeMigrate(action, cwd, opts);
			}
			const failure = await verifyLanded(
				action.targetHash,
				roots.map((r) => r.commitHash),
				cwd,
				readTarget,
			);
			outcomes.push(failure ? { action, ok: false, error: failure } : { action, ok: true });
		} catch (err) {
			outcomes.push({ action, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return outcomes;
}

/**
 * `onFailure: "throw"` is the repair-side policy: a genuine LLM failure
 * surfaces and points the user at `--no-llm` rather than silently degrading
 * to a mechanical merge. A `"no-content"` outcome (nothing to consolidate)
 * is healthy under this policy too and returns a mechanical result — it
 * never throws.
 */
async function executeMigrate(
	action: Extract<RepairAction, { kind: "migrate" }>,
	cwd: string,
	opts: ExecutorDeps,
): Promise<void> {
	const getCommitInfoFn = opts.getCommitInfo ?? getCommitInfo;
	const migrateOneToOneFn = opts.migrateOneToOne ?? defaultMigrateOneToOne;
	const consolidateFn = opts.consolidateSquashSources ?? consolidateSquashSources;
	const mergeManyToOneFn = opts.mergeManyToOne ?? mergeManyToOne;

	const commitInfo = await getCommitInfoFn(action.targetHash, cwd);
	const sources = action.sources.map((s) => s.root);
	if (sources.length === 1) {
		await migrateOneToOneFn(sources[0] as CommitSummary, commitInfo, cwd);
		return;
	}
	const consolidated = await consolidateFn(sources, commitInfo.message, {
		onFailure: "throw",
		useLlm: opts.useLlm,
	});
	await mergeManyToOneFn(sources, commitInfo, cwd, { consolidated });
}
