/**
 * StoredMemories — "does this backend hold any memories?", as a three-state
 * answer, for the callers that must not act on a guess.
 *
 * `StorageProvider.exists()` deliberately answers a DIFFERENT question — "is
 * the backend initialized?" — and the two used to coincide. On the orphan
 * branch, the branch existing WAS the data existing: nothing creates
 * `jollimemory/summaries/v3` except writing a summary to it. Past a cutover
 * that is no longer true. `SqliteStorage.exists()` is "the database opened and
 * this repo has a registry row", which every enabled repo satisfies from its
 * first `jolli enable`, memories or not.
 *
 * That silent change of meaning is only dangerous where the caller does
 * something destructive with the answer, which is why this is not a blanket
 * replacement for `exists()`: a gate that merely SKIPS work on a false
 * negative is fine (the next pass picks it up), and `SchemaV5Migration`
 * genuinely wants the initialization question. The rebuild path is the one
 * that archives the user's existing Memory Bank folders before re-migrating —
 * so on a cut-over repo with zero memories it archived the lot and migrated
 * nothing into a fresh folder.
 *
 * The third state is what keeps that safe. A read failure must not collapse
 * into "none": that is the same destructive branch reached for a different
 * reason, and after a cutover the database is the only source there is.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("StoredMemories");

/** `unknown` means the backend could not be read — never treat it as `none`. */
export type StoredMemoryPresence = "some" | "none" | "unknown";

/**
 * Whether `storage` holds at least one stored memory.
 *
 * Asks through `listFiles`, the one primitive every backend implements against
 * its real contents, rather than a backend-specific probe — a new backend gets
 * the right answer with no change here.
 */
export async function detectStoredMemories(storage: StorageProvider): Promise<StoredMemoryPresence> {
	try {
		// An uninitialized backend holds nothing, and `listFiles` on one is not
		// guaranteed to be cheap (or quiet) — ask the cheap question first.
		if (!(await storage.exists())) return "none";
		const summaries = await storage.listFiles("summaries/");
		return summaries.length > 0 ? "some" : "none";
	} catch (err) {
		log.warn("could not determine whether %s holds memories: %s", storage.kind, errMsg(err));
		return "unknown";
	}
}
