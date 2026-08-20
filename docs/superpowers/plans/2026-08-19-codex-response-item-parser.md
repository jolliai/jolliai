# Codex `response_item` Conversation Parser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex conversations capture again by parsing turns from the `response_item/message` shape Codex writes today (the `event_msg` shape it is retiring), add a loud signal + cursor safety net for future format drift, pin all parser-backed sources to real captured fixtures, and give an explicit recovery path for conversations already consumed into nothing.

**Architecture:** `CodexTranscriptParser.parseLine` switches its conversation source from `event_msg/{user_message,agent_message}` to `response_item/message` (roles `user`→human, `assistant`→assistant, `developer`→skip), reproducing the injection-filtering that `event_msg` gave for free. `event_msg` conversation parsing is **dropped entirely** — not kept as a fallback — because `response_item/message` is a complete 1:1 superset in every era (proven: 2214 real rollouts, zero counterexamples) and keeping both would double-count every turn in transition-era rollouts. `parseToolUse` (reads `response_item` types + `mcp_tool_call_end`) and `parseUsageByModel` (reads `token_count`) are untouched. QueueWorker warns when a discovered session consumes lines but yields zero conversation entries, and withholds the read-cursor only when a consumed slice was recognized as *nothing at all* (zero entries AND zero usage AND zero tools). A cursor-rewind helper + `jolli doctor` flag make already-consumed sessions re-readable.

**Tech Stack:** TypeScript (Node 22.13+ ESM), Vitest (coverage floor 97/96/97/97 on `cli/src/`), Biome (tabs, 120 col).

**Spec:** Linear JOLLI-2240 — <https://linear.app/jolliai/issue/JOLLI-2240> (root cause + acceptance criteria). Observed-reality evidence is in the "Observed Reality" section below.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated …` trailers.
- **`npm run all` must pass before the final commit.** Inner loop: `npm run test:fast` (CLI, with coverage); this touches `cli/src/core` + `cli/src/hooks`, both in the fast tier.
- **Do not regress CLI coverage** — 97% statements / 96% branches / 97% functions / 97% lines on `cli/src/`.
- **Branch:** `fix-codex-transcript-parser` (already checked out).
- **`toForwardSlash` for `\`→`/`** path normalization — never inline `.replace(/\\/g,"/")`.
- Parsers are **stateless singletons**; keep `parseLine` per-line and side-effect free.

## Observed Reality (Codex rollout, measured on this machine 2026-08-19)

- **Location:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; one JSON envelope per line. `session_meta.cwd` scopes the worktree.
- **Two shapes are redundant representations of the SAME turns.** `event_msg/{user_message,agent_message}` (clean stream) and `response_item/message` (raw stream, `role` ∈ {user, assistant, developer}). Measured on a March rollout: `agent_message` text vs `response_item(assistant)` `output_text` are 1:1 equal (total 1696 / distinct 678 on both sides; the gap is resume-replay duplication present identically in both).
- **`response_item/message` is a complete superset in every era.** Scan of **all 2214** rollout files: **zero** files had `event_msg` conversation turns without `response_item/message`. Codex is retiring `event_msg` (August rollouts with `response_item` only exist).
- **Message content shape:** `payload.content` is an array of `{type,text}` items. User turns carry `input_text`; assistant turns carry `output_text`.
- **Injected content mixed into `response_item` (what `event_msg` filtered for free):** `role:"developer"` messages (`<app-context>`, `<skills_instructions>`) — all injection. `role:"user"` messages wholly wrapped in `<recommended_plugins>…</recommended_plugins>` or `<environment_context>…</environment_context>`, plus bare `<image …/>` placeholder fragments and empty strings. **Keep** the `# Files mentioned by the user:` wrapper — it is a genuine user submission (`event_msg/user_message` kept it too).
- **No clean structural discriminator:** `payload.internal_chat_message_metadata_passthrough.turn_id` is present on both real and injected messages and is *shared* across the injected + real messages of one turn. So filtering is necessarily tag-content-based — which is exactly what a real captured fixture can guard.
- **Architecture:** `parseLine` is stateless per-line; reading only `response_item` covers every era with no cross-line dedup state and no double-count. `parseToolUse`/`parseUsageByModel` consume the whole slice and read other event types (`response_item` tool types, `mcp_tool_call_end`, `token_count`) — unaffected by this change, so token/cost/tool accounting keeps working.

