import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptCursor, TranscriptReadResult, TranscriptSource } from "../Types.js";

// PARTIAL, and it has to be: `Logger` imports `appendFile` / `readdir` / `rename` /
// `stat` / `unlink` from the same module to write `debug.log`, so a factory offering
// only `readFile` makes the first `log.warn` in a case here fail with a TypeError
// instead of exercising the branch under test.
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, readFile: vi.fn() };
});

// Every per-source reader is replaced, because what this module IS is the dispatch:
// the bug it exists to prevent is a source reaching the wrong one, and handing a
// SQLite file to a line parser does not fail — it reports an empty conversation.
vi.mock("./GeminiTranscriptReader.js", () => ({ readGeminiTranscript: vi.fn() }));
vi.mock("./OpenCodeTranscriptReader.js", () => ({ readOpenCodeTranscript: vi.fn() }));
vi.mock("./CursorTranscriptReader.js", () => ({ readCursorTranscript: vi.fn() }));
vi.mock("./CopilotTranscriptReader.js", () => ({ readCopilotTranscript: vi.fn() }));
vi.mock("./DevinTranscriptReader.js", () => ({ readDevinTranscript: vi.fn() }));
vi.mock("./CursorCliTranscriptReader.js", () => ({ readCursorCliTranscript: vi.fn() }));
vi.mock("./CopilotChatTranscriptReader.js", () => ({ readCopilotChatTranscript: vi.fn() }));
vi.mock("./ClineTranscriptReader.js", () => ({ readClineTranscript: vi.fn() }));
vi.mock("./ClineCliTranscriptReader.js", () => ({ readClineCliTranscript: vi.fn() }));
vi.mock("./AntigravityTranscriptReader.js", () => ({ readAntigravityTranscript: vi.fn() }));
// PARTIAL: only the read is faked. `splitTranscriptLines` is a pure string split this
// module's line accessor depends on, and a mocked-away `undefined` would surface as a
// TypeError rather than as a failed expectation.
vi.mock("./TranscriptReader.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./TranscriptReader.js")>();
	return { ...original, readTranscript: vi.fn() };
});

