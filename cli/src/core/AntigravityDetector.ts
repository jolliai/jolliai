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
 * Gated on hasNodeSqliteSupport() so VS Code-extension Node 18 hosts report
 * "not installed" rather than "detected but 0 sessions".
 */

import { existsSync, readdirSync } from "node:fs";
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
 */
export async function isAntigravityInstalled(home: string = homedir()): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Antigravity support disabled: this runtime is Node %s, requires 22.5+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	for (const v of getAntigravityVariants(home)) {
		try {
			if (readdirSync(v.conversationsDir).some((f) => f.endsWith(".db"))) return true;
		} catch {
			// Unreadable variant dir — skip and try the next variant.
		}
	}
	return false;
}
