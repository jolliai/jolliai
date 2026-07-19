/**
 * Devin CLI test fixture builder.
 *
 * Builds a throwaway SQLite database that reproduces the *real* Devin CLI
 * session-store schema — verified against a live
 * `~/.local/share/devin/cli/sessions.db` install (see
 * `cli/src/core/DevinSessionDiscoverer.ts` for the production reader) — but
 * with fully synthetic content: no real user paths, no real conversation text.
 *
 * Shared by `DevinSessionDiscoverer.test.ts` (session discovery, `sessions`
 * table only) and the Devin transcript reader's tests (`message_nodes` forest
 * walking), so both exercise the same schema definition instead of drifting
 * apart. Do not hand-roll a second copy of this schema in another test file —
 * import `createDevinDb` from here.
 *
 * Devin stores `last_activity_at` / `created_at` as epoch **SECONDS** — the
 * key difference from OpenCode's milliseconds. Every timestamp field accepted
 * by this helper is seconds; callers must not pass `Date.now()` directly
 * (use `Math.floor(Date.now() / 1000)`).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DevinMessageRole = "system" | "user" | "assistant" | "tool";

export interface DevinMessageNodeInput {
	readonly nodeId: number;
	/** null for a root (forest entry) node. */
	readonly parentNodeId: number | null;
	readonly role: DevinMessageRole;
	readonly content: string;
	/** Epoch seconds. */
	readonly createdAt: number;
	readonly isUserInput?: boolean;
}

export interface DevinSessionInput {
	readonly id: string;
	readonly workingDirectory: string;
	readonly title?: string | null;
	/** Epoch seconds. */
	readonly lastActivityAt: number;
	/** Epoch seconds; defaults to `lastActivityAt` when omitted. */
	readonly createdAt?: number;
	/** node_id of the tip of the accepted conversation chain, if any. */
	readonly mainChainId?: number | null;
	readonly hidden?: 0 | 1;
	/** Raw `workspace_dirs` column value (Devin stores a JSON array of paths). Passed through verbatim so tests can exercise malformed/non-array payloads. */
	readonly workspaceDirs?: string | null;
	readonly backendType?: string;
	readonly model?: string;
	readonly agentMode?: string;
	readonly messageNodes?: ReadonlyArray<DevinMessageNodeInput>;
}

/**
 * Creates `<dbDir>/sessions.db` with the real `sessions` + `message_nodes`
 * schema (columns and constraints match the live install) and inserts the
 * given rows. Returns the DB path.
 */
export async function createDevinDb(dbDir: string, sessions: ReadonlyArray<DevinSessionInput>): Promise<string> {
	await mkdir(dbDir, { recursive: true });
	const dbPath = join(dbDir, "sessions.db");
	const db = new DatabaseSync(dbPath);

	db.prepare(
		`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			working_directory TEXT NOT NULL,
			backend_type TEXT NOT NULL,
			model TEXT NOT NULL,
			agent_mode TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_activity_at INTEGER NOT NULL,
			title TEXT,
			main_chain_id INTEGER,
			shell_last_seen_index INTEGER DEFAULT 0,
			cogs_json TEXT,
			workspace_dirs TEXT,
			hidden INTEGER NOT NULL DEFAULT 0,
			metadata TEXT
		)`,
	).run();
	db.prepare(
		`CREATE TABLE message_nodes (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			node_id INTEGER NOT NULL,
			parent_node_id INTEGER,
			chat_message TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			metadata TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			UNIQUE(session_id, node_id)
		)`,
	).run();

	const insertSession = db.prepare(
		`INSERT INTO sessions
			(id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden, workspace_dirs)
		 VALUES (:id, :workingDirectory, :backendType, :model, :agentMode, :createdAt, :lastActivityAt, :title, :mainChainId, :hidden, :workspaceDirs)`,
	);
	const insertNode = db.prepare(
		`INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
		 VALUES (:sessionId, :nodeId, :parentNodeId, :chatMessage, :createdAt)`,
	);

	for (const s of sessions) {
		insertSession.run({
			id: s.id,
			workingDirectory: s.workingDirectory,
			backendType: s.backendType ?? "anthropic",
			model: s.model ?? "claude-sonnet",
			agentMode: s.agentMode ?? "plan",
			createdAt: s.createdAt ?? s.lastActivityAt,
			lastActivityAt: s.lastActivityAt,
			title: s.title ?? null,
			mainChainId: s.mainChainId ?? null,
			hidden: s.hidden ?? 0,
			workspaceDirs: s.workspaceDirs ?? null,
		});
		for (const node of s.messageNodes ?? []) {
			const chatMessage = JSON.stringify({
				message_id: `${s.id}-${node.nodeId}`,
				role: node.role,
				content: node.content,
				metadata: {
					created_at: new Date(node.createdAt * 1000).toISOString(),
					is_user_input: node.isUserInput ?? node.role === "user",
				},
			});
			insertNode.run({
				sessionId: s.id,
				nodeId: node.nodeId,
				parentNodeId: node.parentNodeId,
				chatMessage,
				createdAt: node.createdAt,
			});
		}
	}

	db.close();
	return dbPath;
}

/**
 * A representative synthetic message forest for one session:
 *   0 (system) -> 1 (user) -> 2 (assistant) -> 3 (tool) -> 5 (assistant, tip)
 * plus node 4, a discarded sibling regeneration that also parents off node 2
 * (Devin re-generated the assistant turn once before settling on node 3).
 * The accepted chain's tip is node 5 — pass `mainChainId: 5` on the session
 * that uses this forest.
 *
 * @param baseCreatedAt epoch seconds for node 0; later nodes increment from it.
 */
export function sampleDevinMessageForest(baseCreatedAt: number): DevinMessageNodeInput[] {
	return [
		{
			nodeId: 0,
			parentNodeId: null,
			role: "system",
			content: "You are Devin, an AI software engineer.",
			createdAt: baseCreatedAt,
		},
		{
			nodeId: 1,
			parentNodeId: 0,
			role: "user",
			content: "What is the current git branch?",
			createdAt: baseCreatedAt + 1,
			isUserInput: true,
		},
		{
			nodeId: 2,
			parentNodeId: 1,
			role: "assistant",
			content: "Let me check that for you.",
			createdAt: baseCreatedAt + 2,
		},
		{
			nodeId: 3,
			parentNodeId: 2,
			role: "tool",
			content: '{"branch":"main"}',
			createdAt: baseCreatedAt + 3,
		},
		{
			nodeId: 4,
			parentNodeId: 2,
			role: "assistant",
			content: "(discarded regeneration) Alternate response attempt.",
			createdAt: baseCreatedAt + 3,
		},
		{
			nodeId: 5,
			parentNodeId: 3,
			role: "assistant",
			content: "You are on branch main.",
			createdAt: baseCreatedAt + 4,
		},
	];
}
