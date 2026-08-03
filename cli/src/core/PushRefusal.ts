/**
 * PushRefusal — the one place that answers "is this failure repo-wide or per-item?".
 *
 * A repo-wide refusal is a property of the **repo + credential**, not of the
 * document being pushed: an outdated client, the user's own outbound opt-out
 * (spec 306), or the server's allowlist / ownership verdict. Every loop over
 * documents must STOP on these — collecting them instead reports one repo-wide
 * condition as N per-item failures (`plan "X" failed`), fires N doomed requests
 * on the way, and robs the surfaces of the admin-oriented / "re-enable to push"
 * handling they have for exactly these.
 *
 * **This module is the single source of truth for all three surfaces.** It lives
 * in `cli/` because that is the direction dependencies actually run: the VS Code
 * extension bundles `cli/src/**` at build time and imports this file directly
 * (`../../../cli/src/core/PushRefusal.js`, the same cross-package style the rest
 * of `vscode/src/**` uses), while the CLI can never import from `vscode/`. There
 * is deliberately no VS Code-side copy or re-export shim — a second file of the
 * same name is exactly the drift this module exists to prevent. The Kotlin side
 * mirrors the set in `JolliPushOrchestrator.isFatalPushError` /
 * `CreatePrPanel.repoWideStopReason`. Add a new repo-wide refusal HERE and every
 * classifier picks it up.
 *
 * **Why its own module, with no imports.** The classification used to be an
 * `instanceof` chain copied into each loop, which drifted (a type added to one
 * site and not the others). Sharing it from `JolliMemoryPushOrchestrator` or
 * `JolliPushService` breaks instead, because those are the collaborators every
 * test around here replaces with `vi.mock`: importing a predicate FROM a stubbed
 * module yields `undefined`, and calling it throws a TypeError that the
 * surrounding catch swallows — turning a missing mock entry into silently wrong
 * control flow. This module has no imports, no I/O and no side effects, so
 * nothing has a reason to stub it. That is the point.
 *
 * **Matched by `err.name`, not `instanceof`,** for the same reason: each of these
 * classes sets its own `name`, the IntelliJ bridge already dispatches on the same
 * strings (`remapBridgeException`'s `errorName`), and the CLI's `PushDisabledError`
 * exists precisely so the name survives the bridge — so the name IS the
 * cross-surface contract, and matching on it also removes the undefined-binding
 * hazard above.
 */

/**
 * Error `name`s that mean "this repo cannot push right now", for any credential
 * and for every document in it.
 *
 * Two conditions are listed under BOTH of their spellings on purpose, because the
 * surfaces name the same server response differently and errors cross the IDE
 * bridge by name — matching one spelling would silently classify the other as a
 * per-item failure. HTTP 426: `ClientOutdatedError` (CLI) / `PluginOutdatedError`
 * (VS Code + IntelliJ). HTTP 401: `NotAuthenticatedError` (CLI) /
 * `UnauthorizedError` (IntelliJ).
 *
 * Note that 403 maps to whichever of the two auth names the endpoint can justify,
 * and both are listed here because both are repo-wide: the read-shaped endpoints
 * (`frontDoor`, `deleteDoc`) cannot tell a rejected credential from a forbidden
 * repo and fold 403 into `NotAuthenticatedError`, while the push/bind endpoints
 * distinguish it and raise `PermissionDeniedError`. Don't go looking for a single
 * 403 branch — there isn't one (see `JolliMemoryPushClient`).
 *
 * A rejected credential is repo-wide for the same reason the others are: it is a
 * property of the repo + credential, so every remaining document in a loop gets
 * the identical rejection. It was the last classifier disagreement — IntelliJ's
 * `CreatePrPanel.repoWideStopReason` already stopped the whole loop on it and
 * reported "sign-in rejected", while `JolliPushOrchestrator.isFatalPushError` and
 * the CLI's three attachment loops collected it as N separate `plan "X" failed`
 * lines and fired N doomed requests on the way.
 *
 * **That 401 promotion reaches the CLI and IntelliJ, NOT VS Code** — membership
 * here is necessary but not sufficient, because a surface also has to PRODUCE one
 * of these names. `vscode/src/services/JolliPushService.ts` branches on 426, 412,
 * 409 and 403 only, so a 401 falls through to its generic non-2xx arm and rejects
 * with a plain `Error`, whose `name` is `"Error"` — a string this set cannot
 * match. Its attachment loops therefore still collect a rejected credential as N
 * per-item failures, exactly the shape the promotion removes elsewhere. A
 * `status === 401` branch in that client, raising `UnauthorizedError`, is all it
 * takes for VS Code to inherit the behaviour; until it exists, read "shared
 * classifier" as shared membership, not as identical behaviour on this one
 * condition.
 *
 * `BindingRequiredError` is deliberately ABSENT: it is recoverable — the caller
 * runs the binding chooser and retries — so it is fatal only to the loop that
 * cannot run that chooser, and each such caller adds it explicitly rather than
 * having it folded in here.
 */
export const REPO_WIDE_REFUSAL_NAMES: ReadonlySet<string> = new Set([
	"ClientOutdatedError",
	"PluginOutdatedError",
	"NotAuthenticatedError",
	"UnauthorizedError",
	"PushDisabledError",
	"PermissionDeniedError",
]);

/** True when `err` is a refusal that applies to every doc in the repo. */
export function isRepoWideRefusal(err: unknown): boolean {
	return err instanceof Error && REPO_WIDE_REFUSAL_NAMES.has(err.name);
}
