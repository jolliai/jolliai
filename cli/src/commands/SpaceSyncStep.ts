/**
 * Cloud sync / Space-binding step delegated by the guided front door.
 *
 * The guided front door (`runGuidedFrontDoor`) owns the auth + enable axes and
 * calls this once whenever the repo is in the enabled state. Everything about
 * getting memories into a Jolli Space — unbound detection, single/multi Space
 * binding, and every sync-related user prompt — belongs here, not in the front
 * door. Kept in its own module so the front door's tests can mock it.
 *
 * Contract for the implementer:
 *   - Called only on an interactive TTY (the front door guards this) and only
 *     when the repo is enabled. Whether the user is signed in / has a Jolli API
 *     key is this function's own concern — return quietly when there is none.
 *   - Called on EVERY bare `jolli` that reaches the enabled state, so this owns
 *     the setup-if-needed decision: return fast and silently once the repo is
 *     bound and synced; do not hit the network every time.
 *   - A 409 "binding already exists" must be handled fail-closed: treat it as
 *     success only when the existing space id matches the requested one;
 *     otherwise surface an error and stop, never silently pushing memories to
 *     the wrong Space (mirror pushBranchToJolli's existing behaviour).
 *   - Push catch-up is already triggered by the front door whenever the repo is
 *     enabled; re-trigger here only if needed (it is idempotent).
 *
 * Currently a stub: prints a development-only placeholder so the front door's
 * call site and timing can be exercised end-to-end. Replace the body with the
 * real push / sync / Space orchestration.
 */
export async function runSpaceSyncStep(cwd: string): Promise<void> {
	void cwd;
	// Development placeholder — remove when the real sync / binding lands.
	console.log("\n  [space-sync] cloud sync / Space binding placeholder — not yet implemented");
}
