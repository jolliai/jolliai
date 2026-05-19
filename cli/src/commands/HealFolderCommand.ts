/**
 * `jolli heal-folder` — explicit recovery of Memory Bank visible `.md` files
 * the manifest tracks but the filesystem no longer contains.
 *
 * Why an explicit command exists when the sidebar already heals on refresh:
 * users who don't open the Folders panel, or whose IDE caches a stale tree,
 * need a one-shot recovery they can run from the terminal.
 */

import type { Command } from "commander";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import type { HealResult } from "../core/StorageProvider.js";
import { createLogger, errMsg, setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("heal-folder");

async function readStorageMode(): Promise<"dual-write" | "folder" | "orphan"> {
	try {
		const cfg = (await loadConfig()) as Record<string, unknown>;
		const mode = cfg.storageMode as string | undefined;
		if (mode === "folder" || mode === "orphan") return mode;
		return "dual-write";
	} catch {
		return "dual-write";
	}
}

async function runHealFolder(cwd: string): Promise<number> {
	const mode = await readStorageMode();

	let storage: Awaited<ReturnType<typeof createStorage>>;
	try {
		storage = await createStorage(cwd, cwd);
	} catch (err) {
		console.error(`\n  Heal aborted: cannot open Memory Bank storage. ${errMsg(err)}`);
		console.error("  Run `jolli doctor` to diagnose the underlying config/storage issue.\n");
		log.error("createStorage failed: %s", errMsg(err));
		return 1;
	}

	if (!storage.healMissingVisibleMarkdown) {
		console.log(
			"\n  Heal not available: this repo is configured for orphan-only storage. " +
				"Run `jolli configure --set storageMode=dual-write` (or `folder`) first.\n",
		);
		return 0;
	}

	console.log("\n  Scanning Memory Bank manifest for missing visible Markdown files...");
	// In dual-write mode the orphan branch is the system of record, so it's
	// safe to drop manifest rows whose hidden JSON is also missing. In
	// folder-only mode there is no truth source to repopulate from, so
	// preserve every manifest row (heal-folder still counts them as failed
	// for visibility, but never deletes).
	//
	// DualWriteStorage catches its own delegated throws and surfaces them as
	// `result.error`. Folder-only mode calls FolderStorage directly — which
	// does not self-catch its manifest read / replace / regenerate failures.
	// Wrap so a corrupted manifest, disk-full, or permission error becomes
	// the same user-facing "Heal errored:" path instead of an uncaught
	// rejection.
	let result: HealResult;
	try {
		result = await storage.healMissingVisibleMarkdown({
			dropOrphanedManifestEntries: mode === "dual-write",
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		const message = errMsg(err);
		console.error(`\n  Heal errored: ${code ? `[${code}] ` : ""}${message}`);
		console.error("  Re-run after resolving the underlying error (check storage permissions / disk space).\n");
		log.error("heal-folder threw: %s%s", code ? `[${code}] ` : "", message);
		return 1;
	}

	if (result.error) {
		console.error(`  Heal errored: ${result.error}`);
		console.error(
			`  Counts may be partial: healed=${result.healed} skipped=${result.skipped} failed=${result.failed}`,
		);
		console.error("  Re-run after resolving the underlying error (check storage permissions / disk space).\n");
		log.error("heal-folder errored: %s", result.error);
		return 1;
	}

	if (result.healed === 0 && result.failed === 0) {
		if (result.skipped === 0) {
			console.log("  Manifest is empty — nothing to heal.\n");
		} else {
			console.log(`  No heal needed. Skipped: ${result.skipped} existing file(s).\n`);
		}
		log.info("heal-folder finished (no-op): skipped=%d", result.skipped);
		return 0;
	}

	if (result.healed > 0) {
		console.log(`  Healed:   ${result.healed} visible .md file(s) regenerated from hidden JSON`);
	}
	if (result.skipped > 0) {
		// "Skipped" also covers entries whose manifest path drifted from the
		// path heal would have computed — heal refuses to silently rewrite the
		// manifest, leaving those for `jolli reconcile` to resolve.
		console.log(
			`  Skipped:  ${result.skipped} file(s) (already on disk or path-drifted — run \`jolli reconcile\` to resolve drift)`,
		);
	}
	if (result.failed > 0) {
		console.log(`  Failed:   ${result.failed} entry/entries (hidden JSON missing, malformed, or read-blocked)`);
		const dropped = result.droppedIds ?? [];
		if (dropped.length > 0) {
			console.log(`            Dropped from manifest: ${dropped.length}`);
			const preview = dropped
				.slice(0, 5)
				.map((id) => id.substring(0, 8))
				.join(", ");
			console.log(`              ${preview}${dropped.length > 5 ? ", ..." : ""}`);
			console.log("            Re-run `jolli enable` to repopulate from the orphan branch.");
		} else if (mode === "folder") {
			console.log("            Manifest entries kept (folder-only mode has no truth source to repopulate).");
			console.log(
				"            Inspect `.jolli/manifest.json` and restore the hidden JSON, or remove the row manually.",
			);
		} else {
			console.log("            Manifest entries kept (transient read error). Re-run later.");
		}
	}
	console.log("");

	log.info("heal-folder finished: healed=%d skipped=%d failed=%d", result.healed, result.skipped, result.failed);
	return 0;
}

export function registerHealFolderCommand(program: Command): void {
	program
		.command("heal-folder")
		.description("Restore missing Memory Bank Markdown files from the hidden JSON source")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			setLogDir(options.cwd);
			log.info("Running 'heal-folder' command");
			const exit = await runHealFolder(options.cwd);
			if (exit !== 0) process.exitCode = exit;
		});
}
