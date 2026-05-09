package ai.jolli.jollimemory.bridge

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
 * Mirrors `vscode/src/util/GitRemoteUtils.ts` byte-for-byte in normalization
 * behavior — any change must be made in both places, otherwise a VS Code
 * teammate and an IntelliJ teammate on the same repo will produce different
 * `repoUrl` keys and end up with two separate bindings.
 *
 * Normalization rules:
 *   - SSH scp form `git@host:owner/repo[.git]`          → `https://host/owner/repo`
 *   - SSH URL  `ssh://git@host[:port]/path[.git]`       → `https://host[:port]/path`
 *   - git URL  `git://host[:port]/path[.git]`           → `https://host[:port]/path`
 *   - HTTP(S):  strip trailing `.git`, lower-case scheme + host
 *   - No remote configured: fall back to `file://<workspaceRoot>` (forward slashes)
 *
 * Port handling:
 *   - HTTP(S): always preserve the port (self-hosted forges on non-default
 *     HTTPS ports are common).
 *   - ssh / git: preserve the port unless it's the scheme's default (22 / 9418).
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

    private val CASE_INSENSITIVE_PATH_HOSTS: Set<String> = setOf(
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

    /** Returns the canonical, server-facing repo URL for the given workspace root. */
    fun getCanonicalRepoUrl(workspaceRoot: String): String {
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
            val port = if (parsed.port == -1) "" else parsed.port.toString()
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
