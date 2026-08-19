/**
 * Turns the stranded roots this repo currently has into a concrete, typed set
 * of repair actions — one per repair target — without executing anything.
 *
 * Grouping is the whole trick: several stranded roots pairing to the SAME
 * live commit is exactly what a squash looks like from this side, so they
 * become one `migrate` action with `needsLlm: true` rather than N separate
 * ones each clobbering the last.
 */
import { getIndex } from "../SummaryStore.js";
import { commitSubject, isReachableFromAnyRef, resolveCommitHash } from "./GitReachability.js";
import { type PairingResult, pairStrandedHash } from "./ReflogPairing.js";
import { findStrandedRoots, type StrandedTree } from "./StrandedTrees.js";

export type RepairAction =
	| {
			readonly kind: "migrate";
			readonly targetHash: string;
			readonly targetSubject: string | null;
			readonly sources: ReadonlyArray<StrandedTree>;
			readonly needsLlm: boolean;
	  }
	| {
			readonly kind: "remount";
			readonly targetHash: string;
			readonly targetSubject: string | null;
			readonly source: StrandedTree;
	  }
	| { readonly kind: "unpaired"; readonly source: StrandedTree; readonly reason: "none" | "conflict" }
	// A target that already has its own memory can only carry ONE stranded
	// source (remount's `source` field is singular). More than one landing on
	// such a target is a shape nobody has designed consolidation rules for —
	// `remountStrandedTree` itself refuses a target with existing children —
	// so this reports the situation instead of silently dropping the extras
	// or guessing at a merge.
	| {
			readonly kind: "unsupported";
			readonly targetHash: string;
			readonly targetSubject: string | null;
			readonly sources: ReadonlyArray<StrandedTree>;
			readonly reason: string;
	  };

export interface PlanDeps {
	readonly stranded?: ReadonlyArray<StrandedTree>;
	readonly pair?: (oldHash: string, cwd: string) => Promise<PairingResult>;
	readonly targetHasMemory?: (hash: string, cwd: string) => Promise<boolean>;
	readonly resolveTarget?: (ref: string, cwd: string) => Promise<string | null>;
	readonly isReachable?: (hash: string, cwd: string) => Promise<boolean>;
	readonly subjectOf?: (hash: string, cwd: string) => Promise<string | null>;
}

/**
 * Is `hash` a ROOT that already has a stored memory?
 *
 * The question the action dispatch needs, and deliberately not "does a blob
 * exist at `summaries/<hash>.json`" — that probe answers differently on the
 * two backends and would make the same repository plan differently before and
 * after cutover. On the orphan branch only roots have their own file (children
 * are embedded in the root blob), so a non-root answers `false`; on SQLite the
 * same path routes through `assembleMemoryTree`, which serves non-root hashes
 * too, so it answers `true`. Reachable after `git merge --squash`, where the
 * source commits survive and are another tree's children — and picking
 * `remount` there would write a hash as a root while it is still a child
 * elsewhere.
 *
 * The index carries the parent edge for every stored hash, so it answers both
 * halves at once and costs one read the caller may already have warm.
 */
async function defaultTargetHasMemory(hash: string, cwd: string): Promise<boolean> {
	const index = await getIndex(cwd);
	const entry = index?.entries.find((e) => e.commitHash === hash);
	// `== null` covers v3 roots (null) and v1 legacy entries (undefined) alike,
	// matching `SummaryStore`'s own `isRootEntry`.
	return entry !== undefined && entry.parentCommitHash == null;
}

