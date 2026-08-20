package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.net.URI

/**
 * GitRemoteUtils
 *
 * Resolves a workspace's canonical remote URL for the Jolli Memory push
 * contract. The returned string is the stable identity key the server uses
 * to look up `jolli_memory_repo_bindings`, so the same physical repo must
 * always yield the same string regardless of clone transport or owner/repo
 * casing the user happened to type in their `git clone` invocation.
 *
 * The CLI (`cli/src/core/GitRemoteUtils.ts`) is the source of truth. Approach B
 * of JOLLI-2135: [getCanonicalRepoUrl] routes through the `git-remote` ide-bridge
 * action so the primary key is computed by that one canonicalizer — including its
 * `~/.ssh/config` Host-alias resolution, which this Kotlin copy does NOT do. The
 * local normalizer below is kept ONLY as a fallback for when the bridge is
 * unreachable (no Node, no daemon): it is deliberately alias-UNAWARE, which is
 * the "config unreadable → behaviour unchanged" degradation JOLLI-2135 specifies.
 * It no longer needs to mirror the TS normalizer byte-for-byte; the daemon-backed
 * path is what every online surface actually uses.
 *
 * Normalization rules (fallback path):
 *   - SSH scp form `git@host:owner/repo[.git]`          → `https://host/owner/repo`
 *   - SSH URL  `ssh://git@host[:port]/path[.git]`       → `https://host[:port]/path`
 *   - git URL  `git://host[:port]/path[.git]`           → `https://host[:port]/path`
 *   - HTTP(S):  strip trailing `.git`, lower-case scheme + host
 *   - No remote configured: fall back to `file://<workspaceRoot>` (forward slashes)
 *
 * Port handling:
 *   - HTTP(S): always preserve the port (self-hosted forges on non-default
 *     HTTPS ports are common — there the port IS the identity).
 *   - ssh: the port is a connection coordinate, not the https identity, so for a
 *     self-hosted host it is dropped entirely — an ssh clone folds onto the
 *     `https://host/x` key (JOLLI-2135 follow-up). Known forges keep it.
 *   - git: a distinct transport; preserve the port unless it's the default (9418).
 *
 * Path-case handling:
 *   - github.com / gitlab.com / bitbucket.org → lowercase path (these hosts
 *     route owner/repo case-insensitively; not lowercasing would let two
 *     clones with different casing fork into separate bindings).
 *   - All other hosts → preserve path case (self-hosted Gitea/GitLab can be
 *     case-sensitive; silently lowercasing would merge distinct repos).
 *
 * Trailing slashes and a single trailing `.git` are stripped.
 */
object GitRemoteUtils {

    private val log = JmLogger.create("GitRemoteUtils")
    private val gson = Gson()

    private val CASE_INSENSITIVE_PATH_HOSTS: Set<String> = setOf(
        "github.com",
        "gitlab.com",
        "bitbucket.org",
    )

    /**
     * Hosts whose surviving ssh port is part of the canonical identity and is
     * KEPT; every other (self-hosted) host has its ssh port DROPPED — see
     * [sshIdentityPort]. Deliberately SEPARATE from [CASE_INSENSITIVE_PATH_HOSTS]
     * even though the members coincide today: the two answer unrelated questions
     * (path-case folding vs. port-as-identity), so a self-hosted forge added to
     * the case list must not silently start preserving ssh ports here. Mirrors
     * the CLI's `SSH_PORT_IDENTITY_HOSTS`.
     */
    private val SSH_PORT_IDENTITY_HOSTS: Set<String> = setOf(
        "github.com",
        "gitlab.com",
        "bitbucket.org",
    )

    /**
     * Default wire ports for ssh / git. A port equal to the default carries
     * no identity information, so `ssh://host:22/x` collapses with `ssh://host/x`.
     * http/https are intentionally absent — keep whatever the user typed,
     * since self-hosted forges sometimes serve on `:443`/`:80` explicitly.
     */
    private val SSH_GIT_DEFAULT_PORTS: Map<String, String> = mapOf(
        "ssh" to "22",
        "git" to "9418",
    )

    private val SSH_SCP_REGEX = Regex("""^([A-Za-z0-9_.+-]+@)([^:/\s]+):(.+)$""")

    /**
     * Returns the canonical, server-facing repo URL for the given workspace root.
     *
     * Primary path: the CLI's canonicalizer over the `git-remote` ide-bridge
     * action (ssh-alias aware). Any bridge failure — no daemon, no Node, protocol
     * error, or a reply without a usable `value` — falls back to the local,
     * alias-UNAWARE normalizer so a push still resolves an identity.
     *
     * [runBridge] is an injectable seam for tests only; production callers pass a
     * single argument and get the real bridge.
     */
    fun getCanonicalRepoUrl(
        workspaceRoot: String,
        runBridge: (String, String, String) -> JsonElement =
            { dir, action, req -> CliIntegrations.runIdeBridge(dir, action, req) },
    ): String {
        try {
            val request = JsonObject().apply { addProperty("operation", "canonical-url") }
            val value = runBridge(workspaceRoot, "git-remote", gson.toJson(request))
                ?.asJsonObject?.get("value")
            if (value != null && !value.isJsonNull && value.asString.isNotEmpty()) {
                return value.asString
            }
            // Fall through: the bridge answered without a usable value.
        } catch (e: Exception) {
            log.debug("git-remote canonical-url bridge failed; using local fallback: %s", e.message)
        }
        return localCanonicalRepoUrl(workspaceRoot)
    }

