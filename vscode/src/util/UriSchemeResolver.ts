/**
 * UriSchemeResolver — Maps the host IDE's appName to its OS-registered URI scheme.
 *
 * Why not `vscode.env.uriScheme`: it returns "vscode" in most forks (Cursor,
 * Windsurf, Kiro, Antigravity, ...) because forks inherit upstream VSCode's
 * default for that API without overriding it. The OS-level scheme registration
 * is usually correct, so we detect the host via `appName` (which forks
 * consistently rebrand) and return the scheme the OS has registered.
 *
 * Used by:
 * - `AuthService` — building OAuth callback URIs.
 *
 * Earlier the resolver also drove `/summary/<hash>` deep links emitted from
 * `/jolli-search`, but that path was abandoned because Claude Code's chat
 * webview filters non-http(s) link clicks (see
 * `docs/jolli-search-open-action-design.md`). The OAuth flow is the only
 * remaining consumer; new forks here still need a matching entry in Jolli's
 * cli_callback allowlist.
 */

import * as vscode from "vscode";

/** Publisher-qualified extension ID, matches package.json publisher.name. */
export const EXTENSION_ID = "jolli.jollimemory-vscode";

export function resolveUriScheme(): string {
	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes("cursor")) return "cursor";
	if (appName.includes("windsurf")) return "windsurf";
	if (appName.includes("vscodium")) return "vscodium";
	if (appName.includes("kiro")) return "kiro";
	if (appName.includes("antigravity")) return "antigravity";
	// Check "insiders" last: it coexists with "visual studio code" in the
	// VSCode Insiders appName, and we want the more specific match to win.
	if (appName.includes("insiders")) return "vscode-insiders";
	return "vscode";
}
