/**
 * ClaudeEnvelopeParser — the Claude Code transcript envelope.
 *
 * Migrated verbatim from the inline loop that used to live in
 * ReferenceExtractor.ts (readRole / readContentBlocks / collectToolUses /
 * collectToolResults / extractResultPayloadText). Behaviour is byte-identical:
 * same substring pre-filter, same role dispatch, same tool_use→tool_result
 * pairing via `tool_use_id`, same `content` envelope stripping, same
 * `beforeTimestamp` cutoff on BOTH tool_use and tool_result, same line-number
 * accounting.
 *
 * The only structural change vs. the old code: instead of calling `walkPayload`
 * inline at each tool_result, it emits a NormalizedToolResult (carrying the
 * matched SourceDefinition + the JSON-parsed payload). The shared driver then
 * walks each payload. Emission order is strict transcript order, so the driver's
 * collect→dedupe produces identical output.
 *
 * Identity resolution goes through `SourceDefinitionRegistry.match()` for the
 * MCP path and `matchCliCommand` (agent-neutral) + `registry.byId()` for the
 * CLI/shell path. `bindings/claude/index.ts` now carries only the two
 * pre-filter constants (`CLAUDE_TOOL_PREFIXES`/`CLAUDE_SHELL_TOOL_NAMES`); the
 * old `resolveClaudeTool`/`claudeBindingForToolName`/`RULES` match-identity
 * layer was deleted once this parser became the only caller.
 */

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createLogger } from "../../Logger.js";
import { CLAUDE_SHELL_TOOL_NAMES, CLAUDE_TOOL_PREFIXES } from "./bindings/claude/index.js";
import { matchCliCommand } from "./bindings/cli/index.js";
import { isObject } from "./guards.js";
import { scanUserPermalinks } from "./SlackPermalink.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { getRegistry } from "./SourceDefinitionRegistry.js";
import { normalizeSlackThread } from "./sources/SlackNormalize.js";
import { normalizeZoomDoc } from "./sources/ZoomDocNormalize.js";
import type {
	EnvelopeParseResult,
	ExtractOptions,
	NormalizedToolResult,
	TranscriptEnvelopeParser,
} from "./TranscriptEnvelopeParser.js";

const log = createLogger("ClaudeEnvelopeParser");

const TOOL_USE_ID_SUBSTR = '"tool_use_id"';

// Per-line substring needles, computed ONCE at module load (both inputs are
// module-level constants). Recognition (which tool → which source) lives in the
// registry now; the needles use its Claude prefixes plus the shell tool names
// (exact-quoted to avoid matching e.g. `BashOutput`).
const NAME_NEEDLES = [
	...CLAUDE_TOOL_PREFIXES.map((p) => `"name":"${p}`),
	...[...CLAUDE_SHELL_TOOL_NAMES].map((n) => `"name":"${n}"`),
];

/** Claude's own MCP payloads are the model for the canonical shape, so normalize is identity. */
const identity = (business: unknown): unknown => business;

interface PendingEntry {
	readonly toolName: string;
	readonly timestamp?: string;
	readonly def: SourceDefinition;
	readonly normalize: (business: unknown, command?: string) => unknown;
	/** Originating shell command for CLI entries, forwarded to `normalize` so a
	 *  binding can recover payload-absent fields from the command args. Undefined
	 *  for MCP entries (whose `normalize` is identity). */
	readonly command?: string;
	/** CLI (shell) entries require a successful command — drop the result if
	 *  `is_error: true`. MCP entries set this false to keep prior behaviour. */
	readonly requireSuccess: boolean;
	/**
	 * The tool_use `input`, retained only for sources with a registered
	 * {@link CONTEXT_NORMALIZERS} entry (Slack, zoom-doc). Those need the tool
	 * result payload AND out-of-payload context from the originating tool_use —
	 * Slack's `channel_id` / `message_ts`, zoom-doc's `fileId` — that no other
	 * source needs; every other MCP source's `normalize` is `identity` and never
	 * looks at this field.
	 */
	readonly toolInput?: unknown;
}

