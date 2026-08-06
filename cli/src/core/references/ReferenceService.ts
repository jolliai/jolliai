/**
 * ReferenceService — registry-level operations on `plans.json.references`.
 *
 * Split from {@link ReferenceStore} (which owns the per-reference markdown
 * files) because the registry writers live in `SessionTracker`, and
 * `SessionTracker` already imports `ReferenceStore` — putting these here keeps
 * that dependency one-directional.
 *
 * SHARED BY BOTH IDE HOSTS: VS Code imports this in-process, IntelliJ reaches
 * it over `jolli ide-bridge`. See the `cli/src/core/PlanService.ts` header for
 * why host-side re-implementations of these rules are a defect.
 */

import type { PlansRegistry } from "../../Types.js";
import { withPlansLock } from "../Locks.js";
import { loadPlansRegistry, savePlansRegistry } from "../SessionTracker.js";
import { deleteReferenceMarkdown } from "./ReferenceStore.js";

/**
 * Hard-removes a reference, keyed by mapKey (`<source>:<nativeId>`): deletes the
 * registry row AND the backing
 * `.jolli/jollimemory/references/<source>/<key>.md` file.
 *
 * Reference markdown always lives inside the per-project `.jolli/jollimemory/`
 * directory, so the file is always safe to delete — no internal/external check
 * needed (contrast `PlanService.removePlan`, whose source files are usually
 * external). Idempotent: an unknown mapKey is a no-op, and a missing `.md` is
 * tolerated (`deleteReferenceMarkdown` uses `force`).
 *
 * Allows revival: removal leaves no tombstone, so a later re-reference of the
 * same entity is re-discovered and re-inserted. The registry's plans / notes
 * section is preserved verbatim.
 */
export async function removeReference(cwd: string, mapKey: string): Promise<void> {
	// Registry RMW under plans.lock so a concurrent writer (an IDE host's
	// discovery tick, or a cross-process StopHook/QueueWorker) can't clobber the
	// removal (or be clobbered by it). The closure returns the removed entry's
	// sourcePath; the markdown delete happens AFTER the lock — persisting the row
	// removal first, then a best-effort file cleanup, is strictly safer than the
	// reverse (a failed save would otherwise leave a row with no backing file).
	const removedSourcePath = await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		const existing = { ...(registry.references ?? {}) };
		const entry = existing[mapKey];
		if (!entry) return null;
		delete existing[mapKey];
		const out: PlansRegistry = {
			version: 1,
			plans: registry.plans,
			...(registry.notes !== undefined ? { notes: registry.notes } : {}),
			references: existing,
			// Carried, not dropped: removing one reference from the panel must not erase
			// the skill registry. See PlansRegistryWriters.test.ts.
			...(registry.skills !== undefined ? { skills: registry.skills } : {}),
		};
		await savePlansRegistry(out, cwd);
		return entry.sourcePath;
	});
	if (removedSourcePath === null) return;
	// Best-effort file delete — a permission/lock error (Windows EPERM/EBUSY)
	// must not strand anything; mirrors PlanService.removePlan / NoteService.removeNote.
	// deleteReferenceMarkdown already tolerates ENOENT.
	try {
		await deleteReferenceMarkdown(removedSourcePath);
	} catch {
		/* registry row is already removed */
	}
}
