/**
 * Minimal block-level YAML writer for Hermes' config.yaml.
 *
 * Handles TWO top-level mappings — `mcp_servers:` (MCP registration) and
 * `hooks:` (shell hook declarations). Everything else in the file — provider,
 * credentials in `custom_providers[].api_key`, terminal/browser policy, dozens
 * of nested sub-sections — is preserved byte-stable.
 *
 * ## The contract this shares with `CodexTomlWriter`
 *
 * Every rule below is the same rule the Codex writer shipped — Hermes' file
 * carries the same kind of user configuration, and getting it wrong has the same
 * cost (a torn write truncating other tools' credentials, a widened mode leaking
 * secrets, an mtime storm invalidating the runtime's config cache). Read that
 * file's header for the WHY; this comment repeats only the delta.
 *
 * - **No-op short-circuit on identical bytes.** `install()` runs on every plugin
 *   bootstrap and every `jolli enable`, so the write path is a hot loop over a
 *   file mostly full of other people's configuration. Re-serialising to
 *   byte-identical output on every session is pure risk.
 * - **Atomic write.** `atomicWriteFile` = tmpfile + rename, so a torn write
 *   cannot truncate the user's `custom_providers[].api_key`.
 * - **Preserve mode.** `atomicWriteFile` gives the tmpfile the umask-derived
 *   mode (typically 0644), and the rename carries it onto the target. That
 *   file's default is 0600 (Hermes' own writer sets it — the file has plaintext
 *   api keys). Read the current mode back and pass it in, so a write does not
 *   silently widen 0600 to 0644.
 *
 * ## The delta from CodexTomlWriter, and why YAML forced them
 *
 * ### 1. Two top-level keys, not one
 *
 * The Codex writer only touched one table (`[mcp_servers.jollimemory]`). Hermes
 * has both `mcp_servers:` and `hooks:` blocks and each has independent lifecycle
 * (MCP is per-machine registration, hook is per-machine shell hook). So the
 * writer works on {@link YamlBlockKey} — a discriminator of which top-level key
 * a call targets — and the block-find / block-strip / block-append logic is
 * key-parameterised.
 *
 * ### 2. YAML has NO literal "table header", so the boundary is indentation
 *
 * TOML's block boundary is `[table.subtable]` at start of line. YAML's is:
 *
 *   - the top-level key line (`hooks:` at column 0), then
 *   - every subsequent line that is EITHER blank OR starts with whitespace
 *     (`^[ \t]`), until
 *   - the next top-level, non-comment, non-empty line (`^[^\s#]`) — the block
 *     ends BEFORE that line.
 *
 * The Codex writer took advantage of "one table = one line + content until next
 * `\n[`". Here we scan line by line, which is why the block find / strip
 * functions are more code even though the shape is the same.
 *
 * A comment sitting at column 0 between our block and the next real key is kept
 * with what follows it, not with our block. That is the only readable answer —
 * `# ... explains the next section ...` belongs to the next section by
 * convention, and stripping it with our block would delete the user's comment.
 *
 * ### 3. `mcp_servers: {}` is the OFF state, not an empty block
 *
 * When Hermes has no MCP servers configured, its writer leaves `mcp_servers: {}`
 * on ONE line. That flow-mapping is the same key as `mcp_servers:` followed by
 * nothing — semantically identical, syntactically distinct. Upsert must handle
 * both: overwrite `{}` and also overwrite an empty block. This is what the
 * `TRIVIAL_INLINE_VALUES` case handles.
 *
 * ### 4. The header is matched at the LEFT MARGIN only
 *
 * `mcp_servers:` inside a comment or inside another block's value must not be
 * mistaken for our block. Same rule as Codex's `^\[` anchor, expressed here as
 * "line starts with the key name at column 0".
 *
 * ## What we do NOT do
 *
 * We do NOT preserve YAML comments inside the sections we own. Hermes' own
 * writer (`utils.atomic_yaml_write`) is a `pyyaml.dump` — it strips every
 * comment and reorders keys on every save. So "preserving comments" was never on
 * the table; the user's own `hermes model` / `hermes mcp add` erases them, and
 * our contract just matches. What we DO preserve is every other TOP-LEVEL
 * section byte-for-byte — that is the whole file except the two 3-line blocks
 * we author.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../core/AtomicWrite.js";
import { createLogger } from "../../Logger.js";

const log = createLogger("HermesConfigWriter");

/** The top-level keys this writer knows how to upsert. */
export type YamlBlockKey = "mcp_servers" | "hooks";

