/**
 * Hermes Agent test fixture builder.
 *
 * Builds a throwaway SQLite database reproducing the *real* Hermes Agent state
 * store — verified against a live `~/.hermes/state.db` (Hermes Agent v0.20.5,
 * `hermes_state_schema.py`) — with fully synthetic content: no real user paths,
 * no real conversation text.
 *
 * Shared by `HermesSessionDiscoverer.test.ts` (the `sessions` table) and
 * `HermesTranscriptReader.test.ts` (the `messages` table), so both exercise one
 * schema definition instead of drifting apart. Do not hand-roll a second copy
 * of this schema in another test file — import `createHermesDb` from here.
 *
 * Two shapes are easy to get wrong and are therefore encoded in the types:
 *
 *   - **Timestamps are epoch SECONDS as REAL**, not milliseconds and not
 *     integers (`started_at REAL NOT NULL`, `last_activity_at REAL`). A caller
 *     that passes `Date.now()` produces a session dated in the year 58,000 and
 *     every window filter silently keeps it.
 *   - **`tool_calls` is the OpenAI chat-completions array**, serialised as TEXT:
 *     `[{id, call_id, type:"function", function:{name, arguments}}]`, where
 *     `arguments` is itself a JSON *string*. {@link hermesToolCall} builds one
 *     correctly so a test cannot accidentally assert against a shape Hermes
 *     never writes.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type HermesMessageRole = "user" | "assistant" | "tool" | "system";

/** One entry of a `messages.tool_calls` array, in Hermes' on-disk shape. */
export interface HermesToolCallInput {
	readonly id: string;
	readonly name: string;
	/** Decoded arguments; serialised to the JSON *string* Hermes stores. */
	readonly args?: Record<string, unknown>;
}

export interface HermesMessageInput {
	readonly role: HermesMessageRole;
	readonly content?: string | null;
	/** Set on `role: "tool"` rows — the tool that produced the result. */
	readonly toolName?: string | null;
	/** Set on `role: "tool"` rows — pairs the result with its call. */
	readonly toolCallId?: string | null;
	/** Set on `role: "assistant"` rows that invoked tools. */
	readonly toolCalls?: ReadonlyArray<HermesToolCallInput>;
	/** Epoch SECONDS (REAL). */
	readonly timestamp: number;
	/** 1 = live, 0 = soft-archived (compaction-replaced or rewound). Default 1. */
	readonly active?: 0 | 1;
	/** 1 = archived BY a compaction (still real history). Default 0. */
	readonly compacted?: 0 | 1;
	/** 1 = this row IS a compaction summary Hermes inserted. Default 0. */
	readonly compressedSummary?: 0 | 1;
	/** "hidden" marks an empty placeholder row. Default null. */
	readonly displayKind?: string | null;
}

export interface HermesSessionInput {
	readonly id: string;
	/** Hermes' own platform tag: "cli", "telegram", … Default "cli". */
	readonly source?: string;
	readonly cwd?: string | null;
	readonly gitRepoRoot?: string | null;
	readonly gitBranch?: string | null;
	readonly title?: string | null;
	readonly titleSource?: string | null;
	readonly model?: string | null;
	/** Epoch SECONDS (REAL). */
	readonly startedAt: number;
	/** Epoch SECONDS (REAL); null for a session that has not ended. */
	readonly endedAt?: number | null;
	/** Epoch SECONDS (REAL); null falls back to `startedAt` in the reader. */
	readonly lastActivityAt?: number | null;
	readonly messageCount?: number;
	readonly toolCallCount?: number;
	readonly hidden?: 0 | 1;
	readonly archived?: 0 | 1;
	readonly messages?: ReadonlyArray<HermesMessageInput>;
}

/** Builds one `tool_calls` entry in Hermes' exact on-disk shape. */
export function hermesToolCall(input: HermesToolCallInput): Record<string, unknown> {
	return {
		id: input.id,
		call_id: input.id,
		response_item_id: `fc_${input.id}`,
		type: "function",
		function: { name: input.name, arguments: JSON.stringify(input.args ?? {}) },
	};
}