    /** Local, alias-UNAWARE canonicalizer — the no-Node / no-daemon fallback. */
    private fun localCanonicalRepoUrl(workspaceRoot: String): String {
        val remote = GitOps(workspaceRoot)
            .exec("config", "--get", "remote.origin.url")
            ?.trim()
            .orEmpty()
        if (remote.isEmpty()) {
            return toFileUrl(workspaceRoot)
        }
        return normalizeRemoteUrl(remote, workspaceRoot)
    }

    /** Normalizes a remote URL string into the canonical form. Visible for tests. */
    fun normalizeRemoteUrl(remote: String, workspaceRootForFallback: String): String {
        val trimmed = remote.trim()
        if (trimmed.isEmpty()) {
            return toFileUrl(workspaceRootForFallback)
        }

        if (!trimmed.contains("://")) {
            val sshMatch = SSH_SCP_REGEX.matchEntire(trimmed)
            if (sshMatch != null) {
                val host = sshMatch.groupValues[2].lowercase()
                val pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(sshMatch.groupValues[3]))
                return "https://$host/$pathPart"
            }
        }

        val parsed = try {
            URI(trimmed)
        } catch (_: Exception) {
            return toFileUrl(workspaceRootForFallback)
        }

        val scheme = parsed.scheme?.lowercase()
        if (scheme == "ssh" || scheme == "git" || scheme == "http" || scheme == "https") {
            val host = parsed.host?.lowercase()
                ?: return toFileUrl(workspaceRootForFallback)
            val rawPath = parsed.path.orEmpty().trimStart('/')
            val pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(rawPath))
            val rawPort = if (parsed.port == -1) "" else parsed.port.toString()
            // The ssh port is a CONNECTION coordinate, not the https identity, so for
            // a self-hosted host it is dropped — an ssh clone folds onto the https key
            // (JOLLI-2135 follow-up). git:// keeps its port. Mirrors the CLI's
            // `sshIdentityPort`. (The scp branch above already emits no port.)
            val port = if (scheme == "ssh") sshIdentityPort(host, rawPort) else rawPort
            val portSegment = canonicalPortSegment(scheme, port)
            return "https://$host$portSegment/$pathPart"
        }

        if (scheme == "file") {
            return toFileUrl(parsed.path.orEmpty())
        }

        return toFileUrl(workspaceRootForFallback)
    }

    /** Mirrors the server's `deriveRepoName` spec — used as the chooser default only. */
    fun deriveRepoNameFromUrl(repoUrl: String): String {
        val trimmed = repoUrl.trim()
        if (trimmed.isEmpty()) {
            return ""
        }
        val parsed = try {
            URI(trimmed)
        } catch (_: Exception) {
            return trimmed.take(120)
        }

        val scheme = parsed.scheme?.lowercase()
        val lastSegment = lastNonEmptyPathSegment(parsed.path.orEmpty())
        if (scheme == "http" || scheme == "https" || scheme == "ssh" || scheme == "git") {
            if (lastSegment.isNotEmpty()) {
                return stripGitSuffixOnly(lastSegment)
            }
            return parsed.host?.lowercase().orEmpty()
        }
        if (scheme == "file") {
            return if (lastSegment.isNotEmpty()) lastSegment else trimmed.take(120)
        }
        return trimmed.take(120)
    }

    /**
     * Sanitizes a branch name into a path-safe slug for use inside `relativePath`.
     * Mirrors the server's `stripPathUnsafeChars` (replace anything outside
     * `[A-Za-z0-9._-]` and `/` with `_`, collapse runs, trim leading/trailing
     * `_` and `/`).
     */
    fun sanitizeBranchSlug(branch: String?): String {
        val raw = branch?.trim().orEmpty()
        if (raw.isEmpty()) {
            return "_"
        }
        val replaced = raw.replace(Regex("[^A-Za-z0-9._\\-/]"), "_")
        val collapsed = replaced.replace(Regex("_+"), "_").replace(Regex("/+"), "/")
        val trimmed = collapsed.trim('_', '/')
        return trimmed.ifEmpty { "_" }
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private fun toFileUrl(absolutePath: String): String {
        val forward = absolutePath.replace('\\', '/').trimEnd('/')
        if (forward.isEmpty()) {
            return "file:///"
        }
        return if (forward.startsWith("/")) "file://$forward" else "file:///$forward"
    }

    private fun stripGitSuffixAndSlashes(path: String): String {
        var p = path.trimEnd('/')
        if (p.lowercase().endsWith(".git")) {
            p = p.dropLast(4)
        }
        return p.trimEnd('/')
    }

    private fun normalizePathCase(host: String, pathPart: String): String {
        return if (host in CASE_INSENSITIVE_PATH_HOSTS) pathPart.lowercase() else pathPart
    }

    /**
     * The port an ssh transport contributes to the https identity: dropped for a
     * self-hosted host (the ssh connection port is not the repo's https identity),
     * kept for a known forge ([SSH_PORT_IDENTITY_HOSTS]). Mirrors the CLI's
     * `sshIdentityPort` (JOLLI-2135 follow-up). Only the ssh:// path needs this —
     * the scp fallback emits no port.
     */
    private fun sshIdentityPort(host: String, port: String): String {
        return if (host in SSH_PORT_IDENTITY_HOSTS) port else ""
    }

    private fun canonicalPortSegment(scheme: String, port: String): String {
        if (port.isEmpty()) {
            return ""
        }
        if (scheme == "ssh" || scheme == "git") {
            return if (port == SSH_GIT_DEFAULT_PORTS[scheme]) "" else ":$port"
        }
        return ":$port"
    }

    private fun stripGitSuffixOnly(segment: String): String {
        return if (segment.lowercase().endsWith(".git")) segment.dropLast(4) else segment
    }

    private fun lastNonEmptyPathSegment(pathname: String): String {
        val parts = pathname.split("/").filter { it.isNotEmpty() }
        return parts.lastOrNull().orEmpty()
    }
}