/**
 * A single entry inside a top-level key. `subKey` is the child key
 * (`jollimemory` under `mcp_servers`, an event name like `on_session_end`
 * under `hooks`), `body` is its already-rendered YAML block INDENTED at 2
 * spaces (or a list, indented the same).
 */
export interface YamlBlockEntry {
	readonly subKey: string;
	readonly body: string;
}

/** File's current mode, or 0o600 when absent. See {@link upsertYamlBlockEntry}. */
async function currentMode(p: string): Promise<number> {
	try {
		return (await stat(p)).mode & 0o777;
	} catch {
		return 0o600;
	}
}

/** Normalize CRLF (and bare CR) to LF so regex `$` anchors work on Windows-edited files. */
function normalizeLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Predicate helpers used by the block scan. */
const isBlank = (line: string): boolean => /^\s*$/.test(line);
const isCommentAtCol0 = (line: string): boolean => /^#/.test(line);
const isIndentedOrBlank = (line: string): boolean => line.length === 0 || /^[ \t]/.test(line);

/**
 * Drop a header line's inline value when the whole of it is a YAML comment.
 *
 * `key: # remark` is block form: the comment is not a value, the indented lines
 * below are. Every caller either compares this result against
 * {@link TRIVIAL_INLINE_VALUES} or reads a non-empty one as "an inline shape
 * this small parser will not touch" — so a comment reaching either test is the
 * same silent failure at three different depths, and all three fail by doing
 * nothing while reporting success: the whole block is skipped, our own entry is
 * never refreshed, or our hook is never registered at all.
 *
 * Only a value that is ENTIRELY a comment is stripped. A `#` further along may
 * be a literal inside a flow mapping (`{cmd: "a # b"}`), and telling those apart
 * needs a real YAML scanner — so `{} # note` stays non-trivial and its caller
 * keeps its hands off it. That conservative half is the same contract: guessing
 * there would corrupt the file, which is worse than the stale value it avoids.
 *
 * Takes an already-trimmed value; every caller's header regex trims for it.
 */
function stripTrailingComment(inlineValue: string): string {
	return inlineValue.startsWith("#") ? "" : inlineValue;
}

/**
 * Locate the block for `key` in `lines`. Returns:
 *   - null when the key is absent,
 *   - `{ headerIndex, endIndex, trivialInline }` when it is present.
 *
 * `headerIndex` is the 0-based line index of `<key>:` at column 0.
 * `endIndex` is the FIRST line index NOT belonging to the block (or `lines.length`
 * when the block reaches EOF), so `lines.slice(headerIndex, endIndex)` is the
 * whole block.
 *
 * `trivialInline` is true when the header line is `<key>: {}` / `<key>: []` /
 * `<key>: null` — Hermes' own "empty" idiom. These have no indented body and
 * the block is exactly ONE line.
 */
interface BlockLocation {
	readonly headerIndex: number;
	readonly endIndex: number;
	readonly trivialInline: boolean;
	/**
	 * True when the header line itself carries a non-trivial inline value
	 * (for example `mcp_servers: {someServer: {command: x}}`). This writer
	 * does not understand such a block well enough to merge into it without
	 * risking user data, so upsert callers must leave the file untouched.
	 */
	readonly nonTrivialInline: boolean;
}

const TRIVIAL_INLINE_VALUES = new Set(["{}", "[]", "null", "~"]);

function findBlock(lines: ReadonlyArray<string>, key: string): BlockLocation | null {
	const headerRe = new RegExp(`^${key}:(\\s*(.*))?$`);
	let headerIndex = -1;
	let inlineValue: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const m = headerRe.exec(lines[i]);
		if (m !== null) {
			headerIndex = i;
			inlineValue = (m[2] ?? "").trim();
			break;
		}
	}
	if (headerIndex === -1) return null;

	// A trailing YAML comment (`mcp_servers: # remark`) is semantically null —
	// strip it so it does not read as a non-trivial inline value.
	if (inlineValue !== undefined) inlineValue = stripTrailingComment(inlineValue);

	if (inlineValue !== undefined && inlineValue.length > 0) {
		if (TRIVIAL_INLINE_VALUES.has(inlineValue)) {
			return { headerIndex, endIndex: headerIndex + 1, trivialInline: true, nonTrivialInline: false };
		}
		// A header line carrying a non-trivial inline value (unusual — Hermes'
		// own writer never emits one). We mark it explicitly so the pure
		// transforms can preserve the whole file instead of replacing the block
		// with an empty parse.
		return { headerIndex, endIndex: headerIndex + 1, trivialInline: false, nonTrivialInline: true };
	}

	// Ordinary block form: walk forward while lines are indented or blank.
	let endIndex = headerIndex + 1;
	while (endIndex < lines.length) {
		const line = lines[endIndex];
		if (isBlank(line)) {
			endIndex++;
			continue;
		}
		if (!isIndentedOrBlank(line) && !isCommentAtCol0(line)) break;
		if (isCommentAtCol0(line)) {
			// A col-0 comment might be INSIDE the block (followed by more indented
			// lines) or BETWEEN blocks (followed by another top-level key). Look
			// ahead past blanks and comments to decide.
			let peek = endIndex + 1;
			while (peek < lines.length && (isBlank(lines[peek]) || isCommentAtCol0(lines[peek]))) peek++;
			if (peek < lines.length && isIndentedOrBlank(lines[peek]) && !isBlank(lines[peek])) {
				endIndex++;
				continue;
			}
			break;
		}
		endIndex++;
	}
	// Trim trailing blank lines from the block — they belong to the seam between
	// this section and the next, not to the block itself.
	while (endIndex > headerIndex + 1 && isBlank(lines[endIndex - 1])) endIndex--;
	return { headerIndex, endIndex, trivialInline: false, nonTrivialInline: false };
}

