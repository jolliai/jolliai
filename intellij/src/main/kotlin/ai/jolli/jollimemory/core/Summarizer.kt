package ai.jolli.jollimemory.core

/**
 * Summarizer — Kotlin port of Summarizer.ts
 *
 * Calls the Anthropic API to generate structured multi-topic commit summaries.
 * Also generates commit messages and squash messages.
 */
object Summarizer {

    private val log = JmLogger.create("Summarizer")
    private const val DEFAULT_MODEL_ALIAS = "sonnet"
    private const val DEFAULT_MAX_TOKENS = 8192

    private val MODEL_ALIAS_MAP = mapOf(
        "haiku" to "claude-haiku-4-5-20251001",
        "sonnet" to "claude-sonnet-4-6",
        "opus" to "claude-opus-4-6",
    )

    fun resolveModelId(aliasOrId: String?): String {
        val key = aliasOrId ?: DEFAULT_MODEL_ALIAS
        return MODEL_ALIAS_MAP[key] ?: key
    }

    /** Result from generateSummary */
    data class SummaryResult(
        val transcriptEntries: Int,
        val conversationTurns: Int? = null,
        val llm: LlmCallMetadata,
        val stats: DiffStats,
        val topics: List<TopicSummary>,
        val ticketId: String? = null,
    )

    /** Parameters for generating a summary */
    data class SummarizeParams(
        val conversation: String,
        val diff: String,
        val commitInfo: CommitInfo,
        val diffStats: DiffStats,
        val transcriptEntries: Int,
        val conversationTurns: Int? = null,
        val apiKey: String? = null,
        val model: String? = null,
        val jolliApiKey: String? = null,
    )

    /** Builds the full summarization prompt. */
    fun buildSummarizationPrompt(conversation: String, diff: String, commitInfo: CommitInfo): String {
        return """You are JolliMemory, an AI development process documentation tool. Your job is to analyze a development session (human-AI conversation + code changes) and produce a structured summary.

## Input

### Commit Information
- Hash: ${commitInfo.hash}
- Message: ${commitInfo.message}
- Author: ${commitInfo.author}
- Date: ${commitInfo.date}

### Development Session Transcript (conversation context)
$conversation

### Code Changes (git diff — for verification)
```diff
$diff
```

## Instructions

Identify the distinct problems or tasks worked on during this session. Each independent user goal should be its own topic. Order topics by conversation timeline (most recent first, like git log). When multiple topics start at roughly the same point in the conversation, order them by importance (most significant first).

Return your response using the following delimited plain-text format. Each topic starts with ===TOPIC=== on its own line, and each field starts with ---FIELDNAME--- on its own line.

Before the first topic, output the ticket identifier if one exists:

---TICKETID---
PROJ-597

===TOPIC===
---TITLE---
8-15 word concrete and searchable label for this topic
---TRIGGER---
1-2 sentences: the problem, bug, or need that prompted this work.
---RESPONSE---
What was implemented or fixed.
---DECISIONS---
Why THIS approach was chosen over alternatives.
---TODO---
Tech debt, deferred work, or follow-up items.
---FILESAFFECTED---
src/Auth.ts, src/Middleware.ts
---CATEGORY---
feature
---IMPORTANCE---
major

## Rules
1. The summary has two audiences. Narrative fields use plain language. Detail fields may use technical identifiers.
2. decisions is the most valuable field — it captures reasoning that cannot be reconstructed from the diff alone.
3. trigger should remain concise (1-2 sentences).
4. response is a detail field — be specific and technical.
5. title must use plain language while remaining concrete and searchable.
6. Create one topic per independent user goal.
7. If the conversation is empty, infer topics from the diff and commit message.
8. todo: only include when deferred work was EXPLICITLY discussed.
9. The conversation transcript is the PRIMARY source.
10. Extract high-value elements for trigger and decisions.
11. Return ONLY the delimited text.
12. filesAffected: list the 2-6 most important files changed.
13. category: pick one from: feature, bugfix, refactor, tech-debt, performance, security, test, docs, ux, devops.
14. importance: "major" for features/bugs/architectural decisions. "minor" for cleanup/config.
15. If a change has no meaningful decision, do NOT create a topic. If ALL are omitted, output: ===NO_TOPICS===
16. ticketId: extract from commit message, branch, or conversation.
17. NEVER use ===TOPIC=== or ---FIELDNAME--- inside your content."""
    }

