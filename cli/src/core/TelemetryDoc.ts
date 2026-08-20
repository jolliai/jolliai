/**
 * TelemetryDoc — generates the repo-root `TELEMETRY.md` transparency document
 * from the `TelemetryEvents` registry (JOLLI-1785 Phase 4).
 *
 * The event table is auto-generated so the doc can never drift from what the
 * code actually sends; the surrounding prose (what is/isn't collected, the off
 * switches, what `installId` is) is the human-authored privacy contract. A test
 * (`TelemetryDoc.test.ts`) regenerates and diffs against the committed file, so
 * adding an event without regenerating the doc fails CI.
 *
 * Regenerate with: `npm run gen:telemetry-doc`.
 *
 * The surface and agent vocabularies are now generated too. They used to be
 * hand-written prose in this file's template, which the drift-guard test cannot
 * see — the staleness was in the generator's own string — and the surface list
 * had already gone stale by three entries. Derive, never restate.
 */
import { TELEMETRY_SURFACES } from "./Telemetry.js";
import { AGENT_DIMENSION_SINCE_VERSION, TELEMETRY_AGENTS } from "./TelemetryAgent.js";
import { TELEMETRY_EVENTS } from "./TelemetryEvents.js";

/**
 * Render a vocabulary as a code-quoted, comma-separated list, hard-wrapped to
 * the prose width with a two-space continuation indent.
 *
 * Wrapped because these lists grow: unwrapped, one thirteen-entry vocabulary is
 * a 200-column line in a file people read as a privacy contract, and every
 * addition rewrites that whole line in the diff.
 */
function codeList(values: ReadonlyArray<string>, width = 74): string {
	const lines: string[] = [];
	let line = "";
	for (const [i, value] of values.entries()) {
		const token = `\`${value}\`${i === values.length - 1 ? "" : ","}`;
		if (line === "") {
			line = token;
		} else if (`${line} ${token}`.length <= width) {
			line = `${line} ${token}`;
		} else {
			lines.push(line);
			line = token;
		}
	}
	if (line !== "") lines.push(line);
	return lines.join("\n  ");
}

/** The full Markdown body of `TELEMETRY.md`. Deterministic — registry order. */
export function generateTelemetryMarkdown(): string {
	const eventRows = Object.entries(TELEMETRY_EVENTS)
		.map(([name, doc]) => `| \`${name}\` | ${doc} |`)
		.join("\n");

	return `<!-- GENERATED FILE — do not edit by hand.
     Regenerate with \`npm run gen:telemetry-doc\` (sources: cli/src/core/TelemetryEvents.ts,
     cli/src/core/TelemetryAgent.ts, cli/src/core/Telemetry.ts). -->

# Jolli Memory telemetry

Jolli Memory collects **anonymous, opt-out, content-free** usage telemetry to
help us understand whether the memory pipeline works in the wild and how the
tools are adopted. This document is the exact, complete description of what is
collected — generated from the event registry the code actually uses.

## What we collect

- A random per-machine identifier (\`installId\`) and the surface — which Jolli
  build sent the event — plus its version. The surfaces are:
  ${codeList(TELEMETRY_SURFACES)}.
- The \`agent\` property: which AI coding tool the work happened in, when that
  is known. It is a fixed, low-cardinality list of tool names, never free-form:
  ${codeList(TELEMETRY_AGENTS)}. See below for when it is omitted.
- Coarse environment facts: OS, architecture, runtime version, and which Jolli
  environment your client is pointed at (\`local\` / \`dev\` / \`preview\` / \`prod\`).
- The events listed below, each with a small bag of **bucketed or boolean**
  properties (e.g. a result count as \`"1-5"\`, not the actual number).

### About the \`agent\` property

\`agent\` records the AI host — Claude Code, Codex, Cursor, Gemini, and so on —
because the surface above only identifies which of our own builds ran, which is
often not the tool you were using. It is a tool name and nothing else: not
identity, not content, not a path, and not anything you typed.

It is **omitted whenever the host is not actually known**, rather than defaulted
to a guess. An absent \`agent\` means "not measured", never "the CLI". A host we
do not recognise is omitted too — the value can only ever be one of the tokens
listed above.

Events recorded by earlier client versions carry no \`agent\` at all, and nothing
reconstructs it retroactively. The first version to emit it is
\`${AGENT_DIMENSION_SINCE_VERSION}\`.

## What we never collect

- No source code, file contents, file paths, repository or branch names, commit
  messages, search queries, or AI prompts.
- Counts are bucketed (\`"0"\`, \`"1-5"\`, \`"6-20"\`, …); any identifier that must
  persist is salted-hashed; query lengths are bucketed (\`short\`/\`medium\`/\`long\`),
  never the text. A client-side scrubber additionally drops anything that looks
  like a path, URL, email, or secret, and bounds nesting depth.

## How to turn it off

Telemetry is on by default, but is silenced when any of these is true:

- The \`DO_NOT_TRACK\` environment variable is set to anything other than \`0\`.
- You run \`jolli telemetry off\` (re-enable with \`jolli telemetry on\`).
- (VS Code) your editor telemetry is disabled (\`telemetry.telemetryLevel\`).
- (IntelliJ) the IDE data-sharing consent is declined.

The off switch (\`telemetry\`) and \`installId\` live in the machine-global
\`~/.jolli/jollimemory/config.json\`, so the choice is shared across all three
surfaces. Run \`jolli telemetry inspect\` to print the exact events buffered on
disk **before** they are sent.

## What identifies you

- \`installId\` — a random UUID minted once per machine. It is anonymous: it is
  not derived from your name, email, hostname, or any account.
- \`accountId\` — **never sent by the client**. When you sign in, the backend
  attributes events to your account from your API key; until then every event is
  anonymous (\`accountId\` is null).

## Events

| Event | Description |
| -- | -- |
${eventRows}

---
*Generated from \`cli/src/core/TelemetryEvents.ts\` (events),
\`cli/src/core/TelemetryAgent.ts\` (agents) and \`cli/src/core/Telemetry.ts\`
(surfaces). The IntelliJ plugin is an independent implementation that sends the
same event names and envelope.*
`;
}