/**
 * True when `text` has a `key` header whose value is a non-trivial inline
 * block. Used by the file-writing wrappers to log an accurate skip message;
 * the pure transforms also short-circuit on this state so no call path can
 * silently drop the user's existing inline configuration.
 */
export function hasNonTrivialInlineBlock(text: string, key: YamlBlockKey): boolean {
	const normalized = normalizeLF(text);
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	return findBlock(lines, key)?.nonTrivialInline ?? false;
}

/**
 * Return the sub-entries the current block carries, as `{ subKey, body }` pairs.
 *
 * A sub-entry is `<indent><subKey>:` followed by every subsequent line whose
 * indent is DEEPER than that (or blank). Anything the writer does not recognise
 * — a sub-entry authored with a hand indent that differs from the block's own
 * norm — is kept verbatim. The result preserves declaration order.
 *
 * Returns `null` when the block is `{}`/`[]`/`null` (nothing to enumerate).
 */
function parseSubEntries(lines: ReadonlyArray<string>, block: BlockLocation): YamlBlockEntry[] | null {
	if (block.trivialInline) return null;
	const body = lines.slice(block.headerIndex + 1, block.endIndex);
	if (body.length === 0) return [];
	// Detect the block's baseline indent from the first non-blank body line.
	const first = body.find((l) => !isBlank(l));
	if (first === undefined) return [];
	const baseIndent = /^([ \t]+)/.exec(first)?.[1] ?? "";
	// PyYAML renders a sequence nested under a mapping as an "indentless"
	// sequence by default:
	//
	//   on_session_end:
	//   - command: /user/hook
	//
	// The list marker is at the SAME indent as the mapping key. It still belongs
	// to that key and must not be parsed as a sibling called "- command".
	const baseRe = new RegExp(`^${baseIndent}(?!-\\s)([^\\s:#][^:]*):(.*)$`);
	// A comment at exactly baseline indent — belongs to the NEXT entry, not the
	// current one (YAML convention: "# … explains the next section").
	const isBaselineComment = (line: string): boolean =>
		line.length > baseIndent.length && line.startsWith(baseIndent) && line[baseIndent.length] === "#";
	const entries: YamlBlockEntry[] = [];
	let i = 0;
	while (i < body.length) {
		if (isBlank(body[i])) {
			i++;
			continue;
		}
		const m = baseRe.exec(body[i]);
		if (m === null) {
			// A body line that is not a sub-entry header: a comment, a list item, or
			// a stray at a different indent. Kept as a standalone anonymous entry so
			// it survives removal of any neighboring sub-entry.
			entries.push({ subKey: "", body: `${body[i]}\n` });
			i++;
			continue;
		}
		const subKey = m[1].trim();
		// Collect this sub-entry: the header line itself, plus every following
		// blank / more-deeply-indented line.
		const start = i;
		i++;
		while (i < body.length) {
			const line = body[i];
			if (isBlank(line)) {
				i++;
				continue;
			}
			// Same-baseline-indent line means a sibling sub-entry begins here.
			if (baseRe.exec(line) !== null) break;
			// A comment at baseline indent belongs to the next entry — break so the
			// outer loop keeps it as a standalone anonymous entry.
			if (isBaselineComment(line)) break;
			// Any deeper indent is part of THIS entry.
			i++;
		}
		// Trim trailing blank lines from the entry — they belong to the seam.
		let endOfEntry = i;
		while (endOfEntry > start + 1 && isBlank(body[endOfEntry - 1])) endOfEntry--;
		entries.push({ subKey, body: `${body.slice(start, endOfEntry).join("\n")}\n` });
	}
	return entries;
}