class ClaudeEnvelopeParser implements TranscriptEnvelopeParser {
	parse(lines: string[], opts: ExtractOptions): EnvelopeParseResult {
		const fromLine = opts.fromLineNumber ?? 0;
		const pending = new Map<string, PendingEntry>();
		const results: NormalizedToolResult[] = [];
		let lastConsumed = fromLine;
		// Slack's normalize needs a url no MCP payload carries; the pasted
		// permalink (if any) is the only place it lives. Scanned once up front so
		// every user text line is visited exactly once regardless of how many
		// Slack tool_results follow it.
		const permalinks = scanUserPermalinks(lines);

		for (let i = fromLine; i < lines.length; i++) {
			const line = lines[i];
			lastConsumed = i + 1;
			/* v8 ignore start -- empty-line skip; real JSONL writers don't emit empty lines, but this is the defensive guard. */
			if (line.trim().length === 0) continue;
			/* v8 ignore stop */

			const hasAdapterNeedle = NAME_NEEDLES.some((needle) => line.includes(needle));
			const couldBeToolResult = pending.size > 0 && line.includes(TOOL_USE_ID_SUBSTR);
			if (!hasAdapterNeedle && !couldBeToolResult) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				log.warn(
					"Skipping malformed transcript line %d: %s | preview=%s",
					i,
					(err as Error).message,
					line.slice(0, 200),
				);
				continue;
			}

			const role = readRole(parsed);
			const blocks = readContentBlocks(parsed);
			const timestamp = readTimestamp(parsed);
			if (role === undefined || blocks === undefined) continue;

			if (role === "assistant") {
				collectToolUses(blocks, timestamp, opts.beforeTimestamp, pending);
				/* v8 ignore start -- readRole returns only "assistant" | "user" | undefined; undefined is filtered above, so the else-if's false branch is unreachable. */
			} else if (role === "user") {
				/* v8 ignore stop */
				collectToolResults(blocks, i + 1, timestamp, opts.beforeTimestamp, pending, results, permalinks, opts);
			}
		}

		return { results, lastLineNumberScanned: lastConsumed };
	}
}

export const claudeEnvelopeParser: TranscriptEnvelopeParser = new ClaudeEnvelopeParser();

// ─── Block-level helpers (migrated verbatim from ReferenceExtractor) ──────────

function readRole(parsed: unknown): "assistant" | "user" | undefined {
	/* v8 ignore start -- the outer caller only invokes this on lines that already passed `line.includes("tool_use_id")` or `"name":"mcp__<src>__"` substring filters, so JSON.parse-success of those lines essentially always yields a message-shaped object with a role. Kept as a defensive guard for malformed JSONL. */
	if (!isObject(parsed)) return undefined;
	const message = (parsed as { message?: unknown }).message;
	if (!isObject(message)) return undefined;
	/* v8 ignore stop */
	const role = (message as { role?: unknown }).role;
	if (role === "assistant" || role === "user") return role;
	return undefined;
}

function readContentBlocks(parsed: unknown): readonly unknown[] | undefined {
	const message = (parsed as { message?: { content?: unknown } }).message;
	const content = message?.content;
	return Array.isArray(content) ? content : undefined;
}

function readTimestamp(parsed: unknown): string | undefined {
	const ts = (parsed as { timestamp?: unknown }).timestamp;
	return typeof ts === "string" ? ts : undefined;
}

/** `input.command` when `block.input` carries a shell command line (`Bash`'s shape). */
function readCommand(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const cmd = (input as { command?: unknown }).command;
	return typeof cmd === "string" ? cmd : undefined;
}

