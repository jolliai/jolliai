/**
 * SkillArchive — freeze captured skill usage onto a commit.
 *
 * Runs at post-commit time, between `detectActiveSkillsForBranch` and
 * `SummaryStore.storeSkills`. Parallel to the plan / note / reference archival
 * steps in QueueWorker, but kept in its own module rather than added to that
 * file: the logic is pure enough to test directly against a temp directory,
 * whereas QueueWorker's tests need the whole pipeline stood up.
 *
 * **Archival is a copy, not a re-render.** The working-area markdown written at
 * capture time is read byte-for-byte and handed to the caller to store. Rendering
 * from the registry row here would put the display format in a second place and
 * let the two drift apart silently.
 *
 * **The working row is guarded, not deleted** — the plan/note lifecycle, not the
 * reference one. `commitHash` + `contentHashAtCommit` are set on the row that is
 * already there. That matters for a skill specifically: a skill archived onto one
 * commit can be entered again during the next piece of work, and the guard hash
 * changing is the signal that there is fresh content to archive.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLogger } from "../../Logger.js";
import type { PlansRegistry, SkillCommitRef, SkillEntry, SkillSource } from "../../Types.js";
import { withPlansLock } from "../Locks.js";
import { loadPlansRegistry, savePlansRegistry } from "../SessionTracker.js";
import { archivedTotalsOf, uncommittedDelta } from "./SkillDelta.js";
import { sanitizeSkillIdForPath } from "./SkillStore.js";

const log = createLogger("SkillArchive");

/** A skill markdown file to write to the orphan branch. */
export interface SkillFileWrite {
	readonly path: string;
	readonly content: string;
}

export interface AssociateSkillsResult {
	/** Post-archive snapshots for `CommitSummary.skills`. */
	readonly refs: ReadonlyArray<SkillCommitRef>;
	/** Raw working-file bytes for `SummaryStore.storeSkills`. */
	readonly filesToStore: ReadonlyArray<SkillFileWrite>;
}

/**
 * Orphan-branch path for an archived skill: `skills/<source>/<stem>-<shortHash>.md`.
 *
 * The `<source>` segment is required, mirroring how references are laid out. The
 * design sketched a flat `skills/<slug>-<hash>.md`, but the registry key is
 * `<source>:<skill>` — two hosts can hold the same skill id, and a flat layout
 * would archive one over the other. `<stem>` comes from the same sanitizer the
 * working-area file uses, so an id from an untrusted transcript cannot shape the
 * path.
 */
export function skillOrphanPath(source: SkillSource, skill: string, shortHash: string): string {
	return `skills/${source}/${sanitizeSkillIdForPath(skill)}-${shortHash}.md`;
}

/**
 * Archive every uncommitted skill row onto `commitHash`.
 *
 * The caller must pass `filesToStore` to `SummaryStore.storeSkills` and `refs`
 * onto the `CommitSummary`. Rows are guarded here BEFORE the orphan write, which
 * is the opposite of the reference flow's write-ahead ordering — safe because a
 * guarded skill row is never deleted, so a failed orphan write leaves the row
 * recoverable rather than lost, and the guard clears no data.
 */
export async function associateSkillsWithCommit(
	commitHash: string,
	cwd: string,
	_branch: string,
	excludedKeys: ReadonlySet<string> = new Set(),
): Promise<AssociateSkillsResult> {
	const shortHash = commitHash.substring(0, 8);
	const refs: SkillCommitRef[] = [];
	const filesToStore: SkillFileWrite[] = [];

	await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		const skills = registry.skills;
		if (skills === undefined || Object.keys(skills).length === 0) return;

		const updated: Record<string, SkillEntry> = { ...skills };
		let changed = false;

		for (const [mapKey, entry] of Object.entries(skills)) {
			// What belongs on this commit is the INCREMENT since the last archive, not
			// the row's running total. A skill entered again after being frozen onto
			// commit A must still archive onto commit B — carrying only B's share, so
			// the PR-wide aggregate (a plain sum across commits) cannot re-count A.
			//
			// `commitHash` is deliberately NOT consulted here: it is set on every
			// archive and never cleared, so gating on it froze a re-used skill out of
			// every later commit permanently.
			const delta = uncommittedDelta(entry);
			if (delta === undefined) continue;

			// Exclusions are applied HERE, not to the returned refs: this function has
			// side effects (guards the row, emits bytes to store), so a post-filter would
			// leave an excluded skill archived on the orphan branch anyway. Skipping
			// association is also not a delete — the row keeps commitHash null and comes
			// back on the panel for the next commit.
			if (excludedKeys.has(mapKey)) continue;

			const content = await readWorkingFile(entry.sourcePath);
			if (content === undefined) {
				// Nothing to copy means nothing to archive. Emitting a ref anyway would
				// point the commit summary at a file that was never written.
				log.warn("Skill working file missing, skipping archive: %s", entry.sourcePath);
				continue;
			}

			refs.push({
				archivedKey: `${mapKey}-${shortHash}`,
				source: entry.source,
				skill: entry.skill,
				...(entry.plugin !== undefined ? { plugin: entry.plugin } : {}),
				entryPaths: entry.entryPaths,
				invocationCount: delta.invocationCount,
				firstUsedAt: entry.firstUsedAt,
				lastUsedAt: entry.lastUsedAt,
				...(delta.usage !== undefined ? { usage: delta.usage } : {}),
				// Snapshotted so a post-commit detach can still subtract the right session.
				...(delta.usageBySession !== undefined ? { usageBySession: delta.usageBySession } : {}),
				// Carried onto the commit so an archived heuristic entry still reads as
				// inferred. Dropping it here would silently promote a guess to an
				// observation the moment the commit landed.
				...(entry.detection !== undefined ? { detection: entry.detection } : {}),
			});

			filesToStore.push({
				path: skillOrphanPath(entry.source, entry.skill, shortHash),
				content,
			});

			// Hash the bytes we are actually archiving, so a later re-entry that
			// rewrites the file reads as changed against exactly what was stored.
			updated[mapKey] = {
				...entry,
				commitHash,
				contentHashAtCommit: createHash("sha256").update(content).digest("hex"),
				// The new baseline is the row's CURRENT total, not the delta just written:
				// everything up to here is now accounted for on some commit.
				archivedTotals: archivedTotalsOf(entry),
			};
			changed = true;
			log.info("Skill archived: %s → %s", mapKey, `${mapKey}-${shortHash}`);
		}

		if (!changed) return;

		// Reload inside the lock before saving: a concurrent StopHook or discovery
		// tick may have added an unrelated row between our read and this write.
		const fresh = await loadPlansRegistry(cwd);
		const out: PlansRegistry = { ...fresh, skills: { ...fresh.skills, ...pickArchived(updated, skills) } };
		await savePlansRegistry(out, cwd);
	});

	return { refs, filesToStore };
}

/**
 * Only the rows this run actually guarded, so the merge onto a freshly-loaded
 * registry cannot revert a concurrent writer's change to a different row.
 */
function pickArchived(
	updated: Readonly<Record<string, SkillEntry>>,
	before: Readonly<Record<string, SkillEntry>>,
): Record<string, SkillEntry> {
	const out: Record<string, SkillEntry> = {};
	for (const [key, entry] of Object.entries(updated)) {
		if (entry !== before[key]) out[key] = entry;
	}
	return out;
}

async function readWorkingFile(sourcePath: string): Promise<string | undefined> {
	try {
		return await readFile(sourcePath, "utf-8");
	} catch {
		return undefined;
	}
}
