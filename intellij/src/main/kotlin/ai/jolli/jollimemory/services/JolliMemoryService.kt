package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.bridge.ConversationBrief
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.HookInstaller
import ai.jolli.jollimemory.bridge.SummaryReader
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.HookEnv
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.RefreshEscalator
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StatusInfo
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.sync.CliSyncOrchestrator
import ai.jolli.jollimemory.sync.STATUS_AUTO_CLEAR_DELAY_MS
import ai.jolli.jollimemory.sync.SyncState
import ai.jolli.jollimemory.sync.SyncStatusBarWidget
import ai.jolli.jollimemory.sync.SyncStatusDetail
import ai.jolli.jollimemory.sync.autoClearableSyncState
import ai.jolli.jollimemory.toolwindow.PanelRegistry
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.concurrency.AppExecutorUtil
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.withLock
import javax.swing.Timer

/**
 * Project-level service managing JolliMemory state.
 *
 * Read paths (storage, session data, per-source discovery, sync) route
 * through the bundled CLI's `jolli ide-bridge` command, so a working Node.js
 * runtime is required — see [ai.jolli.jollimemory.bridge.NodeRuntime].
 */
@Service(Service.Level.PROJECT)
class JolliMemoryService(private val project: Project) : Disposable {

    private val log = Logger.getInstance(JolliMemoryService::class.java)
    private var git: GitOps? = null
    private var installer: HookInstaller? = null
    // Written once by initialize() on a pool thread; read from EDT (SummaryPanel
    // hovers), other pool threads (refreshFolderReader, hook status refresh) and
    // Task.Backgroundable actions. Executor happens-before covers the common case,
    // but the @Volatile matches the convention used for cachedStatus/workerBusy/
    // installProtectionUntil below and documents cross-thread intent.
    @Volatile
    private var reader: SummaryReader? = null
    @Volatile
    private var cachedStatus: StatusInfo? = null
    /**
     * Cached `manuallyDisabled` opt-out (repo-wide, anchored to the main worktree via
     * [ai.jolli.jollimemory.core.RepoProfileBridge]). Refreshed by [refreshStatus] on
     * the same fan-out as [cachedStatus] — startup, GIT_REPO_CHANGE, VFS events on
     * `profile.json`, daemon `refresh` pushes — so cross-window / terminal writes
     * become visible without a tool-window rebuild. Read on the EDT via
     * [isManuallyDisabled] by the tool window's status listener. */
    @Volatile
    private var manuallyDisabledCached: Boolean = false
    /** Cached worker-busy flag. Read synchronously by AnAction.update() so the EDT
     *  never blocks on a node-bridge call. Refreshed by refreshStatus() and by the
     *  NIO watcher on worker.lock create/delete events. Mirrors VS Code's
     *  StatusStore.workerBusy: source of truth is the on-disk worker.lock, this is
     *  the pushed-in-memory view actions read. Click-time paths still re-check the
     *  authoritative SessionTracker.isWorkerBusy() to close the update-latency window. */
    @Volatile
    private var workerBusyCached: Boolean = false
    /** Timestamp until which refreshStatus() should not downgrade enabled→disabled.
     *  Set after install() to prevent GIT_REPO_CHANGE from flapping the status. */
    @Volatile
    private var installProtectionUntil: Long = 0L
    /**
     * The resolved main repo root (handles worktrees). Written on the initialize
     * pool thread; read from many surfaces (EDT + pool) including
     * [refreshFolderReader], hook-driven callers, and `getStatus` consumers. Kept
     * @Volatile so late readers see the assignment without relying on executor
     * happens-before, and to match the convention on the other cross-thread fields
     * in this class.
     */
    @Volatile
    var mainRepoRoot: String? = null
        private set
    var lastError: String? = null
        private set
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    /**
     * @Volatile because the debounce timer is scheduled from the VFS listener
     * thread and stopped from the disposer/EDT — the reference must publish safely.
     */
    @Volatile
    private var orphanRefDebounceTimer: Timer? = null

    /**
     * Tracks whether the window [orphanRefDebounceTimer] is currently timing has
     * seen a commit-time file (orphan ref / lock / profile.json / worker.lock) and
     * therefore owes a full status recompute.
     *
     * The stickiness rule lives in [RefreshEscalator] rather than in a field here,
     * because the daemon push channel needs the identical rule and the two used to
     * be hand-copied — see that class. Recorded from the VFS listener thread,
     * drained by the Swing timer on the EDT; the type is safe for both.
     */
    private val refreshEscalator = RefreshEscalator()

    /**
     * Separate from [orphanRefDebounceTimer] on purpose: a `.md` save and a
     * plans.json write are independent events, and sharing one timer would let a
     * burst of markdown saves keep cancelling a pending state refresh (or the
     * reverse). Same @Volatile rationale.
     */
    @Volatile
    private var noteSourceDebounceTimer: Timer? = null

    /**
     * Markdown paths saved since the last note-source check settled.
     *
     * Accumulated rather than replaced per burst: the VFS delivers a save as its
     * own event batch, so two saves 100 ms apart arrive as two calls into
     * [scheduleNoteSourceCheck], and overwriting would drop the first one's paths
     * along with the reorder it should have triggered. Guarded by its own monitor
     * — the VFS listener thread fills it, the pooled check drains it.
     */
    private val pendingMarkdownSaves = mutableSetOf<String>()
    /**
     * Watch-root tokens returned by [LocalFileSystem.addRootsToWatch]. Kept so
     * we can hand them back on [dispose] via `removeWatchedRoots`.
     */
    @Volatile
    private var vfsWatchRequests: Set<LocalFileSystem.WatchRequest> = emptySet()
    /**
     * Set true at the very start of [dispose] so any late-arriving VFS_CHANGES
     * batch (already in-flight when disposal begins) does not schedule a new
     * debounce timer against a released service.
     */
    @Volatile
    private var disposed = false

    // ── Sync orchestrator ────────────────────────────────────────────────
    private var orchestrator: CliSyncOrchestrator? = null
    private val lastSyncSuccessAtMs = AtomicLong(0)
    @Volatile
    private var syncState: SyncState? = null
    @Volatile
    private var syncDetail: SyncStatusDetail? = null
    /** Bumped on every sync-state change so a pending auto-clear can detect that
     *  a newer state arrived and skip clobbering it. */
    private val syncStateGen = AtomicLong(0)
    /** Listeners notified (on the EDT) whenever the sync state changes. Lets the
     *  KB explorer toolbar mirror the status-bar widget's progress/error feedback. */
    private val syncListeners = CopyOnWriteArrayList<(SyncState, SyncStatusDetail?) -> Unit>()

    /** Registry of panel references for action lookup (set by JolliMemoryToolWindowFactory). */
    var panelRegistry: PanelRegistry? = null

    /**
     * Adds a status listener. If the service is already initialized (has cached status),
     * the listener is immediately invoked so late-registering panels receive the current state.
     */
    fun addStatusListener(listener: () -> Unit) {
        listeners.add(listener)
        if (cachedStatus != null) {
            listener()
        }
    }
    fun removeStatusListener(listener: () -> Unit) { listeners.remove(listener) }
    private fun notifyListeners() { listeners.forEach { it() } }

    /**
     * Listeners notified when working-area context moves — a plan, note or reference
     * added, removed or edited. Kept separate from the status listeners because that
     * list is fourteen subscribers wide and most of them answer a different question:
     * [CommitsPanel] re-runs a full round of `rev-parse` + `merge-base` + `log` +
     * per-commit orphan-branch reads, [ActiveConversationsPanel] re-aggregates every
     * transcript source's SQLite, and the Memory Bank explorer rebuilds its tree —
     * none of which can have a different answer because `plans.json` changed.
     *
     * Only the two surfaces that actually read working-area context subscribe: the
     * CONTEXT list and the Working Memory review. [PinnedPanel] deliberately does
     * NOT — it renders from `pins.json`, whose titles are snapshotted at pin time,
     * so no working-context event can change what it paints.
     *
     * A panel may be on BOTH lists — [PlansPanel] is, because it also has to react
     * to enabled/disabled status. That is not a double-refresh: [refreshStatus]
     * fires only the status list and [refreshWorkingContext] only this one, so a
     * given event reaches each panel exactly once.
     *
     * **Which makes membership of BOTH lists an obligation, not a convenience.**
     * The two refreshes are strictly either/or — [scheduleDebouncedRefresh] picks
     * one, and [refreshStatus] deliberately does not fan out to this list — so
     * [refreshStatus] is NOT a superset of [refreshWorkingContext]. A subscriber
     * here that is not also on the status list is therefore skipped entirely by
     * any batch that escalated to a status recompute, which is exactly the batch a
     * committing agent produces (`plans.json` and the orphan ref land together).
     * Both current subscribers happen to be on both lists, so there is no symptom
     * today; a working-context-only panel would silently miss those updates. Add
     * such a panel to [addStatusListener] as well, or teach [refreshStatus] to
     * call [notifyWorkingContextListeners] — but note the latter would double-fire
     * every panel that is already on both, which is why it is not done here.
     *
     * So the asymmetry is KNOWN and deliberately left standing — not a review
     * finding. Making [refreshStatus] a true superset would regress the two panels
     * that sit on both lists into a double reload per event, and the structural
     * alternative (take working-context subscribers off the status list and gate
     * them some other way) is a refactor of how fourteen subscribers are wired.
     * Both are out of scope here; the invariant above is the contract in the
     * meantime, and it is currently satisfied.
     */
    private val workingContextListeners = CopyOnWriteArrayList<() -> Unit>()

    /** @see workingContextListeners — no immediate invoke; subscribers load on their own init. */
    fun addWorkingContextListener(listener: () -> Unit) { workingContextListeners.add(listener) }
    fun removeWorkingContextListener(listener: () -> Unit) { workingContextListeners.remove(listener) }
    private fun notifyWorkingContextListeners() { workingContextListeners.forEach { it() } }

    /**
     * Listeners notified whenever a commit-selection toggle changes — a conversation
     * or context checkbox ([CommitSelectionStore]) or an in-memory file selection in
     * [ChangesPanel]. Kept separate from the status listeners so toggling a checkbox
     * can refresh the open Working Memory review without forcing the sidebar panels to
     * rebuild (which would, for files, reset their in-memory selection).
     */
    private val selectionListeners = CopyOnWriteArrayList<() -> Unit>()
    fun addSelectionListener(listener: () -> Unit) { selectionListeners.add(listener) }
    fun removeSelectionListener(listener: () -> Unit) { selectionListeners.remove(listener) }
    fun notifySelectionChanged() { selectionListeners.forEach { it() } }

    /**
     * Listeners notified when a commit memory's PR or Jolli-share state changes — a PR
     * created/updated for the branch, or a memory shared to the Jolli site. All surfaces
     * that show those two states (the Commits list, an open memory summary, the Create PR
     * view) subscribe so they re-read the shared truth — the branch PR
     * ([ai.jolli.jollimemory.services.PrService.findPrForBranch]) and each summary's
     * `jolliDocUrl`/`jolliDocId` — and never disagree. Since GitHub has one PR per branch,
     * creating it from any surface must update them all.
     */
    private val memoryStateListeners = CopyOnWriteArrayList<() -> Unit>()
    fun addMemoryStateListener(listener: () -> Unit) { memoryStateListeners.add(listener) }
    fun removeMemoryStateListener(listener: () -> Unit) { memoryStateListeners.remove(listener) }
    fun notifyMemoryStateChanged() {
        // Any surface that changed a committed memory (topic edit, e2e regen,
        // squash, PR creation, branch backfill, orphan-branch update from
        // outside) fires this. Wipe the summary cache — the shape of "which
        // hashes are affected" is not always knowable from the call site, and
        // over-invalidation is cheap (next read repopulates lazily).
        invalidateSummaryCache()
        memoryStateListeners.forEach { it() }
    }

    /**
     * Wipes the [getSummary] LRU without firing memory-state listeners.
     * Use this from in-panel edit handlers (topic / e2e / recap / plan /
     * reference edits in [ai.jolli.jollimemory.toolwindow.SummaryPanel]) so
     * a subsequent cross-surface reopen — via CommitsPanel, MemoriesPanel,
     * PinnedPanel, ActionBarPanel, ViewSummaryAction, [CreatePrData.build] —
     * reads the just-persisted content instead of the pre-edit snapshot.
     *
     * Not routed through [notifyMemoryStateChanged] because those panels
     * already update themselves locally (patch acks + refreshHtml) — a
     * full listener refresh would clobber their patch with a redundant
     * full reload and flash the tab. Alias-aware by construction (clear
     * removes both the raw and root-hash entries in one shot; a targeted
     * per-hash remove would leave the alias sibling stale).
     */
    fun invalidateSummaryCache() {
        summaryCache.clear()
    }