    /** Generates a summary by calling the LLM (direct Anthropic or Jolli proxy). */
    fun generateSummary(params: SummarizeParams): SummaryResult {
        log.info("Generating summary for commit %s", params.commitInfo.hash.take(8))

        // Select template variant based on diff size (matches CLI logic)
        val totalLines = params.diffStats.insertions + params.diffStats.deletions
        val workSize = when {
            totalLines <= 100 -> "small"
            totalLines <= 500 -> "medium"
            else -> "large"
        }

        val prompt = buildSummarizationPrompt(params.conversation, params.diff, params.commitInfo)
        val proxyParams = mapOf(
            "commitHash" to params.commitInfo.hash,
            "commitMessage" to params.commitInfo.message,
            "commitAuthor" to params.commitInfo.author,
            "commitDate" to params.commitInfo.date,
            "conversation" to params.conversation,
            "diff" to params.diff,
        )

        val result = LlmClient.callLlm(
            action = "summarize:$workSize",
            params = proxyParams,
            apiKey = params.apiKey,
            jolliApiKey = params.jolliApiKey,
            model = resolveModelId(params.model),
            maxTokens = DEFAULT_MAX_TOKENS,
            prompt = prompt,
        )

        log.info("API response in %dms (in=%d, out=%d)", result.apiLatencyMs, result.inputTokens, result.outputTokens)

        val responseText = result.text
            ?: throw RuntimeException("No text content in API response")

        val parsed = parseSummaryResponse(responseText)
        log.info("Summary parsed: %d topic(s)", parsed.topics.size)

        val llm = LlmCallMetadata(
            model = result.model ?: resolveModelId(params.model),
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            apiLatencyMs = result.apiLatencyMs,
            stopReason = result.stopReason,
        )

        return SummaryResult(
            transcriptEntries = params.transcriptEntries,
            conversationTurns = params.conversationTurns,
            llm = llm,
            stats = params.diffStats,
            topics = parsed.topics,
            ticketId = parsed.ticketId,
        )
    }

    // ── Response Parsing ────────────────────────────────────────────────────

    private val TOPIC_DELIMITER_RE = Regex("^\\s*===TOPIC===\\s*$", RegexOption.MULTILINE)
    private val NO_TOPICS_RE = Regex("^\\s*===NO_TOPICS===\\s*$", RegexOption.MULTILINE)
    private val KNOWN_FIELDS = setOf("TITLE", "TRIGGER", "RESPONSE", "DECISIONS", "TODO", "FILESAFFECTED", "CATEGORY", "IMPORTANCE")
    private val EMPTY_DECISIONS_RE = Regex("^(no\\s+(design\\s+)?decisions?\\s+recorded|n/?a|none\\.?)$", RegexOption.IGNORE_CASE)

    data class ParsedResponse(
        val topics: List<TopicSummary>,
        val ticketId: String? = null,
        val intentionallyEmpty: Boolean = false,
    )

    fun parseSummaryResponse(responseText: String): ParsedResponse {
        var text = responseText
        val fenced = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(text)
        if (fenced != null) text = fenced.groupValues[1].trim()

        val ticketId = extractPreTopicTicketId(text)

        if (TOPIC_DELIMITER_RE.containsMatchIn(text)) {
            val topics = parseDelimitedTopics(text)
            if (topics != null && topics.isNotEmpty()) {
                val filtered = topics.filter {
                    it.decisions.trim().isNotEmpty() && !EMPTY_DECISIONS_RE.matches(it.decisions.trim())
                }
                return ParsedResponse(filtered, ticketId)
            }
        }

        if (NO_TOPICS_RE.containsMatchIn(text)) {
            return ParsedResponse(emptyList(), ticketId, intentionallyEmpty = true)
        }

        return ParsedResponse(emptyList(), ticketId)
    }