/** Render `<key>:\n<entries>\n` — the ordinary YAML block form. */
function renderBlock(key: string, entries: ReadonlyArray<YamlBlockEntry>): string {
	if (entries.length === 0) return `${key}: {}`;
	const parts = entries.map((e) => e.body.replace(/\n+$/, ""));
	return `${key}:\n${parts.join("\n")}`;
}

/**
 * Add or refresh `entry` under `key` in the Hermes config at `p`.
 *
 * Preservation runs at THREE levels, and the innermost one is the easiest to
 * lose: every other TOP-LEVEL section stays byte-for-byte, every other SUB-ENTRY
 * under `key` stays verbatim (a user's other MCP servers, other hook events),
 * and inside our own sub-entry every CHILD KEY we do not author stays too — see
 * {@link mergeEntryPreservingExtras} for why that last one is a security
 * property and not just tidiness.
 *
 * Idempotent: re-running with the same entry writes nothing. Parent directories
 * are created if absent. Fails open on a permission-error read — the file is
 * left untouched and a warning is logged.
 */
export async function upsertYamlBlockEntry(p: string, key: YamlBlockKey, entry: YamlBlockEntry): Promise<void> {
	let text = "";
	try {
		text = await readFile(p, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping %s: %s unreadable (%s)", p, key, String(err));
			return;
		}
	}
	if (hasNonTrivialInlineBlock(text, key)) {
		log.warn(
			"Skipping Hermes %s upsert in %s: the %s block is a non-trivial inline block and was left untouched",
			key,
			p,
			key,
		);
		return;
	}
	const normalizedText = normalizeLF(text);
	const next = writeUpsert(normalizedText, key, entry);
	if (next === normalizedText) {
		log.info("Hermes %s already up to date in %s — no write needed", key, p);
		return;
	}
	await mkdir(dirname(p), { recursive: true });
	await atomicWriteFile(p, next, await currentMode(p));
	log.info("Wrote Hermes %s.%s to %s", key, entry.subKey, p);
}

/**
 * Remove `subKey` from the `key` block in the Hermes config at `p`. No-op when
 * the file is absent, the block is absent, or the sub-key is absent.
 */
export async function removeYamlBlockEntry(p: string, key: YamlBlockKey, subKey: string): Promise<void> {
	let text: string;
	try {
		text = await readFile(p, "utf-8");
	} catch {
		return;
	}
	const normalizedText = normalizeLF(text);
	const next = writeRemoval(normalizedText, key, subKey);
	if (next === normalizedText) return;
	await atomicWriteFile(p, next, await currentMode(p));
	log.info("Removed Hermes %s.%s from %s", key, subKey, p);
}

/**
 * Add or refresh one command in a Hermes hook event's LIST without replacing
 * the event. Users may register several commands for `on_session_end`; treating
 * that event as an ordinary mapping sub-entry would erase every sibling command.
 */
export async function upsertYamlHookCommand(
	p: string,
	event: string,
	command: string,
	timeoutSeconds: number,
): Promise<void> {
	let text = "";
	try {
		text = await readFile(p, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping %s: hooks unreadable (%s)", p, String(err));
			return;
		}
	}
	if (hasNonTrivialInlineBlock(text, "hooks")) {
		log.warn(
			"Skipping Hermes hooks upsert in %s: the hooks block is a non-trivial inline block and was left untouched",
			p,
		);
		return;
	}
	const normalizedText = normalizeLF(text);
	const next = writeHookCommandUpsert(normalizedText, event, command, timeoutSeconds);
	if (next === normalizedText) {
		log.info("Hermes hook already up to date in %s — no write needed", p);
		return;
	}
	await mkdir(dirname(p), { recursive: true });
	await atomicWriteFile(p, next, await currentMode(p));
	log.info("Wrote Hermes hook %s command to %s", event, p);
}

/** Remove only one command from a Hermes hook event, preserving every sibling. */
export async function removeYamlHookCommand(p: string, event: string, command: string): Promise<void> {
	let text: string;
	try {
		text = await readFile(p, "utf-8");
	} catch {
		return;
	}
	const normalizedText = normalizeLF(text);
	const next = writeHookCommandRemoval(normalizedText, event, command);
	if (next === normalizedText) return;
	await atomicWriteFile(p, next, await currentMode(p));
	log.info("Removed Hermes hook %s command from %s", event, p);
}

