/**
 * UiTelemetry — thin, unit-testable helpers for VS Code click-layer telemetry
 * (JOLLI-1904). The UI runs in-process (not via commander), so button clicks get
 * no `command_invoked` fallback and must `track()` explicitly. Event names +
 * prop shapes mirror the IntelliJ implementation so both surfaces aggregate
 * together (`surface` is auto-injected at build time).
 *
 * Only emits that need real logic (async gathering, bucketing) live here; a
 * trivial `track("name")` at a call site doesn't need a wrapper.
 */
import { bucket, track } from "../../../cli/src/core/Telemetry.js";

/**
 * `memory_committed` — the user committed a memory via the Commit button.
 * Mirrors IntelliJ CurrentMemoryPanel: bucketed changed-file count, whether any
 * active conversations exist, and bucketed context (plans) count. Counts go
 * through `bucket()` (never raw, for privacy). Best-effort and never throws —
 * telemetry must not disturb the commit. Gather the (async) conversation count
 * off the click path so this never delays committing.
 */
export async function trackMemoryCommitted(deps: {
	readonly getFilesCount: () => number;
	readonly getContextCount: () => number;
	readonly listConversations: () => Promise<readonly unknown[]>;
}): Promise<void> {
	try {
		// All reads happen inside the try so a store snapshot / conversation read
		// that throws degrades to "no event", never an error in the commit flow.
		const files = deps.getFilesCount();
		const context = deps.getContextCount();
		const conversations = (await deps.listConversations()).length;
		track("memory_committed", {
			files_bucket: bucket(files),
			has_conversations: conversations > 0,
			context_bucket: bucket(context),
		});
	} catch {
		// telemetry is best-effort — never surface an error into the commit flow
	}
}
