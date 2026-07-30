package ai.jolli.jollimemory.services

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Locks down TTL + invalidation + LookupError semantics for the project-scoped
 * PR badge cache. The primary constructor takes no Project (the platform-facing
 * secondary constructor does, but the cache never dereferences it), so tests
 * build the cache directly without needing to mock IntelliJ platform types.
 * That means this class runs under the default parallel-tests policy — no
 * @Isolated, no mockk statics, no SAME_THREAD ceremony.
 */
class PrStatusCacheTest {

    private fun sampleFound(number: Int) = PrService.PrLookup.Found(
        pr = PrService.PrInfo(number = number, url = "https://x/$number", title = "t", body = "b"),
        history = emptyList(),
    )

    // Advance-able clock so we can push time forward across the 60 s TTL boundary
    // without wall-clock sleeps.
    private class FakeClock(var nowMs: Long = 0L) : () -> Long {
        override fun invoke(): Long = nowMs
        fun advance(ms: Long) { nowMs += ms }
    }

    private fun buildCache(
        find: (String, String) -> PrService.PrLookup = { _, _ -> sampleFound(1) },
        ghAvailable: (String) -> Boolean = { true },
        ghAuth: (String) -> Boolean = { true },
        clock: FakeClock = FakeClock(),
    ): PrStatusCache = PrStatusCache(
        findPrFn = find,
        ghAvailableFn = ghAvailable,
        ghAuthFn = ghAuth,
        clock = clock,
    )

    // ── getLookup ────────────────────────────────────────────────────────

    @Test
    fun `getLookup dedupes within the TTL and refetches after it expires`() {
        val calls = AtomicInteger(0)
        val clock = FakeClock()
        val cache = buildCache(
            find = { _, _ -> calls.incrementAndGet(); sampleFound(42) },
            clock = clock,
        )

        cache.getLookup("/repo", "feat")
        cache.getLookup("/repo", "feat")
        cache.getLookup("/repo", "feat")
        calls.get() shouldBe 1

        clock.advance(30_000)  // still within 60 s TTL
        cache.getLookup("/repo", "feat")
        calls.get() shouldBe 1

        clock.advance(31_000)  // now past 60 s
        cache.getLookup("/repo", "feat")
        calls.get() shouldBe 2
    }

    @Test
    fun `getLookup returns null when the underlying call throws`() {
        val cache = buildCache(find = { _, _ -> throw RuntimeException("gh crashed") })
        cache.getLookup("/repo", "feat").shouldBeNull()
    }

    @Test
    fun `getLookup does NOT cache LookupError so a transient failure recovers on next call`() {
        val calls = AtomicInteger(0)
        val results: List<PrService.PrLookup> = listOf(
            PrService.PrLookup.LookupError("network flake"),
            PrService.PrLookup.LookupError("still flaking"),
            sampleFound(7),
        )
        val cache = buildCache(
            find = { _, _ ->
                val i = calls.getAndIncrement()
                results[i]
            },
        )

        // Every call must fall through to the fetcher until we get a non-error.
        val first = cache.getLookup("/repo", "feat")
        (first is PrService.PrLookup.LookupError) shouldBe true

        val second = cache.getLookup("/repo", "feat")
        (second is PrService.PrLookup.LookupError) shouldBe true

        val third = cache.getLookup("/repo", "feat")
        third shouldBe sampleFound(7)

        // …and once we DO get a success, it's cached (no re-fetch).
        cache.getLookup("/repo", "feat") shouldBe sampleFound(7)
        calls.get() shouldBe 3
    }

    @Test
    fun `invalidateBranch drops the cached entry so the next getLookup re-fetches`() {
        val calls = AtomicInteger(0)
        val cache = buildCache(
            find = { _, _ -> calls.incrementAndGet(); sampleFound(1) },
        )
        cache.getLookup("/repo", "feat")
        cache.getLookup("/repo", "feat")
        calls.get() shouldBe 1

        cache.invalidateBranch("/repo", "feat")

        cache.getLookup("/repo", "feat")
        calls.get() shouldBe 2

        // Invalidation is per-(cwd,branch) — other branches survive.
        cache.getLookup("/repo", "other")
        cache.invalidateBranch("/repo", "feat")
        cache.getLookup("/repo", "other")
        calls.get() shouldBe 3   // "other" only fetched once
    }

    @Test
    fun `invalidateAll drops every cache line`() {
        val findCalls = AtomicInteger(0)
        val ghAvailCalls = AtomicInteger(0)
        val cache = buildCache(
            find = { _, _ -> findCalls.incrementAndGet(); sampleFound(1) },
            ghAvailable = { ghAvailCalls.incrementAndGet(); true },
        )
        cache.getLookup("/repo", "feat")
        cache.isGhAvailable("/repo")
        cache.invalidateAll()
        cache.getLookup("/repo", "feat")
        cache.isGhAvailable("/repo")

        findCalls.get() shouldBe 2
        ghAvailCalls.get() shouldBe 2
    }

    // ── isGhAvailable / isGhAuthenticated ────────────────────────────────

    @Test
    fun `isGhAvailable dedupes for 5 minutes then refetches`() {
        val calls = AtomicInteger(0)
        val clock = FakeClock()
        val cache = buildCache(
            ghAvailable = { calls.incrementAndGet(); true },
            clock = clock,
        )

        cache.isGhAvailable("/repo") shouldBe true
        cache.isGhAvailable("/repo") shouldBe true
        calls.get() shouldBe 1

        clock.advance(4 * 60_000)  // 4 min, still fresh
        cache.isGhAvailable("/repo") shouldBe true
        calls.get() shouldBe 1

        clock.advance(2 * 60_000)  // 6 min total, past 5 min TTL
        cache.isGhAvailable("/repo") shouldBe true
        calls.get() shouldBe 2
    }

    @Test
    fun `isGhAuthenticated caches false as well as true so a logged-out gh stops re-forking`() {
        val calls = AtomicInteger(0)
        val cache = buildCache(
            ghAuth = { calls.incrementAndGet(); false },
        )
        cache.isGhAuthenticated("/repo") shouldBe false
        cache.isGhAuthenticated("/repo") shouldBe false
        cache.isGhAuthenticated("/repo") shouldBe false
        calls.get() shouldBe 1
    }

    @Test
    fun `cachedBool falls back to false when the underlying compute throws`() {
        val cache = buildCache(ghAvailable = { throw RuntimeException("boom") })
        cache.isGhAvailable("/repo") shouldBe false
    }

    @Test
    fun `cachedBool does NOT cache exception-driven false so recovery is immediate`() {
        // Same shape as the LookupError policy for getLookup: a thrown compute
        // gets a 0-TTL entry, so once the underlying command recovers, the very
        // next call reflects reality instead of sticking "unavailable" for the
        // full 5 min TTL.
        val calls = AtomicInteger(0)
        val results: List<() -> Boolean> = listOf(
            { throw RuntimeException("gh binary temporarily missing") },
            { throw RuntimeException("still transient") },
            { true },
        )
        val cache = buildCache(
            ghAvailable = {
                val i = calls.getAndIncrement()
                results[i]()
            },
        )

        // Two consecutive throwing calls both return false but neither poisons
        // the cache; the third (recovering) call actually reaches compute() and
        // returns true.
        cache.isGhAvailable("/repo") shouldBe false
        cache.isGhAvailable("/repo") shouldBe false
        cache.isGhAvailable("/repo") shouldBe true
        // …once compute returned true, the entry is cached for the full TTL.
        cache.isGhAvailable("/repo") shouldBe true
        calls.get() shouldBe 3
    }
}
