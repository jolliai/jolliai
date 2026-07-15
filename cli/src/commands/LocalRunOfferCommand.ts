/**
 * `local-run-workflows` — prints, as JSON, the workflows that can be run locally
 * right now (git-backed + cloned destination). Agent/recipe consumption: the
 * `jolli-local-run` recipe shells this one command to obtain the offerable set
 * instead of orchestrating the manifest fetch + clones read itself.
 *
 * This is a normal CLI process (not the MCP stdio server), so it can freely spawn
 * `jolli space clones --json` without any risk of corrupting a JSON-RPC channel.
 *
 * Output (always JSON on stdout):
 *   - `{ type: "workflows", workflows: [{ id, name?, autoMerges }] }` — the offerable
 *     set (possibly empty; an empty list is a normal "nothing to offer" state).
 *     `name` is present only when the backend supplied one (advisory display). Exit 0.
 *   - `{ type: "space_cli_required", message, install }` — needs-input: space-cli
 *     must be installed first. Exit 0 (not a failure — mirrors `binding_required`).
 *   - `{ type: "error", message }` — an unexpected failure. Exit 1.
 */

import type { Command } from "commander";
import { JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { parseClonedSpaceKeys, resolveLocalRunOffer } from "../core/LocalRunOffer.js";
import { resolveCliInvocation } from "../install/McpRegistration.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";

/**
 * Reads the cloned-space keys (space JRNs / slugs) on this machine by spawning
 * `jolli space clones --json` through the run-cli indirection (never a bare
 * `jolli` on PATH). Returns `null` when space-cli is unavailable — the spawn
 * errors, or the `space` command stub prints its install hint and exits non-zero
 * — which the offer resolver surfaces as `space_cli_required`. A spawn that
 * succeeds but emits an unreadable body degrades to an empty set (no clones)
 * rather than an error.
 */
async function readClonedSpaceKeys(): Promise<Set<string> | null> {
	const { command, args } = resolveCliInvocation(["space", "clones", "--json"]);
	let stdout: string;
	try {
		({ stdout } = await execFileAsyncHidden(command, args));
	} catch {
		return null;
	}
	return parseClonedSpaceKeys(stdout);
}

/** Registers the `local-run-workflows` command on the given Commander program. */
export function registerLocalRunOfferCommand(program: Command): void {
	program
		.command("local-run-workflows")
		.description(
			"List the workflows runnable locally (git-backed + cloned destination) as JSON (agent/recipe consumption)",
		)
		.action(async () => {
			try {
				const client = new JolliMemoryPushClient();
				const result = await resolveLocalRunOffer({
					listWorkflows: () => client.listWorkflows(),
					readClonedSpaceKeys,
				});
				console.log(JSON.stringify(result));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.log(JSON.stringify({ type: "error", message }));
				process.exitCode = 1;
			}
		});
}
