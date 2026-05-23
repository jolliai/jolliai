/**
 * `GIT_ASKPASS` shim for the sync engine.
 *
 * When the sync engine spawns `git clone/fetch/push` against the vault, git
 * prompts for a password (the Installation Token). We feed the token via a
 * one-shot askpass script that reads the token from the spawned child's
 * environment block — NEVER from argv (which `ps -ef` can read on every OS).
 *
 * The script is generated on first use into `~/.jolli/jollimemory/askpass/`
 * with mode 0700, then reused across subsequent spawns. Windows gets a
 * separate `.cmd` variant because POSIX shebangs aren't honoured there.
 *
 * Threat model: an attacker with read access to `/proc/<pid>/environ` on
 * Linux/macOS (uid-gated) or the equivalent on Windows can still read the
 * token while the spawned git process is alive — but that's a post-compromise
 * threat, not casual leakage. Argv-based passing would be readable by any
 * user on the host via `ps`, which is the leak we're actually closing.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Env var name the spawned git child reads to learn the token. Constant so
 * tests and callers reference the same string — typos here would silently
 * cause git to prompt forever (well, until `GIT_TERMINAL_PROMPT=0` kills it).
 */
export const ASKPASS_ENV_VAR = "JOLLI_SYNC_GIT_TOKEN";

/** POSIX askpass script — prints the token from env and exits. */
const POSIX_SCRIPT = `#!/usr/bin/env sh
printf '%s\\n' "$${ASKPASS_ENV_VAR}"
`;

/** Windows askpass script. `@echo` would echo the line itself, so use `@echo off` first. */
const WINDOWS_SCRIPT = `@echo off\r\necho %${ASKPASS_ENV_VAR}%\r\n`;

export interface AskpassHandle {
	/** Absolute path to the script. POSIX: `.sh`, Windows: `.cmd`. */
	readonly scriptPath: string;
	/** Name of the env var the script reads. Constant — always `ASKPASS_ENV_VAR`. */
	readonly envVar: typeof ASKPASS_ENV_VAR;
	/**
	 * Env object ready to merge into `child_process.spawn` options. Contains:
	 *   - a curated allowlist of variables from `process.env` (see
	 *     `ENV_ALLOWLIST` + the `GIT_*` prefix pass below) — NOT a full spread
	 *   - `GIT_ASKPASS` pointing at `scriptPath`
	 *   - `GIT_TERMINAL_PROMPT=0` (fail fast if askpass exits non-zero)
	 *   - `GCM_INTERACTIVE=Never` (Windows GCM modal kill switch)
	 *   - `JOLLI_SYNC_GIT_TOKEN=<token>`
	 *
	 * The allowlist exists so host secrets that have no business reaching git
	 * — `ANTHROPIC_API_KEY`, `JOLLI_API_KEY`, `GITHUB_TOKEN`, cloud creds,
	 * etc. — don't get inherited by git or anything git spawns (credential
	 * helpers, `core.editor`, hooks). Argv leaks are closed by the askpass
	 * shim; this closes the corresponding env-block leak.
	 */
	readonly env: NodeJS.ProcessEnv;
}

/**
 * Env vars passed through to spawned git children unchanged. Anything not on
 * this list (and not matching the `GIT_*` prefix pass in `prepareAskpass`,
 * minus `GIT_DENY_PREFIX_PASS`) is dropped — secrets like `ANTHROPIC_API_KEY`
 * / `JOLLI_API_KEY` / `GITHUB_TOKEN` must not leak to git or its subprocesses.
 *
 * Categories:
 *   - PATH / search: needed so git can find `ssh`, credential helpers, hooks
 *   - HOME / profile: git reads `~/.gitconfig`, `~/.git-credentials`, etc.
 *   - Temp dirs: git writes lockfiles, packfiles, merge artifacts here
 *   - Locale: controls error message language + LC_CTYPE-driven path handling
 *   - SSH agent: needed if a user ever swaps the askpass shim for SSH auth
 *   - XDG: git honours `XDG_CONFIG_HOME` for the config search path
 *   - Windows: `SystemRoot` / `APPDATA` / `LOCALAPPDATA` / `PATHEXT` /
 *     `COMSPEC` for git-for-windows (PATHEXT is required so the `.exe`
 *     suffix is auto-resolved; COMSPEC is the shell-out fallback)
 *   - Proxy: `HTTP(S)_PROXY` / `NO_PROXY` / `ALL_PROXY` + lowercase variants
 *     so corporate-proxy users keep working. libcurl + git both check these
 *   - TLS / CA: `SSL_CERT_FILE` / `SSL_CERT_DIR` / `CURL_CA_BUNDLE` /
 *     `NODE_EXTRA_CA_CERTS` so self-signed CAs (corp MITM proxies, internal
 *     CAs) are trusted by libcurl during HTTPS git transport
 *   - Author identity fallback: `USER` / `LOGNAME` / `USERNAME` /
 *     `USERDOMAIN` — git uses these when `user.name` is unset; without
 *     them commit fails with "Author identity unknown"
 *   - Editor fallback: `EDITOR` / `VISUAL` — sync invocations all pass
 *     `-m` so no editor should launch, but rebase/merge can fall through
 *     to an editor and would otherwise hang on a nonexistent binary
 */
const ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
	"SystemRoot",
	"APPDATA",
	"LOCALAPPDATA",
	"PATHEXT",
	"COMSPEC",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
	"USER",
	"LOGNAME",
	"USERNAME",
	"USERDOMAIN",
	"EDITOR",
	"VISUAL",
] as const;

/**
 * `GIT_*` env vars that the prefix pass refuses to forward, even though
 * they're git-native. These three rewrite which repo git operates on —
 * `GIT_DIR` / `GIT_WORK_TREE` would silently retarget the Memory Bank
 * sync at whatever the user's shell points at, and `GIT_INDEX_FILE` would
 * substitute a foreign staging area. Memory Bank always operates on the
 * vault clone via explicit `cwd`; honouring these env vars would either
 * mis-sync or push the wrong tree.
 */
const GIT_PREFIX_DENYLIST: ReadonlySet<string> = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

/** Returns the askpass directory under the global jolli memory dir. */
function getAskpassDir(): string {
	return join(homedir(), ".jolli", "jollimemory", "askpass");
}

/** Returns the absolute script path for the current platform. */
export function getAskpassScriptPath(): string {
	const name = platform() === "win32" ? "git-askpass.cmd" : "git-askpass.sh";
	return join(getAskpassDir(), name);
}

/** Returns the script body the current platform expects. */
function getDesiredScriptBody(): string {
	return platform() === "win32" ? WINDOWS_SCRIPT : POSIX_SCRIPT;
}

/**
 * Hash to detect script drift across version upgrades. If the user (or a
 * prior build) wrote a different shim, we silently overwrite — the script
 * is a build artifact, not user state.
 */
function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/**
 * Ensures the askpass script exists with the current expected content, then
 * returns a handle ready to spread into `child_process.spawn` options.
 *
 * Idempotent: a matching script on disk is left alone (saves a write +
 * chmod on every sync round). A mismatched script is rewritten.
 */
export async function prepareAskpass(token: string): Promise<AskpassHandle> {
	const scriptPath = getAskpassScriptPath();
	const desired = getDesiredScriptBody();
	await mkdir(getAskpassDir(), { recursive: true });

	let needsWrite = true;
	try {
		const existing = await readFile(scriptPath, "utf-8");
		if (sha256(existing) === sha256(desired)) {
			needsWrite = false;
		}
	} catch {
		// Missing or unreadable — we'll write below.
	}

	if (needsWrite) {
		await writeFile(scriptPath, desired);
		// chmod 0700 only on POSIX; Windows ignores mode bits but still needs
		// the file to exist. `fs.chmod` on Windows is a silent no-op.
		if (platform() !== "win32") {
			await chmod(scriptPath, 0o700);
		}
	}

	// Build the inherited slice from a curated allowlist instead of
	// `...process.env` so host secrets (ANTHROPIC_API_KEY, JOLLI_API_KEY,
	// GITHUB_TOKEN, cloud creds, …) never reach git or anything git spawns.
	// `GIT_*` is passed through as a prefix so user-set git env vars
	// (`GIT_SSL_NO_VERIFY`, `GIT_HTTP_USER_AGENT`, `GIT_EDITOR`, …) keep
	// working without having to enumerate every one.
	const inherited: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) inherited[key] = value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (
			key.startsWith("GIT_") &&
			value !== undefined &&
			inherited[key] === undefined &&
			!GIT_PREFIX_DENYLIST.has(key)
		) {
			inherited[key] = value;
		}
	}

	const env: NodeJS.ProcessEnv = {
		...inherited,
		GIT_ASKPASS: scriptPath,
		GIT_TERMINAL_PROMPT: "0",
		// Belt-and-braces for Git Credential Manager on Windows. The
		// `-c credential.helper=` / `-c credential.modalprompt=false`
		// hardening in `GitClient.GIT_HARDENING_CONFIG` empties the helper
		// chain at the config layer; `GCM_INTERACTIVE=Never` is GCM's own
		// env-var kill switch and protects us if a stale per-repo
		// `credential.helper` somewhere in the config tree still resolves
		// to GCM. Without these, a default Git-for-Windows install pops a
		// modal sign-in dialog when `git fetch` hits the vault remote, and
		// the sync round hangs until the user notices the (often off-
		// screen) window.
		GCM_INTERACTIVE: "Never",
		[ASKPASS_ENV_VAR]: token,
	};

	return { scriptPath, envVar: ASKPASS_ENV_VAR, env };
}
