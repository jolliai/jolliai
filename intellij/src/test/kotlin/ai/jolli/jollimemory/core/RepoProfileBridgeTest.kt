package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Tests for [RepoProfileBridge]'s disk-fallback path — the ONLY reader of the opt-out
 * when the daemon is down or Node.js is missing, which the auto-install gate in
 * [ai.jolli.jollimemory.services.JolliMemoryService.initialize] depends on.
 *
 * These call [RepoProfileBridge.readManuallyDisabledFromDisk] DIRECTLY rather than
 * reaching it through `readManuallyDisabled`. The earlier version did the latter on the
 * premise that "the bundled Cli.js is absent in tests, so runIdeBridge throws and falls
 * through" — which is false in a built monorepo checkout: `resolveCliJs` finds
 * `../cli/dist/Cli.js` through its development lookup, so the bridge call succeeded and
 * really spawned Node (~1 s per case, ~9 s for the class). The assertions still passed,
 * because the real CLI reads the same file, but they were then covering the bridge path
 * while claiming to cover the fallback — and whether the fallback ran at all depended on
 * whether `cli/dist` happened to be built. Calling it directly makes the coverage
 * deterministic and the class fast.
 *
 * Every case pins one of the four disk lookups the CLI's `readManualDisableFlagSync`
 * documents: profile.json has an explicit `manuallyDisabled`, profile.json missing
 * the field but a legacy `disabled-by-user` marker exists (pre-migration disable),
 * both missing, and a malformed profile.json falling through to the legacy marker.
 */
class RepoProfileBridgeTest {

    @TempDir
    lateinit var tempDir: Path

    /** A second temp dir that is NOT inside [repo] — for the no-git-repo case. */
    @TempDir
    lateinit var outsideDir: Path

    private lateinit var repo: File

    @BeforeEach
    fun setUp() {
        repo = tempDir.toFile()
        run("init", "-b", "main")
        run("config", "user.email", "test@example.com")
        run("config", "user.name", "Test User")
    }

    private fun run(vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        check(p.waitFor(30, TimeUnit.SECONDS)) { "git ${args.joinToString(" ")} timed out" }
        check(p.exitValue() == 0) { "git ${args.joinToString(" ")} failed: $out" }
        return out.trim()
    }

    private fun writeProfileJson(content: String) {
        val dir = File(repo, ".jolli/jollimemory").apply { mkdirs() }
        File(dir, "profile.json").writeText(content, Charsets.UTF_8)
    }

    private fun writeLegacyMarker() {
        val dir = File(repo, ".jolli/jollimemory").apply { mkdirs() }
        File(dir, "disabled-by-user").writeText("", Charsets.UTF_8)
    }

    @Test
    fun `profile json with manuallyDisabled=true reads as disabled`() {
        writeProfileJson("""{"manuallyDisabled":true}""")
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe true
    }

    @Test
    fun `profile json with manuallyDisabled=false reads as not disabled`() {
        writeProfileJson("""{"manuallyDisabled":false}""")
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe false
    }

    @Test
    fun `profile json missing the field falls through to the legacy marker`() {
        // The classic "profile.json exists (backfillDismissed only) but the async
        // migration hasn't run yet" state — this is why the CLI's sync path also
        // checks the legacy marker.
        writeProfileJson("""{"backfillDismissed":true}""")
        writeLegacyMarker()
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe true
    }

    @Test
    fun `no profile json but legacy marker present reads as disabled`() {
        // Pre-migration state: only the legacy per-worktree marker exists.
        // A missing legacy check here would silently un-disable the repo the next
        // time [JolliMemoryService.initialize] runs its auto-install gate.
        writeLegacyMarker()
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe true
    }

    @Test
    fun `no profile json and no legacy marker reads as not disabled`() {
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe false
    }

    @Test
    fun `malformed profile json falls through to the legacy marker instead of throwing`() {
        // Corrupt JSON must not surface as an exception (would break the auto-install
        // gate) — fall through to the legacy marker check.
        writeProfileJson("this is not { valid json")
        writeLegacyMarker()
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe true
    }

    @Test
    fun `malformed profile json with no legacy marker returns false`() {
        writeProfileJson("[]") // valid JSON but not an object
        RepoProfileBridge.readManuallyDisabledFromDisk(repo.absolutePath) shouldBe false
    }

    @Test
    fun `resolveProfileJsonPath returns the main-worktree anchored path`() {
        val path = RepoProfileBridge.resolveProfileJsonPath(repo.absolutePath)
        path shouldBe File(repo, ".jolli/jollimemory/profile.json")
    }