/**
 * Pure string transform: `text` → new text with `entry` upserted under `key`.
 *
 * Exported for tests so the semantics can be pinned without any filesystem — the
 * exhaustive edge-case coverage the wire-shape rules demand ({@link findBlock} /
 * {@link parseSubEntries} branches for `{}` / empty / interleaved-comments /
 * indent-drift) would otherwise need dozens of tmpfiles.
 */
export function writeUpsert(text: string, key: YamlBlockKey, entry: YamlBlockEntry): string {
	const normalized = normalizeLF(text);
	const lines = normalized.split("\n");
	// A trailing "" from a final \n keeps the join round-trip. Drop it so the
	// block-scan indices are exact; we re-terminate with a single "\n" at the end.
	if (normalized.endsWith("\n")) lines.pop();

	const block = findBlock(lines, key);
	const nextBlock = renderBlock(
		key,
		mergeEntries(block !== null ? (parseSubEntries(lines, block) ?? []) : [], entry),
	);

	let out: string;
	if (block === null) {
		// Append the whole block to the end of the file, separated by one blank line.
		const existing = lines.join("\n").replace(/\s*$/, "");
		out = existing.length === 0 ? nextBlock : `${existing}\n\n${nextBlock}`;
	} else {
		if (block.nonTrivialInline) return text;
		const before = lines.slice(0, block.headerIndex).join("\n");
		const after = lines.slice(block.endIndex).join("\n");
		out = [before, nextBlock, after].filter((s) => s.length > 0).join("\n");
	}
	// Always terminate with exactly one trailing newline — the standard POSIX
	// text-file shape and what Hermes' own writer produces. Preserves the
	// no-input case (`out === "…\n"`) too.
	return `${out.replace(/\n+$/, "")}\n`;
}

/**
 * Pure string transform: `text` → new text with `subKey` removed from `key`.
 *
 * Removing the LAST sub-entry collapses the whole block back to `<key>: {}` —
 * the same "off" state Hermes' own writer uses.
 */
export function writeRemoval(text: string, key: YamlBlockKey, subKey: string): string {
	const normalized = normalizeLF(text);
	const lines = normalized.split("\n");
	// A trailing empty element from a final \n keeps the join round-trip. Drop it so
	// the block-scan indices are exact; we re-terminate with a single "\n" at the end.
	if (normalized.endsWith("\n")) lines.pop();
	const block = findBlock(lines, key);
	if (block === null || block.trivialInline) return text;
	const entries = parseSubEntries(lines, block) ?? [];
	const remaining = entries.filter((e) => e.subKey !== subKey);
	if (remaining.length === entries.length) return text;

	const nextBlock = renderBlock(key, remaining);
	const before = lines.slice(0, block.headerIndex).join("\n");
	const after = lines.slice(block.endIndex).join("\n");
	const out = [before, nextBlock, after].filter((s) => s.length > 0).join("\n");
	return `${out.replace(/\n+$/, "")}\n`;
}

interface HookCommandItem {
	readonly start: number;
	readonly end: number;
	readonly indent: string;
	readonly command: string | null;
}

/** Decode the scalar shapes Hermes/PyYAML and this writer emit for `command`. */
function decodeYamlCommandScalar(raw: string): string | null {
	const value = raw.trim();
	if (value.length === 0) return null;
	// Block-scalar markers (`|`, `>`, `|-`, `>+`, `|2`, etc.) — the real value
	// is on the following indented lines and beyond this single-line parser.
	// Return null so the entry is treated as opaque (never matches our command).
	if (/^[|>][+-]?\d*$/.test(value)) return null;
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return null;
		}
	}
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}

/** Find `- command: ...` list items and their full line ranges. */
function hookCommandItems(lines: ReadonlyArray<string>): HookCommandItem[] {
	const starts: Array<{ index: number; indent: string; command: string | null }> = [];
	for (let i = 1; i < lines.length; i++) {
		const match = /^([ \t]*)-\s+command:\s*(.*?)\s*$/.exec(lines[i]);
		if (match !== null) starts.push({ index: i, indent: match[1], command: decodeYamlCommandScalar(match[2]) });
	}
	return starts.map((item, index) => {
		let end = lines.length;
		for (let i = item.index + 1; i < lines.length; i++) {
			if (lines[i].startsWith(`${item.indent}- `)) {
				end = i;
				break;
			}
		}
		// A later command marker at a different indent still begins a sibling item;
		// use the pre-scanned start as a conservative boundary.
		const nextStart = starts[index + 1]?.index;
		if (nextStart !== undefined) end = Math.min(end, nextStart);
		return { start: item.index, end, indent: item.indent, command: item.command };
	});
}