    private fun parseDelimitedTopics(text: String): List<TopicSummary>? {
        val segments = text.split(TOPIC_DELIMITER_RE).drop(1).filter { it.isNotBlank() }
        if (segments.isEmpty()) return null

        return segments.mapIndexed { idx, segment ->
            val fieldPattern = Regex("^---(\\w+)---$", RegexOption.MULTILINE)
            val fields = mutableMapOf<String, String>()
            var lastField: String? = null

            // Find all delimiter matches and extract field names with their content
            val matches = fieldPattern.findAll(segment).toList()
            for ((matchIdx, match) in matches.withIndex()) {
                val fieldName = match.groupValues[1].uppercase()
                val contentStart = match.range.last + 1
                val contentEnd = if (matchIdx + 1 < matches.size) matches[matchIdx + 1].range.first else segment.length
                val content = segment.substring(contentStart, contentEnd).trim()
                if (fieldName in KNOWN_FIELDS) {
                    fields[fieldName] = content
                    lastField = fieldName
                } else if (lastField != null) {
                    fields[lastField] = "${fields[lastField]}\n---${match.groupValues[1]}---\n$content"
                }
            }

            val filesAffected = fields["FILESAFFECTED"]?.split(Regex("[,\\n]"))
                ?.map { it.trim() }?.filter { it.isNotEmpty() }

            val category = try { fields["CATEGORY"]?.trim()?.lowercase()?.let { TopicCategory.valueOf(it) } } catch (_: Exception) { null }
            val importance = try { fields["IMPORTANCE"]?.trim()?.lowercase()?.let { TopicImportance.valueOf(it) } } catch (_: Exception) { null }

            TopicSummary(
                title = fields["TITLE"] ?: "Topic ${idx + 1}",
                trigger = fields["TRIGGER"] ?: "No trigger provided",
                response = fields["RESPONSE"] ?: "No response details provided",
                decisions = fields["DECISIONS"] ?: "No design decisions recorded",
                todo = fields["TODO"]?.takeIf { it.isNotBlank() },
                filesAffected = filesAffected,
                category = category,
                importance = importance,
            )
        }
    }

    private fun extractPreTopicTicketId(text: String): String? {
        val topicIdx = TOPIC_DELIMITER_RE.find(text)?.range?.first ?: text.length
        val preamble = text.substring(0, topicIdx)
        val match = Regex("^---(?:TICKETID|ticketId)---\\s*\\n(.+)", RegexOption.MULTILINE).find(preamble)
        return match?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
    }

    // ── Commit Message Generation ───────────────────────────────────────────

    fun buildCommitMessagePrompt(params: CommitMessageParams): String {
        val fileList = params.stagedFiles.joinToString(", ").ifEmpty { "(none)" }
        return """You are JolliMemory, an AI development assistant. Generate a concise git commit message for the staged changes below.

## Branch Name
${params.branch}

## Staged Files
$fileList

## Staged Diff
```diff
${params.stagedDiff.ifEmpty { "(empty diff — no staged changes)" }}
```

## Instructions
Write a single-line commit message (50-72 characters) that clearly describes WHAT was changed.

Rules:
1. Return ONLY the commit message — no explanation, no quotes, no markdown.
2. Use imperative mood ("Add", "Fix", "Refactor").
3. Be specific: name the key component or file changed.
4. Do NOT include multi-line bodies — just the single subject line.
5. Ticket prefix: if the branch name contains a ticket pattern, prefix with "Part of <TICKET>: "."""
    }

