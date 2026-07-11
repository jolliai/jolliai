/**
 * The curated `/jolli` menu (JOLLI-1925).
 *
 * The host `jolli mcp` server registers a single MCP prompt, `jolli` (surfaced in
 * Claude Code as `/mcp__jollimemory__jolli`), that presents a curated menu of
 * actions and steers the agent to invoke the corresponding — already registered —
 * MCP tool. The menu is the union of:
 *   - backend manifest platform tools flagged with a `menu` block, and
 *   - a CLI-side inclusion list of built-in tool names (`LOCAL_MENU_TOOL_NAMES`).
 *
 * The prompt only steers; every menu item is an already-registered tool, so the
 * prompt is never a second execution path. When the menu is empty the server does
 * not register the prompt at all (see `startMcpServer`), so this module is inert
 * until the backend flags a tool or a local tool is added to the list.
 */

import type { PlatformToolManifestEntry } from "../core/JolliMemoryPushClient.js";

/** The MCP prompt name and its single optional free-text argument. */
export const JOLLI_PROMPT_NAME = "jolli";
export const JOLLI_PROMPT_ARGUMENT = "request";

/**
 * Built-in (local) tool names to surface in the `/jolli` menu. Intentionally EMPTY
 * for now — an extension point for later. A name here must match a built-in tool in
 * `TOOL_DEFINITIONS`; unknown names are ignored by `buildJolliMenu`.
 */
export const LOCAL_MENU_TOOL_NAMES: readonly string[] = [];

/** One resolved menu entry: which tool to call and how to present it. */
export interface JolliMenuItem {
	readonly toolName: string;
	readonly label: string;
	readonly description?: string;
	readonly order?: number;
}

/** Minimal built-in tool shape needed to resolve a local menu entry. */
export interface BuiltInToolInfo {
	readonly name: string;
	readonly description: string;
}

/**
 * Builds the curated menu from the menu-flagged platform tools and the local
 * inclusion list. Platform items take their label/order from the manifest `menu`
 * block and fall back to the tool's own description when the menu block omits one.
 * Local items resolve their description from the built-in registry; a local name
 * with no matching built-in is skipped. The two groups never overlap (surviving
 * platform tools can never share a name with a built-in), so no dedupe is needed.
 * The result is sorted by `order` ascending (unordered items last), then by label,
 * then by tool name for a stable order.
 */
export function buildJolliMenu(
	platformTools: readonly PlatformToolManifestEntry[],
	builtIns: readonly BuiltInToolInfo[],
	localNames: readonly string[] = LOCAL_MENU_TOOL_NAMES,
): JolliMenuItem[] {
	const items: JolliMenuItem[] = [];
	for (const tool of platformTools) {
		if (tool.menu) {
			items.push({
				toolName: tool.name,
				label: tool.menu.label,
				description: tool.menu.description ?? tool.description,
				...(tool.menu.order !== undefined ? { order: tool.menu.order } : {}),
			});
		}
	}
	const builtInByName = new Map(builtIns.map((t) => [t.name, t] as const));
	for (const name of localNames) {
		const info = builtInByName.get(name);
		if (info) {
			items.push({ toolName: info.name, label: info.name, description: info.description });
		}
	}
	return sortMenu(items);
}

function sortMenu(items: JolliMenuItem[]): JolliMenuItem[] {
	return [...items].sort((a, b) => {
		const ao = a.order ?? Number.POSITIVE_INFINITY;
		const bo = b.order ?? Number.POSITIVE_INFINITY;
		if (ao !== bo) {
			return ao - bo;
		}
		const byLabel = a.label.localeCompare(b.label);
		return byLabel !== 0 ? byLabel : a.toolName.localeCompare(b.toolName);
	});
}

/**
 * Builds the steering message the `jolli` prompt returns. MCP prompts return
 * messages, not a native picker, so this text tells the agent how to render the
 * menu and which tool each choice maps to:
 *   - `request` provided → match it to one menu item and invoke that tool directly,
 *     asking only if the intent is ambiguous or matches nothing;
 *   - `request` absent → present the menu via an interactive single-select tool
 *     where the host provides one (e.g. Claude Code's `AskUserQuestion`), otherwise
 *     enumerate the options as text, then invoke the chosen tool.
 * Host-agnostic by design: the `AskUserQuestion` mention is only an example and the
 * text-list fallback keeps the prompt usable in any MCP host.
 */
export function buildJolliPromptText(menu: readonly JolliMenuItem[], request?: string): string {
	const lines = menu.map((item) => {
		const desc = item.description ? ` — ${item.description}` : "";
		return `- ${item.label}${desc} (call tool \`${item.toolName}\`)`;
	});
	const trimmed = request?.trim();
	if (trimmed) {
		return [
			`The user opened the Jolli action menu with this request: "${trimmed}".`,
			"Match the request to exactly one menu item below and invoke its MCP tool directly.",
			"Only ask the user to choose if the request is ambiguous or matches no menu item.",
			"",
			"Menu:",
			...lines,
		].join("\n");
	}
	return [
		"The user opened the Jolli action menu without a specific request.",
		"Present these options and let the user pick one, using an interactive single-select tool if your host provides one (for example AskUserQuestion in Claude Code); otherwise list them as plain text and ask the user to choose.",
		"After the user selects an option, invoke the corresponding MCP tool.",
		"",
		"Menu:",
		...lines,
	].join("\n");
}
