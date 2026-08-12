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

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../core/AtomicWrite.js";
import { createLogger } from "../../Logger.js";

const log = createLogger("JsonMcpWriter");
const SERVER_KEY = "jollimemory";
const DEFAULT_KEY = "mcpServers";

type ServerEntry = Record<string, unknown>;
type JsonConfig = Record<string, unknown>;

/**
 * The file's current permission bits, or `undefined` when it does not exist yet.
 *
 * Exists because {@link atomicWriteFile} replaces the target's INODE — the tmpfile's
 * mode rides the rename onto the target, so a file the user (or its owning tool)
 * tightened to 0600 comes back 0644 at the writer's umask. `writeFile`, which this
 * module used before, kept the target's mode; the atomic write silently does not, and
 * these files hold other tools' `env` blocks and tokens. Measured: 0600 in, 0644 out.
 *
 * `undefined` for a file that does not exist is deliberate — it leaves creation on
 * node's umask-derived default, which is what this module has always produced. The
 * 0600-on-create policy {@link import("./CodexTomlWriter.js")} applies to
 * `~/.codex/config.toml` is a stricter, separate decision; tightening these files on
 * first contact is not part of preserving what the user already chose.
 */
async function currentMode(p: string): Promise<number | undefined> {
	try {
		return (await stat(p)).mode & 0o777;
	} catch {
		return undefined;
	}
}

/**
 * Add or refresh the `jollimemory` entry in `configPath`'s servers object (keyed by `serversKey`).
 * Other servers in the file are always preserved. Parent directories are created if
 * they do not exist.
 *
 * **Idempotent in WRITES, not just in content**, and that distinction is load-bearing
 * now that a plugin bootstrap reaches this on every session start (the Cursor plugin's
 * `sessionStart` hook registers `.cursor/mcp.json` regardless of `automatic`; before
 * that, `registerRepoMcpHosts` only ran from a user-invoked `jolli enable`). This
 * function rewrites the file WHOLE — a user's other MCP servers, their `env` blocks and
 * their hand-chosen formatting included — so re-serialising all of it every session to
 * produce identical bytes is pure risk: two sessions starting together are
 * last-writer-wins over the entire file rather than over Jolli's entry, and the host
 * watches this path, so every write also churns its server state. Compare the bytes we
 * would write against what is on disk and return before touching anything when they
 * match, exactly as `upsertCodexMcpServer` does for `config.toml`.
 *
 * The comparison is over CONTENT, not bytes, and on this path the difference is the
 * whole point. A byte compare against the file on disk misses whenever the user's copy
 * differs only in formatting — CRLF from a Windows checkout, a BOM, a four-space
 * indent — and then the guard never fires and every session rewrites after all, which
 * is the exact state it was added to end. So the parsed file is re-rendered through
 * this same serialiser BEFORE the entry is inserted, and the write is skipped when
 * inserting changed nothing. Two consequences, both wanted: it cannot be fooled by an
 * entry that deep-equals but serialises differently, and it leaves a user's own
 * formatting alone rather than normalising it away on first contact.
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
	let existing = "";
	try {
		const raw = await readFile(configPath, "utf-8");
		existing = raw;
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
	const render = (): string => `${JSON.stringify({ ...config, [serversKey]: servers }, null, 2)}\n`;
	// Rendered BEFORE the insertion below, so `next === before` means "inserting the
	// entry changed nothing" independently of how the file happens to be formatted.
	const before = render();
	servers[SERVER_KEY] = entry;
	const next = render();
	// Steady state on every session after the first — see the note above. `existing` is
	// the cheap exact-bytes path; `before` catches the same file written by another
	// hand (CRLF, BOM, different indent), where a byte compare would rewrite forever.
	if (next === existing || next === before) {
		log.info("MCP server already registered in %s — no write needed", configPath);
		return;
	}
	await mkdir(dirname(configPath), { recursive: true });
	// Atomic, for the same reason the guard above exists: this file is mostly OTHER
	// tools' configuration, so a write torn by a crash or a full disk truncates far more
	// than Jolli's own entry. A tmpfile + rename means a reader sees the old file or the
	// new one.
	//
	// Mode-preserving for the flip side of that same fact: the rename swaps the inode, so
	// without reading the mode back a file its owner tightened to 0600 is republished at
	// the writer's umask. See {@link currentMode}.
	await atomicWriteFile(configPath, next, await currentMode(configPath));
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
	// Atomic and mode-preserving for the same reasons as the upsert: the entry being
	// removed is Jolli's, but the file is mostly other tools'. The already-gone guard
	// above is what keeps this from rewriting on a repeat uninstall.
	await atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`, await currentMode(configPath));
	log.info("Removed MCP server from %s", configPath);
}