    // ── Summary in-memory LRU ────────────────────────────────────────────
    // Reads on the orphan branch cost a `git show` fork (100-200 ms cold);
    // this cache eliminates repeated forks for the same hash across the
    // three read paths (commits-list hover-expand, viewSummary tab open,
    // memory-state refresh). Aligns with the effect VS Code gets for free
    // via FolderStorage.readFileSync + OS page cache; Stage 3.1 adds the
    // Kotlin folder reader for even tighter parity.
    private val summaryCache: MutableMap<String, CommitSummary> =
        java.util.Collections.synchronizedMap(
            object : LinkedHashMap<String, CommitSummary>(128, 0.75f, /*accessOrder=*/true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CommitSummary>) =
                    size > 128
            }
        )

    // ── Back-fill cold-start signals ─────────────────────────────────────
    // Mirrors the VS Code extension's `computeColdStartSignals()` /
    // `currentColdStartVariant` host state (vscode/src/Extension.ts). Drives the
    // "build memory from your history" card in the tool window. Computed off-EDT
    // by [computeColdStartSignals] via the `jolli backfill --list-candidates`
    // subprocess (no LLM). The card is visible only when
    // `coldStartVariant != null && !backfillDismissed`.
    /** "empty" (repo has zero memories) | "gaps" (recent own commits lack one) | null. */
    @Volatile
    var coldStartVariant: String? = null
        private set

    /** Count of recent (last month, capped) own commits lacking a summary — card copy. */
    @Volatile
    var recentMissingCount: Int = 0
        private set

    /** Whether the user permanently dismissed the card for this repo. */
    @Volatile
    var backfillDismissed: Boolean = false
        private set

    private val backfillListeners = CopyOnWriteArrayList<() -> Unit>()

    /** Notified (invoke on the EDT) when cold-start signals or the dismiss flag change. */
    fun addBackfillListener(listener: () -> Unit) {
        backfillListeners.add(listener)
        if (isInitialized) listener()
    }
    fun removeBackfillListener(listener: () -> Unit) { backfillListeners.remove(listener) }
    private fun notifyBackfillListeners() { backfillListeners.forEach { it() } }

    private fun backfillCwd(): String? = mainRepoRoot ?: project.basePath

    /**
     * Resolves cold-start signals for the card. Best-effort and atomic: on any failure
     * the prior snapshot is left intact (never a mixed state). Safe to call off the EDT —
     * it shells out to the CLI. Same window/cap as VS Code (30 days, top 10).
     */
    fun computeColdStartSignals() {
        val cwd = backfillCwd() ?: return
        when (val r = ai.jolli.jollimemory.backfill.BackfillCli.listCandidates(cwd, sinceDays = 30, limit = 10)) {
            is ai.jolli.jollimemory.backfill.BackfillCli.Outcome.Ok -> {
                val s = r.value
                coldStartVariant = when {
                    !s.hasAnyMemory -> "empty"
                    s.candidates.isNotEmpty() -> "gaps"
                    else -> null
                }
                recentMissingCount = s.candidates.size
                backfillDismissed = ai.jolli.jollimemory.backfill.BackfillDismissFlag.isDismissed(cwd)
                notifyBackfillListeners()
            }
            else -> {
                log.info("Back-fill cold-start signals unavailable (${r::class.simpleName}); keeping prior snapshot")
            }
        }
    }

    /** True when the tool-window card should be shown. */
    fun shouldShowBackfillCard(): Boolean = coldStartVariant != null && !backfillDismissed

    /** Records the user's sticky repo-wide dismissal. Idempotent. */
    fun dismissBackfillCard() {
        val cwd = backfillCwd() ?: return
        backfillDismissed = true
        ai.jolli.jollimemory.backfill.BackfillDismissFlag.setDismissed(cwd, true)
        notifyBackfillListeners()
    }

    /**
     * Post-back-fill bookkeeping shared by both entry points (card + Settings). Completing
     * generation clears the cold-start snapshot but preserves an explicit dismissal.
     */
    fun onBackfillCompleted(generatedAny: Boolean) {
        if (generatedAny) {
            coldStartVariant = null
            recentMissingCount = 0
        }
        notifyBackfillListeners()
    }

    /**
     * Adds a sync-state listener. If a sync state has already been observed,
     * the listener is invoked immediately with it so late-registering panels
     * reflect the current state.
     */
    fun addSyncStateListener(listener: (SyncState, SyncStatusDetail?) -> Unit) {
        syncListeners.add(listener)
        val s = syncState
        if (s != null) listener(s, syncDetail)
    }
    fun removeSyncStateListener(listener: (SyncState, SyncStatusDetail?) -> Unit) { syncListeners.remove(listener) }

    /** Debug log of initialization steps. */
    var initLog: String = ""
        private set

    @Volatile
    var isInitialized: Boolean = false
        private set

    /**
     * Set to `true` when a previously available `.git` directory is no longer found.
     * The tool window factory observes this via status listeners to switch back
     * to the "no Git" placeholder.
     */
    @Volatile
    var gitRemoved: Boolean = false
        private set

    /**
     * Set to `true` when [initialize] was blocked because no usable Node.js runtime
     * was found. While set, NOTHING was initialized (no hooks, no KB folder, no
     * watchers) — the tool window shows a blocking "Node.js required" panel instead
     * of the full UI. Cleared by a successful [initialize] after Node is detected.
     */
    @Volatile
    var nodeMissing: Boolean = false
        private set

    /**
     * Serializes every Memory Bank migration run (startup auto-migrate,
     * Settings-save catch-up, the "Migrate to Memory Bank" rebuild, Reset
     * migration). VS Code parity: its `kbInitChain` exists for the same
     * reason — the migration steps do unlocked read-modify-write on
     * manifest.json / migration.json / index.json, so two concurrent runs
     * would race.
     */
    private val migrationLock = java.util.concurrent.locks.ReentrantLock()

    /**
     * Released when this session's startup migration attempt settles (success,
     * failure, or never dispatched — [initialize] counts it down on every
     * early-return path too). The first sync round waits on it, bounded, so
     * sync never classifies/pushes half-written migration output. Mirrors VS
     * Code's `kbInitPromise` gate plus its 60s watchdog.
     */
    val migrationGate = java.util.concurrent.CountDownLatch(1)

    /**
     * Resets initialization state so [initialize] can run again.
     * Called when `.git` reappears after being removed (e.g., user ran `git init`
     * after previously deleting the repo).
     */
    fun resetForReinitialization() {
        gitRemoved = false
        isInitialized = false
    }

    /**
     * Runs [action] under the migration serialization lock. Exposed so the
     * "Migrate to Memory Bank" rebuild and Reset migration — which do more
     * than just the CLI call (archive pile, migration-state reset) — still
     * serialize against background migrations.
     */
    fun <T> withMigrationLock(action: () -> T): T = migrationLock.withLock(action)

    /**
     * Fire-and-forget orphan-branch → Memory Bank folder migration on a
     * pooled thread — parity with VS Code's silent `initializeKB()` run:
     * no progress UI, and the caller (startup, Settings save) is never
     * blocked even when a full first-install migration takes minutes.
     * Concurrent kicks serialize through [migrationLock].
     *
     * [onSettled] fires on the pooled thread AFTER the CLI call settles —
     * whether it succeeded or threw. On success the callback receives the
     * [CliIntegrations.MigrationBridgeResult]; on failure it receives
     * `null` so callers can still run their post-migration refresh (VS
     * Code parity: even a failed migration needs [refreshFolderReader] to
     * pick up whatever the folder holds from a prior settled run, or the
     * next session-wide read keeps forking `git show` needlessly). Pass
     * `null` for [onSettled] when you only need the fire-and-forget side
     * effect. A thrown error inside the callback only logs — like VS
     * Code, the next startup / Settings save retries the migration
     * itself. [migrationGate] counts down either way so the sync first-
     * round wait can never hang.
     */
    fun migrateMemoryBankAsync(onSettled: ((CliIntegrations.MigrationBridgeResult?) -> Unit)? = null) {
        val root = mainRepoRoot ?: project.basePath
        if (root.isNullOrBlank()) {
            migrationGate.countDown()
            return
        }
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            var result: CliIntegrations.MigrationBridgeResult? = null
            try {
                result = migrationLock.withLock {
                    CliIntegrations.migrateMemoryBank(root).also {
                        log.info("Memory Bank migration: ${it.status} (${it.migratedEntries}/${it.totalEntries})")
                    }
                }
            } catch (e: Exception) {
                log.warn("Memory Bank migration failed (silent; retried on next startup/Settings save): ${e.message}")
            } finally {
                try {
                    onSettled?.invoke(result)
                } catch (e: Exception) {
                    log.warn("Post-migration callback failed (non-fatal): ${e.message}")
                }
                migrationGate.countDown()
            }
        }
    }

    /**
     * Thread-safe append to [initLog] from off-[initialize] callers (namely
     * the async migration completion). [initialize] builds [initLog] in a
     * local [StringBuilder] then flips it in one assignment; if an async
     * append lands BEFORE that assignment, the assignment wins and the
     * appended line is lost. That race is only a diagnostic-log gap — the
     * settled migration status is also written to `log.info` above — and
     * the alternative (blocking the async thread on an initialize-done
     * latch) risks hangs for a benefit no user ever sees.
     */
    @Synchronized
    private fun appendInitLog(line: String) {
        if (line.isEmpty()) return
        val prefix = if (initLog.isEmpty() || initLog.endsWith("\n")) "" else "\n"
        initLog = initLog + prefix + line + "\n"
    }

    /**
     * Re-attach the folder reader against the CURRENT `config.localFolder`
     * + `config.storageMode`. Call after Settings persists a change to either —
     * without this, the reader keeps pointing at the previous Memory Bank
     * directory (so summaries/plans/notes are read from a stale folder) or keeps
     * serving folder JSON after storageMode flips to "orphan". Passing null is a
     * valid outcome (folder isn't populated, or storageMode="orphan") — the
     * SummaryReader falls back to orphan-branch reads for the rest of the session.
     *
     * THREADING: does file I/O (SessionTracker.loadConfig, KBPathResolver.resolve,
     * FolderStorageReader.forRoot → File.isDirectory). Must NOT be called on the
     * EDT. Current callers: SettingsDialog's Task.Backgroundable, initialize() on
     * a pool thread, and the async migration completion callback (pooled).
     */
    fun refreshFolderReader() {
        val root = mainRepoRoot ?: project.basePath ?: return
        val r = reader ?: return
        try {
            val repoName = KBPathResolver.extractRepoName(root)
            val remoteUrl = KBPathResolver.getRemoteUrl(root)
            val config = SessionTracker.loadConfig()
            val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.localFolder)
            val folderReader = ai.jolli.jollimemory.bridge.FolderStorageReader.forRoot(kbRoot.toString(), config.storageMode)
            r.attachFolder(folderReader)
        } catch (e: Exception) {
            // Best effort — a failed re-attach just leaves the previous reader in
            // place, and read paths still fall back to the orphan branch.
            log.warn("refreshFolderReader failed: ${e.message}")
        }
    }

    fun initialize() {
        if (isInitialized) return
        val sb = StringBuilder()
        val basePath = project.basePath
        sb.appendLine("basePath=$basePath")

        if (basePath == null) {
            lastError = "Project has no base path"
            initLog = sb.toString()
            migrationGate.countDown()
            return
        }

        // Hard gate: a usable Node.js runtime is REQUIRED. When absent, initialization
        // stops here — no hooks, no KB folder, no watchers, no sync. The startup
        // activity and the tool window surface a blocking "Node.js required" panel
        // with a Retry that re-runs detection and then this method. Blocking probe,
        // but cheap after the first detection (in-process + node-info.json cache).
        val nodeMissingProbe = ai.jolli.jollimemory.bridge.NodeRuntime.detect() == null
        if (nodeMissingProbe) {
            nodeMissing = true
            lastError = "Node.js not found — Jolli Memory is blocked until it is installed"
            sb.appendLine("BLOCKED: no usable Node.js runtime found")
            initLog = sb.toString()
            log.warn("Initialize blocked: no usable Node.js runtime")
            migrationGate.countDown()
            return
        }
        nodeMissing = false

        // migrationGate contract: it MUST count down exactly once per initialize
        // call so JolliMemoryStartupActivity's bounded first-round sync wait
        // (60 s ceiling) can't hang. The two early returns above already fire
        // it; from here down, the async migrateMemoryBankAsync counts it down
        // when dispatched, so this finally only needs to catch paths that
        // throw BEFORE the dispatch — resolveWorktreeRoot(),
        // installer!!.getDebugInfo(), or anything in between. A redundant
        // countDown() on a latch already at zero is a no-op, so the guard is a
        // simple "did we dispatch?" flag.
        var migrationDispatched = false
        try {
            // Check .git entry
            val gitEntry = java.io.File(basePath, ".git")
            sb.appendLine(".git exists=${gitEntry.exists()}, isFile=${gitEntry.isFile}, isDir=${gitEntry.isDirectory}")
            if (gitEntry.isFile) {
                sb.appendLine(".git content=${gitEntry.readText().trim()}")
            }

            val gitOps = GitOps(basePath)
            val resolvedRoot = gitOps.resolveWorktreeRoot() ?: basePath
            mainRepoRoot = resolvedRoot
            JmLogger.setLogDir(resolvedRoot)
            sb.appendLine("resolvedRoot=$resolvedRoot")

            // Check key files in resolved root
            val claudeFile = java.io.File(resolvedRoot, ".claude/settings.local.json")
            sb.appendLine("claudeSettings=${claudeFile.absolutePath} exists=${claudeFile.exists()}")
            val sessionsFile = java.io.File(resolvedRoot, ".jolli/jollimemory/sessions.json")
            sb.appendLine("sessions=${sessionsFile.absolutePath} exists=${sessionsFile.exists()}")
            val configFile = java.io.File(resolvedRoot, ".jolli/jollimemory/config.json")
            sb.appendLine("config=${configFile.absolutePath} exists=${configFile.exists()}")

            git = gitOps
            installer = HookInstaller(basePath, resolvedRoot)
            // SummaryReader.getStatus forwards its dir to `jolli ide-bridge status`,
            // which the CLI treats as worktree-local (reads Claude/Gemini hook
            // configs, sessions.json, source detectors from that exact directory).
            // Pass the CURRENT worktree (basePath) so linked worktrees report their
            // own hook state — passing resolvedRoot here made every linked checkout
            // read the main worktree's hooks and skip startup self-heal.
            reader = SummaryReader(basePath, gitOps)

            sb.appendLine("installerDebug=${installer!!.getDebugInfo()}")

            try {
                // diskOnly: this runs on the EDT during tool-window open, and the
                // manual-disable bridge read would be a second round-trip on top of
                // `getStatus` (a cold start pays a one-shot Node spawn for each).
                refreshStatus(manualDisableFromDiskOnly = true)
                sb.appendLine("status=${cachedStatus}")
            } catch (e: Exception) {
                sb.appendLine("refreshStatus error: ${e.message}")
                lastError = "Status check failed: ${e.message}"
            }

            // Skills are owned by the bundled CLI: written by the full `enable` on first
            // install (auto-install below) and refreshed by the version-gated
            // `enable --integrations-only` catch-up — no Kotlin-side skill writer remains.

            // Auto-initialize KB folder with repo identity + auto-migrate
            try {
                val repoName = KBPathResolver.extractRepoName(resolvedRoot)
                val remoteUrl = KBPathResolver.getRemoteUrl(resolvedRoot)
                val config = SessionTracker.loadConfig()
                val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.localFolder)
                KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)
                sb.appendLine("KB folder initialized: $kbRoot")

                // Auto-migrate orphan-branch data into the Memory Bank folder via the
                // bundled CLI (CliIntegrations.migrateMemoryBank → ide-bridge
                // `migrate-memory-bank` action, daemon fast path with spawn fallback).
                // The CLI decides whether an orphan branch exists and whether migration
                // already completed (full migration vs idempotent stale-child reconcile),
                // matching the VS Code activate path. The Kotlin MigrationEngine is gone.
                //
                // Fire-and-forget on a pooled thread — parity with VS Code's silent
                // `initializeKB()` run: no progress UI, and a full first-install
                // migration (minutes on large repos) no longer blocks everything after
                // this point in initialize() — hooks, status, isInitialized — nor the
                // tool-window / onboarding callers that invoke initialize() directly.
                // Reads until the folder is populated fall back to the orphan branch
                // (the pre-0.99 path), unchanged.
                //
                // The folder reader attach moves into the completion callback
                // ([refreshFolderReader]), keeping the old ordering contract: on a
                // fresh install the folder exists but .jolli/summaries/ is empty until
                // migration copies the orphan-branch data across, and attaching early
                // makes [FolderStorageReader.forRoot] return null (isReady() gates on
                // the summaries dir) — the reader would stay null for the whole
                // session and the page-cache-fast reads would keep forking `git show`.
                migrateMemoryBankAsync { result ->
                    // Refresh runs on both success and failure paths — even a
                    // failed migration can leave a partially-populated folder
                    // (a prior settled run + interrupted retry), and without
                    // the re-attach every read in this session keeps forking
                    // `git show`. The callback receives null when the bridge
                    // call itself threw.
                    refreshFolderReader()
                    refreshStatus()
                    val summary = result?.let { "${it.status} (${it.migratedEntries}/${it.totalEntries})" } ?: "failed"
                    appendInitLog("Auto-migration settled: $summary")
                }
                migrationDispatched = true
                sb.appendLine("Auto-migration: dispatched (async, silent)")
            } catch (e: Exception) {
                sb.appendLine("KB folder init/migration failed: ${e.message}")
            }

            // Auto-install hooks if configured (eliminates the separate "Enable" step).
            // `val`, not `var`: the legacy-pause projection below no longer rewrites the
            // global config, so nothing reassigns this after load.
            val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
            // Legacy machine-global pause (config.json → `paused`). The Pause checkbox
            // that wrote it is gone. Project any surviving `paused=true` from an older
            // plugin onto the modern per-repo `manuallyDisabled` opt-out so those users
            // get a UI escape (the DisabledPanel's Enable button) instead of being
            // stranded on CARD_MAIN with a STATUS overlay reporting "not enabled" and
            // no re-enable affordance.
            //
            // `paused` is MACHINE-GLOBAL (`~/.jolli/jollimemory/config.json`);
            // `manuallyDisabled` is PER-REPO. That mapping is not injective, so the
            // global flag is deliberately NEVER cleared here. Clearing it after
            // converting the one repo that happens to be open first is lossy: on a
            // machine with ten paused repos, opening repo A would clear the only record
            // of the opt-out, and repos B..J would then read `paused=null` plus their
            // own absent `manuallyDisabled` and fall straight into the
            // `hasCredentials && needsInstall` branch below — hooks silently reinstalled
            // in nine repos the user had explicitly turned off, with no notification.
            // That is the same "restart silently re-enables" class of bug this opt-out
            // exists to prevent, so the global flag stays as the standing answer for
            // every repo that has not decided for itself yet.
            //
            // Which makes the per-repo decision the thing to check, not `paused`'s
            // presence: convert only when this repo is still UNDECIDED
            // (`readExplicitManualDisable == null`). Without that guard, leaving
            // `paused` set would re-run this block on every start and re-write
            // `manuallyDisabled=true`, undoing an explicit Enable each restart.
            //
            // Best-effort: on a write failure fall through to the legacyPaused gate
            // below, which still honors the user's intent by skipping auto-install.
            val cwdForLegacyPause = mainRepoRoot
            val legacyPauseSet = config.paused == true
            // Gate the tri-state read on `legacyPauseSet`: [readExplicitManualDisable]
            // forks `git rev-parse --git-common-dir` and reads a file, and `paused` is
            // null for every user who never touched the retired Pause checkbox. This
            // method reaches the EDT via `createFullContent`'s `initialize()`, so an
            // unconditional read here would put a subprocess on the tool-window open
            // path for everyone to serve a shrinking legacy population. When
            // `legacyPauseSet` is false, `legacyPaused` below is false regardless of
            // this value, so skipping the read cannot change any outcome.
            val explicitManualDisable = if (legacyPauseSet) {
                cwdForLegacyPause?.let { ai.jolli.jollimemory.core.RepoProfileBridge.readExplicitManualDisable(it) }
            } else {
                null
            }
            if (legacyPauseSet && cwdForLegacyPause != null && explicitManualDisable == null) {
                sb.appendLine("Detected legacy paused=true in an undecided repo, projecting onto manuallyDisabled")
                try {
                    ai.jolli.jollimemory.core.RepoProfileBridge.writeManuallyDisabled(cwdForLegacyPause, true)
                    manuallyDisabledCached = true
                    sb.appendLine("Legacy pause projection succeeded (global paused left intact for other repos)")
                } catch (e: Exception) {
                    sb.appendLine("Legacy pause projection failed (falling back to legacyPaused gate): ${e.message}")
                }
            }
            val hasCredentials = hasSummaryCredentials(config)
            // spec 306: the repo-wide manual opt-out is the highest-priority signal —
            // once the user has explicitly disabled Jolli (from any surface: CLI, VS Code
            // sidebar, IntelliJ STATUS Disable icon), a plugin restart MUST NOT silently
            // re-install hooks. Because `enableFull` sends `clearManualDisableOnSuccess=true`,
            // running install() here on a disabled repo would also wipe the on-disk flag,
            // effectively "un-disabling" behind the user's back. `manuallyDisabledCached`
            // was populated by the `refreshStatus()` call earlier in this method, so this
            // read is free.
            // Matches VS Code's Extension.ts activate gate on `!manuallyDisabled`.
            val manuallyDisabled = manuallyDisabledCached
            // Legacy machine-global pause (config.json → `paused`), which the projection
            // above deliberately leaves set. It is the standing opt-out for every repo
            // that has NOT recorded a decision of its own, so it gates auto-install only
            // while this repo is undecided:
            //   - projection ran on an earlier start → explicit `true` → the
            //     `manuallyDisabled` branch below handles it, and DisabledPanel offers
            //     Enable. (On the start where the projection itself runs this local is
            //     still the pre-write `null`, which is harmless: the projection also set
            //     `manuallyDisabledCached = true`, so the branch above wins either way.)
            //   - user clicked Enable → explicit `false` → this gate steps aside so hook
            //     self-heal keeps working in the repo they re-enabled, while the other
            //     repos still see `paused` and stay off.
            //   - projection failed to write → still `null` → this gate holds the line,
            //     preserving the pre-migration behavior instead of auto-installing.
            val legacyPaused = legacyPauseSet && explicitManualDisable == null
            // `enabled` from the CLI is `gitHookInstalled` alone — deliberately so a
            // dropped Claude/Gemini integration doesn't kill the whole extension. But
            // that means `enabled == true` no longer implies "every desired hook is
            // wired in THIS worktree". Git hooks are shared through .git/hooks so any
            // worktree's install() satisfies them repo-wide; the Claude Stop hook,
            // however, lives in `<worktree>/.claude/settings.local.json` and MUST be
            // present per worktree. If the user has Claude Code and hasn't disabled
            // it, but the current worktree is missing the Stop hook, run the full
            // install() so the linked checkout is repaired. install() is idempotent
            // on hooks already in place.
            // `claudeEnabled` is the user's opt-in from JolliMemoryConfig (the config
            // loaded a few lines above), NOT a StatusInfo field — the CLI's StatusInfo
            // deliberately omits it because Claude is "always desired unless disabled"
            // and only surfaces `claudeDetected` + `claudeHookInstalled`. Treat null
            // (unset) as "user hasn't disabled Claude", matching the rest of the plugin.
            val claudeHookMissing = cachedStatus?.claudeDetected == true &&
                config.claudeEnabled != false &&
                cachedStatus?.claudeHookInstalled != true
            val needsInstall = cachedStatus?.enabled != true || claudeHookMissing
            if (manuallyDisabled) {
                sb.appendLine("Skipping auto-install: manuallyDisabled=true (spec 306 opt-out)")
            } else if (legacyPaused) {
                sb.appendLine("Skipping auto-install: config.paused=true (legacy opt-out)")
            } else if (hasCredentials && needsInstall) {
                val reason = if (cachedStatus?.enabled != true) "not yet enabled" else "claude hook missing in this worktree"
                sb.appendLine("Auto-installing hooks (configured + $reason)")
                // respectManualDisable=true: this is the ONLY automatic install path, and
                // the `manuallyDisabled` / `legacyPaused` gates above are the only thing
                // standing between a startup and a silent re-enable. Both read through
                // caches that a bridge hiccup can push to a stale `false`, and this call
                // carries `clearManualDisableOnSuccess`, so a wrong read would not just
                // reinstall hooks — it would erase the opt-out that recorded the user's
                // intent. Handing the check to the CLI too makes it fail closed: it
                // re-reads `profile.json` under the profile lock and returns a zero-write
                // "Repository remains manually disabled". Redundant whenever the caches
                // are right, which is the point.
                install(respectManualDisable = true)
                refreshStatus()
                sb.appendLine("status after auto-install=${cachedStatus}")
            } else if (hasCredentials) {
                // Plugin-upgrade catch-up: hooks are already installed (so the block above is
                // skipped), but the node integrations (MCP + skills + bundled Cli.js) may be
                // absent or built for an older plugin version. Refresh them off the EDT so a
                // plugin update activates MCP/skills without a manual re-enable. Version-gated,
                // so this is a no-op once current.
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        val issue = installer?.ensureIntegrations()
                        if (issue != null) {
                            refreshStatus() // so the StatusPanel row reflects the new integration state
                            notifyIntegrationsIssue(issue)
                        }
                    } catch (e: Exception) {
                        log.warn("Integrations catch-up failed (non-fatal): ${e.message}")
                    }
                }
            }

            // Pre-push sync catch-up (JOLLI-1900): retry any commits left in
            // push-pending.json from a previous session — an offline push, or a push
            // that raced ahead of summary generation. Off the EDT; fully guarded and
            // fire-and-forget (no-ops when nothing is pending, Node is absent, or the
            // user isn't signed in). Mirrors VS Code's Extension.activate retry.
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                CliIntegrations.retryPendingPushes(basePath)
            }

            // Warm the CLI daemon's hot read paths on a pooled thread so the first memory
            // click hits warm code instead of paying the cold-call penalty — the first few
            // daemon calls after spawn cost 100-700ms (Node JIT + cold git/fs caches) vs
            // 1-30ms warm, and opening a memory tab puts exactly these reads on the EDT.
            // Covers the three operations a tab open performs: index, transcript-hashes
            // and get. Fire-and-forget: every call is a read-only, idempotent round trip,
            // so a failure only means the first click warms the path itself (old behavior).
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val t = System.currentTimeMillis()
                    val store = ai.jolli.jollimemory.core.SummaryStore(resolvedRoot, gitOps, StorageFactory.create(gitOps, resolvedRoot))
                    val index = store.loadIndex()
                    store.getTranscriptHashes()
                    index?.entries?.firstOrNull()?.commitHash?.let { store.getSummary(it) }
                    log.info("CLI daemon warm-up done in ${System.currentTimeMillis() - t}ms (indexEntries=${index?.entries?.size ?: 0})")
                } catch (e: Exception) {
                    log.warn("CLI daemon warm-up failed (non-fatal): ${e.message}")
                }
            }

            warmJcefRenderPath()

            isInitialized = true
            initLog = sb.toString()
            log.info("Initialize complete:\n$initLog")

            // Subscribe to Git repository changes (new commits, branch switches, etc.)
            // This mirrors VS Code's .git/HEAD file watcher for auto-refresh.
            val connection = project.messageBus.connect(this)
            connection.subscribe(
                GitRepository.GIT_REPO_CHANGE,
                GitRepositoryChangeListener { refreshStatus() },
            )

            // ── Orphan branch ref + lock file watcher (IntelliJ VFS) ──────────
            // The post-commit hook worker runs in the background and writes summaries
            // to the orphan branch via `git update-ref`. IntelliJ's GIT_REPO_CHANGE
            // does NOT fire for orphan branch ref updates (only working-tree changes),
            // so we must arrange our own notification path.
            //
            // We route through IntelliJ's own VFS: LocalFileSystem.addRootsToWatch
            // hands the paths to fsnotifier (JetBrains's native FS helper), which
            // bridges platform-native events (FSEvents on macOS, inotify on Linux,
            // ReadDirectoryChangesW on Windows). This matches VS Code's underlying
            // FileSystemWatcher quality and replaces the previous Java NIO
            // WatchService, which on macOS silently degrades to a 10s polling
            // watcher that regularly misses git's brief atomic-rename events.
            //
            // .git/ subdirs are not part of the project index by default, so we
            // also call refreshAndFindFileByPath to seed the VFS with the paths
            // before subscribing to VFS_CHANGES.
            //
            // Watched:
            //   .git/refs/heads/jollimemory/summaries/ (orphan ref parent dir)
            //   .jolli/jollimemory/ (lock file dir — worker completion fallback)
            startVfsFileWatchers(resolvedRoot)

            // Write debug log to a temp file for easy access
            try {
                val logFile = java.io.File(System.getProperty("user.home") + "/.jolli/logs", "jollimemory-intellij-debug.log").also { it.parentFile.mkdirs() }
                logFile.writeText("=== JolliMemory IntelliJ Init Log ===\n${java.time.Instant.now()}\n\n$initLog")
                log.info("Debug log written to: ${logFile.absolutePath}")
            } catch (_: Exception) { }
        } finally {
            if (!migrationDispatched) migrationGate.countDown()
        }
    }

    /**
     * Kicks off pool prewarm. Delegates to [ai.jolli.jollimemory.toolwindow.JcefBrowserPool]
     * which builds one browser asynchronously on the EDT and keeps it around for the
     * first memory tab to reuse — priming the same one-time browser-process costs the
     * old throwaway warm-up did (libcef load, CefApp init, GPU/network subprocess
     * spawn, render-launcher OS-cache warmth), plus keeping the browser alive so its
     * V8 bytecode cache stays warm across every tab that follows.
     */
    private fun warmJcefRenderPath() {
        try {
            ai.jolli.jollimemory.toolwindow.JcefBrowserPool.get(project).warmUp()
        } catch (e: Exception) {
            log.warn("JCEF pool warm-up failed (non-fatal): ${e.message}")
        }
    }

    /**
     * Starts file watchers on top of IntelliJ's VFS.
     *
     * IntelliJ's VFS uses fsnotifier (a JetBrains-shipped native helper) to
     * receive OS-level FS events — FSEvents on macOS, inotify on Linux,
     * ReadDirectoryChangesW on Windows. Event quality matches VS Code's
     * FileSystemWatcher / Node fsevents.
     *
     * Steps for each watched directory:
     *   1. `refreshAndFindFileByPath` — seed the VFS with the dir so events
     *      inside `.git/` (normally outside project scope) actually fire.
     *   2. `addRootsToWatch(paths, watchRecursively=false)` — tell fsnotifier
     *      to bridge platform events for this dir into the VFS.
     *
     * We then subscribe to `VirtualFileManager.VFS_CHANGES` and filter events
     * by full path — matching only the four files we actually care about so
     * unrelated writes (debug.log, sessions.json, cursors.json) don't spam
     * refreshes.
     *
     * Filenames watched (see the path comparisons in the listener body):
     *   .git/refs/heads/jollimemory/summaries/v3  (or whatever ORPHAN_BRANCH ends with)
     *   .jolli/jollimemory/lock         (post-commit worker lifecycle)
     *   .jolli/jollimemory/worker.lock  (drives workerBusyCached — AI-Commit/Squash gate)
     *   .jolli/jollimemory/plans.json   (StopHook plan/reference discovery mid-session)
     *   .jolli/jollimemory/profile.json (repo-wide manuallyDisabled — resolved via
     *                                    git-common-dir so linked worktrees observe
     *                                    the main worktree's file, same anchor the
     *                                    CLI's RepoProfile.ts uses)
     */
    private fun startVfsFileWatchers(repoRoot: String) {
        val orphanBranch = JmLogger.ORPHAN_BRANCH
        val orphanRefDir = Path.of(repoRoot, ".git", "refs", "heads", orphanBranch).parent
        val orphanRefFile = orphanRefDir.resolve(Path.of(orphanBranch).fileName.toString())
        val lockDir = Path.of(repoRoot, ".jolli", "jollimemory")
        val orphanRefFileName = orphanRefFile.fileName.toString()
        // profile.json lives at the MAIN worktree, not necessarily `repoRoot` (which
        // is the current worktree). Resolve via git-common-dir — RepoProfileBridge
        // matches the CLI's `resolvePaths` exactly (dirname of common-dir). Null when
        // not a git repo (no watch, same fallback as the sibling dirs).
        val profileJsonFile = ai.jolli.jollimemory.core.RepoProfileBridge.resolveProfileJsonPath(repoRoot)
        val profileDir = profileJsonFile?.parentFile?.toPath()

        try {
            val fs = LocalFileSystem.getInstance()
            val rootsToWatch = mutableSetOf<String>()

            // Resolve each dir to the SAME canonical form the VFS reports back in
            // event.path. macOS in particular routes /tmp, /var and many other
            // real paths through symlinks (e.g. /var → /private/var), so a bare
            // Path.toAbsolutePath() would never match the canonical event.path
            // — every VFS_CHANGES event would silently miss.
            val orphanDirVfsPath: String? = if (Files.isDirectory(orphanRefDir)) {
                val vf = fs.refreshAndFindFileByPath(orphanRefDir.toAbsolutePath().toString())
                if (vf == null) log.warn("VFS refused to register orphan ref dir: $orphanRefDir")
                rootsToWatch.add(orphanRefDir.toAbsolutePath().toString())
                log.info("VFS watcher registered on: $orphanRefDir")
                vf?.path ?: canonicalize(orphanRefDir)
            } else {
                log.info("Orphan ref dir does not exist yet, skipping VFS watch: $orphanRefDir")
                null
            }

            val lockDirVfsPath: String? = if (Files.isDirectory(lockDir)) {
                val vf = fs.refreshAndFindFileByPath(lockDir.toAbsolutePath().toString())
                if (vf == null) log.warn("VFS refused to register lock dir: $lockDir")
                rootsToWatch.add(lockDir.toAbsolutePath().toString())
                log.info("VFS watcher registered on: $lockDir")
                vf?.path ?: canonicalize(lockDir)
            } else {
                log.info("Lock dir does not exist yet, skipping VFS watch: $lockDir")
                null
            }

            // profile.json's parent dir is `<mainRoot>/.jolli/jollimemory/`. On the
            // main worktree this equals [lockDir] and addRootsToWatch de-duplicates;
            // on a linked worktree it points at the main worktree so we can observe
            // repo-wide manualDisable writes from any worktree of this repo.
            val profileDirVfsPath: String? = if (profileDir != null && Files.isDirectory(profileDir)) {
                val vf = fs.refreshAndFindFileByPath(profileDir.toAbsolutePath().toString())
                if (vf == null) log.warn("VFS refused to register profile dir: $profileDir")
                rootsToWatch.add(profileDir.toAbsolutePath().toString())
                log.info("VFS watcher registered on: $profileDir")
                vf?.path ?: canonicalize(profileDir)
            } else {
                log.info("Profile dir does not exist yet or not a git repo, skipping VFS watch: $profileDir")
                null
            }

            if (rootsToWatch.isNotEmpty()) {
                vfsWatchRequests = fs.addRootsToWatch(rootsToWatch, false)
            }

            val orphanRefPath = orphanDirVfsPath?.let { "$it/$orphanRefFileName" }
            val workerLockPath = lockDirVfsPath?.let { "$it/worker.lock" }
            val lockPath = lockDirVfsPath?.let { "$it/lock" }
            val plansJsonPath = lockDirVfsPath?.let { "$it/plans.json" }
            val profileJsonPath = profileDirVfsPath?.let { "$it/profile.json" }

            // Tie the message-bus subscription to the service's Disposable lifecycle
            // so IntelliJ tears it down automatically when the project closes.
            val busConnection = ApplicationManager.getApplication().messageBus.connect(this)
            busConnection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    if (disposed) return
                    val batch = classifyVfsBatch(
                        paths = events.map { it.path },
                        plansJsonPath = plansJsonPath,
                        // profile.json belongs with the commit-time paths, not with
                        // plans.json: it carries the repo-wide `manuallyDisabled`
                        // opt-out, which only [refreshStatus] reads (into
                        // manuallyDisabledCached). Routing it to the cheap
                        // working-context repaint would leave a `jolli disable` from
                        // a terminal or a sibling VS Code window invisible here.
                        commitTimePaths = listOfNotNull(orphanRefPath, workerLockPath, lockPath, profileJsonPath),
                    )
                    // One call, not one per signal: the kind is already resolved by
                    // the classifier, and a second call would only restart the timer.
                    if (batch.statusRefresh || batch.workingContextRefresh) {
                        scheduleDebouncedRefresh(statusRecompute = batch.statusRefresh)
                    }
                    if (batch.savedMarkdown.isNotEmpty()) scheduleNoteSourceCheck(batch.savedMarkdown)
                }
            })
        } catch (ex: Exception) {
            log.warn("Failed to start VFS file watchers: ${ex.message}")
        }
    }

    /**
     * Canonicalize a path (resolve symlinks) with forward-slash normalization,
     * so its string form matches what IntelliJ VFS reports in event.path.
     * Falls back to the plain absolute path if canonicalization fails.
     */
    private fun canonicalize(path: Path): String {
        val absolute = path.toAbsolutePath().toString()
        return try {
            path.toFile().canonicalPath.replace('\\', '/')
        } catch (_: Exception) {
            absolute.replace('\\', '/')
        }
    }

    /**
     * Debounced "was one of those markdown files a note's source?" check.
     *
     * Any `.md` write reaches here — the subscription is on the APPLICATION message
     * bus, so other open projects' saves arrive too — and the answer is usually no,
     * hence the debounce and the pooled thread. It cannot be narrowed to the project
     * root: a markdown note references the user's own file wherever it lives, which
     * is frequently outside the workspace. The membership test asks the CLI for the
     * note list rather than guessing from the path: which files back a note (and
     * which of those are still visible) is `detectNotes`' decision, and the paths
     * live in a registry this side does not own. VS Code's equivalent hook does the
     * same, one `bridge.listNotes()` per save.
     *
     * Paths ACCUMULATE across bursts into [pendingMarkdownSaves] and are drained
     * when the check runs — each VFS batch is its own call, so replacing the list
     * would silently drop a note save that a later unrelated `.md` write pushed out
     * of the window.
     *
     * The membership test itself is [noteSourceWasSaved] — the two sides do NOT
     * arrive in a comparable form (VFS is always forward-slashed, the CLI stores
     * whatever separator the creating host handed it), so both are normalised
     * there. See that function for why comparing them raw silently broke this
     * whole path on Windows.
     */
    private fun scheduleNoteSourceCheck(savedMarkdown: List<String>) {
        if (disposed || cachedStatus?.enabled != true) return
        val cwd = mainRepoRoot ?: return
        synchronized(pendingMarkdownSaves) { pendingMarkdownSaves.addAll(savedMarkdown) }
        noteSourceDebounceTimer?.stop()
        noteSourceDebounceTimer = Timer(500) {
            if (disposed) return@Timer
            ApplicationManager.getApplication().executeOnPooledThread {
                val touched = synchronized(pendingMarkdownSaves) {
                    pendingMarkdownSaves.toSet().also { pendingMarkdownSaves.clear() }
                }
                if (touched.isEmpty()) return@executeOnPooledThread
                val isNoteSource = try {
                    noteSourceWasSaved(WorkingContext.detectNotes(cwd).map { it.filePath }, touched)
                } catch (e: Exception) {
                    log.warn("Note-source check failed: ${e.message}")
                    false
                }
                if (isNoteSource) refreshWorkingContext()
            }
        }.apply {
            isRepeats = false
            start()
        }
    }

    /**
     * Debounced refresh for the watched files, ESCALATING when a window mixes them.
     *
     * The worker writes multiple git objects in sequence (blob → tree → commit →
     * update-ref), so a 500 ms window collapses many events into one refresh. What
     * that window must not do is let the LAST event decide which refresh runs:
     * `plans.json` only moves working-area rows and takes the cheap repaint, while
     * the commit-time files (orphan ref, lock, worker.lock) can change installation
     * state and drive the status listeners the commits and memories panels sit on.
     * A `plans.json` write landing on top of a pending status refresh would demote
     * it, and nothing polls to recover — the sidebar would just stop reflecting the
     * commit that had already happened.
     *
     * So the flag is sticky for the life of the window and cleared only when the
     * timer fires. That rule is [RefreshEscalator], shared verbatim with the daemon
     * channel's `DaemonNotificationClient.scheduleDebounced` — it used to be a
     * second hand-written copy here, kept in step by a comment.
     *
     * @param statusRecompute true for the commit-time files, false for plans.json.
     */
    private fun scheduleDebouncedRefresh(statusRecompute: Boolean) {
        if (disposed) return
        refreshEscalator.record(statusRecompute)
        orphanRefDebounceTimer?.stop()
        orphanRefDebounceTimer = Timer(500) {
            if (disposed) return@Timer
            // Drain before the pooled hop so an event arriving mid-dispatch opens a
            // fresh window instead of having its flag consumed by this one.
            val recompute = refreshEscalator.drain()
            ApplicationManager.getApplication().executeOnPooledThread {
                if (recompute) refreshStatus() else refreshWorkingContext()
            }
        }.apply {
            isRepeats = false
            start()
        }
    }

    fun getStatus(): StatusInfo? = cachedStatus

    /**
     * Repo-wide `manuallyDisabled` opt-out — the highest-priority disable that wins
     * over `enabled`/`isConfigured`. Returns the value observed by the most recent
     * [refreshStatus]; `false` until the first refresh completes.
     *
     * The tool window reads this via the same [addStatusListener] fan-out that
     * carries every other status field, so a `jolli disable` from a terminal or a
     * sibling VS Code window is picked up by the VFS `profile.json` watcher and
     * reflected in the UI without a tool-window rebuild.
     */
    fun isManuallyDisabled(): Boolean = manuallyDisabledCached

    /**
     * Reloads the working-area context surfaces — and nothing else.
     *
     * For a plan, note or reference appearing, leaving or being edited, this is
     * the whole of the correct refresh. [refreshStatus] would additionally take a
     * `@Synchronized` lock, run a full `ide-bridge status` round-trip, recompute
     * the worker-busy flag and then wake all fourteen status listeners — none of
     * which can have a different answer because `plans.json` changed. A plan
     * showing up says nothing about whether hooks are installed, which commits
     * exist, or what the transcript sources are doing.
     *
     * A no-op before initialization, where there is no cached status and the
     * panels are still showing their "Initializing" state — reloading rows
     * underneath that would only replace it with a misleading empty list.
     */
    fun refreshWorkingContext() {
        if (disposed || cachedStatus == null) return
        notifyWorkingContextListeners()
    }

    /**
     * True when any credential capable of driving summary/wiki generation is set —
     * config.apiKey, config.jolliApiKey, or the ANTHROPIC_API_KEY env var.
     *
     * The env-var read goes through [HookEnv] so tests can override it without
     * mutating JVM globals (per scripts/check-global-state.sh's test-side gate).
     * The default `HookEnv()` argument returns the real `System.getenv`, so
     * production behaviour is unchanged — but the read is no longer a raw
     * `System.getenv` sitting in a file-level-ratcheted baseline.
     */
    fun hasSummaryCredentials(config: JolliMemoryConfig, env: HookEnv = HookEnv()): Boolean =
        !config.apiKey.isNullOrBlank() ||
            !config.jolliApiKey.isNullOrBlank() ||
            !env.getenv("ANTHROPIC_API_KEY").isNullOrBlank()

    /** EDT-safe cheap read of the worker-busy flag. Never blocks. See workerBusyCached. */
    fun isWorkerBusy(): Boolean = workerBusyCached

    private fun computeWorkerBusy(): Boolean {
        val cwd = mainRepoRoot ?: return false
        return try {
            SessionTracker.isWorkerBusy(cwd)
        } catch (e: Exception) {
            log.warn("computeWorkerBusy failed: ${e.message}")
            false
        }
    }

    /**
     * Reads the repo-wide `manuallyDisabled` opt-out and updates the cache, respecting
     * the same install-protection window as [refreshStatus] (`true → false` always
     * applies immediately; `false → true` is suppressed during an in-flight enable so
     * the tool window's optimistic Enable flip doesn't bounce back).
     *
     * Kept as its own method so callers can refresh the opt-out even when [refreshStatus]'s
     * main status probe fails — a bridge hiccup on `getStatus` must NOT hide a disk-side
     * `manuallyDisabled=true` from the auto-install gate. [RepoProfileBridge.readManuallyDisabled]
     * has its own bridge-then-disk fallback, so this call still lands correct data when the
     * daemon is down.
     *
     * [diskOnly] skips the bridge and reads `profile.json` directly. Used by the
     * [initialize] path, which runs synchronously on the EDT (`createToolWindowContent` →
     * `createFullContent` → `initialize`): the bridge read is a full round-trip there, and
     * a cold start with no daemon yet makes it a one-shot Node spawn (500 ms-2 s) — a
     * second one, since `getStatus` below is also a bridge call. That is the same cost the
     * legacy-pause read is gated against a few lines up in [initialize], and the same
     * reasoning applies here.
     *
     * Sound because the disk read is not a degraded substitute for this particular
     * question: the CLI writes `profile.json` with a temp-file + rename, so a direct read
     * can never observe a torn write, and the auto-install gate wants exactly the on-disk
     * truth. The bridge stays the default for every other caller (they run off-EDT, and it
     * keeps reads mutex-serialized with the CLI's own writers).
     */
    private fun refreshManuallyDisabled(diskOnly: Boolean = false) {
        val cwd = mainRepoRoot ?: return
        try {
            val fresh = if (diskOnly) {
                ai.jolli.jollimemory.core.RepoProfileBridge.readManuallyDisabledFromDisk(cwd)
            } else {
                ai.jolli.jollimemory.core.RepoProfileBridge.readManuallyDisabled(cwd)
            }
            val isProtected = System.currentTimeMillis() < installProtectionUntil
            if (isProtected && !manuallyDisabledCached && fresh) {
                log.info("refreshManuallyDisabled: suppressed manuallyDisabled flap (install protection active)")
            } else {
                manuallyDisabledCached = fresh
            }
        } catch (e: Exception) {
            log.warn("refreshManuallyDisabled: failed to read manuallyDisabled, keeping cached value: ${e.message}")
        }
    }

    /**
     * [manualDisableFromDiskOnly] forwards to [refreshManuallyDisabled] — see there for
     * why the EDT-bound [initialize] path sets it. Defaults to false so the other 38 call
     * sites, all off-EDT, keep the bridge read.
     */
    @Synchronized
    fun refreshStatus(manualDisableFromDiskOnly: Boolean = false): StatusInfo? {
        lastError = null

        // Check if .git was removed since initialization
        val basePath = project.basePath
        if (basePath != null && !java.io.File(basePath, ".git").exists()) {
            gitRemoved = true
            lastError = "Git repository removed"
            cachedStatus = null
            log.info("JolliMemory: .git directory no longer exists at $basePath")
            notifyListeners()
            return null
        }

        val i = installer
        val r = reader
        if (i == null || r == null) {
            lastError = "Service not initialized"
            return null
        }

        // Refresh the manuallyDisabled opt-out FIRST, before the main status probe.
        // This runs unconditionally: a bridge failure on `getStatus` (daemon down,
        // node blip) must NOT hide a disk-side `manuallyDisabled=true` from the
        // auto-install gate — the previous inline read was inside the try/catch
        // and got skipped whenever `getStatus` threw, silently un-disabling repos.
        // The install-protection early return below also lives after this call so
        // the opt-out cache doesn't stall during hook flapping windows.
        refreshManuallyDisabled(diskOnly = manualDisableFromDiskOnly)

        return try {
            val newStatus = r.getStatus(i)
            // During install protection period, don't downgrade from enabled to disabled.
            // GIT_REPO_CHANGE events fire when .git/hooks/ is modified and can momentarily
            // read stale hook state, causing status to flap enabled→disabled→enabled.
            val wasEnabled = cachedStatus?.enabled == true
            val isProtected = System.currentTimeMillis() < installProtectionUntil
            if (isProtected && wasEnabled && !newStatus.enabled) {
                log.info("refreshStatus: suppressed enabled→disabled flap (install protection active)")
                return cachedStatus
            }
            cachedStatus = newStatus
            workerBusyCached = computeWorkerBusy()
            notifyListeners()
            // Onboarding-funnel snapshot from the status just computed here (the
            // IntelliJ analog of VS Code's StatusStore.refresh hook), carrying
            // surface="intellij". Deduped per repo, gated on telemetry being on,
            // and never throws.
            basePath?.let { ai.jolli.jollimemory.core.telemetry.OnboardingFunnel.maybeEmit(it, newStatus) }
            cachedStatus
        } catch (e: Exception) {
            // Check if the error is because .git was removed
            if (basePath != null && !java.io.File(basePath, ".git").exists()) {
                gitRemoved = true
                lastError = "Git repository removed"
                cachedStatus = null
                log.info("JolliMemory: .git removed (detected via error): ${e.message}")
                notifyListeners()
                return null
            }
            lastError = "Status check failed: ${e.message}"
            log.warn(lastError!!)
            // manuallyDisabledCached was already refreshed above, so listeners
            // fired here observe an accurate opt-out even when getStatus failed.
            notifyListeners()
            null
        }
    }

    /**
     * Runs the CLI's full enable for this repo.
     *
     * [respectManualDisable] hands the opt-out check to the CLI as well, making it the
     * LAST gate rather than trusting [manuallyDisabledCached] alone — see
     * [CliIntegrations.enableFull]. Automatic startup repair passes `true`; every
     * explicit user Enable leaves it `false`, because there the whole intent is to lift
     * the opt-out and a refusal would make the button a silent no-op.
     */
    fun install(respectManualDisable: Boolean = false): Boolean {
        // Optimistically clear the cached opt-out to match what a successful install
        // will achieve — the CLI writes `manuallyDisabled=false` at the END of install
        // (via `clearManualDisableOnSuccess`), so a refreshStatus() firing mid-install
        // would otherwise read stale `true`, keep the cache at `true`, and — via the
        // tool window's `statusSyncListener` (which compares svc vs. its local flag)
        // — undo the optimistic Enable flip back to CARD_DISABLED. Pair this with
        // [installProtectionUntil] below so the suppression branch in [refreshStatus]
        // (`isProtected && !manuallyDisabledCached && fresh`) keeps the cache at
        // `false` even if a mid-install refresh reads the still-set disk flag.
        // Rolled back on failure below so a real disabled state isn't hidden.
        val previousManuallyDisabled = manuallyDisabledCached
        manuallyDisabledCached = false
        // Set install-protection EAGERLY, before the actual install work — the CLI
        // writes `manuallyDisabled=false` at the END of a successful install, so
        // any refreshStatus() firing during the window would otherwise read stale
        // `true` and bounce the tool window's optimistic Enable flip back to
        // CARD_DISABLED. Ceiling is generous: install is normally 500 ms–2 s but
        // dist-extract can spike on cold cache. Cleared on failure so a genuine
        // enabled→disabled elsewhere isn't held off.
        installProtectionUntil = System.currentTimeMillis() + 10_000
        val result = installer?.install(respectManualDisable)
        if (result != null && result.success) {
            // Re-base the window to 3 s from NOW, so late-arriving VFS events (from the
            // CLI's own writes) still can't flap the UI. GIT_REPO_CHANGE fires when
            // .git/hooks/ is modified and can momentarily read stale hook state.
            //
            // Since install normally takes 500 ms-2 s, this usually SHORTENS the 10 s
            // pre-install ceiling rather than extending it — deliberately: the ceiling
            // has to cover a cold dist-extract spike, but once the install has actually
            // returned, holding the cache against reality for the remaining ~8 s buys
            // nothing and only delays a genuine enabled→disabled from elsewhere.
            installProtectionUntil = System.currentTimeMillis() + 3000
            // Fire-and-forget: refreshStatus() costs 2+ bridge round-trips (getStatus +
            // readManuallyDisabled) but nothing on the click path needs its result — the
            // tool window's status listener will pick up the fresh values whenever they
            // land. Blocking here made the Enable click wait ~30-60 ms of pure IPC before
            // the UI could flip.
            ApplicationManager.getApplication().executeOnPooledThread { refreshStatus() }
            return true
        }
        // Failure — roll back the optimistic cache flip and release the protection
        // window so a real enabled→disabled elsewhere isn't held off. Releasing it also
        // lets the caller's follow-up refreshStatus() re-read the disk flag immediately
        // instead of being held at the optimistic `false` for the rest of the window.
        manuallyDisabledCached = previousManuallyDisabled
        installProtectionUntil = 0L
        // A `manuallyDisabled` refusal is NOT an error: the CLI declined to touch a repo
        // the user turned off, which is what we asked it to do. `lastError` is rendered to
        // the user in red as "Error" (see buildStatusHtml), so recording it there would
        // report a fault to someone who deliberately disabled Jolli. Everything else
        // above still applies — nothing was installed, so this returns false.
        lastError = if (result?.manuallyDisabled == true) null else result?.message ?: "Installer not available"
        return false
    }

    /**
     * Non-blocking heads-up when MCP + skills could not be set up (Node missing, bundle
     * missing, or the bundled CLI failed): memory generation works (Java hooks), but the
     * Node-powered features are unavailable. Never an error — just guidance. The durable
     * surface is the StatusPanel "MCP & Skills" row; this balloon is the first-time nudge.
     */
    private fun notifyIntegrationsIssue(message: String) {
        try {
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification(
                    "Jolli Memory: MCP & skills unavailable",
                    message,
                    com.intellij.notification.NotificationType.WARNING,
                )
                .notify(project)
        } catch (t: Throwable) {
            // Notification is best-effort; never fail install over it — but no longer silent.
            log.warn("Failed to show integrations notification: ${t.message}")
        }
    }

    fun uninstall(): Boolean {
        val result = installer?.uninstall()
        if (result != null && result.success) {
            // Clear protection so disable takes effect immediately
            installProtectionUntil = 0L
            // Fire-and-forget — same rationale as [install]: nothing on the click path
            // needs the refreshed StatusInfo; the tool window's listener picks it up
            // whenever it lands.
            ApplicationManager.getApplication().executeOnPooledThread { refreshStatus() }
            return true
        }
        lastError = result?.message ?: "Installer not available"
        return false
    }

    fun listSummaries(): List<CommitSummaryBrief> = reader?.listSummaries() ?: emptyList()

    /**
     * Lists memory entries from the orphan branch index for the Memories panel.
     * Returns root entries (parentCommitHash == null), sorted by commitDate descending,
     * with optional case-insensitive filtering on commitMessage and branch.
     *
     * @param count Max number of entries to return
     * @param filter Optional search text (filters by commitMessage or branch)
     * @return Pair of (matched entries, total count before pagination)
     */
    /**
     * Lists memory entries for the Memories panel.
     *
     * @param count Max number of entries to return
     * @param filter Optional search text (filters by commitMessage or branch)
     * @param scope "branch" = current branch only, "repo" = all branches, "all" = all repos in memory bank
     * @return Pair of (matched entries, total count before pagination)
     */
    fun listMemoryEntries(count: Int, filter: String? = null, scope: String = "branch"): Pair<List<ai.jolli.jollimemory.core.SummaryIndexEntry>, Int> {
        val g = git ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0
        val projectPath = mainRepoRoot ?: ""
        val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        val index = store.loadIndex()
            ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0

        // Filter to root entries only (no child/incremental summaries)
        var entries = index.entries
            .filter { it.parentCommitHash == null }
            .sortedByDescending { it.commitDate }

        // Apply scope filter
        if (scope == "branch") {
            val currentBranch = g.getCurrentBranch()?.trim()
            if (!currentBranch.isNullOrBlank()) {
                entries = entries.filter { it.branch == currentBranch }
            }
        }
        // scope == "repo" → no branch filter (all branches in this repo)
        // scope == "all" → same as repo for now (memory bank browsing is in KB panel)

        // Apply search filter
        if (!filter.isNullOrBlank()) {
            val lowerFilter = filter.lowercase()
            entries = entries.filter { entry ->
                entry.commitMessage.lowercase().contains(lowerFilter) ||
                    entry.branch.lowercase().contains(lowerFilter)
            }
        }

        val totalCount = entries.size
        return entries.take(count) to totalCount
    }

    fun getSummary(commitHash: String): CommitSummary? {
        // Cache hit → skip the git-show fork (and, later, the folder read).
        // The cache is wiped whenever a memory-state event fires
        // ([notifyMemoryStateChanged]) or an in-panel edit calls
        // [invalidateSummaryCache], so any real change repopulates lazily.
        summaryCache[commitHash]?.let { return it }

        // Try direct lookup first, then resolve through tree-hash aliases
        val direct = reader?.getSummary(commitHash)
        if (direct != null) {
            summaryCache[commitHash] = direct
            return direct
        }

        val g = git ?: return null
        val projectPath = mainRepoRoot ?: ""
        val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        val resolvedHash = store.resolveAlias(commitHash)
        if (resolvedHash != commitHash) {
            // Find the root summary for the alias target
            val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
            val fresh = reader?.getSummary(rootHash) ?: return null
            // Cache under BOTH keys so future lookups by either the alias or
            // the root hit — the alias→root resolution is stable per branch.
            summaryCache[commitHash] = fresh
            summaryCache[rootHash] = fresh
            return fresh
        }
        return null
    }

    fun getSummaryJson(commitHash: String): String? = reader?.getSummaryJson(commitHash)

    /** Archived plan body (`plans/<slug>.md`) from committed-memory storage, or null. */
    fun readArchivedPlan(slug: String): String? = reader?.readPlanBody(slug)

    /** Archived markdown-note body (`notes/<id>.md`) from committed-memory storage, or null. */
    fun readArchivedNote(id: String): String? = reader?.readNoteBody(id)

    /**
     * Archived reference body (`references/<source>/<sanitized-bareKey>.md`) from
     * committed-memory storage, or null. Used by CommittedMemories to open a
     * reference (e.g. a jollimemory recall) whose upstream `url` is absent —
     * without this the row would fall back to re-opening the whole commit summary.
     */
    fun readArchivedReference(source: ai.jolli.jollimemory.core.references.SourceId, archivedKey: String): String? =
        reader?.readReferenceBody(source, archivedKey)

    /** Stored committed conversation (by session) rendered as read-only markdown, or null. */
    fun readCommittedConversationMarkdown(commitHash: String, sessionId: String): String? =
        reader?.renderCommittedConversationMarkdown(commitHash, sessionId)

    fun getChangedFiles(): List<FileChange> {
        val output = git?.getStatus() ?: return emptyList()
        // Parse the NUL-separated `git status -z` stream (mirrors VS Code's listFiles):
        //   normal entry: <XY><space><path>; rename/copy adds the old path as the next segment.
        val segments = output.split("\u0000")
        val files = mutableListOf<FileChange>()
        var i = 0
        while (i < segments.size) {
            val segment = segments[i]
            if (segment.length < 3) { i++; continue }
            val stagedCode = segment[0]
            val unstagedCode = segment[1]
            val resolvedPath = segment.substring(3)
            // Rename/copy carries the original path in the next NUL segment — consume it.
            if (stagedCode == 'R' || stagedCode == 'C') i++
            // Belt-and-suspenders: skip any directory-shaped row (files-only list).
            if (resolvedPath.endsWith("/")) { i++; continue }
            // Single display code: the index column when staged, else the worktree column.
            val code = if (stagedCode != ' ' && stagedCode != '?') stagedCode else unstagedCode
            files.add(FileChange(relativePath = resolvedPath, statusCode = code.toString()))
            i++
        }
        return files
    }

    fun getBranchCommits(): List<CommitSummaryBrief> {
        val g = git ?: run {
            log.warn("getBranchCommits: git is null")
            return emptyList()
        }

        // Resolve base ref: prefer origin/main over main (matches VS Code resolveHistoryBaseRef)
        val baseRef = listOf("origin/main", "upstream/main", "main").firstOrNull { ref ->
            g.exec("rev-parse", "--verify", ref) != null
        } ?: "main"

        val headHash = g.getHeadHash()

        // Find merge-base (val so the else arm below smart-casts it to non-null).
        val mergeBaseRaw = g.exec("merge-base", "HEAD", baseRef)?.trim()
        val mergeBase = mergeBaseRaw?.takeIf { it.isNotBlank() }

        // If merge-base equals HEAD, we're on main or the branch is fully merged.
        // Enter merged mode: list the user's own commits from the reflog creation
        // point, filtered by author. Mirrors VS Code listBranchCommits, which does
        // NOT special-case a fully-synced remote base. IntelliJ previously short-
        // circuited baseRef=origin/* to "$baseRef..HEAD", which is always empty on
        // a fully-synced main / release branch and hid every already-pushed memory
        // from the panel.
        var authorFilter: String? = null
        val range: String? = when {
            mergeBase == null -> null // No common ancestor
            mergeBase == headHash -> {
                val branch = g.getCurrentBranch()?.trim()
                val merged = if (branch.isNullOrBlank()) null else g.resolveMergedHistory(branch)
                // A branch/main that never authored anything of its own (only
                // creation + rebase/reset) has no commits to show — clear the panel.
                if (merged == null || !merged.hasOwnCommit) return emptyList()
                // Merged mode is author-scoped; without a user.name the filter can't
                // be applied, so degrade to the empty panel rather than over-listing.
                authorFilter = g.getCurrentUserName() ?: return emptyList()
                "${merged.base}..HEAD"
            }
            else -> {
                // Narrow the fork point to the branch's true reflog creation point,
                // so a branch cut from a feature/release branch — including a
                // brand-new branch that still shares its parent's tip — does not
                // inherit the base branch's commits as its own. When the refined
                // base equals HEAD the branch has no own commits yet, so the panel
                // clears. Mirrors VS Code listBranchCommits -> resolveOwnCommitsBase.
                val branch = g.getCurrentBranch()?.trim()
                val ownBase = if (branch.isNullOrBlank()) mergeBase else g.resolveOwnCommitsBase(branch, mergeBase)
                if (ownBase == headHash) return emptyList()
                "$ownBase..HEAD"
            }
        }

        // Get commits with metadata AND shortstat in ONE git log call. Two separate
        // calls used to race a fully-synced remote (each -20 could enumerate a
        // different set of last-20 commits when a new commit arrived between the
        // shell-outs) and doubled process-fork overhead. --format has NO trailing
        // NULNUL so each commit prints its metadata on ONE line and its shortstat
        // (plus a leading blank line git inserts) on the following lines; the
        // parser routes each output line by whether it contains a NUL delimiter.
        val logArgs = if (range != null) {
            val base = arrayOf("log", range, "--format=%H%x00%s%x00%an%x00%ae%x00%aI", "--shortstat", "--no-merges")
            // --fixed-strings makes --author a literal substring match: git treats the
            // pattern as a regex by default, so a user.name with metacharacters (".", "()")
            // would error or match the wrong commits. Mirrors cli/core/BranchCommitLister.ts.
            //
            // ⚠ GLOBAL FLAG: --fixed-strings switches EVERY pattern operand in this git
            // invocation to literal mode — not just --author. Adding --grep / --committer /
            // any other regex-taking flag here without accounting for that will silently
            // change their semantics. If you need a mix of literal + regex, split into
            // two `git log` calls instead.
            if (authorFilter != null) base + arrayOf("--author=$authorFilter", "--fixed-strings") else base
        } else {
            arrayOf("log", "--format=%H%x00%s%x00%an%x00%ae%x00%aI", "--shortstat", "--no-merges", "-20")
        }
        val output = g.exec(*logArgs) ?: return emptyList()
        if (output.isBlank()) return emptyList()

        // Route each output line: metadata lines contain the NUL delimiters injected
        // by --format; any other non-blank line is the shortstat that belongs to the
        // most recent metadata line. Root commits — where git omits the shortstat —
        // keep the (0, 0, 0) default seeded when the metadata is first seen.
        val parsedEntries = mutableListOf<List<String>>()
        val commitHashes = mutableListOf<String>()
        val shortstatByHash = mutableMapOf<String, Triple<Int, Int, Int>>()
        var currentHash: String? = null
        for (rawLine in output.split("\n")) {
            if (rawLine.contains('\u0000')) {
                val parts = rawLine.split("\u0000")
                if (parts.size >= 5) {
                    val hash = parts[0]
                    currentHash = hash
                    parsedEntries.add(parts)
                    commitHashes.add(hash)
                    shortstatByHash[hash] = Triple(0, 0, 0)
                }
            } else if (currentHash != null && rawLine.isNotBlank()) {
                // parseDiffStatLine tolerates non-matching lines (returns 0/0/0), so an
                // unexpected line here would just leave the seeded default in place.
                shortstatByHash[currentHash!!] = parseDiffStatLine(rawLine)
            }
        }

        // Batch check which commits have summaries (including tree-hash aliases)
        val projectPath = mainRepoRoot ?: ""
            val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        var summaryHashSet = store.filterCommitsWithSummary(commitHashes)

        // Scan unmatched commits for tree-hash aliases (cross-branch matching)
        val unmatchedHashes = commitHashes.filter { it !in summaryHashSet }
        if (unmatchedHashes.isNotEmpty()) {
            val aliasesFound = store.scanTreeHashAliases(unmatchedHashes)
            if (aliasesFound) {
                // Re-check with new aliases
                summaryHashSet = store.filterCommitsWithSummary(commitHashes)
            }
        }

        // Detect pushed commits — matches VS Code resolvePushBaseRef() fallback chain:
        // 1) @{upstream}  2) origin/<branch>  3) no base (branch not published)
        val unpushedHashes = mutableSetOf<String>()
        val pushBaseRef = resolvePushBaseRef(g)
        val unpushedOutput = if (pushBaseRef != null) g.exec("rev-list", "$pushBaseRef..HEAD") else null
        if (unpushedOutput != null) {
            unpushedOutput.lines().filter { it.isNotBlank() }.forEach { unpushedHashes.add(it) }
        }

        // shortstatByHash was populated by the one-pass parser above (same git log call
        // as the metadata). Per-commit loop cost is now dominated by orphan-branch reads;
        // accumulate their total so the log shows exactly where a large branch
        // spends its time.
        val result = parsedEntries.map { parts ->
            val hash = parts[0]
            val message = parts[1]
            val author = parts[2]
            val email = parts[3]
            val isoDate = parts[4]

            // Read diff stats from the batched shortstat map (no per-commit shell-out).
            val (files, ins, del) = shortstatByHash[hash] ?: Triple(0, 0, 0)

            // Get topic count, commit type, and memory-detail enrichment from the
            // summary (resolving aliases). The enrichment fields feed the panel's
            // token meter, status chips, and collapsed sub-line without a second
            // read per row at expand time.
            var topicCount = 0
            var commitType: String? = null
            // Canonical (TS-identical) display fields: prefer the shared summary's
            // top-level breakdown/cost; fall back to a legacy IntelliJ `tokenUsage`
            // object (mapping cached = cache_creation, dropping cache_read to match TS).
            var tokenBreakdown: ai.jolli.jollimemory.core.ConversationTokenBreakdown? = null
            var estimatedCostUsd: Double? = null
            var e2eScenarioCount = 0
            var isSyncedToJolli = false
            var jolliDocUrl: String? = null
            var jolliDocId: Int? = null
            var conversationTurns: Int? = null
            var contextCount = 0
            if (hash in summaryHashSet) {
                val resolvedHash = store.resolveAlias(hash)
                val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
                val summary = reader?.getSummary(rootHash)
                if (summary != null) {
                    topicCount = ai.jolli.jollimemory.core.SummaryTree.countTopics(summary)
                    if (summary.commitType != null && summary.commitType.name != "commit") {
                        commitType = summary.commitType.name
                    }
                    // Token usage + cost: aggregate the WHOLE tree, exactly like the detail webview.
                    // A consolidated (squash/amend/rebase/merge) memory carries its tokens on the
                    // folded children, so reading only the root's own breakdown made the list + branch
                    // meter show N/A for memories whose detail view shows real usage.
                    val aggBreakdown = ai.jolli.jollimemory.core.SummaryTree.aggregateConversationTokenBreakdown(summary)
                    tokenBreakdown = aggBreakdown.takeIf { it.input + it.output + it.cached > 0 }
                    // Cost: prefer the accurate write-time per-model estimate (summed across the
                    // tree); when absent (legacy / token-only memories) fall back to a Sonnet-rate
                    // estimate of the aggregated breakdown — the same "prefer stored, else Sonnet"
                    // logic the VS Code sidebar uses, so both tools show the same figure.
                    val storedCost = ai.jolli.jollimemory.core.SummaryTree.aggregateEstimatedCost(summary)
                    estimatedCostUsd = if (storedCost > 0.0) {
                        storedCost
                    } else {
                        ai.jolli.jollimemory.core.ModelPricing.estimateSonnetCostUsd(
                            aggBreakdown,
                            ai.jolli.jollimemory.core.SummaryTree.aggregateConversationTokens(summary),
                        ).takeIf { it > 0.0 }
                    }
                    e2eScenarioCount = summary.e2eTestGuide?.size ?: 0
                    isSyncedToJolli = summary.jolliDocId != null || summary.jolliDocUrl != null
                    jolliDocUrl = summary.jolliDocUrl
                    jolliDocId = summary.jolliDocId
                    conversationTurns = summary.conversationTurns
                    contextCount = (summary.plans?.size ?: 0) +
                        (summary.notes?.size ?: 0) +
                        (summary.references?.size ?: 0)
                }
            }

            // Short date: MM-DD
            val shortDate = try {
                val instant = java.time.Instant.parse(isoDate)
                val ld = instant.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                "${ld.monthValue.toString().padStart(2, '0')}-${ld.dayOfMonth.toString().padStart(2, '0')}"
            } catch (_: Exception) { isoDate.take(10) }

            CommitSummaryBrief(
                hash = hash,
                shortHash = hash.take(7),
                message = message,
                author = author,
                authorEmail = email,
                date = isoDate,
                shortDate = shortDate,
                topicCount = topicCount,
                insertions = ins,
                deletions = del,
                filesChanged = files,
                isPushed = pushBaseRef != null && hash !in unpushedHashes,
                hasSummary = hash in summaryHashSet,
                commitType = commitType,
                conversationTokenBreakdown = tokenBreakdown,
                estimatedCostUsd = estimatedCostUsd,
                e2eScenarioCount = e2eScenarioCount,
                isSyncedToJolli = isSyncedToJolli,
                jolliDocUrl = jolliDocUrl,
                jolliDocId = jolliDocId,
                conversationTurns = conversationTurns,
                contextCount = contextCount,
            )
        }
        return result
    }

    /** Reads the committed AI conversations for a commit (CONVERSATIONS group). */
    fun getCommittedConversations(hash: String, summary: CommitSummary? = null): List<ConversationBrief> =
        reader?.getCommittedConversations(hash, summary) ?: emptyList()

    /**
     * Lists files changed in a specific commit — matches VS Code listCommitFiles().
     * Uses `git diff-tree` with rename detection, first-parent merge handling, and root commit support.
     */
    fun listCommitFiles(hash: String): List<CommitFileInfo> {
        val g = git ?: return emptyList()
        val raw = g.exec(
            "-c", "core.quotepath=false",
            "diff-tree", "-m", "--first-parent", "-M", "-r", "--name-status", "--root", hash,
        ) ?: return emptyList()

        val files = mutableListOf<CommitFileInfo>()
        var seenFiles = false

        for (rawLine in raw.split("\n")) {
            val entry = rawLine.trimEnd('\r')
            // Hash header or empty line — stop after first parent's diff block
            if (entry.isBlank() || !entry.contains("\t")) {
                if (seenFiles) break
                continue
            }
            seenFiles = true

            val parts = entry.split("\t")
            val rawStatus = parts[0]
            // Normalize: strip similarity percentage from rename codes (e.g. "R100" → "R")
            val statusCode = if (rawStatus.startsWith("R")) "R" else rawStatus

            if (statusCode == "R" && parts.size >= 3) {
                files.add(CommitFileInfo(relativePath = parts[2], statusCode = statusCode, oldPath = parts[1]))
            } else if (parts.size >= 2) {
                files.add(CommitFileInfo(relativePath = parts[1], statusCode = statusCode))
            }
        }
        return files
    }

    /**
     * Resolves the push comparison base for "isPushed" status.
     * Matches VS Code's resolvePushBaseRef() fallback chain:
     *   1) @{upstream}
     *   2) origin/<currentBranch>
     *   3) null (branch not published yet — all commits treated as not pushed)
     */
    private fun resolvePushBaseRef(g: GitOps): String? {
        // Try upstream tracking ref first
        val upstream = g.exec("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")?.trim()
        if (!upstream.isNullOrBlank()) {
            // Verify the ref actually exists
            val resolved = g.exec("rev-parse", "--verify", "--quiet", upstream)?.trim()
            if (!resolved.isNullOrBlank()) return upstream
        }
        // Fallback: origin/<currentBranch>
        val branch = g.getCurrentBranch()?.trim()
        if (!branch.isNullOrBlank()) {
            val originRef = "origin/$branch"
            val resolved = g.exec("rev-parse", "--verify", "--quiet", originRef)?.trim()
            if (!resolved.isNullOrBlank()) return originRef
        }
        // Branch not published — no push base
        return null
    }

    /** Parses "N files changed, N insertions(+), N deletions(-)" */
    private fun parseDiffStatLine(line: String): Triple<Int, Int, Int> {
        var files = 0; var ins = 0; var del = 0
        val filesMatch = Regex("(\\d+) files? changed").find(line)
        val insMatch = Regex("(\\d+) insertions?").find(line)
        val delMatch = Regex("(\\d+) deletions?").find(line)
        if (filesMatch != null) files = filesMatch.groupValues[1].toInt()
        if (insMatch != null) ins = insMatch.groupValues[1].toInt()
        if (delMatch != null) del = delMatch.groupValues[1].toInt()
        return Triple(files, ins, del)
    }

    /**
     * Checks whether the current branch is fully merged into main.
     * A branch is merged when merge-base(HEAD, main) equals HEAD itself,
     * meaning all branch commits are already reachable from main.
     */
    fun isBranchMerged(): Boolean {
        val g = git ?: return false
        val headHash = g.getHeadHash() ?: return false
        val baseRef = listOf("origin/main", "upstream/main", "main").firstOrNull { ref ->
            g.exec("rev-parse", "--verify", ref) != null
        } ?: return false
        val mergeBase = g.exec("merge-base", "HEAD", baseRef)?.trim()
        return !mergeBase.isNullOrBlank() && mergeBase == headHash
    }

    fun getGitOps(): GitOps? = git
    fun getInstallerDebug(): String = installer?.getDebugInfo() ?: "installer is null"

    // ── Sync orchestrator lifecycle ──────────────────────────────────────

    /**
     * Start the sync orchestrator with the given engine and poll interval.
     * Wires the orchestrator's state changes to the status bar widget.
     */
    fun startSync(cwd: String, pollIntervalSec: Int? = null, autoSyncEnabled: Boolean = true) {
        stopSync()
        // Each orchestrator owns a dedicated bounded ScheduledExecutorService.
        // Auth reconciles call startSync() on every sign-in / sign-out flip,
        // so the previous instance must be disposed explicitly or its
        // executor thread lingers for the lifetime of the IDE.
        orchestrator?.dispose()
        orchestrator = null
        val widget = findSyncWidget()
        val orch = CliSyncOrchestrator(
            project = project,
            cwd = cwd,
            pollIntervalSec = pollIntervalSec,
            onStateChange = { state, detail ->
                val gen = syncStateGen.incrementAndGet()
                syncState = state
                syncDetail = detail
                if (state == SyncState.SYNCED) lastSyncSuccessAtMs.set(System.currentTimeMillis())
                ApplicationManager.getApplication().invokeLater {
                    widget?.setSyncState(state, detail)
                    syncListeners.forEach { it(state, detail) }
                }
                scheduleStatusAutoClear(state, gen)
            },
        )
        orchestrator = orch
        if (autoSyncEnabled) orch.start()
    }

    /** Stop the sync polling loop (orchestrator remains usable for manual sync). */
    fun stopSync() {
        orchestrator?.stop()
        // A terminal failure from the last round is sticky: the status bar only
        // leaves OFFLINE on a subsequent *successful* round, which never comes
        // once polling has stopped (sign-out, auto-sync disabled, restart). Reset
        // it so a stale "✗ Sync failed" badge doesn't linger while no sync runs.
        // Gated on "was actually a failure" so a healthy ✓ state is preserved
        // across the stop()/start() restart dance. Widget + cached state +
        // listeners are reset together, mirroring the onStateChange path.
        if (syncState == SyncState.OFFLINE && syncDetail?.failed == true) {
            syncStateGen.incrementAndGet()
            syncState = SyncState.OFFLINE
            syncDetail = null
            val widget = findSyncWidget()
            ApplicationManager.getApplication().invokeLater {
                widget?.clearFailureStatus()
                syncListeners.forEach { it(SyncState.OFFLINE, null) }
            }
        }
    }

    /**
     * Auto-dismiss a finished sync status after [STATUS_AUTO_CLEAR_DELAY_MS] so
     * the status bar and KB toolbar return to a neutral resting state instead of
     * holding a stale badge. A failure is the worst offender — it otherwise
     * lingers until the next round (up to 90 min away, or never once polling
     * stops). SYNCING is skipped: it's an in-progress indicator that its own
     * result replaces.
     *
     * The [gen] guard ensures a newer state (a fresh round starting inside the
     * window, a sign-out clear, etc.) is never clobbered by a stale timer: if
     * [syncStateGen] has moved on, the scheduled clear is a no-op. Widget +
     * cached state + listeners are reset together, mirroring the onStateChange
     * path so getSyncState() and late-registering panels stay consistent.
     */
    private fun scheduleStatusAutoClear(state: SyncState, gen: Long) {
        if (!autoClearableSyncState(state)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            if (syncStateGen.get() != gen) return@schedule
            syncState = SyncState.OFFLINE
            syncDetail = null
            val widget = findSyncWidget()
            ApplicationManager.getApplication().invokeLater {
                if (syncStateGen.get() != gen) return@invokeLater
                widget?.setSyncState(SyncState.OFFLINE, null)
                syncListeners.forEach { it(SyncState.OFFLINE, null) }
            }
        }, STATUS_AUTO_CLEAR_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    /** Trigger a manual sync round, coalescing with any in-flight round. */
    fun requestManualSync() {
        orchestrator?.requestManualSync()
    }

    /**
     * Whether the sync orchestrator has been built yet. Mirrors the
     * `runtime.ensureBuilt()` gate in `vscode/src/sync/SyncCommands.ts`: a
     * manual-sync entry point should lazy-build the orchestrator (via
     * [ai.jolli.jollimemory.sync.SyncActivation.reconcileSync]) when this
     * returns `false` before calling [requestManualSync].
     */
    fun isSyncBuilt(): Boolean = orchestrator != null

    /** Current sync state, or null if sync has never run. */
    fun getSyncState(): SyncState? = syncState

    private fun findSyncWidget(): SyncStatusBarWidget? {
        val statusBar = WindowManager.getInstance().getStatusBar(project) ?: return null
        return statusBar.getWidget(SyncStatusBarWidget.ID) as? SyncStatusBarWidget
    }

    override fun dispose() {
        // Set first so any VFS_CHANGES batch already in-flight sees `disposed`
        // and refuses to schedule a fresh debounce timer against a released
        // service.
        disposed = true
        orchestrator?.dispose()
        orchestrator = null
        orphanRefDebounceTimer?.stop()
        orphanRefDebounceTimer = null
        refreshEscalator.clear()
        synchronized(pendingMarkdownSaves) { pendingMarkdownSaves.clear() }
        noteSourceDebounceTimer?.stop()
        noteSourceDebounceTimer = null
        if (vfsWatchRequests.isNotEmpty()) {
            try {
                LocalFileSystem.getInstance().removeWatchedRoots(vfsWatchRequests)
            } catch (_: Exception) { }
            vfsWatchRequests = emptySet()
        }
        // The VFS_CHANGES subscription was connected with `this` as the parent
        // Disposable, so IntelliJ tears it down automatically here.
        listeners.clear()
        syncListeners.clear()
    }
}

