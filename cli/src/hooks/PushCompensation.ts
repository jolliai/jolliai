/**
 * PushCompensation — the "retry pending pushes on startup" entry point shared by
 * the three surfaces that activate Jolli Memory:
 *   - VS Code   `Extension.activate()`
 *   - IntelliJ  `JolliMemoryService.initialize()` (via the Kotlin port)
 *   - CLI       `jolli enable`
 *
 * Fire-and-forget: retries every under-the-ceiling entry in push-pending.json
 * (no hash filter). Fully guarded — a non-git directory, missing state file, or
 * network error must never surface to the caller or block activation.
 * `processPushPending` itself no-ops cleanly when there are no pending entries
 * or the user isn't signed in, so no pre-checks are needed here.
 */

import { processPushPending } from "../core/PushExecutor.js";
import { createLogger, errMsg } from "../Logger.js";

const log = createLogger("PushCompensation");

/**
 * Retries all pending pushes for `cwd`. Never throws — failures are logged at
 * debug and left in push-pending.json for the next trigger.
 */
export async function triggerPendingPushRetry(cwd: string): Promise<void> {
	try {
		const result = await processPushPending(cwd, { source: "activation" });
		if (result.attempted > 0) {
			log.info(
				"Activation push retry: attempted=%d pushed=%d failed=%d",
				result.attempted,
				result.pushed,
				result.failed,
			);
		}
	} catch (err) {
		log.debug("Activation push retry failed (will retry later): %s", errMsg(err));
	}
}