    @Test
    fun `resolveProfileJsonPath agrees with git for a linked worktree`() {
        // The `.git`-is-a-directory fast path must not change the answer for the case it
        // deliberately does NOT cover: a linked worktree keeps `.git` as a FILE, so this
        // exercises the git-common-dir fork and must still anchor at the MAIN worktree —
        // that anchoring is the whole point of the helper (repo-wide manualDisable).
        //
        // Compared canonically: git reports the common dir through its real path, while
        // the temp dir here is reached via a symlink on macOS (/var → /private/var), so
        // the two spellings name the same file and only canonical form can assert that.
        File(repo, "seed.txt").writeText("seed")
        run("add", "-A")
        run("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "seed")
        val linked = File(repo.parentFile, "linked-wt-${repo.name}")
        try {
            run("worktree", "add", linked.absolutePath, "-b", "wt-branch")
            File(linked, ".git").isFile shouldBe true // precondition: fast path not taken
            val resolved = RepoProfileBridge.resolveProfileJsonPath(linked.absolutePath)
            resolved?.canonicalFile shouldBe File(repo, ".jolli/jollimemory/profile.json").canonicalFile
        } finally {
            linked.deleteRecursively()
        }
    }

    @Test
    fun `resolveProfileJsonPath resolves a subdirectory to the same repo-root file`() {
        // A subdir has no `.git` of its own, so it takes the fork path. git answers with a
        // RELATIVE common-dir there, which is why the returned File can still carry a `..`
        // segment — it names the right file, and both consumers (File.isFile/readText and
        // the VFS lookup) resolve it. Assert on canonical form, which is what matters.
        val sub = File(repo, "nested/deeper").apply { mkdirs() }
        val resolved = RepoProfileBridge.resolveProfileJsonPath(sub.absolutePath)
        resolved?.canonicalFile shouldBe File(repo, ".jolli/jollimemory/profile.json").canonicalFile
    }

    @Test
    fun `resolveProfileJsonPath returns null outside any git repo`() {
        // Must be a directory genuinely outside `repo` — a subdir of it is still in the
        // repo and resolves (see the test above).
        val plain = outsideDir.toFile()
        File(plain, ".git").exists() shouldBe false // precondition
        RepoProfileBridge.resolveProfileJsonPath(plain.absolutePath) shouldBe null
    }

    // ── readExplicitManualDisable — the tri-state the legacy `paused` projection needs ──
    // `config.paused` is machine-global while `manuallyDisabled` is per-repo, so the
    // projection in JolliMemoryService must tell "this repo decided" from "this repo is
    // still undecided". Collapsing undecided to `false` (what readManuallyDisabled does,
    // correctly, for its own callers) is what let the projection clear the global flag and
    // silently re-enable every repo the user had not opened yet — and, once the flag was
    // kept, what would have re-written manuallyDisabled=true on every restart and undone
    // an explicit Enable.

    @Test
    fun `readExplicitManualDisable returns true for an explicit disable`() {
        writeProfileJson("""{"manuallyDisabled":true}""")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe true
    }

    @Test
    fun `readExplicitManualDisable returns false for an explicit re-enable`() {
        // The state a successful Enable leaves behind (clearManualDisableOnSuccess).
        // Must be distinguishable from "undecided" or the projection undoes it.
        writeProfileJson("""{"manuallyDisabled":false}""")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe false
    }

    @Test
    fun `readExplicitManualDisable returns null when the field is absent`() {
        writeProfileJson("""{"backfillDismissed":true}""")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }

    @Test
    fun `readExplicitManualDisable returns null when there is no profile json`() {
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }

    @Test
    fun `readExplicitManualDisable ignores the legacy marker (it is not a profile decision)`() {
        // readManuallyDisabled falls through to this marker; the tri-state read must NOT,
        // or a legacy-marked repo would look "decided" and escape the projection.
        writeLegacyMarker()
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }

    @Test
    fun `readExplicitManualDisable returns null on malformed json rather than throwing`() {
        writeProfileJson("{not json")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }

    @Test
    fun `readExplicitManualDisable returns null when json is not an object`() {
        writeProfileJson("[]")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }

    @Test
    fun `readExplicitManualDisable returns null for an explicit json null`() {
        writeProfileJson("""{"manuallyDisabled":null}""")
        RepoProfileBridge.readExplicitManualDisable(repo.absolutePath) shouldBe null
    }
}
