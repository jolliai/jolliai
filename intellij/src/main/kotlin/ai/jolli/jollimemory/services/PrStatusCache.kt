package ai.jolli.jollimemory.services

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * TTL cache in front of the three `gh` subprocess calls made by both
 * [ai.jolli.jollimemory.toolwindow.SummaryPanel.handleCheckPrStatus] and
 * [ai.jolli.jollimemory.toolwindow.CommitsPanel.lookupBranchPr].
 *
 * Motivation: opening N committed-memory tabs on the same branch used to
 * fork the `gh` CLI up to 3×N times (isGhAvailable, isGhAuthenticated,
 * findPrForBranch) — each cold fork is 100–500 ms, and the two call sites
 * competed on the exact same query. Both now route through this cache;
 * concurrent callers dedupe by joining a shared [CompletableFuture], so
 * `gh` is spawned at most once per (cwd, branch) per TTL — even under
 * contention. The subprocess fork happens OUTSIDE any [ConcurrentHashMap]
 * bin lock (each map value is a Future — the compute() block only decides
 * "reuse existing Future vs install a new one", then whoever installed
 * runs the fork and completes the Future); this stops one slow `gh` call
 * from blocking unrelated keys that happen to hash to the same bin.
 *
 * Transient [PrService.PrLookup.LookupError]s are deliberately NOT cached
 * so a network flake doesn't stick the badge for the full 60 s window.
 *
 * Invalidation: [invalidateBranch] should be called after any surface
 * creates or updates a PR (CreatePrPanel, cli-driven pushes) so the next
 * badge read reflects reality without waiting for the TTL.
 *
 * This is UI-side caching only — the source of truth remains `gh` /
 * GitHub. Never persist entries across IDE sessions.
 */