### Divergence from the spec, resolved (record in the issue on close)

- Acceptance criterion 2's second half — "a rollout containing only `event_msg` turns still parses to non-zero" — describes a state that **does not occur** (2214-file proof). Keeping `event_msg` conversation parsing to satisfy it literally would **reintroduce double-counting** in the transition-era rollouts that *do* exist. Decision (owner-approved): read `response_item` only; document the proof on close.
- The cursor safety net (criteria 3–4) deliberately does **not** catch the exact reported bug. Those Codex slices carried `token_count` (usage > 0) and skill tool calls, so they were not "recognized as nothing" and their cursor still advances. Withholding the cursor on *any* zero-entry slice would strand every legitimate tool-only / token-only slice into an infinite re-read + token re-count loop (owner-approved to avoid). The real anti-drift defenses are **the CI fixture guard (Task 2)** and **the warning (Task 3)**; the cursor gate is a safe bonus for the narrower "format wrote lines we understood in no way" case.

---

## File Structure

- `cli/src/core/TranscriptParser.ts` — **modify.** Rewrite `CodexTranscriptParser.parseLine`; replace the two `event_msg` message helpers with a `response_item/message` extractor + injection predicate. Update the class docstring.
- `cli/src/core/TranscriptParser.test.ts` — **modify.** Replace the `event_msg` conversation unit tests with `response_item` ones (event_msg conversation now yields `null`); add injection-filter and multi-content-item cases.
- `cli/src/core/__fixtures__/transcripts/` — **create.** Real captured, redacted rollout/transcript slices: `codex-response-item.jsonl`, `claude.jsonl`, `kimi-wire.jsonl`.
- `cli/src/core/TranscriptParserFixtures.test.ts` — **create.** The zero-entry guard: every `PARSER_BACKED_SOURCES` source must extract ≥1 conversation entry from its own real fixture.
- `cli/src/hooks/QueueWorker.ts` — **modify** (~line 4542–4566). Warn on consumed-but-zero-entry; withhold cursor only on consumed-but-recognized-nothing.
- `cli/src/core/CodexCursorRewind.ts` — **create.** `rewindCodexCursors(cwd)` — makes consumed Codex sessions re-readable.
- `cli/src/core/CodexCursorRewind.test.ts` — **create.**
- `cli/src/commands/DoctorCommand.ts` — **modify.** Add `--relink-codex` flag calling the rewind helper and printing the regenerate instruction.

---

## Task 1: Codex parser reads `response_item/message`

**Files:**
- Modify: `cli/src/core/TranscriptParser.ts` (`CodexTranscriptParser.parseLine` ~314-346; helpers `parseCodexUserMessage`/`parseCodexAgentMessage` ~650-676; class docstring ~301-312)
- Test: `cli/src/core/TranscriptParser.test.ts` (Codex `describe` block ~20-…)

**Interfaces:**
- Consumes: `TranscriptEntry` (`{role:"human"|"assistant", content:string, timestamp?:string}`), the existing `log` logger.
- Produces: `CodexTranscriptParser.parseLine(line, lineNum): TranscriptEntry | null` — now yields entries for `response_item/message` and `null` for `event_msg/*`. Two new module-private helpers: `extractCodexMessageText(content: unknown): string | null` and `isCodexInjectedUserText(text: string): boolean`.

