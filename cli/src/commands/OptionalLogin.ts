/**
 * The optional "sign in to Jolli to sync" nudge, shared by the guided front door
 * (bare `jolli`) and `jolli enable`'s report step.
 *
 * Extracted to a neutral module so both callers use ONE implementation — same
 * wording, same "ask once, remember a decline" semantics — and so neither
 * command has to import the other (`GuidedFrontDoor` already imports
 * `promptSetup` from `EnableCommand`; routing this helper through either would
 * form an import cycle). This module only depends on `auth/*`, `UserProfile`,
 * and `CliUtils`, none of which import the command modules back.
 *
 * Semantics:
 *   - Skip entirely if the user previously declined (global, persisted in
 *     `UserProfile.signInPromptDeclined`). Sign-in is a machine-level act, so the
 *     decline is remembered machine-wide, matching where the credential lives.
 *   - Otherwise ask once, default Yes. On an explicit "no" persist the decline so
 *     it never reappears. A login FAILURE is NOT a decline — it stays unrecorded
 *     so the next run can offer again.
 *
 * The prompt wording is intentionally identical to every other place the choice
 * appears in the guided flow.
 */

import { getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { loadUserProfile, saveUserProfile } from "../core/UserProfile.js";
import { createLogger } from "../Logger.js";
import { isAffirmative, promptText } from "./CliUtils.js";

const log = createLogger("OptionalLogin");

/**
 * Offers the optional Jolli sign-in for cloud sync. No-op when the user has
 * already declined once. Callers should re-read auth/config afterward to pick up
 * a fresh sign-in — this returns nothing.
 */
export async function offerOptionalJolliLogin(): Promise<void> {
	const profile = await loadUserProfile();
	if (profile.signInPromptDeclined) return;

	const answer = await promptText("\n  Sign in to Jolli to sync memories to a Space? [Y/n] ");
	if (!isAffirmative(answer)) {
		// Persisting the decline is best-effort: a cosmetic "don't ask again" flag
		// must never abort the caller if the profile dir isn't writable — we just
		// offer again next run.
		try {
			await saveUserProfile({ signInPromptDeclined: true });
		} catch {
			log.debug("Could not persist the sign-in decline; will offer again next run");
		}
		console.log("  You can sign in anytime with `jolli auth login`.\n");
		return;
	}
	try {
		await browserLogin(getJolliUrl());
		console.log("\n  ✓ signed in — memories will sync to your Space.\n");
	} catch (err) {
		console.error(`\n  Login failed: ${err instanceof Error ? err.message : String(err)}`);
		console.log("  You can try again with `jolli auth login`.\n");
	}
}
