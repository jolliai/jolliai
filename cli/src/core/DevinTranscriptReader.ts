/**
 * Devin CLI Transcript Reader
 *
 * Reads one Devin session (identified by a "<dbPath>#<sessionId>" synthetic
 * path) out of the global sessions.db and returns the canonical conversation.
 *
 * Devin's `message_nodes` form a FOREST: alternate regenerations appear as
 * sibling nodes under one parent. The canonical thread is the "main chain",
 * walked from `sessions.main_chain_id` up the `parent_node_id` pointers to a
 * root, then reversed. Each `chat_message` is JSON:
 *   { role: "system"|"user"|"assistant"|"tool", content: string, metadata: { created_at } }
 * Role mapping: user→human, assistant→assistant, system/tool dropped, empty→skipped.
 *
 * Envelope verified against a live `~/.local/share/devin/cli/sessions.db`
 * install: `content` is always a plain string (assistant turns that are pure
 * tool calls carry `content: ""`, which the empty-content skip already
 * handles), and `metadata.created_at` is an ISO 8601 string. Other fields the
 * live rows carry (`tool_calls`, `thinking`, `tool_call_id`, `telemetry`,
 * `extensions`, …) are ignored — only `role`/`content`/`metadata.created_at`
 * are read here.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("DevinReader");

interface NodeRow {
	readonly node_id: number;
	readonly parent_node_id: number | null;
	readonly chat_message: string;
}

interface ChatMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly metadata?: { readonly created_at?: unknown } | null;
}

const ROLE_MAP: Readonly<Record<string, "human" | "assistant">> = {
	user: "human",
	assistant: "assistant",
};

/** Split "<dbPath>#<sessionId>" into its parts. */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hash = transcriptPath.lastIndexOf("#");
	if (hash < 0) {
		throw new Error(`Malformed Devin transcript path (no '#'): ${transcriptPath}`);
	}
	return { dbPath: transcriptPath.slice(0, hash), sessionId: transcriptPath.slice(hash + 1) };
}

/**
 * Walk from the tip node up parent pointers to a root, then reverse to
 * chronological order. Cycle-guarded; stops on a dangling parent.
 */
function buildMainChain(byId: Map<number, NodeRow>, tip: number | null): NodeRow[] {
	const chain: NodeRow[] = [];
	const visited = new Set<number>();
	let cur: number | null = tip;
	while (cur !== null && byId.has(cur) && !visited.has(cur)) {
		visited.add(cur);
		const node = byId.get(cur) as NodeRow;
		chain.push(node);
		cur = node.parent_node_id;
	}
	chain.reverse();
	return chain;
}