function renderHookCommand(indent: string, command: string, timeoutSeconds: number): string[] {
	return [`${indent}- command: ${JSON.stringify(command)}`, `${indent}  timeout: ${timeoutSeconds}`];
}

/** Merge one command into an existing event entry, collapsing stale duplicates. */
function mergeHookCommandEntry(
	entry: YamlBlockEntry,
	event: string,
	command: string,
	timeoutSeconds: number,
): YamlBlockEntry {
	const lines = entry.body.replace(/\n+$/, "").split("\n");
	const header = /^([ \t]*)[^:]+:\s*(.*?)\s*$/.exec(lines[0]);
	const headerIndent = header?.[1] ?? "  ";
	// `event: # remark` is block form, not an inline value — without the strip it
	// reads as one below and this event silently never receives our command.
	const inlineValue = stripTrailingComment(header?.[2] ?? "");
	// `event: []` / null is the empty state. Replace it with block form before
	// adding the first command; appending beneath an inline scalar is invalid YAML.
	if (TRIVIAL_INLINE_VALUES.has(inlineValue)) {
		return {
			subKey: event,
			body: `${headerIndent}${event}:\n${renderHookCommand(`${headerIndent}  `, command, timeoutSeconds).join("\n")}\n`,
		};
	}
	// A user-authored non-empty flow value (for example `event: [{...}]`) is
	// valid YAML but outside this byte-preserving writer's small parser. Appending
	// block-list lines beneath it would corrupt the whole config, so fail open and
	// leave that event untouched. MCP registration in the independent block still
	// succeeds; only this hook remains for the user to reconcile manually.
	if (inlineValue.length > 0) return entry;

	const items = hookCommandItems(lines);
	const matches = items.filter((item) => item.command === command);
	const listIndent = items[0]?.indent ?? `${headerIndent}  `;
	if (matches.length === 0) {
		return {
			subKey: event,
			body: `${[...lines, ...renderHookCommand(listIndent, command, timeoutSeconds)].join("\n")}\n`,
		};
	}

	const first = matches[0];
	const removeLines = new Set<number>();
	for (const item of matches) {
		for (let i = item.start; i < item.end; i++) removeLines.add(i);
	}
	const next = lines.filter((_line, index) => !removeLines.has(index));
	const removedBeforeFirst = [...removeLines].filter((index) => index < first.start).length;
	next.splice(first.start - removedBeforeFirst, 0, ...renderHookCommand(first.indent, command, timeoutSeconds));
	return { subKey: event, body: `${next.join("\n")}\n` };
}

/** Match the indentation already used by sibling hook events and their lists. */
function hookIndentsForNewEntry(entries: ReadonlyArray<YamlBlockEntry>): { event: string; list: string } {
	for (const entry of entries) {
		if (entry.subKey.length === 0) continue;
		const lines = entry.body.replace(/\n+$/, "").split("\n");
		const eventIndent = /^([ \t]*)/.exec(lines[0])?.[1];
		if (!eventIndent) continue;
		const existingListIndent = hookCommandItems(lines)[0]?.indent;
		return {
			event: eventIndent,
			// Reuse indentless PyYAML lists and hand-authored nested-list styles
			// exactly. An empty sibling has no list to inspect, so repeat its
			// indentation unit rather than falling back to a hard-coded two spaces.
			list: existingListIndent ?? `${eventIndent}${eventIndent}`,
		};
	}
	return { event: "  ", list: "    " };
}

/**
 * Pure transform for command-level hook upsert. Other events and other commands
 * in the same event remain byte-stable.
 */
export function writeHookCommandUpsert(text: string, event: string, command: string, timeoutSeconds: number): string {
	const normalized = normalizeLF(text);
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	const block = findBlock(lines, "hooks");
	const entries = block !== null ? (parseSubEntries(lines, block) ?? []) : [];
	const index = entries.findIndex((entry) => entry.subKey === event);
	const indent = hookIndentsForNewEntry(entries);
	const initial: YamlBlockEntry = {
		subKey: event,
		body: `${indent.event}${event}:\n${renderHookCommand(indent.list, command, timeoutSeconds).join("\n")}\n`,
	};
	const nextEntries = [...entries];
	if (index === -1) nextEntries.push(initial);
	else nextEntries[index] = mergeHookCommandEntry(entries[index], event, command, timeoutSeconds);
	const nextBlock = renderBlock("hooks", nextEntries);

	let out: string;
	if (block === null) {
		const existing = lines.join("\n").replace(/\s*$/, "");
		out = existing.length === 0 ? nextBlock : `${existing}\n\n${nextBlock}`;
	} else {
		if (block.nonTrivialInline) return text;
		const before = lines.slice(0, block.headerIndex).join("\n");
		const after = lines.slice(block.endIndex).join("\n");
		out = [before, nextBlock, after].filter((s) => s.length > 0).join("\n");
	}
	return `${out.replace(/\n+$/, "")}\n`;
}