async function actionFor(
	targetHash: string,
	sources: ReadonlyArray<StrandedTree>,
	cwd: string,
	targetHasMemory: (hash: string, cwd: string) => Promise<boolean>,
	subjectOf: (hash: string, cwd: string) => Promise<string | null>,
): Promise<RepairAction> {
	// Carried on the action, not looked up at render time: `--status` is the only
	// review a pairing gets before it is written, and two bare hashes cannot be
	// reviewed. The subject is what makes a wrong graft visible.
	const targetSubject = await subjectOf(targetHash, cwd);
	// A target that already has a memory must keep its own topics/recap, which
	// migrateOneToOne would overwrite — hence remount. Remount never calls an LLM.
	if (await targetHasMemory(targetHash, cwd)) {
		if (sources.length > 1) {
			return {
				kind: "unsupported",
				targetHash,
				targetSubject,
				sources,
				reason: `${sources.length} stranded trees pair to ${targetHash.substring(0, 8)}, which already has its own memory; remounting several trees onto one target is not supported`,
			};
		}
		const source = sources[0] as StrandedTree;
		return { kind: "remount", targetHash, targetSubject, source };
	}
	return { kind: "migrate", targetHash, targetSubject, sources, needsLlm: sources.length > 1 };
}

export async function buildRepairPlan(
	cwd: string,
	override?: { readonly from: string; readonly to: string },
	deps: PlanDeps = {},
): Promise<ReadonlyArray<RepairAction>> {
	const pair = deps.pair ?? ((hash: string, dir: string) => pairStrandedHash(hash, dir));
	const targetHasMemory = deps.targetHasMemory ?? defaultTargetHasMemory;
	const resolveTarget = deps.resolveTarget ?? resolveCommitHash;
	const isReachable = deps.isReachable ?? isReachableFromAnyRef;
	const subjectOf = deps.subjectOf ?? commitSubject;
	const stranded = deps.stranded ?? (await findStrandedRoots(cwd));

	// Explicit override: skip detection and pairing — but NOT validation.
	// `--from` is prefix-matched against a set we computed, so a bad one simply
	// finds nothing; `--to` names a commit only git knows about, and the spec's
	// rule for it is "target unreachable or absent -> refuse. Never guess a
	// target." Both checks are the override path's only enforcement of that,
	// since the reflog pairing that guarantees it elsewhere is exactly what
	// this branch bypasses. Resolving to the FULL sha additionally keeps an
	// abbreviated `--to` from selecting `migrate` for a target that has a
	// memory, which lands in migrateOneToOne's silent idempotency skip.
	if (override) {
		const matches = stranded.filter((s) => s.oldHash.startsWith(override.from));
		if (matches.length === 0) throw new Error(`no stranded memory tree found for ${override.from}`);
		// An ambiguous prefix refuses rather than repairing whichever is first —
		// the same guarantee `--to` gets from `rev-parse --verify`. The tool prints
		// 8-char hashes and invites abbreviation, so a collision is realistic and a
		// silent wrong-tree repair (reported as success) is the failure to prevent.
		if (matches.length > 1) {
			throw new Error(
				`--from ${override.from} is ambiguous — it matches ${matches.length} stranded memory trees ` +
					`(${matches.map((s) => s.oldHash.substring(0, 12)).join(", ")}); pass a longer prefix`,
			);
		}
		const source = matches[0];
		const targetHash = await resolveTarget(override.to, cwd);
		if (!targetHash) {
			throw new Error(`--to ${override.to} does not resolve to a commit in this repository`);
		}
		if (!(await isReachable(targetHash, cwd))) {
			throw new Error(
				`--to ${override.to} is not reachable from any ref — repairing onto it would leave the tree stranded again`,
			);
		}
		return [await actionFor(targetHash, [source], cwd, targetHasMemory, subjectOf)];
	}

	// Group by paired target: several sources landing on one target IS a squash.
	const byTarget = new Map<string, StrandedTree[]>();
	const unpaired: RepairAction[] = [];
	for (const source of stranded) {
		const result = await pair(source.oldHash, cwd);
		if (result.kind === "paired") {
			const group = byTarget.get(result.newHash) ?? [];
			group.push(source);
			byTarget.set(result.newHash, group);
		} else {
			unpaired.push({ kind: "unpaired", source, reason: result.kind });
		}
	}

	const actions: RepairAction[] = [];
	for (const [targetHash, sources] of byTarget) {
		actions.push(await actionFor(targetHash, sources, cwd, targetHasMemory, subjectOf));
	}
	return [...actions, ...unpaired];
}
