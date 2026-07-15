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
 * Cache-first on the common path: a fresh healthy entry in the local
 * SpaceBindingCache (`space-binding.json`) prints the sync line with zero
 * network I/O. On a cache miss, ONE `POST /api/jolli-memory/front-door`
 * round-trip resolves "already bound", "auto-bound to the only Space",
 * "several Spaces — ask", and "no Spaces" in a single call (JOLLI-1937), and
 * the answer maintains the cache: a healthy bound (or a completed bind /
 * rebind) writes it, an unbound / no-spaces / degraded answer clears it.
 * Only two flows add a second call, both of them writes driven by an explicit
 * user choice: the several-Spaces first run (`createBinding` with the pick)
 * and the rebind escape hatch for a binding the caller can't push to
 * (`createBinding` with `replace: true`; the choices ride along on the
 * degraded bound response, so no extra read either). The server stays the
 * authority on binding state — the cache is a display/probe accelerator with
 * a TTL, and every rejected push clears it (see SpaceBindingCache), so a
 * re-bind or unbind done elsewhere is still picked up.
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
	SPACE_PROBE_TIMEOUT_MS,
} from "../core/JolliMemoryPushClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import {
	clearSpaceBindingCache,
	loadSpaceBindingCache,
	saveSpaceBindingCache,
	tenantOriginForKey,
} from "../core/SpaceBindingCache.js";
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
		const repoUrl = await getCanonicalRepoUrl(cwd);
		const repoName = deriveRepoNameFromUrl(repoUrl);
		const origin = tenantOriginForKey(config.jolliApiKey);

		// Cache-first: a fresh healthy binding prints the sync line with zero
		// network I/O. Degraded/unbound states are never cached, so every
		// warning and prompt below is always backed by a live server answer.
		if (origin) {
			const cached = await loadSpaceBindingCache(cwd, { repoUrl, origin });
			if (cached) {
				printSyncLine(cached.spaceName, cached.canPush);
				return;
			}
		}

		// Reuse the config snapshot read above — one config read per run, and the
		// key check and the requests can never observe different keys. The probe
		// timeout is aligned with `jolli status` (was: the 30 s default) — an
		// interactive front door must not hang half a minute on a slow server.
		const client =
			opts.client ??
			new JolliMemoryPushClient({
				apiKeyProvider: async () => config.jolliApiKey,
				timeoutMs: SPACE_PROBE_TIMEOUT_MS,
			});
		const result = await client.frontDoor({ repoUrl, repoName });

		if (result.status === "bound") {
			// Rebind escape hatch: the server attaches a non-empty bindable pool
			// exactly when the binding is unusable for this caller (canPush
			// false). Without it there is nothing to offer — the warning line
			// points at restored access instead (rebindFollows false).
			const rebindFollows = result.binding.canPush === false && result.spaces.length > 0;
			const healthy = result.binding.canPush !== false && result.binding.spaceName !== null;
			if (healthy && origin) {
				await saveSpaceBindingCache(cwd, {
					repoUrl,
					origin,
					jmSpaceId: result.binding.jmSpaceId,
					spaceName: result.binding.spaceName as string,
					canPush: result.binding.canPush === true ? true : null,
				});
			} else {
				// Degraded bindings must never be served from cache.
				await clearSpaceBindingCache(cwd);
			}
			printSyncLine(result.binding.spaceName, result.binding.canPush, rebindFollows);
			if (rebindFollows) {
				await offerRebind(client, { cwd, repoUrl, repoName, origin }, result.spaces, result.defaultSpaceId);
			}
			return;
		}
		// An `unbound` whose list came back empty is contract drift (the server
		// answers `no_spaces` when nothing is bindable) — prompting would offer
		// zero choices, so fold it into the same hint. "available to you", not
		// "on this tenant": the server's bindable pool is permission-filtered,
		// so this is also the answer when Spaces exist but the caller lacks
		// access to every one of them.
		if (result.status === "no_spaces" || result.spaces.length === 0) {
			await clearSpaceBindingCache(cwd);
			const site = siteFromApiKey(config.jolliApiKey);
			console.log(
				`  No Jolli Spaces available to you — create one${site ? ` at ${site}` : " in the Jolli web app"}`,
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
		// canPush is true by construction here: the server's bindable pool is
		// filtered by the same `articles.edit` the push endpoint enforces.
		if (origin) {
			await saveSpaceBindingCache(cwd, {
				repoUrl,
				origin,
				jmSpaceId: chosen.id,
				spaceName: chosen.name,
				canPush: true,
			});
		}
		printSyncLine(chosen.name, true);
	} catch (error) {
		// Best-effort: never block or noise up the front door over cloud state
		// (offline, revoked key, outdated client, server hiccup).
		log.debug(`space sync step skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Prints the one-line sync status in the front door's `✓ label · detail`
 * status-line shape. The Space name is labelled and quoted (`Space "Acme Core"`)
 * so a name that happens to read like a product name (e.g. a Space called
 * "Jolli Memory") is still recognizably a Space.
 *
 * Two degraded shapes warn instead of showing a green check — both mean the
 * next push 403s (verified against the backend's `getFrontDoorBoundBinding`;
 * a deleted Space goes down the unbound path instead):
 * - `spaceName` null — the server withholds the details exactly when the
 *   caller has no `spaces.view` on the bound Space (no role at all).
 * - `canPush` false — the Space is visible but the push gate
 *   (`articles.edit`) is gone, e.g. the caller was demoted to viewer.
 * A null `canPush` (older server that predates the flag) keeps the green
 * check: unknown must not false-alarm.
 *
 * `rebindFollows` is true when the caller offers the interactive rebind right
 * below this line — the "(ask for access)" hint is dropped then, so the user
 * is not told to chase access one line before being offered a way out
 * (mirrors StatusCommand's canRebind-switched hint).
 */
function printSyncLine(spaceName: string | null, canPush: boolean | null, rebindFollows = false): void {
	const hint = rebindFollows ? "" : " (ask for access)";
	if (!spaceName) {
		console.log(`  ⚠ bound · no access to the Space — memories won't sync${hint}`);
		return;
	}
	if (canPush === false) {
		console.log(`  ⚠ bound · Space "${spaceName}" — read-only access, memories won't sync${hint}`);
		return;
	}
	console.log(`  ✓ syncing · Space "${spaceName}"`);
}

/**
 * Interactive rebind escape hatch for a binding the caller can't push to.
 * Offered only when the server attached a non-empty bindable pool to the
 * degraded bound response. Defaults to No — the user may prefer getting
 * their access restored over moving the binding. The bind call sends
 * `replace: true`, which the server honors only while the existing binding is
 * still unusable for the caller (org-shared state must not be re-pointed once
 * it works again — see the backend policy), so any failure here just prints a
 * one-line retry hint instead of breaking the front door — except the 409
 * race where the existing binding already matches the pick, which is success
 * (mirrors the main bind flow's tolerance).
 */
async function offerRebind(
	client: JolliMemoryPushClient,
	repo: { cwd: string; repoUrl: string; repoName: string; origin: string | null },
	spaces: ReadonlyArray<JolliMemorySpace>,
	defaultSpaceId: number | null,
): Promise<void> {
	const single = spaces.length === 1 ? spaces[0] : null;
	const question = single
		? `\n  Rebind this repo to Space "${single.name}"? [y/N] `
		: "\n  Rebind this repo to another Space? [y/N] ";
	const answer = (await promptText(question)).trim();
	if (!/^y(es)?$/i.test(answer)) {
		return;
	}
	const chosen = single ?? (await promptSpaceChoice(spaces, defaultSpaceId));
	try {
		await client.createBinding({
			repoUrl: repo.repoUrl,
			repoName: repo.repoName,
			jmSpaceId: chosen.id,
			replace: true,
		});
	} catch (error) {
		// A concurrent rebind that landed on the same Space is success, not
		// failure (same 409 tolerance as the main bind flow above).
		if (!(error instanceof BindingAlreadyExistsError) || error.existingSpaceId !== chosen.id) {
			log.debug(`rebind failed: ${error instanceof Error ? error.message : String(error)}`);
			console.log("  ⚠ rebind failed — re-run `jolli` to retry");
			return;
		}
	}
	// The rebind target came from the server's bindable pool, so canPush is
	// true by construction — cache it like the main bind flow.
	if (repo.origin) {
		await saveSpaceBindingCache(repo.cwd, {
			repoUrl: repo.repoUrl,
			origin: repo.origin,
			jmSpaceId: chosen.id,
			spaceName: chosen.name,
			canPush: true,
		});
	}
	printSyncLine(chosen.name, true);
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
	// "available to you", not "on your tenant" — the pool is permission-
	// filtered server-side (same wording rationale as the no-Spaces hint).
	console.log(`\n  ${spaces.length} Spaces available to you. Which Space should this repo sync to?`);
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
