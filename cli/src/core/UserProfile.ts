/**
 * User profile — machine-global, non-credential state that Jolli observes or
 * remembers about the user, kept separate from `config.json`.
 *
 * `config.json` holds credentials and settings the user actively sets (auth
 * token, API keys, chosen AI provider). `profile.json` holds things Jolli
 * derives or remembers on the user's behalf: a captured sign-in email (future),
 * and small UX flags such as whether the user has declined the optional
 * sign-in nudge. The two never overwrite each other.
 *
 * Lives at `<globalConfigDir>/profile.json`. Mirrors SessionTracker's config
 * load/save idiom: read errors fall back to defaults; writes merge with the
 * existing file and land atomically so a partial write can't corrupt it.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("UserProfile");
const PROFILE_FILE = "profile.json";

export interface UserProfile {
	/** Sign-in email captured after OAuth (reserved for future use). */
	readonly email?: string;
	/** The user explicitly declined the optional sign-in nudge; don't ask again. */
	readonly signInPromptDeclined?: boolean;
}

/**
 * Reads the global profile.json. Returns an empty profile on any error (missing
 * file, bad JSON) and on well-formed but non-object JSON (e.g. `42`, `null`,
 * `[]`) — the latter can only arise from external tampering, but guarding it
 * keeps the "always an object" contract that callers spread and read from.
 */
export async function loadUserProfile(): Promise<UserProfile> {
	const filePath = join(getGlobalConfigDir(), PROFILE_FILE);
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as UserProfile) : {};
	} catch {
		log.debug("No profile file at %s, using defaults", filePath);
		return {};
	}
}

/** Merges a partial update into the global profile.json and writes it atomically. */
export async function saveUserProfile(update: Partial<UserProfile>): Promise<void> {
	const dir = getGlobalConfigDir();
	await mkdir(dir, { recursive: true });
	const merged = { ...(await loadUserProfile()), ...update };
	await atomicWriteFile(join(dir, PROFILE_FILE), JSON.stringify(merged, null, "\t"));
	log.debug("Profile saved to %s", dir);
}
