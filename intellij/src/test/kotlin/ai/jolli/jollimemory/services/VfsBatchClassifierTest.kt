package ai.jolli.jollimemory.services

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Locks down [classifyVfsBatch], the per-batch routing the VFS fallback uses to
 * decide between the heavy status refresh, the cheap working-context repaint, and
 * the note-source check.
 *
 * The function exists as a pure `internal` helper precisely so these cases are
 * reachable: the listener that calls it is an anonymous [com.intellij.openapi.vfs.newvfs.BulkFileListener]
 * created inside a project-level service, so there is no seam for a unit test to
 * drive it end-to-end. The regression it guards against is a batch whose signals
 * are silently discarded because an earlier path already matched — see the
 * `mixed batch` cases, which are the ones that actually shipped broken.
 *
 * Pure string classification: no Project, no VFS, no JVM globals, so this runs
 * under the default parallel-tests policy.
 */
class VfsBatchClassifierTest {

    private val plansJson = "/repo/.jolli/jollimemory/plans.json"
    private val orphanRef = "/repo/.git/refs/heads/jollimemory/summaries/v3"
    private val workerLock = "/repo/.jolli/jollimemory/worker.lock"
    private val lock = "/repo/.jolli/jollimemory/lock"

    private fun classify(vararg paths: String) = classifyVfsBatch(
        paths = paths.toList(),
        plansJsonPath = plansJson,
        commitTimePaths = listOf(orphanRef, workerLock, lock),
    )

    @Test
    fun `plans_json alone takes the cheap working-context repaint`() {
        val outcome = classify(plansJson)
        outcome.workingContextRefresh shouldBe true
        outcome.statusRefresh shouldBe false
        outcome.savedMarkdown.shouldContainExactly()
    }

    @Test
    fun `each commit-time path alone takes the status refresh`() {
        for (path in listOf(orphanRef, workerLock, lock)) {
            val outcome = classify(path)
            outcome.statusRefresh shouldBe true
            outcome.workingContextRefresh shouldBe false
        }
    }

    // The regression. A StopHook plans.json write and a post-commit orphan-ref
    // write routinely merge into one VFS batch, and plans.json sorting first used
    // to end the loop — so the status refresh was never scheduled at all and the
    // new memory never appeared. Order must not decide the outcome.
    @Test
    fun `mixed batch with plans_json first still escalates to a status refresh`() {
        val outcome = classify(plansJson, orphanRef)
        outcome.statusRefresh shouldBe true
        outcome.workingContextRefresh shouldBe true
    }

    @Test
    fun `mixed batch is order-independent`() {
        classify(orphanRef, plansJson) shouldBe classify(plansJson, orphanRef)
    }

    // Same failure mode, second victim: a note's source file saved behind a
    // matched control file was dropped, so the CONTEXT list never reordered.
    @Test
    fun `markdown saved behind a matched control file is still collected`() {
        val note = "/home/u/notes/design.md"
        classify(plansJson, note).savedMarkdown.shouldContainExactly(note)
        classify(orphanRef, note).savedMarkdown.shouldContainExactly(note)
    }

    @Test
    fun `all three outcomes can come from one batch`() {
        val note = "/home/u/notes/design.md"
        val outcome = classify(plansJson, orphanRef, note)
        outcome.statusRefresh shouldBe true
        outcome.workingContextRefresh shouldBe true
        outcome.savedMarkdown.shouldContainExactly(note)
    }

    @Test
    fun `every markdown path in the batch is collected, in order`() {
        val a = "/home/u/a.md"
        val b = "/home/u/b.MD"
        classify(a, plansJson, b).savedMarkdown.shouldContainExactly(a, b)
    }

    @Test
    fun `markdown extension is matched ignoring case`() {
        classify("/home/u/NOTE.MD").savedMarkdown.shouldContainExactly("/home/u/NOTE.MD")
    }

    @Test
    fun `unrelated paths trigger nothing`() {
        val outcome = classify("/repo/src/Main.kt", "/repo/.jolli/jollimemory/debug.log")
        outcome.statusRefresh shouldBe false
        outcome.workingContextRefresh shouldBe false
        outcome.savedMarkdown.shouldContainExactly()
    }

    @Test
    fun `an empty batch triggers nothing`() {
        classify() shouldBe VfsBatchOutcome(
            statusRefresh = false,
            workingContextRefresh = false,
            savedMarkdown = emptyList(),
        )
    }

    // A watched dir that did not exist at startup leaves its path null. A null
    // must never match — before the extraction this fell out of Kotlin's
    // `String == null` being false, so it stays pinned.
    @Test
    fun `a null plans_json path matches nothing`() {
        val outcome = classifyVfsBatch(
            paths = listOf(plansJson, orphanRef),
            plansJsonPath = null,
            commitTimePaths = listOf(orphanRef),
        )
        outcome.workingContextRefresh shouldBe false
        outcome.statusRefresh shouldBe true
    }

    @Test
    fun `no commit-time paths registered means no status refresh`() {
        val outcome = classifyVfsBatch(
            paths = listOf(orphanRef, plansJson),
            plansJsonPath = plansJson,
            commitTimePaths = emptyList(),
        )
        outcome.statusRefresh shouldBe false
        outcome.workingContextRefresh shouldBe true
    }
}
