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
