package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.*
import ai.jolli.jollimemory.core.references.PromptRenderer
import ai.jolli.jollimemory.core.references.ReferenceCommitRef
import ai.jolli.jollimemory.core.references.ReferenceStore
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.PlanService
import ai.jolli.jollimemory.sync.VaultWriteLock
import ai.jolli.jollimemory.sync.VaultWriteLockMode
import java.io.File
import java.time.Instant

/**
 * PostCommitHook — Kotlin port of PostCommitHook.ts
 *
 * The main summarization pipeline. Invoked by git after each commit.
 *
 * Pipeline:
 *   1. Get HEAD commit info
 *   2. Check for squash-pending (merge existing summaries)
 *   3. Check for amend-pending (migrate summary)
 *   4. Load active sessions and read transcripts
 *   5. Get git diff
 *   6. Build conversation context
 *   7. Call Anthropic API for structured summary
 *   8. Store summary in orphan branch
 */
object PostCommitHook {

    private val log = JmLogger.create("PostCommitHook")

    /**
     * Checks if git is currently in a rebase operation.
     * During rebase, post-commit fires for every replayed commit — we must not
     * spawn a worker (and LLM API call) for each.
     */
    private fun isRebase(cwd: String): Boolean {
        val reflogAction = System.getenv("GIT_REFLOG_ACTION") ?: ""
        if (reflogAction.startsWith("rebase")) return true

        // Check for active rebase state directories
        val dotGit = java.io.File(cwd, ".git")
        val gitDir = if (dotGit.isDirectory) dotGit.absolutePath else {
            try {
                val line = dotGit.readText().trim()
                if (line.startsWith("gitdir:")) line.removePrefix("gitdir:").trim() else dotGit.absolutePath
            } catch (_: Exception) { dotGit.absolutePath }
        }
        return java.io.File(gitDir, "rebase-merge").isDirectory ||
            java.io.File(gitDir, "rebase-apply").isDirectory
    }

    /** How many queue entries one drain worker processes before deferring to a successor. */
    private const val MAX_ENTRIES_PER_RUN = 20

    /**
     * Launcher (git post-commit): enqueues one git operation, then spawns the drain
     * worker. Synchronous and fast (a few git calls + one file write) so it never
     * blocks the commit. Rebase replays are skipped here — post-rewrite migrates those.
     *
     * Enqueue (instead of the old spawn-one-worker-per-commit) is what makes rapid
     * commit/amend bursts safe: every op lands as its own file, and the drain worker
     * processes them all in order — so a second commit that arrives while the first is
     * still summarizing no longer loses its memory.
     */
    fun launch(args: Array<String>) {
        val cwd = System.getProperty("user.dir")
        JmLogger.setLogDir(cwd)

        if (isRebase(cwd)) {
            log.info("Rebase in progress — skipping post-commit enqueue (post-rewrite handles it)")
            return
        }

        val git = GitOps(cwd)
        val headHash = git.getHeadHash()?.trim()
        if (headHash.isNullOrBlank()) {
            log.error("Cannot resolve HEAD — skipping enqueue")
            return
        }

        // Capture commit source at enqueue time (consume the one-shot plugin marker here,
        // not in the worker — the worker may run much later, against a different commit).
        val commitSource = if (SessionTracker.loadPluginSource(cwd)) {
            SessionTracker.deletePluginSource(cwd)
            CommitSource.plugin
        } else CommitSource.cli

        val branch = git.getCurrentBranch()

        // Resolve op type + source hashes from the pending markers written by
        // prepare-commit-msg, else from the reflog (cherry-pick / revert / plain commit).
        var type = "commit"
        var sourceHashes: List<String>? = null

        val squashPending = SessionTracker.loadSquashPending(cwd)
        if (squashPending != null) {
            SessionTracker.deleteSquashPending(cwd)
            // A stale squash-pending (from a prior failed run) can be adopted by an
            // unrelated commit — validate its recorded parent against HEAD~1.
            val parent = git.exec("rev-parse", "HEAD~1")?.trim()
            if (parent == null || parent == squashPending.expectedParentHash) {
                type = "squash"; sourceHashes = squashPending.sourceHashes
            } else {
                log.warn("Stale squash-pending (parent %s != HEAD~1 %s) — treating as plain commit",
                    squashPending.expectedParentHash.take(8), parent.take(8))
            }
        } else {
            val amendPending = SessionTracker.loadAmendPending(cwd)
            if (amendPending != null) {
                SessionTracker.deleteAmendPending(cwd)
                type = "amend"; sourceHashes = listOf(amendPending.oldHash)
            } else {
                type = detectQueueCommitType()
            }
        }

        val op = GitOpQueue.GitOperation(
            type = type,
            commitHash = headHash,
            branch = branch,
            sourceHashes = sourceHashes,
            commitSource = commitSource.name,
            createdAt = Instant.now().toString(),
        )
        GitOpQueue.enqueue(op, cwd)
        spawnDrainWorker(cwd)
    }

    /** Spawns the drain worker as a detached background process (never blocks git). */
    private fun spawnDrainWorker(cwd: String) {
        val javaHome = System.getProperty("java.home")
        val javaBin = "$javaHome/bin/java"
        val jarPath = getJarPath() ?: return
        val cmd = listOf(javaBin, "-jar", jarPath, "queue-drain")
        try {
            // Redirect worker output to a log file, not inheritIO(): inheritIO() would
            // hold git's stdout/stderr FDs open and make git wait for the worker.
            val logDir = java.io.File(JmLogger.getJolliMemoryDir(cwd))
            logDir.mkdirs()
            val workerLog = java.io.File(logDir, "post-commit-worker.log")
            ProcessBuilder(cmd)
                .directory(java.io.File(cwd))
                .redirectOutput(ProcessBuilder.Redirect.appendTo(workerLog))
                .redirectError(ProcessBuilder.Redirect.appendTo(workerLog))
                .start()
            log.info("Drain worker spawned (output → %s)", workerLog.absolutePath)
        } catch (e: Exception) {
            log.error("Failed to spawn drain worker: %s", e.message)
        }
    }

