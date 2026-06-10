/**
 * CLI producer binding registry — resolves a shell command string to its
 * {@link CliBinding}, or null. Agent-neutral: both the Claude (`Bash`) and Codex
 * (`shell_command`) envelopes feed their extracted command here. Adding a CLI
 * source = one entry plus its binding file.
 */

import type { CliBinding } from "./CliBinding.js";
import { ghIssueCliBinding } from "./GhIssueCliBinding.js";

const CLI_BINDINGS: readonly CliBinding[] = [ghIssueCliBinding];

/** First CLI binding whose `matches(command)` is true, or null. */
export function matchCliCommand(command: string): CliBinding | null {
	for (const binding of CLI_BINDINGS) {
		if (binding.matches(command)) return binding;
	}
	return null;
}

export type { CliBinding } from "./CliBinding.js";