import { readFile } from "node:fs/promises";
import { readAntigravityTranscript } from "./AntigravityTranscriptReader.js";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";
import { readClineTranscript } from "./ClineTranscriptReader.js";
import { readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";
import { readCopilotTranscript } from "./CopilotTranscriptReader.js";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";
import { readCursorTranscript } from "./CursorTranscriptReader.js";
import { readDevinTranscript } from "./DevinTranscriptReader.js";
import { readGeminiTranscript } from "./GeminiTranscriptReader.js";
import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";
import { getParserForSource } from "./TranscriptParser.js";
import { readTranscript } from "./TranscriptReader.js";
import { readTranscriptForSource, readTranscriptLinesForSource } from "./TranscriptSourceReader.js";

const PATH = "/tmp/s1.jsonl";
const CURSOR: TranscriptCursor = { transcriptPath: PATH, lineNumber: 3, updatedAt: "2026-08-01T00:00:00.000Z" };

function result(tag: string): TranscriptReadResult {
	return {
		entries: [],
		newCursor: { transcriptPath: tag, lineNumber: 0, updatedAt: "2026-08-01T00:00:00.000Z" },
		totalLinesRead: 0,
	};
}

/** Every dedicated reader, paired with the source tag that must reach it. */
const DEDICATED = [
	{ source: "gemini", reader: readGeminiTranscript },
	{ source: "opencode", reader: readOpenCodeTranscript },
	{ source: "cursor", reader: readCursorTranscript },
	{ source: "copilot", reader: readCopilotTranscript },
	{ source: "devin", reader: readDevinTranscript },
	{ source: "cursor-cli", reader: readCursorCliTranscript },
	{ source: "copilot-chat", reader: readCopilotChatTranscript },
	{ source: "cline", reader: readClineTranscript },
	{ source: "cline-cli", reader: readClineCliTranscript },
	{ source: "antigravity", reader: readAntigravityTranscript },
] as const;

/** The two readers whose signature takes `undefined` rather than `null` for no cursor. */
const UNDEFINED_ON_NULL = new Set<string>(["copilot-chat", "antigravity"]);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("readTranscriptForSource", () => {
	for (const { source, reader } of DEDICATED) {
		it(`sends ${source} to its own reader and nothing else`, async () => {
			vi.mocked(reader).mockResolvedValue(result(source));

			await expect(readTranscriptForSource(source as TranscriptSource, PATH, CURSOR)).resolves.toEqual(
				result(source),
			);

			expect(reader).toHaveBeenCalledWith(PATH, CURSOR);
			// The shared JSONL entry point must not see a store-backed source: its
			// transcriptPath is a synthetic `<dbPath>#<sessionId>` handle, not a file.
			expect(readTranscript).not.toHaveBeenCalled();
			for (const other of DEDICATED) {
				if (other.source !== source) expect(other.reader, other.source).not.toHaveBeenCalled();
			}
		});
	}

	for (const { source, reader } of DEDICATED) {
		const expected = UNDEFINED_ON_NULL.has(source) ? undefined : null;
		it(`passes a null cursor to ${source} as ${String(expected)}`, async () => {
			// Two readers take `TranscriptCursor | undefined` while the rest accept null.
			// Normalising in the wrong direction would not fail — it would silently read
			// from the start.
			vi.mocked(reader).mockResolvedValue(result(source));

			await readTranscriptForSource(source as TranscriptSource, PATH, null);

			expect(reader).toHaveBeenCalledWith(PATH, expected);
		});
	}

	it("sends codex through the shared entry point with the codex parser", async () => {
		vi.mocked(readTranscript).mockResolvedValue(result("codex"));

		await readTranscriptForSource("codex", PATH, CURSOR);

		expect(readTranscript).toHaveBeenCalledWith(PATH, CURSOR, getParserForSource("codex"));
	});

	it("sends kimi through the shared entry point with the kimi parser", async () => {
		vi.mocked(readTranscript).mockResolvedValue(result("kimi"));

		await readTranscriptForSource("kimi", PATH, CURSOR);

		expect(readTranscript).toHaveBeenCalledWith(PATH, CURSOR, getParserForSource("kimi"));
	});

	it("sends claude through the shared entry point with the claude parser", async () => {
		vi.mocked(readTranscript).mockResolvedValue(result("claude"));

		await readTranscriptForSource("claude", PATH, CURSOR);

		expect(readTranscript).toHaveBeenCalledWith(PATH, CURSOR, getParserForSource("claude"));
	});

	it("falls back to the claude parser for an UNKNOWN source rather than throwing", async () => {
		// `SessionInfo.source` defaults to "claude" for back-compat, so unknown values
		// flow through here too. Claude's pre-filters simply match nothing on a foreign
		// transcript.
		vi.mocked(readTranscript).mockResolvedValue(result("fallback"));

		await readTranscriptForSource("something-new" as TranscriptSource, PATH, CURSOR);

		expect(readTranscript).toHaveBeenCalledWith(PATH, CURSOR, getParserForSource("claude"));
	});

	it("lets a reader's failure propagate — the caller decides what it means", async () => {
		// The message counter degrades to an empty transcript because a panel must still
		// render; the back-fill logs and keeps the session row it already has. Swallowing
		// here would take that choice away from both.
		vi.mocked(readOpenCodeTranscript).mockRejectedValue(new Error("database is locked"));

		await expect(readTranscriptForSource("opencode", PATH, CURSOR)).rejects.toThrow("database is locked");
	});
});

describe("readTranscriptLinesForSource", () => {
	it("answers undefined for a source with no line-oriented transcript", async () => {
		// `undefined` rather than `[]`: a line scanner reads `[]` as "the conversation is
		// empty" and would report a confident "no skills used" about a store it never
		// opened. The file is not touched at all.
		expect(await readTranscriptLinesForSource("opencode", PATH)).toBeUndefined();
		expect(readFile).not.toHaveBeenCalled();
	});

	for (const source of ["claude", "codex", "kimi"] as const) {
		it(`splits ${source}'s raw lines`, async () => {
			vi.mocked(readFile).mockResolvedValue('{"a":1}\n\n{"b":2}\n');

			expect(await readTranscriptLinesForSource(source, PATH)).toEqual(['{"a":1}', '{"b":2}']);
			expect(readFile).toHaveBeenCalledWith(PATH, "utf-8");
		});
	}

	it("drops blank lines the same way every other reader counts them", async () => {
		// One definition of "line N": a second filter disagreeing by even one blank line
		// would silently strand records on one side of a monotonic cursor.
		vi.mocked(readFile).mockResolvedValue("\n   \n{}\n\t\n");

		expect(await readTranscriptLinesForSource("claude", PATH)).toEqual(["{}"]);
	});

	it("answers undefined for an empty file rather than throwing", async () => {
		vi.mocked(readFile).mockResolvedValue("");
		expect(await readTranscriptLinesForSource("claude", PATH)).toEqual([]);
	});

	it("stays SILENT for a transcript that was rotated away", async () => {
		// Routine rather than exceptional: a transcript can be deleted between the scan
		// and this read, so ENOENT takes the quiet path.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));

		expect(await readTranscriptLinesForSource("claude", PATH)).toBeUndefined();

		warn.mockRestore();
	});

	it("answers undefined for a genuine read failure too", async () => {
		// Still undefined, never `[]` — the distinction that keeps a skill scanner from
		// reporting about a file it could not see.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));

		expect(await readTranscriptLinesForSource("claude", PATH)).toBeUndefined();

		warn.mockRestore();
	});
});