/** Pure transform removing only a matching command from one hook event. */
export function writeHookCommandRemoval(text: string, event: string, command: string): string {
	const normalized = normalizeLF(text);
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	const block = findBlock(lines, "hooks");
	if (block === null || block.trivialInline) return text;
	const entries = parseSubEntries(lines, block) ?? [];
	const entryIndex = entries.findIndex((entry) => entry.subKey === event);
	if (entryIndex === -1) return text;

	const eventLines = entries[entryIndex].body.replace(/\n+$/, "").split("\n");
	const items = hookCommandItems(eventLines);
	const matches = items.filter((item) => item.command === command);
	if (matches.length === 0) return text;
	const removeLines = new Set<number>();
	for (const item of matches) {
		for (let i = item.start; i < item.end; i++) removeLines.add(i);
	}
	const remainingEventLines = eventLines.filter((_line, index) => !removeLines.has(index));
	const hasRemainingValue = remainingEventLines.slice(1).some((line) => !isBlank(line));
	const nextEntries = [...entries];
	if (hasRemainingValue) {
		nextEntries[entryIndex] = { subKey: event, body: `${remainingEventLines.join("\n")}\n` };
	} else {
		nextEntries.splice(entryIndex, 1);
	}

	const nextBlock = renderBlock("hooks", nextEntries);
	const before = lines.slice(0, block.headerIndex).join("\n");
	const after = lines.slice(block.endIndex).join("\n");
	const out = [before, nextBlock, after].filter((s) => s.length > 0).join("\n");
	return `${out.replace(/\n+$/, "")}\n`;
}

/**
 * One child key inside a sub-entry, with every line it owns.
 *
 * `key` is `""` for a group this parser does not read as a `key:` header — a
 * comment, a list item, a stray indent. Those are carried verbatim and in place,
 * so a merge cannot drop them either.
 */
interface EntryChild {
	readonly key: string;
	readonly lines: ReadonlyArray<string>;
}

interface ParsedEntry {
	/** The `<indent><subKey>:` line, verbatim. */
	readonly header: string;
	/**
	 * Whatever followed the colon on the header line, trimmed and with a
	 * whole-line comment stripped ({@link stripTrailingComment}). `""` for block
	 * form — which `jollimemory: # remark` also is.
	 */
	readonly inlineValue: string;
	/** The indent the child keys sit at. `""` when the entry has no children. */
	readonly indent: string;
	readonly children: EntryChild[];
}

/**
 * Split one sub-entry into its header line and one group per child key.
 *
 * Structurally the same scan as {@link parseSubEntries}, one level deeper: a
 * child owns its header line plus every following blank / more-deeply-indented
 * line, and a sibling begins at the next line back at the child indent. Returns
 * `null` when the first line is not a `key:` header at all.
 */