/** Best-effort epoch-ms of a node's `metadata.created_at`; NaN when absent/unparsable. */
function nodeCreatedMs(node: NodeRow): number {
	try {
		const msg = JSON.parse(node.chat_message) as ChatMessage;
		const raw = msg.metadata?.created_at;
		return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

/**
 * Pick a tip when `sessions.main_chain_id` is NULL or dangles. The greatest
 * `node_id` is a poor proxy — in a forest the highest id can belong to a
 * discarded regeneration sibling, which would reconstruct the wrong thread.
 * Instead choose the most recently created LEAF (a node that no other node
 * parents), which yields a complete root→leaf chain anchored on the branch the
 * user most recently extended. Ties (or nodes with no parseable timestamp)
 * break on the greater `node_id`, preserving the old behavior as a floor.
 */
function pickFallbackTip(nodeRows: ReadonlyArray<NodeRow>): number | null {
	if (nodeRows.length === 0) {
		return null;
	}
	const parentIds = new Set<number>();
	for (const r of nodeRows) {
		if (r.parent_node_id !== null) {
			parentIds.add(r.parent_node_id);
		}
	}
	const leaves = nodeRows.filter((r) => !parentIds.has(r.node_id));
	// A well-formed forest always has ≥1 leaf; a fully-cyclic graph has none, in
	// which case fall back to every node so we still return a usable tip.
	const candidates = leaves.length > 0 ? leaves : nodeRows;
	let best = candidates[0];
	let bestMs = nodeCreatedMs(best);
	for (const r of candidates) {
		const ms = nodeCreatedMs(r);
		// Treat NaN as -Infinity so any timestamped node outranks an untimed one.
		const rKey = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
		const bestKey = Number.isFinite(bestMs) ? bestMs : Number.NEGATIVE_INFINITY;
		if (rKey > bestKey || (rKey === bestKey && r.node_id > best.node_id)) {
			best = r;
			bestMs = ms;
		}
	}
	return best.node_id;
}

/**
 * Resolve where to resume reading `chain` from the incoming cursor.
 *
 * Preferred path: the cursor carries an `anchorId` (the `node_id` of the last
 * node consumed on the previous read). We locate it in the freshly-rebuilt
 * chain and resume just after it. If it's gone — a regeneration behind the
 * cursor re-pointed the accepted chain and dropped that node — we re-read from
 * the start rather than `slice()` past nodes that no longer exist, which would
 * silently drop the regenerated turns.
 *
 * Legacy path (no `anchorId`): fall back to the raw positional `lineNumber`.
 */
function resolveStartIndex(chain: ReadonlyArray<NodeRow>, cursor?: TranscriptCursor | null): number {
	if (!cursor) {
		return 0;
	}
	if (cursor.anchorId !== undefined) {
		const anchor = Number(cursor.anchorId);
		const idx = chain.findIndex((n) => n.node_id === anchor);
		if (idx >= 0) {
			return idx + 1;
		}
		log.debug("Devin cursor anchor %s no longer on the main chain — re-reading from start", cursor.anchorId);
		return 0;
	}
	return Math.min(cursor.lineNumber ?? 0, chain.length);
}

export async function readDevinTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const cutoffTime = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	try {
		const { rawEntries, totalNodes, startIndex, lastConsumedIndex, anchorId } = await withSqliteDb(dbPath, (db) => {
			const sessionRow = db.prepare("SELECT main_chain_id FROM sessions WHERE id = ? LIMIT 1").get(sessionId) as
				| { main_chain_id: number | null }
				| undefined;
			if (!sessionRow) {
				throw new Error(`Devin session ${sessionId} not found`);
			}

			const nodeRows = db
				.prepare("SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ?")
				.all(sessionId) as ReadonlyArray<NodeRow>;
			const byId = new Map<number, NodeRow>(nodeRows.map((r) => [r.node_id, r]));

			// main_chain_id NULL (or pointing at a node that isn't in this session) → fall
			// back to the most recently created leaf (see pickFallbackTip).
			let tip = sessionRow.main_chain_id;
			if (tip === null || !byId.has(tip)) {
				log.debug("Devin session %s has no usable main_chain_id — inferring tip from leaves", sessionId);
				tip = pickFallbackTip(nodeRows);
			}

			const chain = buildMainChain(byId, tip);
			// Resume by content anchor (regeneration-safe), not raw position.
			const startIndex = resolveStartIndex(chain, cursor);
			const newNodes = chain.slice(startIndex);
			const rawEntries: TranscriptEntry[] = [];
			let lastConsumedIndex = startIndex;

			for (let i = 0; i < newNodes.length; i++) {
				const node = newNodes[i];
				let msg: ChatMessage;
				try {
					msg = JSON.parse(node.chat_message) as ChatMessage;
				} catch {
					log.debug("Skipping Devin node %d: invalid chat_message JSON", node.node_id);
					lastConsumedIndex = startIndex + i + 1;
					continue;
				}

				const timestamp = typeof msg.metadata?.created_at === "string" ? msg.metadata.created_at : undefined;
				// Untimed / unparsable-timestamp nodes are intentionally kept under a
				// cutoff (favor completeness over truncation for anomalous rows); only
				// a node we can prove is after the cutoff stops the walk.
				if (cutoffTime !== undefined && timestamp !== undefined) {
					const t = Date.parse(timestamp);
					if (Number.isFinite(t) && t > cutoffTime) {
						break;
					}
				}

				const role = typeof msg.role === "string" ? ROLE_MAP[msg.role] : undefined;
				const content = typeof msg.content === "string" ? msg.content.trim() : "";
				if (role !== undefined && content.length > 0) {
					rawEntries.push({ role, content, timestamp });
				}
				lastConsumedIndex = startIndex + i + 1;
			}

			// Anchor the next read on the last node we actually consumed. When
			// nothing new was consumed, carry the incoming anchor forward.
			const anchorId =
				lastConsumedIndex > 0 ? String(chain[lastConsumedIndex - 1].node_id) : (cursor?.anchorId ?? undefined);

			return { rawEntries, totalNodes: chain.length, startIndex, lastConsumedIndex, anchorId };
		});

		const entries = mergeConsecutiveEntries(rawEntries);
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalNodes,
			updatedAt: new Date().toISOString(),
			...(anchorId !== undefined ? { anchorId } : {}),
		};
		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Devin session %s: %d new nodes, %d entries (index %d→%d)",
			sessionId,
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);
		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read Devin session %s: %s", sessionId, (error as Error).message);
		// Preserve an ENOENT code so callers (e.g. TranscriptLoader) can treat a
		// vanished DB as a silent "not present" rather than a real read failure.
		const wrapped = new Error(`Cannot read Devin session: ${sessionId}`) as NodeJS.ErrnoException;
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== undefined) {
			wrapped.code = code;
		}
		throw wrapped;
	}
}
