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
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents.js";

/** The full Markdown body of `TELEMETRY.md`. Deterministic — registry order. */
export function generateTelemetryMarkdown(): string {
	const eventRows = Object.entries(TELEMETRY_EVENTS)
		.map(([name, doc]) => `| \`${name}\` | ${doc} |`)
		.join("\n");

	return `<!-- GENERATED FILE — do not edit by hand.
     Regenerate with \`npm run gen:telemetry-doc\` (source: cli/src/core/TelemetryEvents.ts). -->

# Jolli Memory telemetry

Jolli Memory collects **anonymous, opt-out, content-free** usage telemetry to
help us understand whether the memory pipeline works in the wild and how the
tools are adopted. This document is the exact, complete description of what is
collected — generated from the event registry the code actually uses.

## What we collect

- A random per-machine identifier (\`installId\`) and the surface (\`cli\`,
  \`vscode\`, or \`intellij\`) + version.
- Coarse environment facts: OS, architecture, runtime version, and which Jolli
  environment your client is pointed at (\`local\` / \`dev\` / \`preview\` / \`prod\`).
- The events listed below, each with a small bag of **bucketed or boolean**
  properties (e.g. a result count as \`"1-5"\`, not the actual number).

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
*Generated from \`cli/src/core/TelemetryEvents.ts\`. The IntelliJ plugin is an
independent implementation that sends the same event names and envelope.*
`;
}