function collectToolUses(
	blocks: readonly unknown[],
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, PendingEntry>,
): void {
	if (beforeTimestamp !== undefined && timestamp !== undefined && timestamp > beforeTimestamp) return;
	const registry = getRegistry();
	for (const block of blocks) {
		/* v8 ignore start -- defensive guards (non-object block, wrong type, missing id/name) are unreachable in valid Claude Code JSONL once the substring pre-filter passed; pinned for total-function semantics. */
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
		if (b.type !== "tool_use") continue;
		if (typeof b.id !== "string" || typeof b.name !== "string") continue;
		/* v8 ignore stop */
		const name = b.name;
		// MCP path: source recognition + tool-level business scope (e.g. Notion only
		// `notion-fetch`) live in the registry's `match.claude` rules.
		const mcpDef = registry.match("claude", name);
		if (mcpDef !== undefined) {
			pending.set(b.id, {
				toolName: name,
				timestamp,
				def: mcpDef,
				normalize: identity,
				requireSuccess: false,
				// Only sources with a registered context-normalizer read the
				// tool_use input (Slack's channel_id/message_ts, zoom-doc's
				// fileId); every other source's `normalize` is `identity` and
				// never reads `toolInput`, so it's left undefined for them.
				...(CONTEXT_NORMALIZER_IDS.has(mcpDef.id) ? { toolInput: b.input } : {}),
			});
			continue;
		}
		// CLI/shell fallback (e.g. `Bash` running `gh issue view … --json`): the
		// command is matched against the agent-neutral CLI registry, which yields a
		// SourceId mapped to its `def` here.
		if (CLAUDE_SHELL_TOOL_NAMES.has(name)) {
			const command = readCommand(b.input);
			if (command === undefined) continue;
			const cli = matchCliCommand(command);
			if (cli === null) continue;
			const cliDef = registry.byId(cli.id);
			/* v8 ignore start -- every CLI binding's id names a registered built-in source; guarded for totality. */
			if (cliDef === undefined) continue;
			/* v8 ignore stop */
			pending.set(b.id, {
				toolName: cli.canonicalToolName,
				timestamp,
				def: cliDef,
				normalize: cli.normalize,
				command,
				requireSuccess: true,
			});
		}
	}
}

/** `{channel_id, message_ts}` off a Slack tool_use's `input`, or undefined if malformed. */
function readSlackToolInput(input: unknown): { channelId: string; messageTs: string } | undefined {
	/* v8 ignore start -- defensive: real `slack_read_thread` tool_use input always carries both string fields; guarded for totality against a malformed/future MCP shape. */
	if (!isObject(input)) return undefined;
	const channelId = (input as { channel_id?: unknown }).channel_id;
	const messageTs = (input as { message_ts?: unknown }).message_ts;
	if (typeof channelId !== "string" || typeof messageTs !== "string") return undefined;
	/* v8 ignore stop */
	return { channelId, messageTs };
}

/** `{fileId}` off a zoom-doc tool_use's `input`, or undefined if malformed. */
function readZoomDocToolInput(input: unknown): { fileId: string } | undefined {
	/* v8 ignore start -- defensive: real `hub_get_file_content` tool_use input always carries fileId; guarded for totality against a malformed/future MCP shape. */
	if (!isObject(input)) return undefined;
	const fileId = (input as { fileId?: unknown }).fileId;
	if (typeof fileId !== "string" || fileId.length === 0) return undefined;
	/* v8 ignore stop */
	return { fileId };
}

/**
 * Parse-scoped context a context-aware normalizer may read beyond the tool
 * result payload: the pasted-permalink map and the caller's `ExtractOptions`
 * (workspace url, etc.).
 */
interface ContextNormalizeEnv {
	readonly permalinks: Map<string, string>;
	readonly opts: ExtractOptions;
}

/**
 * Closed registry of context-aware normalizers, keyed by source id. A source
 * belongs here IFF its canonical shape needs out-of-payload context — the
 * originating tool_use `input`, and/or parse-scoped state (permalink map,
 * workspace url) — that the default `identity` path cannot supply. Every other
 * MCP source's `normalize` is `identity` and never appears here.
 *
 * Returning null voids the reference. Adding a fourth such source is one entry
 * here, not a new `def.id === …` branch in `collectToolResults`.
 */
const CONTEXT_NORMALIZERS: Record<
	string,
	(payload: unknown, toolInput: unknown, env: ContextNormalizeEnv) => object | null