/**
 * Creates `<dbDir>/state.db` with the real `sessions` + `messages` schema
 * (subset: every column the production readers touch, with the live NOT NULL /
 * DEFAULT constraints) and inserts the given rows. Returns the DB path.
 */
export async function createHermesDb(dbDir: string, sessions: ReadonlyArray<HermesSessionInput>): Promise<string> {
	await mkdir(dbDir, { recursive: true });
	const dbPath = join(dbDir, "state.db");
	const db = new DatabaseSync(dbPath);

	db.prepare(
		`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			source TEXT NOT NULL,
			display_name TEXT,
			model TEXT,
			parent_session_id TEXT,
			started_at REAL NOT NULL,
			ended_at REAL,
			end_reason TEXT,
			message_count INTEGER DEFAULT 0,
			tool_call_count INTEGER DEFAULT 0,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			cache_read_tokens INTEGER DEFAULT 0,
			cache_write_tokens INTEGER DEFAULT 0,
			reasoning_tokens INTEGER DEFAULT 0,
			cwd TEXT,
			git_branch TEXT,
			git_repo_root TEXT,
			git_metadata_generation INTEGER NOT NULL DEFAULT 0,
			estimated_cost_usd REAL,
			actual_cost_usd REAL,
			title TEXT,
			title_source TEXT,
			last_activity_at REAL,
			api_call_count INTEGER DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0,
			pinned INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0
		)`,
	).run();

	db.prepare(
		`CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT,
			tool_call_id TEXT,
			tool_calls TEXT,
			tool_name TEXT,
			timestamp REAL NOT NULL,
			token_count INTEGER,
			finish_reason TEXT,
			observed INTEGER DEFAULT 0,
			_compressed_summary INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			compacted INTEGER NOT NULL DEFAULT 0,
			api_content TEXT,
			display_kind TEXT,
			display_metadata TEXT
		)`,
	).run();

	const insertSession = db.prepare(
		`INSERT INTO sessions (
			id, source, model, started_at, ended_at, message_count, tool_call_count,
			cwd, git_branch, git_repo_root, title, title_source, last_activity_at, archived, hidden
		) VALUES (
			:id, :source, :model, :startedAt, :endedAt, :messageCount, :toolCallCount,
			:cwd, :gitBranch, :gitRepoRoot, :title, :titleSource, :lastActivityAt, :archived, :hidden
		)`,
	);
	const insertMessage = db.prepare(
		`INSERT INTO messages (
			session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
			_compressed_summary, active, compacted, display_kind
		) VALUES (
			:sessionId, :role, :content, :toolCallId, :toolCalls, :toolName, :timestamp,
			:compressedSummary, :active, :compacted, :displayKind
		)`,
	);

	for (const s of sessions) {
		insertSession.run({
			id: s.id,
			source: s.source ?? "cli",
			model: s.model ?? null,
			startedAt: s.startedAt,
			endedAt: s.endedAt ?? null,
			messageCount: s.messageCount ?? s.messages?.length ?? 0,
			toolCallCount: s.toolCallCount ?? 0,
			cwd: s.cwd ?? null,
			gitBranch: s.gitBranch ?? null,
			gitRepoRoot: s.gitRepoRoot ?? null,
			title: s.title ?? null,
			titleSource: s.titleSource ?? (s.title ? "llm" : null),
			lastActivityAt: s.lastActivityAt === undefined ? s.startedAt : s.lastActivityAt,
			archived: s.archived ?? 0,
			hidden: s.hidden ?? 0,
		});
		for (const m of s.messages ?? []) {
			insertMessage.run({
				sessionId: s.id,
				role: m.role,
				content: m.content ?? null,
				toolCallId: m.toolCallId ?? null,
				toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls.map(hermesToolCall)) : null,
				toolName: m.toolName ?? null,
				timestamp: m.timestamp,
				compressedSummary: m.compressedSummary ?? 0,
				active: m.active ?? 1,
				compacted: m.compacted ?? 0,
				displayKind: m.displayKind ?? null,
			});
		}
	}

	db.close();
	return dbPath;
}