- [ ] **Step 1: Write failing tests** — add these to the Codex `describe` in `TranscriptParser.test.ts` and DELETE/replace the existing `event_msg` conversation cases (they now assert `null`):

```ts
describe("CodexTranscriptParser response_item", () => {
	const parser = new CodexTranscriptParser();
	const line = (o: unknown) => JSON.stringify(o);

	it("parses a response_item/message user turn into a human entry", () => {
		const entry = parser.parseLine(
			line({
				timestamp: "2026-08-18T10:00:00.000Z",
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login bug\n" }] },
			}),
			0,
		);
		expect(entry).toEqual({ role: "human", content: "Fix the login bug", timestamp: "2026-08-18T10:00:00.000Z" });
	});

	it("parses a response_item/message assistant turn into an assistant entry", () => {
		const entry = parser.parseLine(
			line({
				timestamp: "2026-08-18T10:00:01.000Z",
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
			}),
			0,
		);
		expect(entry).toEqual({ role: "assistant", content: "On it.", timestamp: "2026-08-18T10:00:01.000Z" });
	});

	it("joins multiple text content items", () => {
		const entry = parser.parseLine(
			line({
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] },
			}),
			0,
		);
		expect(entry?.content).toBe("a\nb");
	});

	it("skips the injected developer role", () => {
		expect(
			parser.parseLine(
				line({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<app-context>\n...\n</app-context>" }] } }),
				0,
			),
		).toBeNull();
	});

	it("skips <recommended_plugins> injected user messages", () => {
		expect(
			parser.parseLine(
				line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\n- Slack\n</recommended_plugins>" }] } }),
				0,
			),
		).toBeNull();
	});

	it("skips <environment_context> injected user messages", () => {
		expect(
			parser.parseLine(
				line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <current_date>2026-08-18</current_date>\n</environment_context>" }] } }),
				0,
			),
		).toBeNull();
	});

	it("skips image-only user placeholder messages", () => {
		expect(
			parser.parseLine(
				line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: '<image name=[Image #1] path="/tmp/x.png"/>' }] } }),
				0,
			),
		).toBeNull();
	});

	it("keeps a genuine '# Files mentioned by the user:' request", () => {
		const entry = parser.parseLine(
			line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "\n# Files mentioned by the user:\n\n## My request:\nreview this screenshot\n" }] } }),
			0,
		);
		expect(entry?.role).toBe("human");
		expect(entry?.content).toContain("review this screenshot");
	});

	it("no longer treats event_msg turns as conversation (superseded by response_item)", () => {
		expect(parser.parseLine(line({ type: "event_msg", payload: { type: "user_message", message: "hi" } }), 0)).toBeNull();
		expect(parser.parseLine(line({ type: "event_msg", payload: { type: "agent_message", message: "hello" } }), 0)).toBeNull();
	});

	it("returns null for empty / whitespace-only message content", () => {
		expect(parser.parseLine(line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "   " }] } }), 0)).toBeNull();
		expect(parser.parseLine(line({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }), 0)).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm run test -w @jolli.ai/cli -- src/core/TranscriptParser.test.ts -t "response_item"` → FAIL (current parser returns `null` for `response_item`, and the event_msg assertions in the old block still parse).

- [ ] **Step 3: Rewrite `parseLine` and helpers.** Replace the body of `parseLine` (~314-346):

```ts
parseLine(line: string, lineNum: number): TranscriptEntry | null {
	try {
		const data = JSON.parse(line) as Record<string, unknown>;
		const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;

		// Conversation turns now arrive as response_item/message (Codex retired the
		// event_msg/{user_message,agent_message} shape). response_item is a complete
		// superset of event_msg in every era (2214-rollout scan, zero counterexamples),
		// so reading only it covers all history and never double-counts the transition-
		// era rollouts that carry BOTH shapes for the same turns. See TranscriptParser
		// class docstring / JOLLI-2240.
		if (data.type !== "response_item") return null;

		const payload = data.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") return null;
		if (payload.type !== "message") return null;

		// developer-role messages are pure injection (<app-context>, <skills_instructions>).
		const role = payload.role;
		if (role !== "user" && role !== "assistant") return null;

		const text = extractCodexMessageText(payload.content);
		if (text === null) return null;

		if (role === "user") {
			if (isCodexInjectedUserText(text)) return null;
			return { role: "human", content: text, timestamp };
		}
		return { role: "assistant", content: text, timestamp };
	} catch (error: unknown) {
		log.debug("Failed to parse Codex transcript line %d: %s", lineNum, (error as Error).message);
		return null;
	}
}
```

