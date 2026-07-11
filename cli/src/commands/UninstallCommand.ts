/**
 * UninstallCommand — `jolli uninstall`.
 *
 * Machine-wide detection and selective removal of every Jolli Memory
 * installation and configuration artifact: VS Code / IntelliJ editor
 * integrations, the global `@jolli.ai/cli` package, the global + per-project
 * `.jolli/jollimemory/` state directories, and the current repo's hooks.
 *
 * User memory is NEVER touched — the orphan branch and Memory Bank content are
 * out of scope by construction (see UninstallScan). This command removes
 * installation + configuration only.
 *
 * Flags mirror `clean`: `--dry-run` previews, `--yes` skips the prompt (and is
 * required in non-interactive contexts), `--scope` narrows to machine-global or
 * project-local surfaces.
 */

import { rm } from "node:fs/promises";
import type { Command } from "commander";
import { track } from "../core/Telemetry.js";
import { uninstall } from "../install/Installer.js";
import {
	pruneVscodeExtensionManifest,
	type RemovableItem,
	scanUninstallInventory,
	type UninstallInventory,
	type UninstallSurface,
} from "../install/UninstallScan.js";
import { createLogger, setLogDir } from "../Logger.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("uninstall");

/** Removal scope selected via `--scope`. */
type Scope = "all" | "global" | "project";

/** Ordered surface metadata: section heading + which scope each belongs to. */
const SURFACE_META: ReadonlyArray<{ surface: UninstallSurface; heading: string; scope: Exclude<Scope, "all"> }> = [
	{ surface: "vscode-extension", heading: "VS Code editors", scope: "global" },
	{ surface: "intellij-plugin", heading: "JetBrains IDEs", scope: "global" },
	{ surface: "cli-global", heading: "Command-line tool", scope: "global" },
	{ surface: "global-config", heading: "Global configuration", scope: "global" },
	{ surface: "project-config", heading: "Project state (current repo)", scope: "project" },
	{ surface: "repo-hooks", heading: "Hooks & MCP (current repo)", scope: "project" },
];

/** True when `item` belongs to the requested `scope`. */
function inScope(item: RemovableItem, scope: Scope): boolean {
	if (scope === "all") return true;
	const meta = SURFACE_META.find((m) => m.surface === item.surface);
	/* v8 ignore next -- every surface has a SURFACE_META entry; guards a future gap */
	return meta?.scope === scope;
}

/** Prints the grouped inventory. Returns the flat list of in-scope items. */
function printInventory(inventory: UninstallInventory, scope: Scope): RemovableItem[] {
	const items = inventory.items.filter((i) => inScope(i, scope));

	console.log("\n  Jolli Memory — Uninstall");
	console.log("  ────────────────────────────────────────────");

	if (items.length === 0) {
		console.log("\n  No Jolli installation or configuration found for the selected scope.\n");
		return items;
	}

	let index = 0;
	for (const { surface, heading } of SURFACE_META) {
		const group = items.filter((i) => i.surface === surface);
		if (group.length === 0) continue;
		console.log(`\n  ${heading}:`);
		for (const item of group) {
			index++;
			const detail = item.detail ? ` (${item.detail})` : "";
			console.log(`    ${String(index).padStart(2)}. ${item.label}${detail}`);
			console.log(`        ${item.path}`);
		}
	}

	console.log("\n  Preserved (never removed):");
	for (const note of inventory.preserved) {
		console.log(`    · ${note}`);
	}

	return items;
}

/**
 * Parses a selection answer into a set of 1-based indices. Accepts comma- or
 * space-separated numbers, or "a"/"all" for everything. Returns null when the
 * answer is empty (treated as "cancel") or contains no valid index.
 */
export function parseSelection(answer: string, count: number): Set<number> | null {
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === "") return null;
	if (trimmed === "a" || trimmed === "all") {
		return new Set(Array.from({ length: count }, (_, i) => i + 1));
	}
	const selected = new Set<number>();
	for (const token of trimmed.split(/[\s,]+/)) {
		if (token === "") continue;
		const n = Number(token);
		if (Number.isInteger(n) && n >= 1 && n <= count) {
			selected.add(n);
		}
	}
	return selected.size > 0 ? selected : null;
}

/**
 * Removes a single item. Filesystem items are deleted with `rm -rf`; the
 * `repo-hooks` pseudo-item dispatches to the marker-aware `uninstall()` so hook
 * sections are stripped without clobbering unrelated user hooks. Returns an
 * error message on failure, or null on success.
 */
async function removeItem(item: RemovableItem): Promise<string | null> {
	try {
		if (item.kind === "hooks") {
			const result = await uninstall(item.path);
			return result.success ? null : result.message;
		}
		await rm(item.path, { recursive: true, force: true });
		// A VS Code-family editor tracks installs in extensions.json; deleting the
		// folder alone leaves a dangling entry that shows a "corrupt extension"
		// warning on reopen. Reconcile the manifest so the uninstall reads clean.
		if (item.surface === "vscode-extension") {
			await pruneVscodeExtensionManifest(item.path);
		}
		return null;
	} catch (err) {
		return (err as Error).message;
	}
}

