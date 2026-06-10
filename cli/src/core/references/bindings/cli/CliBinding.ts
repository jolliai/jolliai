/**
 * CliBinding — one declaration per shell-CLI command that yields a reference.
 *
 * This is the agent-neutral CLI **producer** binding, the third producer kind
 * alongside `bindings/claude` (MCP tool name) and `bindings/codex` (MCP
 * namespace+name). An LLM commonly falls back from a connector to a shell CLI
 * (e.g. `gh issue view … --json`) when the MCP payload is incomplete; that
 * output is invisible to the MCP path. Both the Claude (`Bash`) and Codex
 * (`shell_command`) envelopes extract the command string and consult this
 * registry — recognition lives here, the prefix/exit-code handling stays in each
 * envelope (Codex's `Exit code:`/`Wall time:` vs Claude's bare stdout).
 *
 * The binding receives the already-parsed business JSON (envelope-stripped); it
 * never touches the transcript shape.
 */

import type { SourceId } from "../../../../Types.js";

export interface CliBinding {
	readonly id: SourceId;
	/** Recognise this CLI invocation from the command string alone (no output parse). */
	matches(command: string): boolean;
	/** Stable synthetic tool name persisted as `Reference.toolName`/`sourceToolName`. */
	readonly canonicalToolName: string;
	/** Normalize the already-parsed business JSON into the shape the adapter reads. */
	normalize(business: unknown): unknown;
}