Replace `parseCodexUserMessage`/`parseCodexAgentMessage` (~650-676) with:

```ts
/**
 * Concatenated text of a Codex `response_item/message` payload's content array.
 * User turns carry `input_text` items, assistant turns `output_text`; both are
 * joined with newlines. Non-text items (images, etc.) are ignored. Returns null
 * when no text survives trimming.
 */
function extractCodexMessageText(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		const text = (item as { text?: unknown }).text;
		if ((type === "input_text" || type === "output_text") && typeof text === "string") {
			parts.push(text);
		}
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : null;
}

/**
 * True for user-role `response_item/message` text that is Codex-injected context
 * rather than a genuine user submission. The `event_msg/user_message` stream
 * excluded exactly these; the raw `response_item` stream does not. Prefixes are
 * derived from real rollouts (JOLLI-2240 Observed Reality) and guarded by the
 * captured fixture in TranscriptParserFixtures.test.ts. The `# Files mentioned by
 * the user:` wrapper is deliberately NOT here — it is a real submission.
 */
const CODEX_INJECTED_USER_PREFIXES: ReadonlyArray<string> = ["<recommended_plugins>", "<environment_context>"];
function isCodexInjectedUserText(text: string): boolean {
	const t = text.trimStart();
	if (CODEX_INJECTED_USER_PREFIXES.some((p) => t.startsWith(p))) return true;
	// Image-only placeholder messages carry no real text once the tags are removed.
	const withoutImages = text.replace(/<image\b[^>]*\/?>|<\/image>/g, "").trim();
	return withoutImages.length === 0;
}
```

Update the class docstring (~301-312) to state that conversation comes from `response_item/message` (user/assistant, developer excluded), that `event_msg` is superseded and retired by Codex, and that `parseToolUse`/`parseUsageByModel` still read their own event types.

- [ ] **Step 4: Run tests to verify they pass** — `npm run test -w @jolli.ai/cli -- src/core/TranscriptParser.test.ts` → PASS (all Codex cases, including the updated event_msg-null ones).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/TranscriptParser.ts cli/src/core/TranscriptParser.test.ts
git commit -s -m "Parse Codex conversations from response_item, not retired event_msg"
```

---

## Task 2: Real captured fixtures + zero-entry guard

**Files:**
- Create: `cli/src/core/__fixtures__/transcripts/codex-response-item.jsonl`, `claude.jsonl`, `kimi-wire.jsonl`
- Create test: `cli/src/core/TranscriptParserFixtures.test.ts`

**Interfaces:**
- Consumes: `getParserForSource`, `PARSER_BACKED_SOURCES` — the latter is module-private today; **export it** from `TranscriptParser.ts` (`export const PARSER_BACKED_SOURCES …`) so the guard iterates the same list the factory is tied to. `TranscriptParser.parseLine`.
- Produces: a test that fails if any parser-backed source extracts zero conversation entries from its own real fixture.

- [ ] **Step 1: Capture real, redacted fixtures.** These MUST be real captures (the whole point of the guard — hand-authored fixtures are what let this bug ship green). Commands:

```bash
mkdir -p cli/src/core/__fixtures__/transcripts
# Codex: a small real rollout containing response_item/message turns + at least one
# injected user message and one developer message (to exercise the filter). Take a
# tail slice of a real rollout, then redact absolute paths / usernames.
CODEX_SRC="$(find ~/.codex/sessions/2026/08 -name 'rollout-*.jsonl' -exec ls -S {} + | head -1)"
# Keep session_meta + a spread of message/injection/tool/token lines, ~20 lines.
{ jq -c 'select(.type=="session_meta")' "$CODEX_SRC" | head -1
  jq -c 'select(.type=="response_item" and .payload.type=="message")' "$CODEX_SRC" | head -8
  jq -c 'select(.type=="response_item" and .payload.role=="developer")' "$CODEX_SRC" | head -1
  jq -c 'select(.type=="event_msg" and .payload.type=="token_count")' "$CODEX_SRC" | head -1
} | sed -E 's#/Users/[^/"]+#/Users/testuser#g' > cli/src/core/__fixtures__/transcripts/codex-response-item.jsonl