> = {
	slack: (payload, toolInput, env) => {
		const slackInput = readSlackToolInput(toolInput);
		/* v8 ignore start -- defensive: paired with a real slack_read_thread tool_use, input is always well-formed. */
		if (slackInput === undefined) return null;
		/* v8 ignore stop */
		const { channelId, messageTs } = slackInput;
		const url =
			env.permalinks.get(`${channelId}:${messageTs}`) ??
			(env.opts.slackWorkspaceUrl !== undefined
				? `${env.opts.slackWorkspaceUrl}/archives/${channelId}/p${messageTs.replace(".", "")}`
				: undefined);
		return normalizeSlackThread(payload, { channelId, url });
	},
	"zoom-doc": (payload, toolInput) => {
		const zoomInput = readZoomDocToolInput(toolInput);
		/* v8 ignore start -- defensive: paired with a real hub_get_file_content tool_use, input is always well-formed. */
		if (zoomInput === undefined) return null;
		/* v8 ignore stop */
		return normalizeZoomDoc(payload, { fileId: zoomInput.fileId });
	},
};

/**
 * Own-key ids of {@link CONTEXT_NORMALIZERS}. Membership is checked through this
 * set (own enumerable keys only) so a prototype-chain id (`toString`,
 * `constructor`) can never resolve a normalizer — the same closed-registry
 * boundary as SourceEngine's `TRANSFORM_NAMES`.
 */
const CONTEXT_NORMALIZER_IDS: ReadonlySet<string> = new Set(Object.keys(CONTEXT_NORMALIZERS));

function collectToolResults(
	blocks: readonly unknown[],
	lineNumber: number,
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, PendingEntry>,
	results: NormalizedToolResult[],
	permalinks: Map<string, string>,
	opts: ExtractOptions,
): void {
	if (beforeTimestamp !== undefined && timestamp !== undefined && timestamp > beforeTimestamp) return;
	for (const block of blocks) {
		/* v8 ignore start -- defensive guards: non-object block / non-tool_result type / non-string tool_use_id all unreachable in valid Claude Code JSONL once the substring pre-filter ran. */
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
		if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
		/* v8 ignore stop */
		const pendingEntry = pending.get(b.tool_use_id);
		if (!pendingEntry) continue;
		// CLI (shell) results require success: a failed command whose stdout is
		// valid issue JSON must not be ingested. Scoped to CLI entries via
		// `requireSuccess` so MCP results stay byte-identical (an errored MCP
		// result is still parsed exactly as before).
		if (pendingEntry.requireSuccess && b.is_error === true) {
			pending.delete(b.tool_use_id);
			continue;
		}
		const payloadText = extractResultPayloadText(b.content);
		/* v8 ignore start -- defensive against malformed payload (no text content); live transcripts always include payload text. */
		if (payloadText === undefined) {
			pending.delete(b.tool_use_id);
			continue;
		}
		/* v8 ignore stop */
		let parsedPayload: unknown;
		try {
			parsedPayload = JSON.parse(payloadText);
		} catch (err) {
			// A result whose JSON exceeded Claude Code's tool-output cap is not in
			// the transcript at all — the harness offloads it to a file and leaves
			// only an "Output has been saved to <path>" pointer here. Recover the
			// real payload from that file before giving up (e.g. get_meeting_assets,
			// whose bundled transcript routinely blows the cap).
			const recovered = recoverOffloadedPayload(payloadText);
			if (recovered === undefined) {
				log.warn(
					"Dropping tool_result for %s (%s): payload JSON.parse failed: %s | preview=%s",
					b.tool_use_id,
					pendingEntry.toolName,
					(err as Error).message,
					payloadText.slice(0, 200),
				);
				pending.delete(b.tool_use_id);
				continue;
			}
			log.info(
				"Recovered offloaded tool_result for %s (%s) from %s",
				b.tool_use_id,
				pendingEntry.toolName,
				recovered.path,
			);
			parsedPayload = recovered.payload;
		}

		// A source whose canonical shape needs out-of-payload context (the
		// tool_use input, and/or parse-scoped state like the permalink map /
		// workspace url) runs its registered context-normalizer here instead of
		// the identity path — a single data-driven branch rather than one
		// `def.id === …` block per such source. Membership goes through
		// CONTEXT_NORMALIZER_IDS (own keys only) so a prototype-chain id can
		// never resolve a function, and every other source's `normalize` stays a
		// pure `(payload, command) => payload` hook.
		const contextNormalize = CONTEXT_NORMALIZER_IDS.has(pendingEntry.def.id)
			? CONTEXT_NORMALIZERS[pendingEntry.def.id]
			: undefined;
		if (contextNormalize !== undefined) {
			const canonical = contextNormalize(parsedPayload, pendingEntry.toolInput, { permalinks, opts });
			if (canonical === null) {
				pending.delete(b.tool_use_id);
				continue;
			}
			results.push({
				def: pendingEntry.def,
				toolName: pendingEntry.toolName,
				payload: canonical,
				lineNumber,
				referencedAt: timestamp ?? "",
			});
			pending.delete(b.tool_use_id);
			continue;
		}

		results.push({
			def: pendingEntry.def,
			toolName: pendingEntry.toolName,
			payload: pendingEntry.normalize(parsedPayload, pendingEntry.command),
			lineNumber,
			referencedAt: timestamp ?? "",
		});
		pending.delete(b.tool_use_id);
	}
}