/** What one VFS batch asks for — see [classifyVfsBatch]. */
internal data class VfsBatchOutcome(
    /** A commit-time file moved: take the heavy `ide-bridge status` path. */
    val statusRefresh: Boolean,
    /** `plans.json` moved: the cheap working-area repaint is the whole correct refresh. */
    val workingContextRefresh: Boolean,
    /** `.md` writes to test for note-source membership. */
    val savedMarkdown: List<String>,
)

/**
 * Classify one VFS batch into the refreshes it should trigger.
 *
 * **Every path in the batch is examined.** Bailing out on the first match was
 * harmless while all four watched paths funnelled into a single refresh, but the
 * branches now have three different outcomes and the batches VFS hands over are
 * merged — an agent that commits at the end of its turn writes `plans.json`
 * (StopHook) and the orphan ref (post-commit worker) close enough together to
 * land in one batch. Stopping at whichever appeared first would drop the other
 * signal outright rather than demote it: the sticky escalation in
 * [JolliMemoryService.scheduleDebouncedRefresh] can only merge calls that
 * actually happen, and nothing polls to recover a status refresh that was never
 * scheduled — the just-created memory would simply never appear in the sidebar.
 * A `.md` save sitting behind a matched control file was lost the same way.
 *
 * Pure and `internal` so this is testable: the listener it serves is an anonymous
 * object inside a project-level service, which no unit test can reach.
 */
