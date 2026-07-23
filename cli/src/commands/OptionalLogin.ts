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
 * Semantics (a three-way choice mirroring the cold-start back-fill prompt, so a
 * single "no" never permanently silences the offer):
 *   - Skip entirely if the user previously chose "don't ask again" (global,
 *     persisted in `UserProfile.signInPromptDeclined`). Sign-in is a machine-level
 *     act, so the decline is remembered machine-wide, matching where the
 *     credential lives.
 *   - Otherwise ask, default Yes:
 *       [Y] yes             → open the browser sign-in.
 *       [n] not now         → skip THIS run only; the offer returns next run
 *                             (nothing persisted).
 *       [d] don't ask again → persist the decline so it never reappears.
 *     A login FAILURE is NOT a decline — it stays unrecorded so the next run can
 *     offer again.
 *
 * The prompt wording is intentionally identical to every other place the choice
 * appears in the guided flow.
 */

import { getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { loadUserProfile, saveUserProfile } from "../core/UserProfile.js";
import { createLogger } from "../Logger.js";
import { promptText } from "./CliUtils.js";

const log = createLogger("OptionalLogin");

/**
 * Offers the optional Jolli sign-in for cloud sync. No-op when the user has
 * already declined once. Callers should re-read auth/config afterward to pick up
 * a fresh sign-in — this returns nothing.
 */
export async function offerOptionalJolliLogin(): Promise<void> {
	const profile = await loadUserProfile();
	if (profile.signInPromptDeclined) return;

	const choice = parseChoice(
		await promptText(
			"\n  Sign in to Jolli to sync memories to a Space?  [Y] yes  [n] not now  [d] don't ask again: ",
		),
	);
	if (choice === "no") {
		// Not now: skip this run only, persist nothing so the offer returns next run.
		console.log("  You can sign in anytime with `jolli auth login`.\n");
		return;
	}
	if (choice === "dismiss") {
		// Persisting the decline is best-effort: a cosmetic "don't ask again" flag
		// must never abort the caller if the profile dir isn't writable — we just
		// offer again next run.
		try {
			await saveUserProfile({ signInPromptDeclined: true });
		} catch {
			log.debug("Could not persist the sign-in decline; will offer again next run");
		}
		console.log("  Got it — I won't ask again. Run `jolli auth login` anytime.\n");
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

type SignInChoice = "yes" | "no" | "dismiss";

/**
 * Maps a prompt answer to a choice. Enter / y / yes → sign in; d / don't / never
 * → permanent dismiss; everything else (including n / no and any typo) → not now,
 * the safe non-action that leaves the offer to reappear next run. Mirrors the
 * cold-start back-fill prompt's parser.
 */
function parseChoice(answer: string): SignInChoice {
	const a = answer.trim().toLowerCase();
	if (a === "" || a === "y" || a === "yes") return "yes";
	if (a === "d" || a === "dont" || a === "don't" || a === "never") return "dismiss";
	return "no";
}
