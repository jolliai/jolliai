/**
 * JolliCloudCommands — `jolli push` / `jolli spaces` / `jolli bind`.
 *
 * The CLI surface over the push-to-Jolli-Space engine: `JolliMemoryPushOrchestrator`
 * (branch push loop) and `JolliMemoryPushClient` (spaces + bindings HTTP calls).
 * Follows the `pr-description` / `queue-status` conventions: `resolveProjectDir()`
 * for `--cwd`, `setLogDir`, `Option(...).choices(["json"])` for `--format`, and a
 * caught-error path that emits `{type:"error",message}` under `--format json`
 * (plain stderr text otherwise) and always sets `process.exitCode = 1`.
 */

import { type Command, Option } from "commander";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import {
	BindingAlreadyExistsError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
} from "../core/JolliMemoryPushClient.js";
import { pushBranchToJolli, resolveSpaceId } from "../core/JolliMemoryPushOrchestrator.js";
import { clearSpaceBindingCache } from "../core/SpaceBindingCache.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface PushOptions {
	base?: string;
	space?: string;
	format?: string;
	cwd: string;
}

interface SpacesOptions {
	format?: string;
	cwd: string;
}

interface BindOptions {
	space: string;
	repoName?: string;
	format?: string;
	cwd: string;
}

/** Shared caught-error rendering: `{type:"error",message}` under `--format json`, plain stderr text otherwise. Always sets a non-zero exit code. */
function emitError(message: string, format: string | undefined): void {
	if (format === "json") {
		console.log(JSON.stringify({ type: "error", message }));
	} else {
		console.error(`\n  Error: ${message}\n`);
	}
	process.exitCode = 1;
}

/** Renders a `<id>  <name> (<slug>)` line per space, marking the tenant's configured default. */
function renderSpaceLines(spaces: ReadonlyArray<JolliMemorySpace>, defaultSpaceId: number | null): string[] {
	return spaces.map((s) => `    ${s.id}  ${s.name} (${s.slug})${s.id === defaultSpaceId ? " (default)" : ""}`);
}

/** Registers the `push` command on the given Commander program. */
export function registerPushCommand(program: Command): void {
	program
		.command("push")
		.description("Push this branch's memory summaries to a bound Jolli Space")
		.option("--base <branch>", "Base branch to diff against (default: the repo's default branch)")
		.option("--space <idOrSlug>", "Jolli Space id, slug, or name — binds the repo before pushing if not yet bound")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: PushOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);
				setActiveStorage(await createStorage(projectDir, projectDir));

				const result = await pushBranchToJolli({
					cwd: projectDir,
					baseBranch: options.base,
					space: options.space,
				});

				if (options.format === "json") {
					console.log(JSON.stringify(result));
					if (result.type === "error") process.exitCode = 1;
					return;
				}

				if (result.type === "pushed") {
					const lines: string[] = [""];
					lines.push(`  Pushed ${result.pushed} memories (${result.skipped} skipped).`);
					for (const url of result.urls) lines.push(`    ${url}`);
					lines.push("");
					console.log(lines.join("\n"));
				} else if (result.type === "binding_required") {
					const lines: string[] = [""];
					lines.push(`  ${result.repoUrl} isn't bound to a Jolli Space yet. Available spaces:`);
					lines.push(...renderSpaceLines(result.spaces, result.defaultSpaceId));
					lines.push("");
					lines.push("  Re-run with --space <id|slug> to bind and push.");
					lines.push("");
					console.log(lines.join("\n"));
				} else {
					emitError(result.message, options.format);
				}
			} catch (error: unknown) {
				emitError(error instanceof Error ? error.message : String(error), options.format);
			}
		});
}

/** Registers the `spaces` command on the given Commander program. */
export function registerSpacesCommand(program: Command): void {
	program
		.command("spaces")
		.description("List the Jolli Spaces available to bind this repo to")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: SpacesOptions) => {
			try {
				setLogDir(options.cwd);
				const { spaces, defaultSpaceId } = await new JolliMemoryPushClient().listSpaces();

				if (options.format === "json") {
					console.log(JSON.stringify({ spaces, defaultSpaceId }));
				} else if (spaces.length === 0) {
					console.log("\n  No Jolli Spaces available.\n");
				} else {
					console.log(["", "  Jolli Spaces:", ...renderSpaceLines(spaces, defaultSpaceId), ""].join("\n"));
				}
			} catch (error: unknown) {
				emitError(error instanceof Error ? error.message : String(error), options.format);
			}
		});
}

/** Registers the `bind` command on the given Commander program. */
export function registerBindCommand(program: Command): void {
	program
		.command("bind")
		.description("Bind this repo to a Jolli Space")
		.requiredOption("--space <idOrSlug>", "Jolli Space id, slug, or name to bind this repo to")
		.option("--repo-name <name>", "Repo name to record with the binding (default: derived from the repo URL)")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: BindOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				const client = new JolliMemoryPushClient();
				const repoUrl = await getCanonicalRepoUrl(projectDir);
				const jmSpaceId = await resolveSpaceId(client, options.space);
				const repoName = options.repoName ?? deriveRepoNameFromUrl(repoUrl);

				const binding = await client.createBinding({ repoUrl, repoName, jmSpaceId });
				// Bind-only entry point: drop the local binding cache — the next
				// probe (or push echo) rebuilds it with the authoritative details.
				await clearSpaceBindingCache(projectDir);

				if (options.format === "json") {
					console.log(JSON.stringify({ type: "bound", ...binding }));
				} else {
					console.log(
						`\n  Bound ${repoUrl} to Jolli Space "${binding.repoName}" (space ${binding.jmSpaceId}).\n`,
					);
				}
			} catch (error: unknown) {
				if (error instanceof BindingAlreadyExistsError) {
					if (options.format === "json") {
						console.log(JSON.stringify({ type: "already_bound", message: error.message }));
					} else {
						console.log("\n  This repo is already bound to a Jolli Space.\n");
					}
					return;
				}
				emitError(error instanceof Error ? error.message : String(error), options.format);
			}
		});
}
