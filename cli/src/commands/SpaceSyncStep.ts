/**
 * Cloud sync / Space-binding step delegated by the guided front door.
 *
 * The guided front door (`runGuidedFrontDoor`) owns the auth + enable axes and
 * calls this once whenever the repo is in the enabled state (interactive TTY
 * guaranteed by the front door). Everything about getting memories into a
 * Jolli Space — binding-state discovery, single/multi Space binding, and every
 * sync-related user prompt — lives here, not in the front door. Kept in its
 * own module so the front door's tests can mock it.
 *
 * One network round-trip on the common path: `POST /api/jolli-memory/front-door`
 * resolves "already bound", "auto-bound to the only Space", "several Spaces —
 * ask", and "no Spaces" in a single call (JOLLI-1937). Only the several-Spaces
 * first run needs a second call (`createBinding` with the user's pick). There
 * is deliberately no local binding cache — the server owns binding state
 * (mirroring the VS Code extension), so a re-bind or unbind done elsewhere is
 * picked up on the next `jolli`.
 *
 * Failure posture: best-effort. The front door must never be blocked by cloud
 * state, so every error (not signed in, outdated client, network) is logged at
 * debug level and swallowed — except a fail-closed mismatch on the 409
 * "binding already exists" race, which is surfaced so memories are never
 * silently confirmed for the wrong Space (mirrors pushBranchToJolli).
 */

import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import { parseJolliApiKey } from "../core/JolliApiUtils.js";
import {
	BindingAlreadyExistsError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
} from "../core/JolliMemoryPushClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger } from "../Logger.js";
import { promptText } from "./CliUtils.js";

const log = createLogger("SpaceSyncStep");

/** Test seam — defaults to a real `JolliMemoryPushClient` (mirrors `PushBranchOpts.client`). */
export interface SpaceSyncStepOpts {
	readonly client?: JolliMemoryPushClient;
}

/** Runs the Space-binding axis of the guided front door. See the module docstring for the contract. */
export async function runSpaceSyncStep(cwd: string, opts: SpaceSyncStepOpts = {}): Promise<void> {
	const config = await loadConfig();
	// No Jolli credential → nothing to sync to. The front door's status line
	// already tells the user how to sign in; stay quiet here.
	if (!config.jolliApiKey) {
		return;
	}
	try {
		// Reuse the config snapshot read above — one config read per run, and the
		// key check and the requests can never observe different keys.
		const client = opts.client ?? new JolliMemoryPushClient({ apiKeyProvider: async () => config.jolliApiKey });
		const repoUrl = await getCanonicalRepoUrl(cwd);
		const repoName = deriveRepoNameFromUrl(repoUrl);
		const result = await client.frontDoor({ repoUrl, repoName });

		if (result.status === "bound") {
			printSyncingTo(result.binding.spaceName);
			return;
		}
		// An `unbound` whose list came back empty is contract drift (the server
		// answers `no_spaces` when nothing is bindable) — prompting would offer
		// zero choices, so fold it into the same hint.
		if (result.status === "no_spaces" || result.spaces.length === 0) {
			const site = siteFromApiKey(config.jolliApiKey);
			console.log(
				`  No Jolli Spaces available yet — create one${site ? ` at ${site}` : " in the Jolli web app"}`,
			);
			return;
		}

		// Several bindable Spaces — ask which one, then bind via the same
		// endpoint the VS Code chooser uses. A single-entry list is contract
		// drift too (the server auto-binds that case) — take it without a
		// pointless one-option prompt.
		const chosen =
			result.spaces.length === 1
				? result.spaces[0]
				: await promptSpaceChoice(result.spaces, result.defaultSpaceId);
		try {
			await client.createBinding({ repoUrl, repoName, jmSpaceId: chosen.id });
		} catch (err) {
			if (!(err instanceof BindingAlreadyExistsError)) {
				throw err;
			}
			// Fail closed on the concurrent-bind race: only treat the 409 as
			// success when the existing binding provably matches the user's pick
			// (mirrors pushBranchToJolli). An undefined existingSpaceId cannot be
			// confirmed, so it is a mismatch too.
			if (err.existingSpaceId !== chosen.id) {
				console.log(
					"  ⚠ this repo is already bound to a different Jolli Space — your pick was not applied. Re-run `jolli` to see the active binding.",
				);
				return;
			}
		}
		printSyncingTo(chosen.name);
	} catch (error) {
		// Best-effort: never block or noise up the front door over cloud state
		// (offline, revoked key, outdated client, server hiccup).
		log.debug(`space sync step skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Prints the one-line sync confirmation. `spaceName` is null when the server withheld it (no `spaces.view`). */
function printSyncingTo(spaceName: string | null): void {
	console.log(`  ✓ syncing to ${spaceName ?? "your Jolli Space"}`);
}

/**
 * Numbered pick-from-list prompt for the several-Spaces case (JOLLI-1937).
 * Only called with two or more entries — the caller resolves empty and
 * single-entry lists without prompting. Empty or unparseable input falls back
 * to the default choice — the tenant's default Space when it is in the list,
 * the first entry otherwise (same "anything else means the default"
 * convention as the front door's own prompts).
 */
async function promptSpaceChoice(
	spaces: ReadonlyArray<JolliMemorySpace>,
	defaultSpaceId: number | null,
): Promise<JolliMemorySpace> {
	const defaultIndex = Math.max(
		0,
		spaces.findIndex((s) => s.id === defaultSpaceId),
	);
	console.log(`\n  ${spaces.length} Spaces on your tenant. Which Space should this repo sync to?`);
	spaces.forEach((space, i) => {
		console.log(`    ${i + 1}) ${space.name}${space.id === defaultSpaceId ? " (default)" : ""}`);
	});
	const answer = await promptText(`\n  Choice [${defaultIndex + 1}]: `);
	const picked = Number.parseInt(answer, 10);
	if (Number.isInteger(picked) && picked >= 1 && picked <= spaces.length) {
		return spaces[picked - 1];
	}
	return spaces[defaultIndex];
}

/** Host of the tenant site encoded in the Jolli API key, for the no-Spaces hint. */
function siteFromApiKey(apiKey: string): string | undefined {
	const url = parseJolliApiKey(apiKey)?.u;
	if (!url) {
		return undefined;
	}
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}