# Claude: a real ~/.claude/projects/**/*.jsonl slice with ≥1 user + ≥1 assistant text turn.
# Kimi: a real ~/.kimi-code/**/agents/main/wire.jsonl slice with ≥1 turn.prompt + ≥1 content.part text.
```

Manually verify each fixture parses to ≥1 entry BEFORE writing the test (this is the step-4 smoke test from integrating-external-systems, done by hand):

```bash
npm run cli -- --version >/dev/null 2>&1 # ensure tsx works; then a throwaway node/tsx snippet, or just rely on the test in step 3.
```

Redaction rule: replace real home paths (`/Users/<name>` → `/Users/testuser`) and any `sk-`/token-like strings; keep the JSON shape byte-for-byte otherwise. Confirm each file is still valid JSONL: `jq -c . <file> >/dev/null`.

- [ ] **Step 2: Write the guard test** `cli/src/core/TranscriptParserFixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getParserForSource, PARSER_BACKED_SOURCES } from "./TranscriptParser.js";

const FIXTURE: Record<(typeof PARSER_BACKED_SOURCES)[number], string> = {
	claude: "claude.jsonl",
	codex: "codex-response-item.jsonl",
	kimi: "kimi-wire.jsonl",
};

describe("parser-backed sources extract conversation from a REAL captured fixture", () => {
	for (const source of PARSER_BACKED_SOURCES) {
		it(`${source}: parses ≥1 conversation entry from its own rollout capture`, () => {
			const path = join(__dirname, "__fixtures__", "transcripts", FIXTURE[source]);
			const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
			const parser = getParserForSource(source);
			const entries = lines.map((l, i) => parser.parseLine(l, i)).filter((e) => e !== null);
			// A parser that extracts nothing from its own source's real transcript has
			// silently gone dark — this is the JOLLI-2240 failure mode made loud in CI.
			expect(entries.length).toBeGreaterThan(0);
		});
	}
});
```

- [ ] **Step 3: Export `PARSER_BACKED_SOURCES`** in `TranscriptParser.ts` (add `export` to the existing `const`). Run: `npm run test -w @jolli.ai/cli -- src/core/TranscriptParserFixtures.test.ts` → PASS for all three.

- [ ] **Step 4: Prove the guard bites.** Temporarily point the Codex fixture at an all-`event_msg`/all-`token_count` slice (no `response_item/message`), re-run → the `codex` case FAILS. Restore the real fixture → PASS. (Manual verification, no commit of the broken state.)

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/__fixtures__/transcripts cli/src/core/TranscriptParserFixtures.test.ts cli/src/core/TranscriptParser.ts
git commit -s -m "Guard parser-backed sources against zero-entry drift with real fixtures"
```

---

