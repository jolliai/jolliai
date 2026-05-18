import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	countTranscriptMessages,
	loadUnreadMergedTranscript,
	loadUnreadTranscript,
} from "./TranscriptMessageCounter.js";

describe("countTranscriptMessages", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "msg-counter-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns 0 when the file does not exist", async () => {
		const n = await countTranscriptMessages({
			sessionId: "x",
			transcriptPath: join(dir, "missing.jsonl"),
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(n).toBe(0);
	});

	it("defaults source to 'claude' when SessionInfo omits the field (legacy SessionInfo shape)", async () => {
		const file = join(dir, "claude-default.jsonl");
		writeFileSync(file, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
		const n = await countTranscriptMessages({
			sessionId: "x",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			// source intentionally omitted — the nullish-coalescing branch.
		});
		expect(n).toBe(1);
	});

	it("counts claude user + assistant lines that the panel would render", async () => {
		// parseClaude requires `message.content` to stringify non-empty. A line
		// with `type: "user"` but no extractable text (tool_use only) is dropped
		// — that mirrors what the details panel actually shows the user.
		const file = join(dir, "c.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"role":"user","content":"a"}}',
				'{"type":"assistant","message":{"role":"assistant","content":"b"}}',
				'{"type":"ai-title","aiTitle":"x"}',
				'{"type":"user","message":{"role":"user","content":[{"type":"tool_use","name":"X"}]}}',
				'{"type":"user","message":{"role":"user","content":"c"}}',
				"",
			].join("\n"),
		);
		const n = await countTranscriptMessages({
			sessionId: "x",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(n).toBe(3);
	});

	it("counts codex role-based lines", async () => {
		const file = join(dir, "x.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"event_msg","payload":{"type":"user_message","message":"x"}}',
				'{"type":"event_msg","payload":{"type":"agent_message","message":"y"}}',
				"",
			].join("\n"),
		);
		const n = await countTranscriptMessages({
			sessionId: "x",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(n).toBe(2);
	});

	it("uses GeminiTranscriptReader for gemini source", async () => {
		// Real Gemini sessions are single-JSON-document, not JSONL.
		const file = join(dir, "gemini-session.json");
		writeFileSync(
			file,
			JSON.stringify({
				sessionId: "s1",
				messages: [
					{ id: "m1", type: "user", timestamp: "2026-05-15T00:00:00Z", content: "hi" },
					{ id: "m2", type: "gemini", timestamp: "2026-05-15T00:00:01Z", content: "hello" },
					{ id: "m3", type: "info", timestamp: "2026-05-15T00:00:02Z", content: "ignored" },
				],
			}),
		);
		const n = await countTranscriptMessages({
			sessionId: "s1",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(n).toBe(2);
	});

	it("skips malformed lines without throwing", async () => {
		const file = join(dir, "bad.jsonl");
		writeFileSync(file, 'not json\n{"type":"user","message":{"role":"user","content":"x"}}\n');
		const n = await countTranscriptMessages({
			sessionId: "x",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(n).toBe(1);
	});

	it("applies overlay deletes when projectDir is given", async () => {
		// Identity-based overlay must drop the entry from the count so the
		// CONVERSATIONS row stays in sync with what the panel renders.
		const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-proj-"));
		try {
			const file = join(dir, "c.jsonl");
			writeFileSync(
				file,
				[
					'{"type":"user","message":{"role":"user","content":"keep me"}}',
					'{"type":"assistant","message":{"role":"assistant","content":"drop me"}}',
				].join("\n"),
			);
			const overlayDir = join(projectDir, ".jolli", "jollimemory", "conversation-edits");
			mkdirSync(overlayDir, { recursive: true });
			writeFileSync(
				join(overlayDir, "claude--sess1.json"),
				JSON.stringify({
					version: 2,
					source: "claude",
					sessionId: "sess1",
					updatedAt: "2026-05-15T00:00:00Z",
					deletes: [{ role: "assistant", content: "drop me" }],
					edits: [],
				}),
			);
			const n = await countTranscriptMessages(
				{
					sessionId: "sess1",
					transcriptPath: file,
					updatedAt: "2026-05-15T00:00:00Z",
					source: "claude",
				},
				projectDir,
			);
			expect(n).toBe(1);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("ignores overlay when projectDir is omitted", async () => {
		// Even if an overlay file exists on disk for the session, omitting
		// projectDir (the panel's read-only mode) returns the raw rendered
		// count — kept as an explicit branch so the symmetry with the panel
		// is verified by tests.
		const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-proj-"));
		try {
			const file = join(dir, "c.jsonl");
			writeFileSync(
				file,
				'{"type":"user","message":{"role":"user","content":"x"}}\n{"type":"assistant","message":{"role":"assistant","content":"y"}}\n',
			);
			const overlayDir = join(projectDir, ".jolli", "jollimemory", "conversation-edits");
			mkdirSync(overlayDir, { recursive: true });
			writeFileSync(
				join(overlayDir, "claude--sess1.json"),
				JSON.stringify({
					version: 2,
					source: "claude",
					sessionId: "sess1",
					updatedAt: "2026-05-15T00:00:00Z",
					deletes: [{ role: "user", content: "x" }],
					edits: [],
				}),
			);
			const n = await countTranscriptMessages({
				sessionId: "sess1",
				transcriptPath: file,
				updatedAt: "2026-05-15T00:00:00Z",
				source: "claude",
			});
			expect(n).toBe(2);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("loads only unread transcript entries after the saved cursor", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-proj-"));
		try {
			const file = join(dir, "cursor-aware.jsonl");
			writeFileSync(
				file,
				[
					'{"message":{"role":"user","content":"used-1"}}',
					'{"message":{"role":"assistant","content":"used-2"}}',
					'{"message":{"role":"user","content":"fresh-3"}}',
					"",
				].join("\n"),
			);
			const jmDir = join(projectDir, ".jolli", "jollimemory");
			mkdirSync(jmDir, { recursive: true });
			writeFileSync(
				join(jmDir, "cursors.json"),
				JSON.stringify({
					version: 1,
					cursors: {
						[file]: {
							transcriptPath: file,
							lineNumber: 2,
							updatedAt: "2026-05-15T00:00:00Z",
						},
					},
				}),
			);
			const entries = await loadUnreadMergedTranscript(
				{
					sessionId: "sess1",
					transcriptPath: file,
					updatedAt: "2026-05-15T00:00:00Z",
					source: "claude",
				},
				projectDir,
			);
			expect(entries).toEqual([{ role: "human", content: "fresh-3", timestamp: undefined }]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("loads only unread Gemini transcript entries after the saved cursor", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-proj-"));
		try {
			const file = join(dir, "gemini-unread.json");
			writeFileSync(
				file,
				JSON.stringify({
					sessionId: "g1",
					messages: [
						{ id: "m1", type: "user", timestamp: "2026-05-15T00:00:00Z", content: "used-1" },
						{ id: "m2", type: "gemini", timestamp: "2026-05-15T00:00:01Z", content: "used-2" },
						{ id: "m3", type: "user", timestamp: "2026-05-15T00:00:02Z", content: "fresh-3" },
					],
				}),
			);
			const jmDir = join(projectDir, ".jolli", "jollimemory");
			mkdirSync(jmDir, { recursive: true });
			writeFileSync(
				join(jmDir, "cursors.json"),
				JSON.stringify({
					version: 1,
					cursors: {
						[file]: {
							transcriptPath: file,
							lineNumber: 2,
							updatedAt: "2026-05-15T00:00:00Z",
						},
					},
				}),
			);
			const entries = await loadUnreadMergedTranscript(
				{
					sessionId: "g1",
					transcriptPath: file,
					updatedAt: "2026-05-15T00:00:00Z",
					source: "gemini",
				},
				projectDir,
			);
			expect(entries).toEqual([{ role: "human", content: "fresh-3", timestamp: "2026-05-15T00:00:02Z" }]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("falls back to the full merged transcript when unread lookup has no projectDir", async () => {
		const file = join(dir, "no-project-dir.jsonl");
		writeFileSync(
			file,
			'{"type":"user","message":{"role":"user","content":"hello"}}\n{"type":"assistant","message":{"role":"assistant","content":"world"}}\n',
		);
		const entries = await loadUnreadMergedTranscript({
			sessionId: "sess1",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(entries).toHaveLength(2);
	});

	// The detail panel uses loadUnreadTranscript (raw, cursor-trimmed) and
	// applies the overlay itself so it can derive a separate rawByIndex view
	// for overlay-identity resolution. These tests pin the contract:
	//   1. Cursor trims the result.
	//   2. Overlay is NOT applied here (the panel composes it later).
	//   3. No-projectDir falls back to the full read so the panel still
	//      renders in read-only mode.
	describe("loadUnreadTranscript", () => {
		it("returns cursor-trimmed raw entries without applying the overlay", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-raw-"));
			try {
				const file = join(dir, "claude-raw-unread.jsonl");
				writeFileSync(
					file,
					[
						'{"message":{"role":"user","content":"used-1"}}',
						'{"message":{"role":"assistant","content":"used-2"}}',
						'{"message":{"role":"user","content":"fresh-3"}}',
						"",
					].join("\n"),
				);
				const jmDir = join(projectDir, ".jolli", "jollimemory");
				mkdirSync(jmDir, { recursive: true });
				writeFileSync(
					join(jmDir, "cursors.json"),
					JSON.stringify({
						version: 1,
						cursors: {
							[file]: {
								transcriptPath: file,
								lineNumber: 2,
								updatedAt: "2026-05-15T00:00:00Z",
							},
						},
					}),
				);
				// Seed an overlay edit pointing at the post-cursor entry.
				// loadUnreadTranscript MUST NOT apply it; the entry's content
				// has to come back as "fresh-3", not "EDITED".
				const overlayDir = join(jmDir, "conversation-edits", "claude");
				mkdirSync(overlayDir, { recursive: true });
				writeFileSync(
					join(overlayDir, "sess1.json"),
					JSON.stringify({
						version: 1,
						deletes: [],
						edits: [
							{
								role: "human",
								content: "fresh-3",
								newContent: "EDITED",
							},
						],
					}),
				);
				const entries = await loadUnreadTranscript("claude", file, projectDir);
				expect(entries).toEqual([{ role: "human", content: "fresh-3", timestamp: undefined }]);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("falls back to the full transcript when projectDir is omitted", async () => {
			const file = join(dir, "raw-no-projdir.jsonl");
			writeFileSync(
				file,
				'{"type":"user","message":{"role":"user","content":"hello"}}\n{"type":"assistant","message":{"role":"assistant","content":"world"}}\n',
			);
			const entries = await loadUnreadTranscript("claude", file);
			expect(entries).toHaveLength(2);
		});

		it("returns an empty array on read failure", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "msg-counter-raw-err-"));
			try {
				// Pointing at a directory rather than a file makes the per-
				// source reader throw, which the function swallows and turns
				// into an empty array so the panel can render "no entries"
				// without surfacing a raw IO error to the user.
				const entries = await loadUnreadTranscript(
					"claude",
					projectDir, // path is a directory → readers throw
					projectDir,
				);
				expect(entries).toEqual([]);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});
});