    fun generateCommitMessage(params: CommitMessageParams): String {
        val prompt = buildCommitMessagePrompt(params)
        val fileList = params.stagedFiles.joinToString(", ").ifEmpty { "(none)" }
        val proxyParams = mapOf(
            "stagedDiff" to params.stagedDiff.ifEmpty { "(empty diff -- no staged changes)" },
            "branch" to params.branch,
            "fileList" to fileList,
        )

        val result = LlmClient.callLlm(
            action = "commit-message",
            params = proxyParams,
            apiKey = params.apiKey,
            jolliApiKey = params.jolliApiKey,
            model = resolveModelId(params.model),
            maxTokens = 256,
            prompt = prompt,
        )

        val text = result.text
            ?: throw RuntimeException("No text content in API response")

        return text.trim('"', '\'')
    }

    // ── E2E Test Generation ──────────────────────────────────────────────

    /** Parameters for generating E2E test scenarios */
    data class E2eTestParams(
        val topics: List<TopicSummary>,
        val commitMessage: String,
        val diff: String,
        val apiKey: String? = null,
        val model: String? = null,
        val jolliApiKey: String? = null,
    )

    private val SCENARIO_DELIMITER_RE = Regex("^\\s*===SCENARIO===\\s*$", RegexOption.MULTILINE)
    private val E2E_KNOWN_FIELDS = setOf("TITLE", "PRECONDITIONS", "STEPS", "EXPECTED")

    /** Builds the prompt for E2E test scenario generation. */
    fun buildE2eTestPrompt(topics: List<TopicSummary>, commitMessage: String, diff: String): String {
        val maxScenarios = if (topics.size <= 3) 5 else 10

        val topicsSummary = topics.mapIndexed { i, t ->
            "### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Response:** ${t.response}"
        }.joinToString("\n\n")

        return """You are JolliMemory, an AI development process documentation tool. Your task is to generate step-by-step E2E testing instructions for PR reviewers who need to manually verify this commit's changes.

## Commit Message
$commitMessage

## Summary of Changes
$topicsSummary

## Code Diff
```diff
$diff
```

## Instructions

Generate one test scenario for each user-facing feature or bug fix. Skip topics that are purely internal refactoring, documentation, devops, or config changes — only generate scenarios for changes a user or reviewer can visually verify in the application.

Return your response using the following delimited plain-text format. Each scenario starts with ===SCENARIO=== on its own line, and each field starts with ---FIELDNAME--- on its own line.

===SCENARIO===
---TITLE---
Short label for this test scenario (e.g. "Article reordering" or "Login timeout fix")
---PRECONDITIONS---
What the reviewer needs to have ready before testing (e.g. "Have a Space with 3+ articles"). Omit this field entirely if no special setup is needed.
---STEPS---
1. Open the app and navigate to...
2. Click on...
3. Type "..." in the search box
4. Verify that...
---EXPECTED---
- The page should display...
- The confirmation message should appear
- The item should move to the new position

## Rules
1. Write for a NON-TECHNICAL person — no code, no file paths, no API names, no developer jargon.
2. Use everyday verbs: "open", "click", "type", "check", "scroll", "wait", "refresh".
3. Steps must be SPECIFIC and ACTIONABLE — not "test the feature" but "type 'hello' in the search box and press Enter".
4. Expected results must be VERIFIABLE — not "should work correctly" but "the page should display 3 search results".
5. Include boundary cases when relevant (e.g. "repeat with an empty list to verify the empty state message").
6. Each feature or bug fix gets its own ===SCENARIO=== block. Do NOT merge unrelated features into one scenario.
7. If a topic is minor refactoring, docs-only, devops, or has no user-visible impact, skip it entirely — do not generate a scenario.
8. Return ONLY the delimited text. No JSON, no markdown fences, no other wrapping.
9. NEVER use the literal strings ===SCENARIO=== or ---FIELDNAME--- inside your content.
10. The preconditions field is OPTIONAL — omit ---PRECONDITIONS--- entirely when no special setup is needed.
11. Keep each scenario to 6 steps or fewer. If a flow requires more, split it into two scenarios or combine minor sub-steps.
12. Generate at most $maxScenarios scenarios total. Focus on the most important user-facing changes. If there are more features than the limit, prioritize major features and user-visible bug fixes over minor improvements."""
    }