internal fun classifyVfsBatch(
    paths: List<String>,
    plansJsonPath: String?,
    commitTimePaths: List<String>,
): VfsBatchOutcome {
    var statusRefresh = false
    var workingContextRefresh = false
    val savedMarkdown = mutableListOf<String>()
    for (path in paths) {
        // plans.json is the odd one out: the commit-time paths describe state that
        // can genuinely change install status, while a plans.json write only moves
        // working-area rows. Route it to the cheap repaint for the same reason the
        // daemon's `working-context` kind takes that path.
        if (plansJsonPath != null && path == plansJsonPath) {
            workingContextRefresh = true
            continue
        }
        if (path in commitTimePaths) {
            statusRefresh = true
            continue
        }
        // A markdown note references the user's own file IN PLACE, and `NoteService`
        // derives the row's lastModified from that file's mtime — so editing it
        // reorders the CONTEXT list with no write to plans.json for the branches
        // above to catch. This is the IntelliJ analogue of VS Code's
        // onDidSaveTextDocument hook. Extension matched ignoring case: the file name
        // is the user's, and `.MD` is a note source just as much as `.md`.
        if (path.endsWith(".md", ignoreCase = true)) savedMarkdown.add(path)
    }
    return VfsBatchOutcome(statusRefresh, workingContextRefresh, savedMarkdown)
}