function parseEntryBody(body: string): ParsedEntry | null {
	const lines = body.replace(/\n+$/, "").split("\n");
	const header = /^[ \t]*[^\s:#][^:]*:\s*(.*?)\s*$/.exec(lines[0]);
	if (header === null) return null;
	const rest = lines.slice(1);
	const firstChild = rest.find((line) => !isBlank(line));
	const indent = firstChild === undefined ? "" : (/^([ \t]+)/.exec(firstChild)?.[1] ?? "");
	const children: EntryChild[] = [];
	if (indent.length > 0) {
		// Same `(?!-\s)` guard as parseSubEntries: an indentless PyYAML sequence
		// puts its `- ` marker at the key's own indent and is NOT a sibling key.
		const childRe = new RegExp(`^${indent}(?!-\\s)([^\\s:#][^:]*):`);
		let i = 0;
		while (i < rest.length) {
			if (isBlank(rest[i])) {
				i++;
				continue;
			}
			const match = childRe.exec(rest[i]);
			if (match === null) {
				children.push({ key: "", lines: [rest[i]] });
				i++;
				continue;
			}
			const start = i;
			i++;
			while (i < rest.length && (isBlank(rest[i]) || childRe.exec(rest[i]) === null)) i++;
			let end = i;
			while (end > start + 1 && isBlank(rest[end - 1])) end--;
			children.push({ key: match[1].trim(), lines: rest.slice(start, end) });
		}
	}
	return { header: lines[0], inlineValue: stripTrailingComment(header[1] ?? ""), indent, children };
}

/** Re-anchor `lines` from one child indent to another, preserving deeper nesting. */
function reindent(lines: ReadonlyArray<string>, from: string, to: string): string[] {
	if (from === to || from.length === 0) return [...lines];
	return lines.map((line) => (line.startsWith(from) ? to + line.slice(from.length) : line));
}

/**
 * Overlay `incoming`'s child keys onto `existing`, keeping every child key
 * `incoming` does not declare.
 *
 * This is the difference between refreshing our registration and rewriting the
 * user's entry. Hermes reads per-server keys we never author — `trust`, which
 * gates every write-capable tool call behind an approval prompt, is the one that
 * matters most — and a wholesale replacement deleted them. That failure is
 * silent AND it fails toward danger: an absent `trust` key means `full` in
 * Hermes' own normalisation, so the gate does not loosen by a notch, it turns
 * OFF, and the only visible symptom is that the prompts the operator asked for
 * stop appearing. Measured on a real config: one `jolli enable` removed a
 * hand-added `trust: untrusted`.
 *
 * Two shapes are handed back rather than merged, and each for its own reason:
 *
 *   - A trivial inline value (`jollimemory: {}` / `null`) is Hermes' "empty"
 *     idiom and carries nothing to keep, so `incoming` wins outright.
 *   - A NON-trivial inline value (`jollimemory: {command: x, trust: untrusted}`)
 *     is valid YAML this small parser does not understand. `existing` is
 *     returned untouched — the same fail-open choice {@link mergeHookCommandEntry}
 *     already makes one level down. Our command may then be stale, which is
 *     recoverable; deleting a key the user set is not.
 *
 * A trailing comment (`jollimemory: # my server`) is NEITHER of those — it is
 * block form with a remark on the header line, and {@link stripTrailingComment}
 * is what keeps it out of the second case. Without that, the entry took the
 * fail-open path forever and our `command` never refreshed again, which is a
 * regression against the wholesale replacement this function replaced: that one
 * at least always wrote the current path.
 */
function mergeEntryPreservingExtras(existing: YamlBlockEntry, incoming: YamlBlockEntry): YamlBlockEntry {
	const current = parseEntryBody(existing.body);
	const next = parseEntryBody(incoming.body);
	// Defensive rather than live: a sub-entry only reaches here once
	// {@link parseSubEntries} read a KEY off its first line, which is the shape
	// {@link parseEntryBody} needs, so neither is null today. It still hands back
	// `existing`, because the two regexes are written apart and the day they
	// drift, THIS is the line that decides whether the drift leaves our command
	// stale or quietly deletes the user's `trust`. Every bail-out below points the
	// same way for the same reason; `incoming` here would be the one exception,
	// and it would fail toward danger.
	if (current === null || next === null) return existing;
	if (current.inlineValue.length > 0) {
		return TRIVIAL_INLINE_VALUES.has(current.inlineValue) ? incoming : existing;
	}
	if (current.children.length === 0) return incoming;

	const merged: EntryChild[] = current.children.map((child) => {
		if (child.key.length === 0) return child;
		const replacement = next.children.find((c) => c.key === child.key);
		if (replacement === undefined) return child;
		// Re-anchor to the indent already in the file: sibling keys of one YAML
		// mapping must share an indent, so emitting ours verbatim beside a
		// hand-indented entry would produce a file Hermes cannot parse.
		return { key: child.key, lines: reindent(replacement.lines, next.indent, current.indent) };
	});
	const declared = new Set(current.children.map((child) => child.key));
	for (const child of next.children) {
		if (child.key.length === 0 || declared.has(child.key)) continue;
		merged.push({ key: child.key, lines: reindent(child.lines, next.indent, current.indent) });
	}

	return {
		subKey: existing.subKey,
		body: `${[current.header, ...merged.flatMap((child) => child.lines)].join("\n")}\n`,
	};
}

function mergeEntries(existing: ReadonlyArray<YamlBlockEntry>, entry: YamlBlockEntry): YamlBlockEntry[] {
	// Refresh an existing sub-entry KEY BY KEY; otherwise append. Replacing the
	// whole entry would delete the user's own per-server keys — see
	// {@link mergeEntryPreservingExtras}.
	const index = existing.findIndex((e) => e.subKey === entry.subKey);
	if (index === -1) return [...existing, entry];
	const next = [...existing];
	next[index] = mergeEntryPreservingExtras(existing[index], entry);
	return next;
}