## Task 3: Warning + cursor safety net in QueueWorker

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts` (~4542-4566, the per-session `result` handling loop)
- Test: `cli/src/hooks/QueueWorker.test.ts` (add cases near the existing transcript-source tests)

**Interfaces:**
- Consumes: `TranscriptReadResult` fields `entries`, `totalLinesRead`, `usageTokens`, `toolUse`; `session.source`, `session.transcriptPath`; `startLine`/`endLine` locals already in scope; `log` (`createLogger`); `pendingCursors`.
- Produces: no signature change — behavior change to when `pendingCursors.push(result.newCursor)` runs, plus two `log.warn` lines.

- [ ] **Step 1: Write failing tests.** Add to `QueueWorker.test.ts` two behaviors, exercised through whatever seam the existing transcript-source tests use (a discovered session whose slice yields (a) consumed lines but zero entries → a warn is emitted and, when it also has usage/tools, the cursor still advances; (b) consumed lines recognized as nothing → cursor withheld). If the loop is not directly unit-addressable, assert via `log.warn` spy + the returned `pendingCursors` length. Model the test on the nearest existing QueueWorker transcript test.

- [ ] **Step 2: Run → FAIL** (`npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts -t "zero entries"`).

- [ ] **Step 3: Implement.** Replace the unconditional `pendingCursors.push(result.newCursor);` (~4566) region with:

```ts
const consumedLines = result.totalLinesRead > 0;
const recognizedNothing =
	result.entries.length === 0 && result.usageTokens === 0 && (!result.toolUse || result.toolUse.length === 0);

// A discovered session we actually read content from but produced no conversation
// entries is the loud signal a future upstream format change would otherwise hide
// (JOLLI-2240 shipped silent for weeks). Name the source and the path.
if (consumedLines && result.entries.length === 0) {
	log.warn(
		"Transcript source read to zero conversation entries: source=%s path=%s lines=%d→%d",
		session.source,
		session.transcriptPath,
		startLine,
		endLine,
	);
}

// Withhold the cursor ONLY when a consumed slice was recognized as nothing at all
// (no entries, no usage, no tools) — "the format wrote lines we understood in no
// way". A slice with tokens/tools but no text is a legitimate tool-only turn and
// must still advance, or it re-reads and re-counts every commit forever.
if (consumedLines && recognizedNothing) {
	log.warn(
		"Not advancing read cursor: source recognized nothing in consumed lines: source=%s path=%s lines=%d→%d",
		session.source,
		session.transcriptPath,
		startLine,
		endLine,
	);
} else {
	pendingCursors.push(result.newCursor);
}
```

Keep the existing `if (result.entries.length > 0) { sessionTranscripts.push(...) … }` block above unchanged.

- [ ] **Step 4: Run → PASS.** Then run the whole file: `npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "Warn on zero-entry transcript reads; withhold cursor only when nothing recognized"
```

---

## Task 4: Recovery path for already-consumed Codex sessions

**Files:**
- Create: `cli/src/core/CodexCursorRewind.ts`
- Create test: `cli/src/core/CodexCursorRewind.test.ts`
- Modify: `cli/src/commands/DoctorCommand.ts` (add `--relink-codex` option near `--mark-migration` ~1015-1050)

**Interfaces:**
- Consumes: the `cursors.json` registry (`Map<transcriptPath, TranscriptCursor>`, `TranscriptCursor.lineNumber`) via SessionTracker's read/write helpers; `getJolliMemoryDir(cwd)`.
- Produces: `rewindCodexCursors(cwd: string): { rewound: number; paths: string[] }` — sets `lineNumber` back to 0 for every cursor whose transcript path is a Codex rollout (`/.codex/sessions/` segment, matched with a `[\\/]` separator regex per the Windows path rule), leaving other sources' cursors untouched, and persists.

- [ ] **Step 1: Write failing test** `CodexCursorRewind.test.ts`: seed a temp project `.jolli/jollimemory/cursors.json` with three cursors (a `~/.codex/sessions/...` at lineNumber 500, a `~/.claude/projects/...` at 300, and another Codex path at 120); call `rewindCodexCursors(tmp)`; assert both Codex entries are back to `lineNumber: 0`, the Claude one is unchanged at 300, and the return is `{ rewound: 2, paths: [<two codex paths>] }`. Add a Windows-separator case (`\\.codex\\sessions\\...`).

- [ ] **Step 2: Run → FAIL** (module not defined).

- [ ] **Step 3: Implement `CodexCursorRewind.ts`.** Load the cursor registry through the existing SessionTracker reader; for each key matching `/[\\/]\.codex[\\/]sessions[\\/]/`, replace its cursor with `{ ...cursor, lineNumber: 0 }`; persist via the existing writer; return the count + rewound paths. Reuse SessionTracker's cursor read/write functions (do not hand-roll JSON IO) — inspect `SessionTracker.ts` for the exact exported names (`CURSORS_FILE`, the load/save pair) and match them.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire `--relink-codex` into DoctorCommand.** Add the option and a handler that calls `rewindCodexCursors(cwd)`, prints how many cursors were rewound, and prints the explicit next step:

```
Rewound N Codex read-cursor(s). The rollout files on disk are now unconsumed.
• Future commits will re-capture these Codex sessions automatically.
• To re-attach them to already-committed memories, regenerate the affected
  commits (Regenerate in the IDE, which calls Regenerator.regenerateSummary).