/**
 * "Did one of these saved `.md` files back a note?" — the membership test behind
 * [JolliMemoryService.scheduleNoteSourceCheck], extracted as a pure `internal`
 * helper for the same reason [classifyVfsBatch] was: its caller runs inside a
 * pooled runnable owned by a project-level service, and the platform difference it
 * exists to absorb cannot be reproduced on the host CI runs on.
 *
 * BOTH sides are normalised because they come from different producers that only
 * agree on POSIX. `touched` holds `VFileEvent.path`, and IntelliJ reports VFS paths
 * forward-slashed on every OS — the same invariant [JolliMemoryService.canonicalize]
 * already leans on. A note's `filePath` is whatever the CLI stored at creation time:
 * `File.absolutePath` from [ai.jolli.jollimemory.actions.AddContextAction] on this
 * host, `uri.fsPath` from VS Code's picker — i.e. the OS-native separator. So on
 * Windows this comparison used to be a guaranteed miss, and the CONTEXT list simply
 * stopped reordering when the user edited a note's source file. Nothing recovers
 * that: it is the one working-context signal that does NOT ride the daemon push
 * channel (see AGENTS.md → "One working-context signal does NOT come from this
 * channel at all"), so there is no second path to notice.
 *
 * Case is folded only where the filesystem is case-insensitive — the same condition
 * under which two spellings denote one file, so folding cannot introduce a match
 * between genuinely distinct notes. This is a cross-HOST fix as much as a
 * cross-platform one: VS Code's `fsPath` lower-cases the Windows drive letter, so a
 * note added there and edited here would miss on case even after the separators
 * agree. A false positive would cost one extra [JolliMemoryService.refreshWorkingContext]
 * repaint and write nothing, which is the cheap direction to be wrong in.
 *
 * @param caseSensitive injected so both branches stay reachable from a test on any
 *   host; production passes the platform's real answer.
 */
