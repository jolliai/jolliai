/**
 * Antigravity Detector
 *
 * Detects Antigravity (Google's Gemini-powered agentic IDE/CLI) by looking for
 * its per-conversation SQLite dbs under `~/.gemini/<variant>/conversations/`.
 *
 * Antigravity ships in three interface variants that share an identical on-disk
 * layout: `antigravity` (2.0 app), `antigravity-ide` (IDE), `antigravity-cli`
 * (CLI). We scan all three.
 *
 * The VS Code shell layer (`~/Library/Application Support/Antigravity*`) and the
 * encrypted `implicit/*.pb` blobs are intentionally NOT read — the readable data
 * lives under `~/.gemini/<variant>/` (see AntigravitySessionDiscoverer).
 *
 * Gated on hasNodeSqliteSupport() so a runtime below the Node floor reports
 * "not installed" rather than "detected but 0 sessions".
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

const log = createLogger("AntigravityDetector");

/** The three Antigravity interface variants, all rooted at `~/.gemini/<variant>/`. */
export const ANTIGRAVITY_VARIANTS = ["antigravity", "antigravity-ide", "antigravity-cli"] as const;

/** Resolved per-variant directories. */
export interface AntigravityVariantDirs {
	readonly variant: string;
	readonly root: string;
	readonly conversationsDir: string;
	readonly brainDir: string;
}

/** Returns the variant dirs that exist on disk (have a `conversations/` directory). */
export function getAntigravityVariants(home: string = homedir()): AntigravityVariantDirs[] {
	const out: AntigravityVariantDirs[] = [];
	for (const variant of ANTIGRAVITY_VARIANTS) {
		const root = join(home, ".gemini", variant);
		const conversationsDir = join(root, "conversations");
		if (existsSync(conversationsDir)) {
			out.push({ variant, root, conversationsDir, brainDir: join(root, "brain") });
		}
	}
	return out;
}

/**
 * Checks whether Antigravity is installed AND the current runtime can read its
 * conversation dbs. Detection = any variant has at least one `*.db` under
 * `conversations/`.
 *
 * Deliberately keyed on the conversation dbs rather than the looser
 * {@link isAntigravityPresent}: this drives session discovery and the status
 * tree, where a host with no readable conversations has nothing to show.
 */
export async function isAntigravityInstalled(home: string = homedir()): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Antigravity support disabled: this runtime is Node %s, requires 22.13+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	return hasAntigravityConversationDb(home);
}

/** Does any variant have at least one conversation `*.db` on disk? */
async function hasAntigravityConversationDb(home: string): Promise<boolean> {
	for (const v of getAntigravityVariants(home)) {
		try {
			if ((await readdir(v.conversationsDir)).some((f) => f.endsWith(".db"))) return true;
		} catch {
			// Unreadable variant dir — skip and try the next variant.
		}
	}
	return false;
}

/**
 * Pure filesystem presence check for MCP registration: is Antigravity on this
 * machine at all, regardless of whether THIS runtime can read its dbs? Unlike
 * `isAntigravityInstalled`, this does NOT gate on `hasNodeSqliteSupport()` — MCP
 * registration only writes a config file, so it must work on a VS Code host
 * below the Node floor, where the SQLite gate would otherwise suppress a host
 * the user genuinely has installed.
 *
 * Accepts a bare `~/.gemini/<variant>/` directory, not just a conversation db,
 * because MCP is registered only on an explicit `jolli enable` (the SessionStart
 * / plugin bootstrap path runs with `repoHooksOnly`, which short-circuits every
 * detector to false and therefore never self-heals). Antigravity's dbs are
 * per-conversation, so keying on them meant "has the user chatted at least once"
 * — and the most natural ordering (install Antigravity, `jolli enable`, then
 * start using it) silently missed MCP until a second enable.
 *
 * Kept async even though both probes could be sync, so the whole
 * `isXPresent` family (Cursor, Copilot, Devin, OpenCode) has one signature at
 * the Installer call site. `getAntigravityVariants` stays sync — it is on the
 * transcript-reader path and its callers are sync.
 */
export async function isAntigravityPresent(home: string = homedir()): Promise<boolean> {
	if (await hasAntigravityConversationDb(home)) return true;
	return ANTIGRAVITY_VARIANTS.some((variant) => existsSync(join(home, ".gemini", variant)));
}