/** Core flow: scan, print, select, confirm, remove. */
async function runUninstall(cwd: string, scope: Scope, dryRun: boolean, skipPrompt: boolean): Promise<void> {
	const inventory = await scanUninstallInventory({ projectDir: cwd });
	const items = printInventory(inventory, scope);

	if (items.length === 0) return;

	if (dryRun) {
		console.log(`\n  [dry-run] Would remove ${items.length} item${items.length === 1 ? "" : "s"}.\n`);
		return;
	}

	// Decide which items to remove.
	let targets: RemovableItem[];
	if (skipPrompt) {
		targets = items;
	} else {
		if (!isInteractive()) {
			console.error(
				"\n  Refusing to delete in non-interactive mode. Pass --yes to remove everything listed, or --dry-run to preview.\n",
			);
			process.exitCode = 1;
			return;
		}
		const answer = await promptText(
			"\n  Enter item numbers to remove (comma/space separated), 'a' for all, or Enter to cancel: ",
		);
		const selection = parseSelection(answer, items.length);
		if (selection === null) {
			console.log("\n  Cancelled. Nothing was removed.\n");
			return;
		}
		targets = items.filter((_, i) => selection.has(i + 1));

		// Second confirmation for irreversible deletion.
		const confirm = await promptText(
			`\n  Remove ${targets.length} selected item${targets.length === 1 ? "" : "s"}? [y/N]: `,
		);
		const lower = confirm.trim().toLowerCase();
		if (lower !== "y" && lower !== "yes") {
			console.log("\n  Aborted. Nothing was removed.\n");
			return;
		}
	}

	// Apply removals; report per-item outcome.
	let removed = 0;
	let removedExtension = false;
	let removedGlobalConfig = false;
	let removedCliGlobal = false;
	const failures: string[] = [];
	for (const item of targets) {
		const error = await removeItem(item);
		if (error === null) {
			removed++;
			if (item.surface === "vscode-extension") removedExtension = true;
			if (item.surface === "global-config") removedGlobalConfig = true;
			if (item.surface === "cli-global") removedCliGlobal = true;
			console.log(`  ✓ ${item.label}`);
		} else {
			failures.push(`${item.label}: ${error}`);
			console.error(`  ✗ ${item.label} — ${error}`);
		}
	}

	// Only record the disable event when something was actually removed — a run
	// where every item failed (or nothing was selected) is not a disable.
	if (removed > 0) {
		track("surface_disabled", { reason: "uninstall" });
	}

	console.log(`\n  Removed ${removed} item${removed === 1 ? "" : "s"}.`);
	if (failures.length > 0) {
		console.error(`  ${failures.length} item${failures.length === 1 ? "" : "s"} could not be removed:`);
		for (const f of failures) console.error(`    - ${f}`);
		process.exitCode = 1;
	}
	if (removedGlobalConfig) {
		// The global config dir holds the shared hook entry scripts (resolve-dist-path,
		// run-hook) that EVERY repo's git hooks invoke. Removing it here does not touch
		// hooks in other repos, so those will error on their next commit until Jolli is
		// re-enabled or fully removed there.
		console.log("\n  Note: global config was removed. Jolli hooks in OTHER repos will error on their next");
		console.log("  commit until you run `jolli disable` (or `jolli uninstall`) in each of them.");
	}
	if (removedExtension) {
		// A running editor may rewrite extensions.json on exit, re-adding the entry
		// we just pruned. Restarting lets it reconcile against the deleted folder.
		console.log("\n  Note: restart any open VS Code / Cursor / fork window so the uninstall takes effect.");
	}
	if (removedCliGlobal && process.platform === "win32") {
		// On Windows the running executable's files can't be deleted while in use, so
		// some may linger until this process exits.
		console.log("\n  Note: the global CLI removed itself; some files may remain until this process exits.");
	}
	console.log("");
}

/** Registers the `uninstall` command on the given Commander program. */
export function registerUninstallCommand(program: Command): void {
	program
		.command("uninstall")
		.description("Detect and remove all Jolli installation & config (never your memories)")
		.option("--dry-run", "Show what would be removed without deleting anything")
		.option("-y, --yes", "Remove everything detected without prompting (required in non-interactive shells)")
		.option("--scope <scope>", "Limit to 'global', 'project', or 'all' surfaces (default: all)", "all")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string; dryRun?: boolean; yes?: boolean; scope?: string }) => {
			setLogDir(options.cwd);
			log.info("Running 'uninstall' command");

			const scope = options.scope;
			if (scope !== "all" && scope !== "global" && scope !== "project") {
				console.error(`\n  Invalid --scope '${scope}'. Use 'all', 'global', or 'project'.\n`);
				process.exitCode = 1;
				return;
			}

			await runUninstall(options.cwd, scope, options.dryRun === true, options.yes === true);
		});
}