    /** Detects the git-op type from GIT_REFLOG_ACTION for the non-squash/non-amend path. */
    private fun detectQueueCommitType(): String {
        val reflogAction = System.getenv("GIT_REFLOG_ACTION") ?: return "commit"
        return when {
            reflogAction.startsWith("cherry-pick") -> "cherry-pick"
            reflogAction.startsWith("revert") -> "revert"
            else -> "commit"
        }
    }

    /** Backward-compatible entry: a stray `post-commit --worker` now drains the queue. */
    fun runWorker(cwd: String, force: Boolean = false) = drainWorker(cwd, force)

    /**
     * Drain worker: holds the per-repo lock and processes every queued git op in
     * chronological order (bounded by [MAX_ENTRIES_PER_RUN]), runs the wiki ingest
     * once, then chain-spawns a successor if new entries arrived mid-drain. The lock's
     * mtime is refreshed every 60s so a long LLM call never lets a concurrent commit's
     * worker judge the lock stale and start a racing drain.
     */
    fun drainWorker(cwd: String, force: Boolean = false) {
        JmLogger.setLogDir(cwd)
        val drainStart = System.currentTimeMillis()
        log.info("=== Queue drain worker started (cwd=%s, force=%s) ===", cwd, force)

        val git = GitOps(cwd)
        val storage = StorageFactory.create(git, cwd)
        val store = SummaryStore(cwd, git, storage)
        val config = SessionTracker.loadConfig(cwd)
        log.info("Config loaded: apiKey=%s, jolliApiKey=%s, model=%s",
            if (config.apiKey != null) "set" else "null",
            if (config.jolliApiKey != null) "set" else "null", config.model ?: "default")

        val logLevel = config.logLevel?.let { try { LogLevel.valueOf(it) } catch (_: Exception) { null } }
        if (logLevel != null) JmLogger.setLogLevel(logLevel)

        if (!SessionTracker.acquireLock(cwd)) {
            log.warn("Cannot acquire lock — another drain worker is running")
            return
        }

        // Keep the lock fresh during long LLM calls so a concurrent commit's worker
        // doesn't reclaim it as stale mid-drain.
        val refresher = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "jolli-lock-refresh").apply { isDaemon = true }
        }
        refresher.scheduleAtFixedRate(
            { SessionTracker.refreshLock(cwd) }, 60, 60, java.util.concurrent.TimeUnit.SECONDS,
        )

        var processed = 0
        try {
            loop@ while (processed < MAX_ENTRIES_PER_RUN) {
                val entries = GitOpQueue.dequeueAll(cwd)
                if (entries.isEmpty()) break
                for ((op, file) in entries) {
                    if (processed >= MAX_ENTRIES_PER_RUN) break@loop
                    try {
                        dispatchOp(op, cwd, git, store, config, force)
                    } catch (e: Exception) {
                        log.error("Failed to process queue op type=%s ref=%s: %s",
                            op.type, op.commitHash.take(8), e.message ?: e.toString())
                    }
                    GitOpQueue.deleteEntry(file)
                    processed++
                }
            }
        } finally {
            // Auto-ingest + re-render the wiki once per drain (no-op when nothing pending).
            try {
                runIngestAndRender(cwd, config)
            } catch (e: Exception) {
                log.warn("Post-commit ingest/render failed (non-fatal): %s", e.message)
            }
            refresher.shutdownNow()
            SessionTracker.releaseLock(cwd)
            // Pre-push sync catch-up (JOLLI-1900): a `git push` may have raced ahead
            // of summary generation, leaving its commit in push-pending.json. Now that
            // this drain has (re)generated summaries, drain the pending queue so those
            // commits sync to Jolli Space without waiting for the next plugin startup —
            // the IntelliJ analog of the TS QueueWorker's triggerPushForNewSummaries.
            // Runs after releaseLock (never holds the drain lock over a network push;
            // the push worker takes its own push-pending lock) and blocks (bounded)
            // because this JVM is already a detached background process. Gated on
            // `processed > 0` + the cheap no-pending short-circuit inside the callee,
            // so a normal commit with nothing pending never spawns Node.
            if (processed > 0) {
                CliIntegrations.retryPendingPushes(cwd, waitForCompletion = true)
            }
            ai.jolli.jollimemory.core.telemetry.Telemetry.track(
                "queue_drained",
                mapOf("ops" to processed, "duration_ms" to (System.currentTimeMillis() - drainStart)),
            )
            // Chain-spawn: entries that landed after our last dequeue get their own worker.
            if (GitOpQueue.hasEntries(cwd)) {
                log.info("Queue non-empty after drain — chain-spawning successor")
                spawnDrainWorker(cwd)
            }
        }
        log.info("=== Queue drain worker finished (%d op(s)) ===", processed)
    }

    /** Resolves the op's commit, then dispatches to the matching handler. */
    private fun dispatchOp(
        op: GitOpQueue.GitOperation, cwd: String, git: GitOps,
        store: SummaryStore, config: JolliMemoryConfig, force: Boolean,
    ) {
        val commitInfoStr = git.getHeadCommitInfo(op.commitHash)
        if (commitInfoStr == null) {
            log.warn("Cannot resolve commit %s (rewritten/gone?) — skipping op", op.commitHash.take(8))
            return
        }
        val infoParts = commitInfoStr.split("\u0000")
        if (infoParts.size < 4) return
        val commitInfo = CommitInfo(infoParts[0], infoParts[1], infoParts[2], infoParts[3])
        log.info("Processing %s op: %s — %s", op.type, commitInfo.hash.take(8), commitInfo.message.take(60))

        when (op.type) {
            "squash", "rebase-squash" -> processSquash(op.sourceHashes ?: emptyList(), commitInfo, store, config)
            "amend", "rebase-pick" -> processAmend(op.sourceHashes?.firstOrNull(), commitInfo, store)
            else -> processCommitOp(op, commitInfo, cwd, git, store, config, force)
        }
    }

    /** Full summarization pipeline for a real commit (commit / cherry-pick / revert). */
    private fun processCommitOp(
        op: GitOpQueue.GitOperation, commitInfo: CommitInfo, cwd: String, git: GitOps,
        store: SummaryStore, config: JolliMemoryConfig, force: Boolean,
    ) {
        val commitSource =
            if (op.commitSource == CommitSource.plugin.name) CommitSource.plugin else CommitSource.cli

        run {
            // 4. Load sessions and read transcripts
            log.info("Step 4: Loading sessions")
            val allSessions = SessionTracker.loadAllSessions(cwd).toMutableList()

            // On-demand discovery: Codex (filesystem scan, no hook). Codex has no
            // Stop/Session hook, so without this scan a Codex-only memory finds no
            // sessions and is silently skipped at commit time. Mirrors the CLI worker
            // and the sidebar aggregator, which both discover Codex this way.
            if (config.codexEnabled != false && CodexSessionDiscoverer.isCodexInstalled()) {
                allSessions.addAll(CodexSessionDiscoverer.discoverSessions(cwd))
            }

            // On-demand discovery: OpenCode (SQLite-backed, no hook)
            if (config.openCodeEnabled != false && OpenCodeSupport.isOpenCodeInstalled()) {
                allSessions.addAll(OpenCodeSupport.discoverSessions(cwd).sessions)
            }

            // On-demand discovery: Cursor (SQLite-backed, no hook)
            if (config.cursorEnabled != false && CursorSupport.isCursorInstalled()) {
                allSessions.addAll(CursorSupport.discoverSessions(cwd).sessions)
            }

            // On-demand discovery: Copilot CLI (SQLite-backed, no hook)
            if (config.copilotEnabled != false && CopilotSupport.isCopilotInstalled()) {
                allSessions.addAll(CopilotSupport.discoverSessions(cwd).sessions)
            }

            // On-demand discovery: Copilot Chat (JSONL-backed, no hook) — shares copilotEnabled with the CLI source
            if (config.copilotEnabled != false && CopilotChatSupport.isCopilotChatInstalled()) {
                allSessions.addAll(CopilotChatSupport.discoverSessions(cwd).sessions)
            }

            // Read ALL sessions so excluded conversations' cursors advance too:
            // selection is a one-time discard — an unchecked conversation is consumed
            // (cursor → commit boundary) so it leaves the working area, but its entries
            // are dropped below and never enter the summary. (Reverses the earlier
            // "keep excluded conversations visible so the user can re-check them".)
            val exclusions = CommitSelectionStore.readExclusions(cwd)
            val sessions = allSessions

            log.info("Discovered %d session(s): %s",
                allSessions.size,
                sessions.joinToString(", ") { "${it.source ?: "claude"}:${it.sessionId.take(8)}" })
            if (sessions.isEmpty()) {
                log.info("No active sessions — skipping summarization")
                return
            }

            val sessionTranscripts = mutableListOf<TranscriptReader.SessionTranscript>()
            var totalEntries = 0
            var totalTurns = 0

            for (session in sessions) {
                val source = session.source ?: TranscriptSource.claude
                // JOLLI-1785: fire ai_source_detected the first time this machine
                // sees a transcript from `source`. Gated on telemetry being enabled
                // so an opted-out run never writes the shared first-seen ledger.
                if (ai.jolli.jollimemory.core.telemetry.Telemetry.isEnabled() &&
                    ai.jolli.jollimemory.core.telemetry.TelemetrySharedConfig.markAiSourceSeen(source.name)
                ) {
                    ai.jolli.jollimemory.core.telemetry.Telemetry.track("ai_source_detected", mapOf("source" to source.name))
                }
                try {
                    val cursor = SessionTracker.loadCursorForTranscript(session.transcriptPath, cwd)
                    log.info("Reading session %s source=%s cursor=%s",
                        session.sessionId.take(8), source, cursor?.lineNumber ?: "none")

                    val result = when (source) {
                        TranscriptSource.gemini -> {
                            val entries = GeminiSupport.readGeminiTranscript(session.transcriptPath)
                            TranscriptReadResult(entries, TranscriptCursor(session.transcriptPath, entries.size, Instant.now().toString()), entries.size)
                        }
                        TranscriptSource.opencode -> {
                            OpenCodeSupport.readTranscript(session.transcriptPath, cursor, commitInfo.date)
                        }
                        TranscriptSource.cursor -> {
                            CursorSupport.readTranscript(session.transcriptPath, cursor, commitInfo.date)
                        }
                        TranscriptSource.copilot -> {
                            CopilotSupport.readTranscript(session.transcriptPath, cursor, commitInfo.date)
                        }
                        TranscriptSource.`copilot-chat` -> {
                            CopilotChatSupport.readTranscript(session.transcriptPath, cursor, commitInfo.date)
                        }
                        else -> {
                            val parser = getParserForSource(source)
                            // Slice to this commit's window (commitInfo.date) so a queued burst
                            // of commits doesn't fold the whole conversation into the oldest one.
                            TranscriptReader.readTranscript(session.transcriptPath, cursor, parser, commitInfo.date)
                        }
                    }

                    log.info("Session %s (%s): %d entries, %d lines read",
                        session.sessionId.take(8), source, result.entries.size, result.totalLinesRead)
                    for ((idx, entry) in result.entries.take(3).withIndex()) {
                        val snippet = entry.content.take(120).replace("\n", " ")
                        log.info("  entry[%d] role=%s: %s%s", idx, entry.role, snippet,
                            if (entry.content.length > 120) "..." else "")
                    }
                    if (result.entries.size > 3) {
                        log.info("  ...and %d more entries", result.entries.size - 3)
                    }

                    // Discard unchecked conversations: still advance the cursor (below)
                    // so the row leaves the working area, but drop the entries so they
                    // never enter the summary.
                    val excludedConversation =
                        CommitSelectionStore.conversationKey(source, session.sessionId) in exclusions.conversations
                    if (result.entries.isNotEmpty() && !excludedConversation) {
                        sessionTranscripts.add(TranscriptReader.SessionTranscript(
                            session.sessionId, session.transcriptPath, result.entries, source
                        ))
                    }
                    if (!excludedConversation) {
                        totalEntries += result.totalLinesRead
                        totalTurns += result.entries.count { it.role == "human" }
                    }
                    SessionTracker.saveCursor(result.newCursor, cwd)
                } catch (e: Exception) {
                    log.warn("Failed to read transcript for session %s (%s), skipping: %s",
                        session.sessionId.take(8), source, e.message ?: e.toString())
                }
            }

            // 5. Get diff
            log.info("Step 5: Getting diff (transcripts=%d entries, %d turns)", totalEntries, totalTurns)
            // Diff this op's OWN commit — by the time the queue drains, HEAD may have
            // moved past it, so HEAD~1..HEAD would be the wrong change.
            val diff = git.getDiffContent(op.commitHash) ?: ""
            val diffStatStr = git.getDiffStats(op.commitHash) ?: ""
            val diffStats = parseDiffStats(diffStatStr)
            log.info("Diff: %d files changed, +%d -%d, diff length=%d chars", diffStats.filesChanged, diffStats.insertions, diffStats.deletions, diff.length)

            // 6. Guard: skip if no transcript and no file changes
            if (sessionTranscripts.isEmpty() && diffStats.filesChanged == 0) {
                log.info("Empty transcript and no file changes — skipping")
                return
            }

            // 7. Build conversation context
            val conversation = TranscriptReader.buildMultiSessionContext(sessionTranscripts)

            // 8. Generate summary via LLM (direct Anthropic or Jolli proxy)
            val apiKey = config.apiKey ?: System.getenv("ANTHROPIC_API_KEY")
            if (apiKey == null && config.jolliApiKey.isNullOrBlank()) {
                log.warn("No LLM credentials configured — skipping summarization")
                return
            }

            // 7b. Assemble reference blocks for prompt injection — branch-scoped to
            //     this commit's branch (legacy blank-branch rows allowed) so the
            //     summary prompt never sees another branch's references.
            val branch = op.branch ?: git.getCurrentBranch() ?: "unknown"
            val registry = SessionTracker.loadPlansRegistry(cwd)
            val referenceBlocks = PromptRenderer.assembleReferenceBlocks(
                (registry.references ?: emptyMap()).filter { (_, entry) ->
                    entry.branch.isNullOrBlank() || entry.branch == branch
                },
                exclusions.references,
            )
            if (referenceBlocks.isNotEmpty()) {
                log.info("Reference blocks assembled: %d chars", referenceBlocks.length)
            }

            log.info("Step 8: Calling LLM for summary generation (conversation=%d chars)", conversation.length)
            val summaryResult = Summarizer.generateSummary(Summarizer.SummarizeParams(
                conversation = conversation,
                diff = diff,
                commitInfo = commitInfo,
                diffStats = diffStats,
                transcriptEntries = totalEntries,
                conversationTurns = totalTurns,
                apiKey = apiKey,
                model = config.model,
                jolliApiKey = config.jolliApiKey,
                aiProvider = config.aiProvider,
                referenceBlocks = referenceBlocks.takeIf { it.isNotBlank() },
            ))
            log.info("Step 8: LLM call completed, topics=%d, recap=%s", summaryResult.topics?.size ?: 0, if (summaryResult.recap != null) "${summaryResult.recap!!.length} chars" else "null")

            // 8b. Detect uncommitted plans, archive, and evaluate progress
            val planRefs = mutableListOf<PlanReference>()
            val planProgressArtifacts = mutableListOf<PlanProgressArtifact>()

            val uncommittedSlugs = detectUncommittedPlanSlugs(cwd, exclusions.plans)
            if (uncommittedSlugs.isNotEmpty()) {
                log.info("Detected %d uncommitted plan(s): %s", uncommittedSlugs.size, uncommittedSlugs.joinToString(", "))
                val plansDir = File(System.getProperty("user.home"), ".claude/plans")
                val topics: List<TopicSummary> = summaryResult.topics ?: emptyList()
                val commitDate = Instant.parse(commitInfo.date).toString()

                for (slug in uncommittedSlugs) {
                    try {
                        // Read plan markdown before archiving (retain for eval)
                        val planFile = File(plansDir, "$slug.md")
                        val planMarkdown = if (planFile.exists()) planFile.readText(Charsets.UTF_8) else null

                        // Archive: renames slug to slug-hash in registry, stores plan on orphan branch
                        val ref = PlanService.archivePlanForCommit(slug, commitInfo.hash, store, cwd)
                        if (ref != null) {
                            planRefs.add(ref)

                            // Evaluate progress via Haiku LLM call
                            if (planMarkdown != null) {
                                val evalResult = try {
                                    PlanProgressEvaluator.evaluatePlanProgress(
                                        planMarkdown, diff, topics, conversation, apiKey, config.model, config.jolliApiKey, config.aiProvider,
                                    )
                                } catch (e: Exception) {
                                    log.warn("Plan progress eval failed for %s: %s", slug, e.message)
                                    null
                                }

                                if (evalResult != null) {
                                    planProgressArtifacts.add(PlanProgressArtifact(
                                        commitHash = commitInfo.hash,
                                        commitMessage = commitInfo.message,
                                        commitDate = commitDate,
                                        planSlug = ref.slug,
                                        originalSlug = slug,
                                        summary = evalResult.summary,
                                        steps = evalResult.steps,
                                        llm = evalResult.llm,
                                    ))
                                }
                            }
                        }
                    } catch (e: Exception) {
                        log.warn("Plan archive failed for %s (non-fatal, skipping): %s", slug, e.message)
                    }
                }
                log.info("Plan progress: evaluated %d/%d plan(s)", planProgressArtifacts.size, planRefs.size)
            }

            // 8c. Detect uncommitted references on this branch, archive to orphan branch.
            //     Branch-scoped like notes (8d) so a commit on this branch leaves other
            //     branches' references pending instead of sweeping them up. `branch` is
            //     declared at the 7b prompt-assembly step above.
            val referenceCommitRefs = mutableListOf<ReferenceCommitRef>()
            val referenceFilesToStore = mutableListOf<FileWrite>()
            val referenceCommitted = mutableListOf<Triple<String, String, String>>() // mapKey, sourcePath, updatedAt

            val uncommittedRefResult = detectUncommittedReferences(cwd, exclusions.references)
            if (uncommittedRefResult.isNotEmpty()) {
                log.info("Detected %d uncommitted reference(s)", uncommittedRefResult.size)
                val shortHash = commitInfo.hash.substring(0, 8)

                for ((mapKey, entry) in uncommittedRefResult) {
                    val rawContent = ReferenceStore.readMarkdownFileContent(entry.sourcePath)
                    if (rawContent == null) {
                        log.warn("Reference archive: cannot read markdown for %s at %s — skipping", mapKey, entry.sourcePath)
                        continue
                    }

                    val fullRef = ReferenceStore.readReferenceMarkdown(entry.sourcePath)
                    if (fullRef == null) {
                        log.warn("Reference archive: %s unparseable — skipping", mapKey)
                        continue
                    }

                    val archivedKey = "$mapKey-$shortHash"
                    val source = entry.source
                    val sanitizedBareKey = ReferenceStore.sanitizeNativeIdForPath(source, archivedKey.removePrefix("${source.name}:"))
                    val orphanPath = "references/${source.name}/$sanitizedBareKey.md"

                    referenceCommitRefs.add(ReferenceCommitRef(
                        archivedKey = archivedKey,
                        source = source,
                        nativeId = entry.nativeId,
                        title = entry.title,
                        url = entry.url,
                        fields = fullRef.fields?.takeIf { it.isNotEmpty() },
                        referencedAt = fullRef.referencedAt,
                        sourceToolName = entry.sourceToolName,
                    ))
                    referenceFilesToStore.add(FileWrite(orphanPath, rawContent))
                    referenceCommitted.add(Triple(mapKey, entry.sourcePath, entry.updatedAt))

                    log.info("Reference snapshot captured: %s → %s", mapKey, archivedKey)
                }
            }

            // 9. Build and store CommitSummary — type comes from the op captured at
            //    enqueue time (the drained JVM has no GIT_REFLOG_ACTION to read).
            val commitType = when (op.type) {
                "cherry-pick" -> CommitType.`cherry-pick`
                "revert" -> CommitType.revert
                else -> CommitType.commit
            }

            // 8d. Detect uncommitted notes on this branch, archive, and attach to the summary.
            //     Mirrors the plan path (8b): the note body is written through the StorageProvider
            //     (so it dual-writes to the orphan branch AND the Memory Bank folder), a
            //     NoteReference goes into the summary so the committed memory shows it, and the
            //     registry row is later stamped committed (finalizeNoteArchive) so it clears from
            //     the CONTEXT panel. Excluded notes and notes from other branches stay pending.
            val noteRefs = mutableListOf<NoteReference>()
            val noteFilesToStore = mutableListOf<FileWrite>()
            val noteGuards = mutableListOf<Pair<String, String>>() // id -> contentHashAtCommit
            val snippetFilesToDelete = mutableListOf<String>()
            run {
                val noteNow = Instant.now().toString()
                val shortHash = commitInfo.hash.take(8)
                val uncommittedNotes = detectUncommittedNotes(cwd, exclusions.notes)
                if (uncommittedNotes.isNotEmpty()) {
                    log.info("Detected %d uncommitted note(s): %s", uncommittedNotes.size, uncommittedNotes.keys.joinToString(", "))
                    for ((id, entry) in uncommittedNotes) {
                        try {
                            val sourcePath = entry.sourcePath
                            if (sourcePath == null || !File(sourcePath).exists()) {
                                log.warn("Note archive: source file missing for %s — skipping", id)
                                continue
                            }
                            val content = File(sourcePath).readText(Charsets.UTF_8)
                            val newId = "$id-$shortHash"
                            noteFilesToStore.add(FileWrite("notes/$newId.md", content))
                            noteRefs.add(NoteReference(
                                id = newId,
                                title = entry.title,
                                format = entry.format,
                                content = if (entry.format == NoteFormat.snippet) content else null,
                                addedAt = entry.addedAt,
                                updatedAt = noteNow,
                            ))
                            noteGuards.add(id to sha256Hex(content))
                            if (entry.format == NoteFormat.snippet) snippetFilesToDelete.add(sourcePath)
                            log.info("Note snapshot captured: %s → %s", id, newId)
                        } catch (e: Exception) {
                            log.warn("Note archive failed for %s (non-fatal, skipping): %s", id, e.message)
                        }
                    }
                }
            }

            // Build stored sessions first so we can aggregate this commit's
            // coding-session token usage from their per-message usage.
            val storedSessions = sessionTranscripts.map { st ->
                log.info("StoredSession: sessionId=%s, source=%s, entries=%d", st.sessionId.take(8), st.source, st.entries.size)
                StoredSession(st.sessionId, source = st.source, transcriptPath = st.transcriptPath, entries = st.entries)
            }
            // Canonical (TS-identical) conversation usage: token breakdown + per-model cost.
            val usage = ConversationUsage.aggregate(storedSessions)
            log.info(
                "ConversationUsage: %s",
                usage?.let { "tokens=${it.conversationTokens} in=${it.breakdown.input} out=${it.breakdown.output} cached=${it.breakdown.cached} cost=${it.estimatedCostUsd}" }
                    ?: "none",
            )

            val summary = CommitSummary(
                version = SummaryTree.CURRENT_SCHEMA_VERSION,
                commitHash = commitInfo.hash,
                commitMessage = commitInfo.message,
                commitAuthor = commitInfo.author,
                commitDate = commitInfo.date,
                branch = branch,
                generatedAt = Instant.now().toString(),
                commitType = commitType,
                commitSource = commitSource,
                transcriptEntries = summaryResult.transcriptEntries,
                conversationTurns = summaryResult.conversationTurns,
                llm = summaryResult.llm,
                conversationTokens = usage?.conversationTokens,
                conversationTokenBreakdown = usage?.breakdown,
                conversationModels = usage?.models?.takeIf { it.isNotEmpty() },
                estimatedCostUsd = usage?.estimatedCostUsd,
                pricesAsOf = usage?.estimatedCostUsd?.let { ModelPricing.PRICES_AS_OF },
                stats = summaryResult.stats,
                topics = summaryResult.topics,
                ticketId = summaryResult.ticketId,
                recap = summaryResult.recap,
                plans = planRefs.takeIf { it.isNotEmpty() },
                notes = noteRefs.takeIf { it.isNotEmpty() },
                references = referenceCommitRefs.takeIf { it.isNotEmpty() },
            )

            val storedTranscript = StoredTranscript(storedSessions)
            log.info("StoredTranscript: %d session(s) total", storedSessions.size)

            log.info("Step 9: Calling store.storeSummary for %s (branch=%s)", commitInfo.hash.take(8), branch)
            store.storeSummary(
                summary, force = force, transcript = storedTranscript,
                planProgress = planProgressArtifacts.takeIf { it.isNotEmpty() },
                referenceFiles = referenceFilesToStore.takeIf { it.isNotEmpty() },
            )

            // Persist note bodies through the StorageProvider so they dual-write to the
            // orphan branch and the Memory Bank folder, then stamp/clean up the registry.
            if (noteFilesToStore.isNotEmpty()) {
                store.storeNoteFiles(noteFilesToStore, "Associate notes with commit ${commitInfo.hash.take(8)}")
            }

            // Finalize: delete archived references from plans.json + local markdown
            // (only if updatedAt matches — a re-upsert during this window preserves the fresh row)
            if (referenceCommitted.isNotEmpty()) {
                finalizeReferenceArchive(referenceCommitted, cwd)
            }
            // Finalize notes: stamp the original rows committed (so they clear from CONTEXT)
            // and delete the now-archived snippet files.
            if (noteGuards.isNotEmpty() || snippetFilesToDelete.isNotEmpty()) {
                finalizeNoteArchive(noteGuards, commitInfo.hash, snippetFilesToDelete, cwd)
            }

            // Discard the unchecked working items: the CHECKED ones were archived above;
            // the excluded ones are useless per the user's selection, so remove their
            // registry rows (+ .jolli-owned backing files) WITHOUT archiving them into
            // committed memory.
            discardExcludedWorkingItems(exclusions, cwd)
            log.info("=== PostCommitHook worker finished successfully for %s ===", commitInfo.hash.take(8))

        }
    }

    /**
     * Drains pending sources into topic pages and re-renders the visible `_wiki/`
     * for the committed repo — the IntelliJ analog of the CLI QueueWorker's
     * `runIngestFromQueue`, so a user's wiki stays fresh on every commit, not only
     * when the "Build Knowledge Wiki" button is clicked.
     *
     * Credential-missing is a silent skip. Serialized against sync / the manual
     * sweep on the shared vault-write lock (wait, then skip — the next commit retries).
     */
    private fun runIngestAndRender(cwd: String, config: JolliMemoryConfig) {
        // Either a Jolli sign-in (proxy) or an Anthropic key (direct) can drive ingest;
        // silent skip when neither is present (mirrors the CLI worker).
        val hasCredentials = !config.apiKey.isNullOrBlank() ||
            !config.jolliApiKey.isNullOrBlank() ||
            !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()
        if (!hasCredentials) {
            log.info("No LLM credentials configured — skipping post-commit wiki ingest")
            return
        }

        val repoName = KBPathResolver.extractRepoName(cwd)
        val remoteUrl = KBPathResolver.getRemoteUrl(cwd)
        val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
        val storage = FolderStorage(kbRoot, MetadataManager(kbRoot.resolve(".jolli")))

        val lockRoot = kbRoot.parent.toAbsolutePath().normalize().toString()
        val handle = VaultWriteLock.acquire(lockRoot, VaultWriteLockMode.Wait(VaultWriteLock.DEFAULT_WAIT_MS))
        if (handle == null) {
            log.warn("vault-write lock busy — skipping post-commit ingest (next commit retries)")
            return
        }
        try {
            val llmConfig = IngestPipeline.LlmConfig(
                apiKey = config.apiKey,
                jolliApiKey = config.jolliApiKey,
                model = config.model,
                aiProvider = config.aiProvider,
            )
            ingestAndRenderRepo(kbRoot, storage, IngestPipeline.defaultLlmCaller(llmConfig), config.model)
        } finally {
            handle.release()
        }
    }

    /**
     * Lock-free core of [runIngestAndRender]: drains pending sources, then
     * re-renders the visible wiki when new sources landed OR the wiki is gone
     * (user deleted `_wiki/`) — mirroring the CLI worker's render condition.
     * Returns whether a render happened. Internal for testing.
     */
    internal fun ingestAndRenderRepo(
        kbRoot: java.nio.file.Path,
        storage: StorageProvider,
        llm: IngestPipeline.LlmCaller,
        model: String?,
    ): Boolean {
        val drain = IngestPipeline.drainIngest(kbRoot, storage, llm, model)
        log.info("Post-commit ingest: %d batch(es), %d source(s)", drain.batches, drain.ingested)
        val shouldRender = drain.ingested > 0 || !storage.isTopicWikiPresent()
        if (shouldRender) TopicWikiRenderer.renderTopicKBWiki(storage)
        return shouldRender
    }

    /** Squash / rebase-squash: consolidate the source summaries into the new commit. */
    private fun processSquash(sourceHashes: List<String>, commitInfo: CommitInfo, store: SummaryStore, config: JolliMemoryConfig) {
        val oldSummaries = sourceHashes.mapNotNull { store.getSummary(it) }
        if (oldSummaries.isEmpty()) {
            log.warn("Squash op for %s: no source summaries found — skipping", commitInfo.hash.take(8))
            return
        }
        val apiKey = config.apiKey ?: System.getenv("ANTHROPIC_API_KEY")
        store.mergeManyToOne(
            oldSummaries, commitInfo,
            apiKey = apiKey,
            model = config.model,
            jolliApiKey = config.jolliApiKey,
            aiProvider = config.aiProvider,
        )
    }

    /** Amend / rebase-pick: 1:1 migrate the old summary to the new hash (no LLM). */
    private fun processAmend(oldHash: String?, commitInfo: CommitInfo, store: SummaryStore) {
        if (oldHash == null) {
            log.warn("Amend/pick op for %s: no source hash — skipping", commitInfo.hash.take(8))
            return
        }
        log.info("Migrating summary: %s -> %s", oldHash.take(8), commitInfo.hash.take(8))
        val oldSummary = store.getSummary(oldHash)
            ?: store.findRootHash(oldHash)?.let { store.getSummary(it) }
            ?: return
        store.migrateOneToOne(oldSummary, commitInfo)
    }

    /**
     * Slugs of plans to ARCHIVE into this commit: uncommitted, not ignored, and NOT
     * unchecked by the user. Excluded (unchecked) plans are left out here — they are
     * discarded separately by [discardExcludedWorkingItems], never archived. No branch
     * filter: uncommitted plans follow the user across branches (matches the CLI).
     */
    private fun detectUncommittedPlanSlugs(cwd: String, excluded: Set<String>): Set<String> {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        return registry.plans.entries
            .filter { (slug, entry) -> entry.commitHash == null && entry.ignored != true && slug !in excluded }
            .map { (slug, _) -> slug }
            .toSet()
    }

    private fun parseDiffStats(statOutput: String): DiffStats {
        var files = 0; var ins = 0; var del = 0
        for (line in statOutput.lines()) {
            val parts = line.trim().split("\\s+".toRegex())
            if (parts.size >= 3) {
                // git diff --numstat uses "-" for binary files; count them as changed files
                val isBinary = parts[0] == "-" && parts[1] == "-"
                if (isBinary) {
                    files++
                    continue
                }
                val insertions = parts[0].toIntOrNull() ?: continue
                val deletions = parts[1].toIntOrNull() ?: continue
                ins += insertions
                del += deletions
                files++
            }
        }
        return DiffStats(files, ins, del)
    }

    /**
     * References to ARCHIVE into this commit: every plans.json reference row is
     * uncommitted (a commit deletes the row) and NOT unchecked by the user. Excluded
     * references are left out here — they are discarded by [discardExcludedWorkingItems],
     * never archived. No branch filter: uncommitted references follow the user across
     * branches (matches the CLI).
     */
    private fun detectUncommittedReferences(
        cwd: String,
        excluded: Set<String>,
    ): Map<String, ai.jolli.jollimemory.core.references.ReferenceEntry> {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        return (registry.references ?: emptyMap()).filter { (mapKey, _) -> mapKey !in excluded }
    }

    /**
     * Notes to ARCHIVE into this commit: uncommitted, not ignored, and not unchecked via
     * the sidebar. Excluded notes are discarded by [discardExcludedWorkingItems], never
     * archived. No branch filter: uncommitted notes follow the user across branches.
     */
    private fun detectUncommittedNotes(cwd: String, excluded: Set<String>): Map<String, NoteEntry> {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        return (registry.notes ?: emptyMap()).filter { (id, entry) ->
            entry.commitHash == null &&
                entry.ignored != true &&
                id !in excluded
        }
    }

    /**
     * Stamps each captured note's registry row as committed (commitHash +
     * contentHashAtCommit) so `PlansPanel.filterNotes` hides it, and deletes the
     * now-archived snippet source files. Stamping skips a row that became committed
     * or was edited since capture (commitHash already set), so a concurrent change
     * is never clobbered.
     */
    private fun finalizeNoteArchive(
        guards: List<Pair<String, String>>,
        commitHash: String,
        snippetFilesToDelete: List<String>,
        cwd: String,
    ) {
        if (guards.isNotEmpty()) {
            val now = Instant.now().toString()
            val fresh = SessionTracker.loadPlansRegistry(cwd)
            val notes = (fresh.notes ?: emptyMap()).toMutableMap()
            for ((id, contentHash) in guards) {
                val entry = notes[id] ?: continue
                if (entry.commitHash != null) continue
                notes[id] = entry.copy(commitHash = commitHash, updatedAt = now, contentHashAtCommit = contentHash)
            }
            SessionTracker.savePlansRegistry(fresh.copy(notes = notes.takeIf { it.isNotEmpty() }), cwd)
        }
        for (path in snippetFilesToDelete) {
            try { File(path).delete() } catch (_: Exception) { /* best-effort */ }
        }
        log.info("Note finalize: stamped %d note(s), removed %d snippet file(s)", guards.size, snippetFilesToDelete.size)
    }

    /** Lowercase hex SHA-256 of a string — used for the note archive guard. */
    private fun sha256Hex(s: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /**
     * Deletes archived references from plans.json + local markdown.
     * Only deletes if updatedAt still matches (a re-upsert during this window
     * bumps updatedAt, so the fresh row is preserved).
     */
    private fun finalizeReferenceArchive(committed: List<Triple<String, String, String>>, cwd: String) {
        val freshRegistry = SessionTracker.loadPlansRegistry(cwd)
        val freshRefs = (freshRegistry.references ?: emptyMap()).toMutableMap()
        val toDeleteMarkdown = mutableListOf<String>()

        for ((mapKey, sourcePath, updatedAt) in committed) {
            val fresh = freshRefs[mapKey]
            if (fresh != null && fresh.updatedAt != updatedAt) {
                log.info("Reference finalize: %s re-upserted since capture — keeping active row", mapKey)
                continue
            }
            freshRefs.remove(mapKey)
            toDeleteMarkdown.add(sourcePath)
        }

        if (toDeleteMarkdown.isNotEmpty() || freshRefs.size != (freshRegistry.references?.size ?: 0)) {
            val updated = freshRegistry.copy(
                references = freshRefs.takeIf { it.isNotEmpty() },
            )
            SessionTracker.savePlansRegistry(updated, cwd)
        }

        for (path in toDeleteMarkdown) {
            ReferenceStore.deleteReferenceMarkdown(path)
        }
        log.info("Reference finalize: deleted %d of %d ref(s)", toDeleteMarkdown.size, committed.size)
    }

    /**
     * Discards the working-area items the user left UNCHECKED: removes the excluded
     * uncommitted rows from plans.json (+ their `.jolli`-owned backing files) WITHOUT
     * archiving them into committed memory. Mirrors the CLI `discardExcludedWorkingItems`.
     *
     * - Plans: registry row removed; the external `~/.claude/plans/<slug>.md` is left
     *   untouched (user-owned). Hard-deletes the row (not `ignored=true`) so the on-disk
     *   plans.json state matches whichever worker — CLI or native — ran the commit.
     * - Notes: registry row removed; backing file deleted only for uncommitted snippet
     *   notes (external markdown note sources are preserved).
     * - References: registry row removed; backing markdown (always `.jolli`) deleted.
     *
     * Only uncommitted rows are touched, so a stale exclusion key can never clobber a
     * committed guard row.
     */
    private fun discardExcludedWorkingItems(exclusions: CommitSelectionStore.CommitExclusions, cwd: String) {
        if (exclusions.plans.isEmpty() && exclusions.notes.isEmpty() && exclusions.references.isEmpty()) return

        val registry = SessionTracker.loadPlansRegistry(cwd)
        val plans = registry.plans.toMutableMap()
        val notes = (registry.notes ?: emptyMap()).toMutableMap()
        val references = (registry.references ?: emptyMap()).toMutableMap()
        val noteFilesToDelete = mutableListOf<String>()
        val refFilesToDelete = mutableListOf<String>()
        var removedPlans = 0
        var removedNotes = 0
        var removedRefs = 0

        for (slug in exclusions.plans) {
            val entry = plans[slug]
            if (entry != null && entry.commitHash == null && entry.contentHashAtCommit == null) {
                plans.remove(slug)
                removedPlans++
            }
        }
        for (id in exclusions.notes) {
            val entry = notes[id]
            if (entry != null && entry.commitHash == null && entry.contentHashAtCommit == null) {
                if (entry.format == NoteFormat.snippet && entry.sourcePath != null) noteFilesToDelete.add(entry.sourcePath)
                notes.remove(id)
                removedNotes++
            }
        }
        for (mapKey in exclusions.references) {
            val entry = references[mapKey]
            if (entry != null) {
                refFilesToDelete.add(entry.sourcePath)
                references.remove(mapKey)
                removedRefs++
            }
        }

        if (removedPlans > 0 || removedNotes > 0 || removedRefs > 0) {
            SessionTracker.savePlansRegistry(
                registry.copy(
                    plans = plans,
                    notes = notes.takeIf { it.isNotEmpty() },
                    references = references.takeIf { it.isNotEmpty() },
                ),
                cwd,
            )
        }

        // Backing-file cleanup after the registry write — snippet note bodies and
        // reference markdown live under .jolli/jollimemory/ (owned); external note
        // sources and ~/.claude/plans files are never deleted.
        for (path in noteFilesToDelete) {
            try {
                val file = File(path)
                if (file.exists()) file.delete()
            } catch (_: Exception) { /* best-effort */ }
        }
        for (path in refFilesToDelete) {
            ReferenceStore.deleteReferenceMarkdown(path)
        }

        if (removedPlans > 0 || removedNotes > 0 || removedRefs > 0) {
            log.info(
                "Discarded excluded working items: %d plan(s), %d note(s), %d reference(s)",
                removedPlans, removedNotes, removedRefs,
            )
        }
    }

    /** Get the path to this JAR file (for spawning the worker). */
    private fun getJarPath(): String? {
        return try {
            val source = PostCommitHook::class.java.protectionDomain.codeSource
            java.io.File(source.location.toURI()).absolutePath
        } catch (_: Exception) {
            null
        }
    }
}
