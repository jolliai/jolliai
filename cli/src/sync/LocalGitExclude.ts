/**
 * Per-clone exclude file shim for `.git/info/exclude`.
 *
 * **Why this exists.** The engine-owned quarantine directory
 * (`.jolli-quarantine-corrupt/`) must never reach the orphan history.
 * `MemoryBankBootstrap.ensureBootstrap`'s `.gitignore` template denies
 * everything by default (`*` + `!.gitignore`), so post-bootstrap nothing
 * sneaks in — but bootstrap runs AFTER the pre-pullRebase auto-reconcile,
 * and the auto-reconcile path can create quarantine dirs that need to be
 * excluded before bootstrap touches `.gitignore`. Pre-bootstrap, also,
 * the working tree may have no `.gitignore` at all.
 *
 * `.git/info/exclude` solves it cleanly: same syntax as `.gitignore`,
 * applied as if it were a top-level project gitignore, but **per-clone
 * only — never tracked, never pushed, never pulled**. Engine owns
 * `.git/` so it can write here without coordinating with bootstrap.
 *
 * **Idempotency.** Each pattern is appended at most once. The file is
 * created with a header comment if absent. Concurrent calls within a
 * single round are serialised by the engine's `sync.lock`; cross-round
 * races would still produce a duplicate line which git tolerates (just
 * costs a few bytes).
 *
 * **What we don't do.**
 *   - Rewrite the file's pre-existing content. Anything the user added
 *     by hand to `.git/info/exclude` is preserved verbatim.
 *   - Remove patterns. If a quarantine directory is renamed in a future
 *     refactor, the stale entry becomes harmless dead config.
 *   - Negate or scope. The pattern is a plain top-level rule; callers
 *     pass the same shape they would use in `.gitignore`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("Sync:LocalGitExclude");

const HEADER = "# Jolli Memory engine-owned exclusions (per-clone; not tracked)\n";

/**
 * Appends `pattern` to `<memoryBankRoot>/.git/info/exclude` exactly
 * once. Returns `true` if the pattern is now present (whether newly
 * added or already there), `false` if the write failed.
 *
 * Failure is non-fatal — the engine's behavioural contract is "never
 * propagate quarantine contents", and the dot-prefixed quarantine
 * directories are still covered by `MemoryBankBootstrap`'s `.gitignore`
 * once bootstrap runs. The window this helper closes is only the
 * first-round-before-bootstrap edge case, so a single missed write
 * means we fall back to the pre-fix (bootstrap-only) behaviour for one
 * round — annoying but not unsafe.
 */
export async function appendLocalExclude(memoryBankRoot: string, pattern: string): Promise<boolean> {
	const infoDir = join(memoryBankRoot, ".git", "info");
	const excludePath = join(infoDir, "exclude");

	let existing = "";
	try {
		existing = await readFile(excludePath, "utf-8");
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			/* v8 ignore start -- defensive: readFile on a path inside `.git/` (which the caller has already guaranteed exists for fetch/clone to have succeeded) only fails with non-ENOENT for permission glitches / fs corruption */
			log.warn("read %s failed (will attempt write anyway): %s", excludePath, err.message);
			/* v8 ignore stop */
		}
	}

	// Match the pattern on a whole-line basis so a longer line that
	// happens to contain `pattern` as a substring doesn't suppress the
	// append (e.g. a user-authored `!my-.jolli-quarantine-corrupt-file`
	// negation wouldn't keep us from writing `.jolli-quarantine-corrupt/`).
	const lines = existing.split(/\r?\n/);
	if (lines.includes(pattern)) {
		return true;
	}

	try {
		await mkdir(infoDir, { recursive: true });
		const prefix = existing.length === 0 ? HEADER : existing.endsWith("\n") ? "" : "\n";
		const next = `${existing}${prefix}${pattern}\n`;
		await writeFile(excludePath, next, "utf-8");
		return true;
	} catch (e) {
		/* v8 ignore start -- mkdir / writeFile failure inside `.git/info` is fs-corruption / read-only territory; logged but non-fatal per the helper's contract */
		log.warn("append to %s failed: %s", excludePath, (e as Error).message);
		return false;
		/* v8 ignore stop */
	}
}
