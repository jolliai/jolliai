package ai.jolli.jollimemory.sync

import java.io.File
import java.security.MessageDigest

/**
 * `GIT_ASKPASS` shim for the sync engine.
 *
 * Port of `cli/src/sync/GitAskpass.ts`.
 *
 * When the sync engine spawns `git clone/fetch/push` against the vault, git
 * prompts for a password (the Installation Token). We feed the token via a
 * one-shot askpass script that reads the token from the spawned child's
 * environment block — NEVER from argv (which `ps -ef` can read on every OS).
 *
 * The script is generated on first use into `~/.jolli/jollimemory/askpass/`
 * and reused across subsequent spawns. Windows gets a separate `.cmd` variant.
 */

/** Env var name the spawned git child reads to learn the token. */
const val ASKPASS_ENV_VAR = "JOLLI_SYNC_GIT_TOKEN"

/**
 * Handle returned by [prepareAskpass] — ready to merge into ProcessBuilder env.
 *
 * @property scriptPath Absolute path to the askpass script.
 * @property env Curated env map: allowlisted vars + GIT_ASKPASS + token.
 */
data class AskpassHandle(
	val scriptPath: String,
	val env: Map<String, String>,
)

/** POSIX askpass script — prints the token from env and exits. */
private const val POSIX_SCRIPT = "#!/usr/bin/env sh\nprintf '%s\\n' \"\$$ASKPASS_ENV_VAR\"\n"

/** Windows askpass script. */
private const val WINDOWS_SCRIPT = "@echo off\r\necho %$ASKPASS_ENV_VAR%\r\n"

/**
 * Env vars passed through to spawned git children. Anything not on this list
 * (and not matching the `GIT_` prefix pass) is dropped — secrets like
 * `ANTHROPIC_API_KEY` / `JOLLI_API_KEY` / `GITHUB_TOKEN` must not leak
 * to git or its subprocesses.
 */
private val ENV_ALLOWLIST = listOf(
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
)

/**
 * `GIT_*` env vars that the prefix pass refuses to forward. These rewrite
 * which repo git operates on — the vault sync must always use its own cwd.
 */
private val GIT_PREFIX_DENYLIST = setOf("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")

private val isWindows = System.getProperty("os.name").lowercase().contains("win")

private fun getAskpassDir(): String {
	val home = System.getProperty("user.home")
	return File(home, ".jolli${File.separator}jollimemory${File.separator}askpass").absolutePath
}

private fun getAskpassScriptPath(): String {
	val name = if (isWindows) "git-askpass.cmd" else "git-askpass.sh"
	return File(getAskpassDir(), name).absolutePath
}

private fun getDesiredScriptBody(): String {
	return if (isWindows) WINDOWS_SCRIPT else POSIX_SCRIPT
}

private fun sha256(s: String): String {
	val digest = MessageDigest.getInstance("SHA-256")
	return digest.digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}

/**
 * Ensures the askpass script exists with the current expected content, then
 * returns a handle ready to merge into ProcessBuilder environment.
 *
 * Idempotent: a matching script on disk is left alone.
 */
fun prepareAskpass(token: String): AskpassHandle {
	val scriptPath = getAskpassScriptPath()
	val desired = getDesiredScriptBody()
	val dir = File(getAskpassDir())
	dir.mkdirs()

	val scriptFile = File(scriptPath)
	var needsWrite = true
	if (scriptFile.exists()) {
		try {
			val existing = scriptFile.readText()
			if (sha256(existing) == sha256(desired)) {
				needsWrite = false
			}
		} catch (_: Exception) {
			// Unreadable — rewrite below.
		}
	}

	if (needsWrite) {
		scriptFile.writeText(desired)
		if (!isWindows) {
			scriptFile.setExecutable(true, true) // chmod 0700
			scriptFile.setReadable(true, true)
			scriptFile.setWritable(true, true)
		}
	}

	// Build curated env from allowlist + GIT_* prefix pass.
	val inherited = mutableMapOf<String, String>()
	for (key in ENV_ALLOWLIST) {
		val value = System.getenv(key)
		if (value != null) inherited[key] = value
	}
	for ((key, value) in System.getenv()) {
		if (key.startsWith("GIT_") && !inherited.containsKey(key) && key !in GIT_PREFIX_DENYLIST) {
			inherited[key] = value
		}
	}

	val env = inherited.toMutableMap()
	env["GIT_ASKPASS"] = scriptPath
	env["GIT_TERMINAL_PROMPT"] = "0"
	env["GCM_INTERACTIVE"] = "Never"
	env[ASKPASS_ENV_VAR] = token

	return AskpassHandle(scriptPath = scriptPath, env = env)
}
