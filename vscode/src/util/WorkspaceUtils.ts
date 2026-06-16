/**
 * WorkspaceUtils
 *
 * Helpers for resolving the active workspace root and the jollimemory CLI path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
	getGlobalConfigDir,
	loadConfigFromDir,
} from "../../../cli/src/core/SessionTracker.js";
import type { JolliMemoryConfig } from "../../../cli/src/Types.js";

/**
 * Returns the root path of the first workspace folder, or null if none is open.
 */
export function getWorkspaceRoot(): string | null {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return null;
	}
	return folders[0].uri.fsPath;
}

/**
 * Resolves the absolute path to the jollimemory CLI entry point.
 *
 * The CLI is always bundled into dist/Cli.js alongside dist/Extension.js
 * by the build step (esbuild.config.mjs). This holds for both:
 * - VSIX installations (dist/ is included in the package)
 * - Monorepo development (F5 debugging)
 *
 * Returns null only if the build has not been run yet.
 */
export function resolveCLIPath(extensionPath: string): string | null {
	const cliPath = join(extensionPath, "dist", "Cli.js");
	return existsSync(cliPath) ? cliPath : null;
}

/** Loads the global JolliMemory config. */
export function loadGlobalConfig(): Promise<JolliMemoryConfig> {
	return loadConfigFromDir(getGlobalConfigDir());
}

/**
 * The transcript sources enabled in config, as a Set of source tags. Each
 * `<source>Enabled` flag is opt-OUT (a missing/true flag = enabled); only an
 * explicit `false` disables. Copilot's single flag gates both the CLI and Chat
 * source tags (they ship together — see CLAUDE.md). Single source of truth for
 * every "which conversations count" path (the Summary panel's transcript stats
 * and the sidebar's committed-memory detail) so they never drift apart.
 */
export function resolveEnabledSources(config: JolliMemoryConfig): Set<string> {
	const sources = new Set<string>();
	if (config.claudeEnabled !== false) sources.add("claude");
	if (config.codexEnabled !== false) sources.add("codex");
	if (config.geminiEnabled !== false) sources.add("gemini");
	if (config.openCodeEnabled !== false) sources.add("opencode");
	if (config.cursorEnabled !== false) sources.add("cursor");
	if (config.copilotEnabled !== false) {
		sources.add("copilot");
		sources.add("copilot-chat");
	}
	return sources;
}