internal fun noteSourceWasSaved(
    notePaths: List<String?>,
    touched: Set<String>,
    caseSensitive: Boolean = SystemInfo.isFileSystemCaseSensitive,
): Boolean {
    if (touched.isEmpty()) return false
    val normalizedTouched = touched.mapTo(mutableSetOf()) { normalizeForPathCompare(it, caseSensitive) }
    return notePaths.any { it != null && normalizeForPathCompare(it, caseSensitive) in normalizedTouched }
}

/**
 * `\` → `/`, then case-folded when the filesystem does not distinguish case.
 * [String.lowercase] is locale-invariant (unlike the deprecated `toLowerCase()`),
 * so a Turkish locale cannot turn `I` into `ı` and break a path that matched
 * everywhere else.
 */
private fun normalizeForPathCompare(path: String, caseSensitive: Boolean): String {
    val forward = FileUtil.toSystemIndependentName(path)
    return if (caseSensitive) forward else forward.lowercase()
}

data class FileChange(
    val relativePath: String,
    val statusCode: String,
    var isSelected: Boolean = true,
)

/** A file changed in a specific commit — matches VS Code CommitFileInfo. */
data class CommitFileInfo(
    /** Path relative to workspace root (for renames, this is the new/destination path) */
    val relativePath: String,
    /** Git status letter: M=modified, A=added, D=deleted, R=renamed */
    val statusCode: String,
    /** Original path before rename (only set when statusCode is "R") */
    val oldPath: String? = null,
)
