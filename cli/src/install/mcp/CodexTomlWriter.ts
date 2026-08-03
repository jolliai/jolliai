/**
 * Minimal block-level TOML writer for Codex MCP server registration.
 *
 * ## Verified config format (observed from real ~/.codex/config.toml on developer machine,
 *    confirmed against official Codex docs at https://developers.openai.com/codex/mcp)
 *
 * Codex global config: ~/.codex/config.toml
 * MCP servers use table key `mcp_servers` (underscore, NOT `mcpServers` or `mcp-servers`):
 *
 *   [mcp_servers.jollimemory]
 *   command = "/path/to/run-cli"
 *   args = ["mcp"]
 *
 * `args` is a standard TOML string array. `command` is a TOML string (double-quoted).
 * JSON.stringify produces valid TOML string / string-array values for our inputs
 * (no backslash paths, no special chars in args).
 *
 * ## Block-level merge strategy (no TOML library)
 *
 * We treat `[mcp_servers.jollimemory]` as a contiguous text block from its header line
 * to the next table `[` header (or EOF). Strip-then-append: remove any existing block,
 * then append the new block after the remaining content.
 *
 * The header is matched ONLY at the start of a line (start-of-file or after a
 * newline), so a header string that merely appears inside a comment or value
 * (e.g. `# see [mcp_servers.jollimemory]`) is never mistaken for the table.
 *
 * All other content is byte-stable: only the seam left behind by removing the
 * block is normalized to a single blank line — blank-line runs elsewhere in the
 * file are preserved exactly.
 *
 * ## Error-guard pattern (mirrors JsonMcpWriter.ts)
 * ENOENT -> create fresh file; any other read error -> log.warn + return (file untouched).
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../core/AtomicWrite.js";
import { createLogger } from "../../Logger.js";

const log = createLogger("CodexTomlWriter");
const HEADER = "[mcp_servers.jollimemory]";

/**
 * The file's current permission bits, or `0o600` when it does not exist yet.
 *
 * Exists so a write can carry the file's OWN mode through the atomic rename (which
 * would otherwise impose the tmpfile's). The 0600 default applies only to a file this
 * code creates.
 */
async function currentMode(p: string): Promise<number> {
	try {
		return (await stat(p)).mode & 0o777;
	} catch {
		return 0o600;
	}
}

function renderBlock(entry: { command: string; args?: string[] }): string {
	return `${HEADER}\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args ?? [])}\n`;
}

/**
 * Index of the `[mcp_servers.jollimemory]` table header, matched only at the
 * start of a line (offset 0 or immediately after a `\n`). Returns -1 if the
 * header is absent at line start — a header that only appears inside a comment
 * or value is intentionally not matched.
 */
function findBlockStart(text: string): number {
	if (text.startsWith(HEADER)) return 0;
	const idx = text.indexOf(`\n${HEADER}`);
	return idx === -1 ? -1 : idx + 1;
}

function stripBlock(text: string): string {
	const start = findBlockStart(text);
	if (start === -1) return text;
	const after = text.indexOf("\n[", start + HEADER.length);
	const end = after === -1 ? text.length : after + 1;
	const before = text.slice(0, start);
	const rest = text.slice(end);
	// Only normalize the seam between the kept content and what followed the
	// removed block — collapse the trailing newlines of `before` to a single
	// blank line. Untouched regions stay byte-for-byte identical.
	if (before === "" || rest === "") return before + rest;
	return `${before.replace(/\n+$/, "")}\n\n${rest}`;
}

/**
 * Add or refresh the `[mcp_servers.jollimemory]` table in the Codex config at `p`.
 * All other content is preserved byte-stable. Idempotent: re-running with the same
 * entry produces exactly one header. Parent directories are created if absent.
 */
export async function upsertCodexMcpServer(p: string, entry: { command: string; args?: string[] }): Promise<void> {
	let text = "";
	try {
		text = await readFile(p, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping Codex MCP: %s unreadable (%s)", p, String(err));
			return;
		}
	}
	const base = stripBlock(text).replace(/\s*$/, "");
	const next = base.length === 0 ? renderBlock(entry) : `${base}\n\n${renderBlock(entry)}`;

	// Write nothing when nothing changes. This is the load-bearing guard, not an
	// optimization: the Codex plugin's SessionStart bootstrap reaches this on EVERY
	// session (`install` with `repoHooksOnly` registers Codex regardless of
	// `automatic`), and this function rewrites the file WHOLE — a user's model
	// settings, sandbox policy and other servers' `env` blocks included. Re-serialising
	// all of that on every session start to produce identical bytes is pure risk: two
	// sessions starting together are last-writer-wins over the entire file, not just
	// over Jolli's table. In the steady state the entry already matches, so this
	// returns before touching anything.
	if (next === text) {
		log.info("Codex MCP server already registered in %s — no write needed", p);
		return;
	}

	await mkdir(dirname(p), { recursive: true });
	// Atomic, for the same reason the guard above exists: this file is mostly OTHER
	// tools' configuration, so a write torn by a crash or a full disk truncates far
	// more than Jolli's own table. A tmpfile + rename means a reader sees the old file
	// or the new one.
	//
	// Permissions: a file we CREATE gets 0600 — it lists commands this machine will
	// spawn and other tools' tokens, so a world-readable default is the wrong thing to
	// leave on a fresh machine. A file that already exists keeps its own mode, which
	// has to be read and passed back because `atomicWriteFile` applies `mode` to the
	// tmpfile and the rename carries it over (unlike `writeFile`, where mode is
	// creation-only). Silently re-chmod'ing another tool's config would be an
	// overreach in either direction.
	const mode = await currentMode(p);
	await atomicWriteFile(p, next, mode);
	log.info("Registered Codex MCP server in %s", p);
}

/**
 * Remove the `[mcp_servers.jollimemory]` table from the Codex config at `p`.
 * No-op if the file is absent or the table is not present. Other content preserved.
 */
export async function removeCodexMcpServer(p: string): Promise<void> {
	let text: string;
	try {
		text = await readFile(p, "utf-8");
	} catch {
		return;
	}
	if (findBlockStart(text) === -1) return;
	// Atomic and mode-preserving for the same reason as the upsert: most of this file
	// is other tools' configuration. The `findBlockStart` check above already makes
	// this a no-op when there is nothing to remove, so no separate short-circuit is
	// needed here.
	await atomicWriteFile(p, `${stripBlock(text).replace(/\s*$/, "")}\n`, await currentMode(p));
	log.info("Removed Codex MCP server from %s", p);
}