@Service(Service.Level.PROJECT)
class PrStatusCache internal constructor(
    // Injected as constructor params so tests can pass fakes instead of
    // reaching for mockkStatic (banned per AGENTS.md JVM-globals policy).
    private val findPrFn: (String, String) -> PrService.PrLookup,
    private val ghAvailableFn: (String) -> Boolean,
    private val ghAuthFn: (String) -> Boolean,
    private val clock: () -> Long,
) {

    // IntelliJ platform instantiates project-scoped services via reflection
    // with a `(Project)` constructor — this delegates to the primary
    // constructor with the real PrService entry points and the system clock.
    // The Project reference itself isn't needed by the cache (all state is
    // keyed by cwd/branch strings), so keeping it out of the primary
    // constructor lets tests construct the cache without mocking Project —
    // which is what let PrStatusCacheTest drop @Isolated + SAME_THREAD.
    @Suppress("unused", "UNUSED_PARAMETER")
    constructor(project: Project) : this(
        PrService::findPrForBranch,
        PrService::isGhAvailable,
        PrService::isGhAuthenticated,
        System::currentTimeMillis,
    )

    private data class LookupEntry(val result: PrService.PrLookup, val expiresAt: Long)
    private data class BoolEntry(val value: Boolean, val expiresAt: Long)

    // key = "$cwd|$branch"; value is a Future so concurrent callers can join
    // the same in-flight fetch without holding any map lock.
    private val lookupCache = ConcurrentHashMap<String, CompletableFuture<LookupEntry?>>()
    // key = cwd
    private val ghAvailableCache = ConcurrentHashMap<String, CompletableFuture<BoolEntry>>()
    private val ghAuthCache = ConcurrentHashMap<String, CompletableFuture<BoolEntry>>()

    /** PR lookup TTL — PRs can change (open → merged) on GitHub any time,
     *  so keep this short. 60 s is long enough to dedupe the burst of
     *  reads that happens when the user opens or switches memory tabs,
     *  short enough that the badge doesn't feel stale. */
    private val lookupTtlMs = 60_000L

    /** gh CLI presence / auth changes rarely (user installs gh, logs in) —
     *  a 5-min TTL is plenty and eliminates the 90%+ of duplicated forks. */
    private val ghStateTtlMs = 5 * 60_000L

    /**
     * Soft cap on distinct `(cwd, branch)` entries retained in [lookupCache].
     * Expired entries are only replaced when their key is next accessed, so a
     * long IDE session on a many-branch repo would otherwise accrete one map
     * entry per branch visited forever. When the map exceeds the cap on a
     * miss, all currently-expired entries are pruned in one sweep — a warm
     * entry is never dropped because its future is still holding a valid
     * value. `(cwd)` maps stay tiny (one entry per open project root), so
     * they don't need a cap. */
    private val maxLookupEntries = 256

    /**
     * Returns the cached [PrService.PrLookup] for `(cwd, branch)`, or runs
     * [PrService.findPrForBranch] fresh if there is no entry or the entry has
     * expired. Concurrent callers dedupe by joining the same in-flight
     * [CompletableFuture] — at most one `gh` subprocess is spawned per
     * (cwd, branch) per TTL. Returns null when [PrService.findPrForBranch]
     * throws.
     *
     * Transient [PrService.PrLookup.LookupError] results are NOT cached: a
     * network flake would otherwise stick the badge for the full 60 s TTL.
     * Callers still need to have verified [isGhAvailable] and
     * [isGhAuthenticated] before calling this — findPrForBranch on an
     * unauthenticated `gh` also returns [PrService.PrLookup.LookupError],
     * which we now discard rather than cache-poisoning.
     *
     * The fork itself runs OUTSIDE the map bin lock — [ConcurrentHashMap.compute]
     * only decides "reuse the Future stored here or install a new one".
     * A slow `gh` fetch on one bin no longer stalls unrelated keys hashing
     * to the same bin.
     */
    fun getLookup(cwd: String, branch: String): PrService.PrLookup? {
        val key = "$cwd|$branch"
        val now = clock()
        val myFuture = CompletableFuture<LookupEntry?>()

        // compute() runs briefly under the bin lock, but only to decide "reuse
        // the Future already stored here vs install myFuture". Both branches
        // return quickly — no I/O.
        val chosen = lookupCache.compute(key) { _, prev ->
            if (prev != null && !isExpiredLookup(prev, now)) prev else myFuture
        }!!

        if (chosen === myFuture) {
            // We installed our own Future — do the actual fetch now, off the
            // map lock, then complete for every joiner.
            //
            // The finally block ALWAYS completes myFuture and evicts the map
            // entry when the fetch didn't produce a keepable value. It is the
            // only backstop against a joiner hanging on `chosen.get()` forever
            // when `findPrFn` throws a JVM Error (OOM, StackOverflow) — Errors
            // don't extend Exception and would otherwise skip the catch below,
            // leave myFuture uncompleted, and strand every thread that ended
            // up joining the same key.
            var entry: LookupEntry? = null
            try {
                val fresh = try {
                    findPrFn(cwd, branch)
                } catch (_: Exception) {
                    null
                }
                if (fresh != null) {
                    val ttl = if (fresh is PrService.PrLookup.LookupError) 0L else lookupTtlMs
                    entry = LookupEntry(fresh, now + ttl)
                }
            } finally {
                myFuture.complete(entry)
                // Null entry (fetch threw an Exception) OR 0-TTL LookupError:
                // both must not persist. LookupError is served to the current
                // caller so the badge still renders "unavailable", then dropped
                // so the very next call re-fetches. Null propagates as
                // getLookup returning null (contract preserved).
                if (entry == null || entry.expiresAt <= now) {
                    lookupCache.remove(key, myFuture)
                }
                if (lookupCache.size > maxLookupEntries) evictExpiredLookupEntries()
            }
        }

        return try { chosen.get()?.result } catch (_: Exception) { null }
    }

    /**
     * Sweep-based eviction: drop entries whose future has completed to an
     * expired-or-null value, keeping only entries that would still be served
     * to a caller. Called on cache miss when [lookupCache] size exceeds
     * [maxLookupEntries]. Warm entries are never evicted — if the pruning
     * sweep can't shrink the map because every entry is still valid, the
     * cap is briefly exceeded until the next miss. That's a self-limiting
     * "user is actively working on 256+ branches within one TTL window"
     * scenario, not a leak.
     */
    private fun evictExpiredLookupEntries() {
        val now = clock()
        lookupCache.entries.removeIf { (_, f) ->
            try { isExpiredLookup(f, now) } catch (_: Exception) { true }
        }
    }

    private fun isExpiredLookup(f: CompletableFuture<LookupEntry?>, now: Long): Boolean {
        if (!f.isDone) return false           // still in flight — join it
        val entry = try { f.getNow(null) } catch (_: Exception) { return true }
        return entry == null || entry.expiresAt <= now
    }

    fun isGhAvailable(cwd: String): Boolean =
        cachedBool(ghAvailableCache, cwd, ghStateTtlMs) { ghAvailableFn(cwd) }

    fun isGhAuthenticated(cwd: String): Boolean =
        cachedBool(ghAuthCache, cwd, ghStateTtlMs) { ghAuthFn(cwd) }

    private inline fun cachedBool(
        map: ConcurrentHashMap<String, CompletableFuture<BoolEntry>>,
        key: String,
        ttl: Long,
        crossinline compute: () -> Boolean,
    ): Boolean {
        val now = clock()
        val myFuture = CompletableFuture<BoolEntry>()

        val chosen = map.compute(key) { _, prev ->
            if (prev != null && !isExpiredBool(prev, now)) prev else myFuture
        }!!

        if (chosen === myFuture) {
            // Same guaranteed-completion pattern as [getLookup]: finally
            // ensures myFuture is completed even when `compute()` throws
            // a JVM Error, so joiners on `chosen.get()` never hang. Errors
            // fall through to the `false` fallback in the return below and
            // the map entry is evicted so the very next call retries.
            var entry: BoolEntry? = null
            try {
                val v = try { compute() } catch (_: Exception) { null }
                if (v != null) {
                    entry = BoolEntry(v, now + ttl)
                } else {
                    // Exception path: 0-TTL negative entry so this caller
                    // gets a "false" and the very next call re-attempts.
                    entry = BoolEntry(false, now)
                }
            } finally {
                // If a Throwable (Error) fires before we set `entry`, install
                // a 0-TTL false so joiners aren't stuck on chosen.get().
                myFuture.complete(entry ?: BoolEntry(false, now))
                if (entry == null || entry.expiresAt <= now) {
                    map.remove(key, myFuture)
                }
            }
        }

        return try { chosen.get().value } catch (_: Exception) { false }
    }

    private fun isExpiredBool(f: CompletableFuture<BoolEntry>, now: Long): Boolean {
        if (!f.isDone) return false
        val entry = try { f.getNow(null) } catch (_: Exception) { return true }
        return entry == null || entry.expiresAt <= now
    }

    /** Drop the cached lookup for one branch — call this after creating a
     *  PR, pushing new commits, or any local action that should refresh
     *  the badge immediately instead of waiting the full 60 s TTL. */
    fun invalidateBranch(cwd: String, branch: String) {
        lookupCache.remove("$cwd|$branch")
    }

    /** Nuke everything. Call on catastrophic auth changes (`gh auth logout`). */
    fun invalidateAll() {
        lookupCache.clear()
        ghAvailableCache.clear()
        ghAuthCache.clear()
    }

    companion object {
        fun getInstance(project: Project): PrStatusCache =
            project.getService(PrStatusCache::class.java)
    }
}