```

Full automatic range-regeneration of historical commits is deliberately OUT of scope: `regenerateSummary` re-reads within one commit's window, so a range tool would need per-commit orchestration not worth building for a one-time drift. Recovery IS available; this is the bounded mechanism.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/CodexCursorRewind.ts cli/src/core/CodexCursorRewind.test.ts cli/src/commands/DoctorCommand.ts
git commit -s -m "Add jolli doctor --relink-codex to re-read consumed Codex sessions"
```

---

## Task 5: Full gate + issue closure statement

- [ ] **Step 1:** `npm run all` → all green (build, typecheck, lint, test with coverage ≥ 97/96/97/97). Triage any `Test timed out` under load by re-running the file alone before treating it as a regression.
- [ ] **Step 2:** End-to-end smoke (integrating-external-systems step 4): in a repo with a real Codex session in the last 48h, make a commit and confirm the generated memory lists the Codex conversation with the Codex badge and a non-zero message count (acceptance criterion 1). Leave Codex running; do not shut it down first.
- [ ] **Step 3:** Draft the JOLLI-2240 closing comment: (a) fix summary; (b) the 2214-rollout superset proof and why `event_msg` conversation parsing was dropped rather than kept; (c) the explicit recoverability statement — *recoverable: rollout files remain on disk; `jolli doctor --relink-codex` rewinds Codex cursors so future commits re-capture, and affected historical commits can be regenerated individually; nothing is permanently lost from disk*; (d) note the same hand-fixture exposure was closed for Claude and Kimi too (Task 2 guard). Post only after the user confirms (per repo convention, do not auto-post reviews/comments).

---

## Self-Review

- **Spec coverage:** criterion 1 → Task 1 + Task 5 smoke; criterion 2 (response_item non-zero) → Task 1 + Task 2 (the event_msg-only half is unreachable, documented); criterion 3 (warn) → Task 3; criterion 4 (cursor not advanced) → Task 3 (scoped to "recognized nothing", owner-approved); criterion 5 (real fixtures + zero-entry guard) → Task 2; criterion 6 (recoverability statement) → Task 4 + Task 5 Step 3.
- **Placeholders:** none — every code step carries real code; the fixtures are captured by concrete commands and hand-verified before the guard is written.
- **Type consistency:** `extractCodexMessageText` / `isCodexInjectedUserText` / `CODEX_INJECTED_USER_PREFIXES` / `rewindCodexCursors` / `PARSER_BACKED_SOURCES` used consistently across tasks; `TranscriptReadResult` fields (`entries`, `totalLinesRead`, `usageTokens`, `toolUse`) match `TranscriptReader.ts`.
