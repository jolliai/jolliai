package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.*
import ai.jolli.jollimemory.services.PlanService
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

    /** Launcher: spawns the worker as a background process. */
    fun launch(args: Array<String>) {
        val cwd = System.getProperty("user.dir")
        JmLogger.setLogDir(cwd)

        if (isRebase(cwd)) {
            log.info("Rebase in progress — skipping post-commit worker")
            return
        }

        log.info("PostCommitHook launcher — spawning background worker")

        val javaHome = System.getProperty("java.home")
        val javaBin = "$javaHome/bin/java"
        val jarPath = getJarPath() ?: return
        val cmd = listOf(javaBin, "-jar", jarPath, "post-commit", "--worker")

        try {
            // Redirect worker output to log file instead of inheritIO().
            // inheritIO() causes the worker to hold git's stdout/stderr FDs open,
            // which makes git wait for the hook to finish (blocking the commit).
            val logDir = java.io.File(JmLogger.getJolliMemoryDir(cwd))
            logDir.mkdirs()
            val workerLog = java.io.File(logDir, "post-commit-worker.log")

            ProcessBuilder(cmd)
                .directory(java.io.File(cwd))
                .redirectOutput(ProcessBuilder.Redirect.appendTo(workerLog))
                .redirectError(ProcessBuilder.Redirect.appendTo(workerLog))
                .start()
            log.info("Worker process spawned (output → %s)", workerLog.absolutePath)
        } catch (e: Exception) {
            log.error("Failed to spawn worker: %s", e.message)
        }
    }

    /** Worker: runs the actual summarization pipeline. */
    fun runWorker(cwd: String, force: Boolean = false) {
        JmLogger.setLogDir(cwd)
        log.info("=== PostCommitHook worker started (cwd=%s, force=%s) ===", cwd, force)

        val git = GitOps(cwd)
        log.info("Creating storage via StorageFactory.create")
        val storage = StorageFactory.create(git, cwd)
        log.info("Storage created: %s", storage::class.simpleName)
        val store = SummaryStore(cwd, git, storage)
        val config = SessionTracker.loadConfig(cwd)
        log.info("Config loaded: apiKey=%s, jolliApiKey=%s, model=%s", if (config.apiKey != null) "set" else "null", if (config.jolliApiKey != null) "set" else "null", config.model ?: "default")

        // Load log level from config
        val logLevel = config.logLevel?.let { try { LogLevel.valueOf(it) } catch (_: Exception) { null } }
        if (logLevel != null) JmLogger.setLogLevel(logLevel)

        // Acquire lock
        if (!SessionTracker.acquireLock(cwd)) {
            log.warn("Cannot acquire lock — another worker is running")
            return
        }

        try {
            // 1. Get HEAD commit info
            val commitInfoStr = git.getHeadCommitInfo()
            if (commitInfoStr == null) {
                log.error("Cannot get HEAD commit info")
                return
            }
            val parts = commitInfoStr.split("\u0000")
            if (parts.size < 4) return
            val commitInfo = CommitInfo(parts[0], parts[1], parts[2], parts[3])
            log.info("HEAD: %s — %s", commitInfo.hash.take(8), commitInfo.message.take(60))

            // Detect commit source (plugin or CLI)
            val commitSource = if (SessionTracker.loadPluginSource(cwd)) {
                SessionTracker.deletePluginSource(cwd)
                CommitSource.plugin
            } else CommitSource.cli

            // 2. Check for squash-pending
            val squashPending = SessionTracker.loadSquashPending(cwd)
            if (squashPending != null) {
                SessionTracker.deleteSquashPending(cwd)
                // Validate: a stale squash-pending from a failed lock can be consumed
                // by an unrelated future commit. Compare expectedParentHash against HEAD~1.
                val parentHash = git.exec("rev-parse", "HEAD~1")?.trim()
                if (parentHash != null && parentHash != squashPending.expectedParentHash) {
                    log.warn(
                        "Stale squash-pending: expected parent %s but HEAD~1 is %s — discarding",
                        squashPending.expectedParentHash.take(8), parentHash.take(8)
                    )
                } else {
                    handleSquash(store, squashPending, commitInfo)
                    return
                }
            }

            // 3. Check for amend-pending
            val amendPending = SessionTracker.loadAmendPending(cwd)
            if (amendPending != null) {
                SessionTracker.deleteAmendPending(cwd)
                handleAmend(store, amendPending, commitInfo)
                return
            }

            // 4. Load sessions and read transcripts
            log.info("Step 4: Loading sessions")
            val allSessions = SessionTracker.loadAllSessions(cwd).toMutableList()

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

            val sessions = allSessions
            log.info("Discovered %d session(s): %s", sessions.size,
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
                            TranscriptReader.readTranscript(session.transcriptPath, cursor, parser)
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

                    if (result.entries.isNotEmpty()) {
                        sessionTranscripts.add(TranscriptReader.SessionTranscript(
                            session.sessionId, session.transcriptPath, result.entries, source
                        ))
                    }
                    totalEntries += result.totalLinesRead
                    totalTurns += result.entries.count { it.role == "human" }
                    SessionTracker.saveCursor(result.newCursor, cwd)
                } catch (e: Exception) {
                    log.warn("Failed to read transcript for session %s (%s), skipping: %s",
                        session.sessionId.take(8), source, e.message ?: e.toString())
                }
            }

            // 5. Get diff
            log.info("Step 5: Getting diff (transcripts=%d entries, %d turns)", totalEntries, totalTurns)
            val diff = git.getDiffContent() ?: ""
            val diffStatStr = git.getDiffStats() ?: ""
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
            ))
            log.info("Step 8: LLM call completed, topics=%d, recap=%s", summaryResult.topics?.size ?: 0, if (summaryResult.recap != null) "${summaryResult.recap!!.length} chars" else "null")

            // 8b. Detect uncommitted plans, archive, and evaluate progress
            val planRefs = mutableListOf<PlanReference>()
            val planProgressArtifacts = mutableListOf<PlanProgressArtifact>()

            val uncommittedSlugs = detectUncommittedPlanSlugs(cwd)
            if (uncommittedSlugs.isNotEmpty()) {
                log.info("Detected %d uncommitted plan(s): %s", uncommittedSlugs.size, uncommittedSlugs.joinToString(", "))
                val plansDir = File(System.getProperty("user.home"), ".claude/plans")
                val topics: List<TopicSummary> = summaryResult.topics ?: emptyList()
                val commitDate = Instant.parse(commitInfo.date).toString()

                for (slug in uncommittedSlugs) {
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
                }
                log.info("Plan progress: evaluated %d/%d plan(s)", planProgressArtifacts.size, planRefs.size)
            }

            // 9. Build and store CommitSummary
            val branch = git.getCurrentBranch() ?: "unknown"
            val commitType = detectCommitType()
            val summary = CommitSummary(
                version = 3,
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
                stats = summaryResult.stats,
                topics = summaryResult.topics,
                ticketId = summaryResult.ticketId,
                recap = summaryResult.recap,
                plans = planRefs.takeIf { it.isNotEmpty() },
            )

            // Store transcript data alongside summary
            val storedSessions = sessionTranscripts.map { st ->
                log.info("StoredSession: sessionId=%s, source=%s, entries=%d", st.sessionId.take(8), st.source, st.entries.size)
                StoredSession(st.sessionId, source = st.source, entries = st.entries)
            }
            val storedTranscript = StoredTranscript(storedSessions)
            log.info("StoredTranscript: %d session(s) total", storedSessions.size)

            log.info("Step 9: Calling store.storeSummary for %s (branch=%s)", commitInfo.hash.take(8), branch)
            store.storeSummary(summary, force = force, transcript = storedTranscript, planProgress = planProgressArtifacts.takeIf { it.isNotEmpty() })
            log.info("=== PostCommitHook worker finished successfully for %s ===", commitInfo.hash.take(8))

        } finally {
            SessionTracker.releaseLock(cwd)
        }
    }

    private fun handleSquash(store: SummaryStore, pending: SquashPendingState, commitInfo: CommitInfo) {
        log.info("Handling squash: %d source hashes", pending.sourceHashes.size)
        val oldSummaries = pending.sourceHashes.mapNotNull { store.getSummary(it) }
        if (oldSummaries.isEmpty()) {
            log.info("No existing summaries to merge")
            return
        }
        store.mergeManyToOne(oldSummaries, commitInfo)
    }

    private fun handleAmend(store: SummaryStore, pending: AmendPendingState, commitInfo: CommitInfo) {
        log.info("Handling amend: %s → %s", pending.oldHash.take(8), commitInfo.hash.take(8))
        val oldSummary = store.getSummary(pending.oldHash) ?: return
        store.migrateOneToOne(oldSummary, commitInfo)
    }

    /**
     * Detects the commit type from GIT_REFLOG_ACTION environment variable.
     * Values: cherry-pick, revert, commit (regular), etc.
     */
    private fun detectCommitType(): CommitType? {
        val reflogAction = System.getenv("GIT_REFLOG_ACTION") ?: return CommitType.commit
        return when {
            reflogAction.startsWith("cherry-pick") -> CommitType.`cherry-pick`
            reflogAction.startsWith("revert") -> CommitType.revert
            reflogAction.startsWith("rebase") -> CommitType.rebase
            reflogAction.startsWith("commit --amend") -> CommitType.amend
            reflogAction.startsWith("commit") -> CommitType.commit
            else -> CommitType.commit
        }
    }

    /** Returns slugs of plans in plans.json that are not yet committed and not ignored. */
    private fun detectUncommittedPlanSlugs(cwd: String): Set<String> {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        return registry.plans.entries
            .filter { (_, entry) -> entry.commitHash == null && entry.ignored != true }
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
