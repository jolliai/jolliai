import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { type Candidate, isPresent, resolveExecutable, type ShimDeps } from "./ExecutableResolver.js";
import {
	type Invocation,
	LocalAgentAuthError,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

/**
 * Shape of the `cursor-agent -p --output-format json` result envelope,
 * captured from a real run (see `__fixtures__/cursor-agent/success.json`).
 * `usage` fields are camelCase — distinct from Claude Code's snake_case.
 */
interface CursorEnvelope {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}

/**
 * Resolves the Windows `cursor-agent` launcher to the bundled Node it ultimately
 * runs. Pinned to a real install (`%LOCALAPPDATA%\cursor-agent`, CLI 2026.07.20):
 *
 *   cursor-agent.cmd  ->  powershell.exe -File cursor-agent.ps1  ->  node.exe index.js
 *   versions\<version>\{node.exe, index.js}
 *
 * We skip both shim layers and spawn `node.exe index.js` straight from argv —
 * neither cmd.exe nor PowerShell gets to re-parse a multi-KB prompt containing
 * quotes and newlines. This mirrors what the POSIX launcher does verbatim
 * (`exec "$SCRIPT_DIR/node" "$SCRIPT_DIR/index.js" "$@"`), including its
 * preference for `--use-system-ca` when the bundled Node accepts it — emitted as
 * a separate, earlier candidate so the capability probe decides rather than us
 * guessing, and the version tie-break keeps it ahead of the plain invocation.
 *
 * EVERY version directory is offered; the probe rejects broken ones and the
 * newest surviving `--version` wins, so no assumption is made about which
 * version the `.ps1` would have picked — a torn or broken newest install falls
 * back to the previous one instead of failing outright. Directories are offered
 * newest-first (the names are date-stamped `<yyyy.mm.dd>-<sha>`, so descending
 * lexicographic order IS chronological); that does not change which candidate
 * wins, but it keeps the diagnostic log and the rejected-candidate list reading
 * in the order a human expects.
 */
export function expandCursorShim(shimPath: string, deps: ShimDeps): Candidate[] {
	const versionsDir = pathWin32.join(pathWin32.dirname(shimPath), "versions");
	const newestFirst = [...deps.listDir(versionsDir)].sort().reverse();
	return newestFirst.flatMap((version) => {
		const node = pathWin32.join(versionsDir, version, "node.exe");
		const entry = pathWin32.join(versionsDir, version, "index.js");
		if (!deps.exists(node) || !deps.exists(entry)) return [];
		return [
			{ file: node, launchArgs: ["--use-system-ca", entry] },
			{ file: node, launchArgs: [entry] },
		];
	});
}

/**
 * Windows per-user app data root. Read from the environment rather than composed
 * from the home directory: managed/enterprise images routinely redirect
 * `%LOCALAPPDATA%` off the profile (folder redirection, a non-`C:` profile disk),
 * where the composed path simply does not exist. The composition is the fallback
 * for when the variable is absent — e.g. a `platform: "win32"`-pinned test on a
 * POSIX host.
 */
function localAppData(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.LOCALAPPDATA || pathWin32.join(home, "AppData", "Local");
}

/** Install locations to check directly, for when the tool is not on the search PATH. */
export function cursorKnownPaths(home: string, platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") return [pathPosix.join(home, ".local/bin/cursor-agent")];
	return [
		// The installer's own location. `where` finds it only when it is on PATH,
		// which a GUI-launched editor's minimal PATH often drops.
		pathWin32.join(localAppData(home, env), "cursor-agent", "cursor-agent.cmd"),
		pathWin32.join(home, ".local", "bin", "cursor-agent.exe"),
	];
}

const CURSOR_SPEC = {
	binName: "cursor-agent",
	knownPaths: cursorKnownPaths,
	probeArgs: ["--version"] as const,
	expandShim: expandCursorShim,
} as const;

export class CursorAgentBackend implements LocalAgentBackend {
	readonly id = "cursor-agent";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CURSOR_SPEC, { overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isPresent(CURSOR_SPEC, { overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.CURSOR_API_KEY; // force subscription login, never proxy through a leaked API key
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo (and, for cursor-agent specifically, from its Workspace
		// Trust prompt over an unfamiliar directory — see --trust below).
		const cwd = createLocalAgentCwd();
		// cursor-agent has no separate system-prompt flag in headless mode, so the
		// system prompt is prepended to the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			// Empty for a native binary; on Windows this is the bundled
			// `node.exe`'s script args, since `exe.file` is that Node (see
			// expandCursorShim). Must lead — they belong to the launcher, not the CLI.
			...(exe.launchArgs ?? []),
			"-p",
			"--output-format",
			"json",
			// Required: the fresh temp cwd above trips cursor-agent's Workspace
			// Trust gate otherwise (confirmed via probe). This is the real
			// "Trust the current workspace without prompting" flag, not
			// -f/--yolo (which governs command execution approval, not trust).
			"--trust",
			...(req.model ? ["--model", req.model] : []),
			prompt,
		];
		// The prompt is a positional arg, not stdin, in headless mode.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let env: CursorEnvelope;
		try {
			env = JSON.parse(stdout) as CursorEnvelope;
		} catch {
			throw new LocalAgentSetupError(
				`Could not parse Cursor output as JSON (first 200 chars): ${stdout.slice(0, 200)}`,
			);
		}
		if (env.is_error) {
			const detail = env.result ?? env.subtype ?? "unknown";
			const msg = `Cursor returned an error: ${detail}`;
			if (
				/log ?in|logged in|unauthori|authenticat|not_logged_in/i.test(detail) ||
				/auth/i.test(env.subtype ?? "")
			) {
				throw new LocalAgentAuthError(msg);
			}
			throw new LocalAgentSetupError(msg);
		}
		const usage = env.usage ?? {};
		return {
			text: env.result ?? "",
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			cachedTokens: (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
			costUsd: 0, // no cost field in the cursor-agent envelope
			stopReason: env.subtype ?? null,
		};
	}
}
