/**
 * Shared idempotent writer for parameterized JSON config files.
 * Writes the `jollimemory` MCP server entry under a configurable top-level key.
 *
 * ## Verified config formats (observed from real installed app source code)
 *
 * ### Cursor & Gemini (key `mcpServers`)
 * Source: /Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js
 * (Cursor) and /opt/homebrew/Cellar/gemini-cli/0.38.2/libexec/.../chunk-7DZN7VCC.js (Gemini).
 *   ```json
 *   { "mcpServers": { "<name>": { "command": "<path>", "args": ["..."] } } }
 *   ```
 *   Entry shape: `{ command: string, args?: string[], env?, envFile?, cwd?, enabledTools?, url?, timeout?, trust? }`.
 *
 * ### OpenCode (key `mcp`)
 * Top-level key: `mcp` (object, server-name → entry).
 * Entry shape: `{ type: "local" | "stdio", command: string | string[], enabled?: boolean, ... }`.
 *
 * ### VS Code Copilot Chat (key `servers`)
 * Top-level key: `servers` (object, server-name → entry).
 * Entry shape: varies by implementation.
 *
 * ## Error-guard pattern (mirrors McpRegistration.ts)
 * ENOENT → create fresh; any other read/parse error → log.warn + return without writing
 * (preserves the user's file even if it is mid-edit or corrupted).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../../Logger.js";

const log = createLogger("JsonMcpWriter");
const SERVER_KEY = "jollimemory";
const DEFAULT_KEY = "mcpServers";

type ServerEntry = Record<string, unknown>;
type JsonConfig = Record<string, unknown>;

/**
 * Add or refresh the `jollimemory` entry in `configPath`'s servers object (keyed by `serversKey`).
 * Idempotent: re-running with the same entry is a no-op in effect (overwrites
 * with identical content). Other servers in the file are always preserved.
 * Parent directories are created if they do not exist.
 *
 * @param configPath path to the JSON config file
 * @param entry server entry (shape depends on the target config format)
 * @param serversKey top-level key for the servers object (defaults to "mcpServers")
 */
export async function upsertJsonMcpServer(
	configPath: string,
	entry: ServerEntry,
	serversKey: string = DEFAULT_KEY,
): Promise<void> {
	let config: JsonConfig;
	try {
		const raw = await readFile(configPath, "utf-8");
		// An empty / whitespace-only file is a fresh-start placeholder, NOT corruption:
		// VS Code ships an empty `User/mcp.json` by default, so JSON.parse("") would
		// otherwise throw and wrongly trip the unreadable-guard below, skipping registration.
		// An empty file has no servers to preserve, so starting from {} is safe.
		config = raw.trim() === "" ? {} : (JSON.parse(raw) as JsonConfig);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// File exists with NON-EMPTY content that is unreadable or not valid JSON
			// (mid-edit, trailing comma, partial write, EACCES). Resetting to {} would
			// silently drop the user's other MCP servers — so refuse to write and leave
			// the file untouched. Re-registration on the next install/activate recovers
			// once the file is valid.
			log.warn("Skipping MCP registration: %s unreadable/invalid (%s)", configPath, String(err));
			return;
		}
		config = {}; // no file yet — fine to create a fresh one
	}
	const servers = (config[serversKey] as Record<string, ServerEntry> | undefined) ?? {};
	servers[SERVER_KEY] = entry;
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...config, [serversKey]: servers }, null, 2)}\n`, "utf-8");
	log.info("Registered MCP server in %s", configPath);
}

/**
 * Remove the `jollimemory` entry from `configPath`'s servers object (keyed by `serversKey`).
 * No-op if the file is absent, unreadable, or the entry is already gone.
 * Other servers are always preserved.
 *
 * @param configPath path to the JSON config file
 * @param serversKey top-level key for the servers object (defaults to "mcpServers")
 */
export async function removeJsonMcpServer(configPath: string, serversKey: string = DEFAULT_KEY): Promise<void> {
	let config: JsonConfig;
	try {
		config = JSON.parse(await readFile(configPath, "utf-8")) as JsonConfig;
	} catch {
		return; // absent or unreadable → nothing to remove
	}
	const servers = config[serversKey] as Record<string, ServerEntry> | undefined;
	if (!servers?.[SERVER_KEY]) return;
	delete servers[SERVER_KEY];
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	log.info("Removed MCP server from %s", configPath);
}