function extractResultPayloadText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	/* v8 ignore start -- defensive guards for non-standard payload shapes; live Claude Code JSONL always wraps tool_result.content as an array with at least one {type:"text"} block. Pinned to make the function total against fuzz / legacy inputs. */
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
	/* v8 ignore stop */
}

/** Cap on an offloaded file we'll read back — generous vs. observed ~130 KB bundles, but bounds a pathological read. */
const MAX_OFFLOAD_BYTES = 10 * 1024 * 1024;
/**
 * Claude Code offloads an oversized tool result to a file and leaves only a
 * pointer in the transcript — and it does so with TWO distinct wordings:
 *  1. Oversized-result error path: "…exceeds maximum allowed tokens. Output has
 *     been saved to <path>." (e.g. a ~120 KB get_meeting_assets bundle).
 *  2. Large non-error persistence path: a `<persisted-output>` wrapper reading
 *     "Output too large (N KB). Full output saved to: <path>" then a truncated
 *     preview (e.g. a ~65 KB hub_get_file_content doc).
 * Each capture group is the path (to end-of-line); recovery tries all patterns
 * so neither wording silently drops the reference.
 */
const OFFLOAD_POINTER_RES: readonly RegExp[] = [
	/exceeds maximum allowed tokens\. Output has been saved to (.+)/,
	/Output too large \([^)]*\)\. Full output saved to: (.+)/,
];

/**
 * When a tool result exceeds Claude Code's output cap, the transcript carries a
 * pointer string instead of the JSON; the real payload is on disk. Detect that
 * pointer, read the file back, and JSON-parse it. Returns undefined for any
 * non-offload parse failure, a path not sitting directly in the harness
 * `tool-results/` offload dir, a traversal attempt, a symlink, a
 * missing/oversized file, or a still-unparseable body — every such case falls
 * through to the caller's existing drop.
 */
function recoverOffloadedPayload(payloadText: string): { payload: unknown; path: string } | undefined {
	let match: RegExpExecArray | null = null;
	for (const re of OFFLOAD_POINTER_RES) {
		match = re.exec(payloadText);
		if (match !== null) break;
	}
	if (match === null) return undefined;
	// The pointer sits on its own line and ends the sentence, so trim the line
	// and strip a single trailing period before the "Format: …" schema hint.
	let path = match[1].split("\n")[0].trim();
	if (path.endsWith(".")) path = path.slice(0, -1);
	// Containment: only read a file sitting DIRECTLY in Claude Code's
	// `tool-results/` offload dir, and never a traversal path. Requiring
	// `tool-results` as the immediate parent (not merely a segment somewhere in
	// the path) keeps a crafted pointer from walking us into an unrelated tree
	// that happens to contain a `tool-results` component. The config/transcript
	// is not trusted with an arbitrary read.
	if (!isAbsolute(path)) return undefined;
	if (path.includes("..")) return undefined;
	const segments = path.split(/[\\/]/);
	if (segments[segments.length - 2] !== "tool-results") return undefined;
	try {
		// `lstatSync` (not `statSync`): a symlinked offload file reports
		// `isFile() === false` here, so the existing guard rejects it — the real
		// path Claude Code writes is a plain file, never a link.
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_OFFLOAD_BYTES) return undefined;
		return { payload: JSON.parse(readFileSync(path, "utf8")), path };
	} catch {
		return undefined;
	}
}