    /** Parses numbered list lines (e.g. "1. Do this\n2. Do that") into a list of strings. */
    private fun parseNumberedList(text: String): List<String> {
        return text.split("\n")
            .map { it.replace(Regex("^\\d+\\.\\s*"), "").trim() }
            .filter { it.isNotEmpty() }
    }

    /** Parses bullet or numbered list lines into a list of strings. */
    private fun parseBulletOrNumberedList(text: String): List<String> {
        return text.split("\n")
            .map { it.replace(Regex("^[-*]\\s+"), "").replace(Regex("^\\d+\\.\\s*"), "").trim() }
            .filter { it.isNotEmpty() }
    }

    /** Parses an AI response in delimited format into E2eTestScenario objects. */
    fun parseE2eTestResponse(text: String): List<E2eTestScenario> {
        var cleaned = text
        val fenced = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(cleaned)
        if (fenced != null) cleaned = fenced.groupValues[1].trim()

        val segments = cleaned.split(SCENARIO_DELIMITER_RE).filter { it.trim().isNotEmpty() }
        if (segments.isEmpty()) return emptyList()

        // NOTE: Kotlin's split(Regex) does NOT include capture groups in the result
        // (unlike JavaScript's String.split). We use findAll to extract field names
        // and content instead.
        val fieldDelimiterRe = Regex("^---(\\w+)---$", RegexOption.MULTILINE)

        val scenarios = mutableListOf<E2eTestScenario>()

        for (segment in segments) {
            val fields = mutableMapOf<String, String>()
            val matches = fieldDelimiterRe.findAll(segment).toList()
            if (matches.isEmpty()) continue

            for (j in matches.indices) {
                val fieldName = matches[j].groupValues[1].uppercase()
                val contentStart = matches[j].range.last + 1
                val contentEnd = if (j + 1 < matches.size) matches[j + 1].range.first else segment.length
                val content = segment.substring(contentStart, contentEnd).trim()

                if (fieldName in E2E_KNOWN_FIELDS) {
                    fields[fieldName] = content
                } else {
                    // Unknown field — append to the previous known field
                    val lastKnown = fields.keys.lastOrNull()
                    if (lastKnown != null) {
                        fields[lastKnown] = "${fields[lastKnown]}\n---${matches[j].groupValues[1]}---\n$content"
                    }
                }
            }

            val title = fields["TITLE"]?.trim() ?: continue
            val steps = parseNumberedList(fields["STEPS"] ?: "")
            val expectedResults = parseBulletOrNumberedList(fields["EXPECTED"] ?: "")
            if (steps.isEmpty()) continue

            val preconditions = fields["PRECONDITIONS"]?.trim()?.takeIf { it.isNotEmpty() }
            scenarios.add(E2eTestScenario(title = title, preconditions = preconditions, steps = steps, expectedResults = expectedResults))
        }

        return scenarios
    }

    /** Generates E2E test scenarios by calling the LLM (direct Anthropic or Jolli proxy). */
    fun generateE2eTest(params: E2eTestParams): List<E2eTestScenario> {
        log.info("Generating E2E test guide for: %s", params.commitMessage.take(60))
        val prompt = buildE2eTestPrompt(params.topics, params.commitMessage, params.diff)
        val maxScenarios = if (params.topics.size <= 3) 5 else 10
        val topicsSummary = params.topics.mapIndexed { i, t ->
            "### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Response:** ${t.response}"
        }.joinToString("\n\n")

        val proxyParams = mapOf(
            "commitMessage" to params.commitMessage,
            "topicsSummary" to topicsSummary,
            "diff" to params.diff,
            "maxScenarios" to maxScenarios.toString(),
        )

        val result = LlmClient.callLlm(
            action = "e2e-test",
            params = proxyParams,
            apiKey = params.apiKey,
            jolliApiKey = params.jolliApiKey,
            model = resolveModelId(params.model),
            maxTokens = DEFAULT_MAX_TOKENS,
            prompt = prompt,
        )

        val text = result.text
            ?: throw RuntimeException("No text in response")

        log.info("E2E raw response length: %d chars, first 500: %s", text.length, text.take(500))
        val scenarios = parseE2eTestResponse(text)
        log.info("E2E test guide parsed: %d scenario(s)", scenarios.size)
        return scenarios
    }

