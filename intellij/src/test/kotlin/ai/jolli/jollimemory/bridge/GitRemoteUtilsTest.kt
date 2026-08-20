package ai.jolli.jollimemory.bridge

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import io.kotest.matchers.shouldBe
import java.nio.file.Files
import org.junit.jupiter.api.Test

/**
 * Pins the approach-B routing of [GitRemoteUtils.getCanonicalRepoUrl]: the
 * canonical repo URL is computed by the CLI-owned canonicalizer over the
 * `git-remote` ide-bridge action (so the ssh-alias fix from JOLLI-2135 reaches
 * IntelliJ with no Kotlin logic change), and the local Kotlin canonicalizer is
 * only a no-Node / no-daemon fallback.
 *
 * The bridge is injected as a plain lambda seam — no Kotlin singleton is stubbed,
 * so this stays within the JVM-global-state rule (`check-global-state.sh`) and
 * runs under the default parallel-tests policy.
 */
class GitRemoteUtilsTest {

    private fun bridgeReturning(value: JsonElement): (String, String, String) -> JsonElement =
        { _, _, _ -> value }

    private fun valueObject(url: String): JsonObject = JsonObject().apply { addProperty("value", url) }

    @Test
    fun `uses the bridge-computed canonical url when the bridge answers`() {
        val result = GitRemoteUtils.getCanonicalRepoUrl(
            "/ws",
            runBridge = bridgeReturning(valueObject("https://github.com/owner/repo")),
        )
        result shouldBe "https://github.com/owner/repo"
    }

    @Test
    fun `falls back to the local canonicalizer when the bridge throws`() {
        // A non-git temp dir: the local fallback runs `git config` (fails), so it
        // resolves to the file:// sentinel — proving the fallback ran and nothing
        // rethrew when the bridge was unreachable.
        val tmp = Files.createTempDirectory("jolli-canon").toFile()
        try {
            // Mirror the normalizer's file:// vs file:/// choice: a POSIX path
            // already starts with `/` (→ two slashes), a Windows `C:/…` does not
            // (→ three). A flat "file://" + path is short one slash on Windows.
            val forward = tmp.absolutePath.replace('\\', '/').trimEnd('/')
            val expected = if (forward.startsWith("/")) "file://$forward" else "file:///$forward"
            val result = GitRemoteUtils.getCanonicalRepoUrl(
                tmp.absolutePath,
                runBridge = { _, _, _ -> throw RuntimeException("bridge down") },
            )
            result shouldBe expected
        } finally {
            tmp.delete()
        }
    }

    @Test
    fun `falls back when the bridge answers without a usable value`() {
        val tmp = Files.createTempDirectory("jolli-canon").toFile()
        try {
            // Mirror the normalizer's file:// vs file:/// choice: a POSIX path
            // already starts with `/` (→ two slashes), a Windows `C:/…` does not
            // (→ three). A flat "file://" + path is short one slash on Windows.
            val forward = tmp.absolutePath.replace('\\', '/').trimEnd('/')
            val expected = if (forward.startsWith("/")) "file://$forward" else "file:///$forward"
            val result = GitRemoteUtils.getCanonicalRepoUrl(
                tmp.absolutePath,
                runBridge = bridgeReturning(JsonObject().apply { addProperty("other", 1) }),
            )
            result shouldBe expected
        } finally {
            tmp.delete()
        }
    }

    @Test
    fun `local fallback drops the ssh port from a self-hosted identity but keeps git and https ports`() {
        // JOLLI-2135 follow-up: the ssh CONNECTION port is not the repo's https
        // identity, so an ssh clone folds onto the https key regardless of the port.
        // git:// (a distinct transport) and http(s) (where the port IS the identity)
        // keep theirs. Mirrors the CLI canonicalizer.
        GitRemoteUtils.normalizeRemoteUrl("ssh://git@host.example:2222/team/repo.git", "/ws") shouldBe
            "https://host.example/team/repo"
        GitRemoteUtils.normalizeRemoteUrl("git://host.example:9419/team/repo", "/ws") shouldBe
            "https://host.example:9419/team/repo"
        GitRemoteUtils.normalizeRemoteUrl("https://host.example:8443/team/repo", "/ws") shouldBe
            "https://host.example:8443/team/repo"
    }
}
