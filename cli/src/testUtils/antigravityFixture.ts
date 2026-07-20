/**
 * Antigravity test fixture builder.
 *
 * Reproduces the real on-disk layout Antigravity writes per conversation:
 *   ~/.gemini/<variant>/conversations/<convId>.db      (SQLite; trajectory_metadata_blob)
 *   ~/.gemini/<variant>/brain/<convId>/.system_generated/logs/transcript_full.jsonl
 *
 * The metadata blob is a REAL protobuf-shaped binary (not a text placeholder),
 * matching the byte layout observed on a live machine: field 1 (LEN) wraps the
 * workspace file:// uri + a git sub-message (remote-url, branch); field 7 (LEN)
 * repeats the workspace uri. The discoverer only needs to recover the first
 * `file://` string, but pinning the real shape guards the byte-scan extractor.
 *
 * REAL_TRANSCRIPT_FULL is a verbatim capture of a real transcript_full.jsonl.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Verbatim real sample (6 lines) from a live Antigravity conversation. */
export const REAL_TRANSCRIPT_FULL: ReadonlyArray<Record<string, unknown>> = [
	{
		step_index: 0,
		source: "USER_EXPLICIT",
		type: "USER_INPUT",
		status: "DONE",
		created_at: "2026-07-19T09:46:50Z",
		content:
			"<USER_REQUEST>\n查看当前分支\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-19T17:46:50+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium).\n</USER_SETTINGS_CHANGE>",
	},
	{
		step_index: 1,
		source: "SYSTEM",
		type: "CONVERSATION_HISTORY",
		status: "DONE",
		created_at: "2026-07-19T09:46:50Z",
	},
	{
		step_index: 2,
		source: "MODEL",
		type: "PLANNER_RESPONSE",
		status: "DONE",
		created_at: "2026-07-19T09:46:50Z",
		tool_calls: [
			{
				name: "run_command",
				args: {
					CommandLine: "git branch --show-current",
					Cwd: "/Users/flyer/jolli/code/jollimemory",
					toolSummary: "Git branch check",
				},
			},
		],
	},
	{
		step_index: 3,
		source: "MODEL",
		type: "RUN_COMMAND",
		status: "DONE",
		created_at: "2026-07-19T09:46:52Z",
		content:
			"Created At: 2026-07-19T17:46:52+08:00\nCompleted At: 2026-07-19T17:46:52+08:00\n\nThe command completed successfully.\nOutput:\nfeature/cline-cli-source\n",
	},
	{
		step_index: 4,
		source: "SYSTEM",
		type: "CHECKPOINT",
		status: "DONE",
		created_at: "2026-07-19T09:46:52Z",
		content: "{{ CHECKPOINT 0 }}\n **The earlier parts of this conversation have been truncated.**",
	},
	{
		step_index: 5,
		source: "MODEL",
		type: "PLANNER_RESPONSE",
		status: "DONE",
		created_at: "2026-07-19T09:46:52Z",
		content: "当前分支是 `feature/cline-cli-source`。",
	},
];

export interface AntigravityConvoInput {
	readonly convId: string;
	/** Variant folder name; defaults to "antigravity". */
	readonly variant?: string;
	/** Absolute workspace path (no file:// prefix). */
	readonly workspacePath: string;
	readonly gitRemote?: string;
	readonly branch?: string;
	/** Transcript rows; each is written as one JSONL line. */
	readonly transcriptLines: ReadonlyArray<Record<string, unknown>>;
	/** When false, skip writing transcript_full.jsonl (models a not-yet-materialized convo). */
	readonly writeTranscript?: boolean;
}

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	let n = value;
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n) b |= 0x80;
		bytes.push(b);
	} while (n);
	return Buffer.from(bytes);
}

function lenField(tag: number, payload: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), encodeVarint(payload.length), payload]);
}

/** Builds a protobuf-shaped metadata blob with the workspace uri + git info. */
export function buildMetadataBlob(workspacePath: string, gitRemote = "", branch = ""): Buffer {
	const uri = Buffer.from(`file://${workspacePath}`, "utf8");
	const uriField = lenField(0x0a, uri); // inner field 1: workspace uri
	const gitSub = gitRemote ? lenField(0x1a, lenField(0x12, Buffer.from(gitRemote, "utf8"))) : Buffer.alloc(0);
	const branchField = branch ? lenField(0x22, Buffer.from(branch, "utf8")) : Buffer.alloc(0);
	const inner = Buffer.concat([uriField, gitSub, branchField]);
	const topWorkspace = lenField(0x3a, uri); // top-level field 7: workspace uri
	return Buffer.concat([lenField(0x0a, inner), topWorkspace]);
}

/** Creates a conversation .db + (optionally) its transcript_full.jsonl under `home`. */
export function createAntigravityConvo(
	home: string,
	input: AntigravityConvoInput,
): { dbPath: string; transcriptPath: string } {
	const variant = input.variant ?? "antigravity";
	const root = join(home, ".gemini", variant);
	const convDir = join(root, "conversations");
	const logDir = join(root, "brain", input.convId, ".system_generated", "logs");
	mkdirSync(convDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	const dbPath = join(convDir, `${input.convId}.db`);
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
	const blob = buildMetadataBlob(input.workspacePath, input.gitRemote, input.branch);
	db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(blob);
	db.close();

	const transcriptPath = join(logDir, "transcript_full.jsonl");
	if (input.writeTranscript !== false) {
		writeFileSync(transcriptPath, `${input.transcriptLines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	}
	return { dbPath, transcriptPath };
}