    // ── Translation ────────────────────────────────────────────────────────

    /** Builds the prompt for translating markdown content to English. */
    fun buildTranslationPrompt(content: String): String {
        return """Translate the following Markdown document into English.

Rules:
- Preserve ALL Markdown formatting exactly (headings, lists, code blocks, tables, links, bold/italic).
- Do NOT translate content inside code blocks (``` ... ``` or inline `...`).
- Keep technical terms, file paths, function names, and variable names unchanged.
- Do NOT add, remove, or reorder any content — only translate natural-language text.
- Output ONLY the translated Markdown, with no wrapping or commentary.

---

$content"""
    }

    /** Translates a Markdown document to English using the LLM (direct Anthropic or Jolli proxy). */
    fun translateToEnglish(content: String, apiKey: String?, model: String?, jolliApiKey: String? = null): String {
        log.info("Translating plan to English (%d chars)", content.length)
        val prompt = buildTranslationPrompt(content)

        val result = LlmClient.callLlm(
            action = "translate",
            params = mapOf("content" to content),
            apiKey = apiKey,
            jolliApiKey = jolliApiKey,
            model = resolveModelId(model),
            maxTokens = DEFAULT_MAX_TOKENS,
            prompt = prompt,
        )

        return result.text
            ?: throw RuntimeException("No text in translation response")
    }

    // ── Squash Message Generation ──────────────────────────────────────────

    /** Generates a squash commit message from multiple commits' summaries. */
    fun generateSquashMessage(
        commits: List<Pair<String, List<TopicSummary>>>,
        ticketId: String?,
        isFullSquash: Boolean,
        apiKey: String?,
        model: String?,
        jolliApiKey: String? = null,
    ): String {
        val commitsBlock = commits.mapIndexed { i, (msg, topics) ->
            val topicLines = if (topics.isNotEmpty()) {
                topics.joinToString("\n") { "   - ${it.title}\n     Why: ${it.trigger}" }
            } else "   (no summary available)"
            "${i + 1}. $msg\n   Topics:\n$topicLines"
        }.joinToString("\n\n")

        val ticketLine = ticketId ?: "No ticket associated"
        val scopeLine = if (isFullSquash) {
            "Full squash: ALL commits on this branch are being merged into one. This represents completed work."
        } else {
            "Partial squash: only some commits are being merged. Other commits remain on the branch."
        }

        val prompt = """You are JolliMemory, an AI development assistant. Generate a concise git commit message that summarizes the following commits being squashed into one.

## Ticket
$ticketLine

## Commits Being Squashed
$commitsBlock

## Squash Scope
$scopeLine

## Instructions

Write a single-line commit message (50-72 characters) that summarizes the combined work.

Rules:
1. Return ONLY the commit message -- no explanation, no quotes, no markdown.
2. Use imperative mood ("Add", "Fix", "Refactor").
3. Summarize the overall intent using the topic titles and triggers as context. Focus on WHAT was achieved and WHY.
4. Do NOT list individual changes -- synthesize into one clear description.
5. Ticket prefix:
   - Full squash: prefix with "Closes <TICKET>: " (or "Fixes" if the commits are bug fixes).
   - Partial squash: prefix with "Part of <TICKET>: ".
   - No ticket: no prefix.
6. Do NOT include multi-line bodies -- just the single subject line."""

        val proxyParams = mapOf(
            "ticketLine" to ticketLine,
            "commitsBlock" to commitsBlock,
            "scopeLine" to scopeLine,
        )

        val result = LlmClient.callLlm(
            action = "squash-message",
            params = proxyParams,
            apiKey = apiKey,
            jolliApiKey = jolliApiKey,
            model = resolveModelId(model),
            maxTokens = 256,
            prompt = prompt,
        )

        return result.text?.trim('"', '\'')
            ?: throw RuntimeException("No text in response")
    }
}
