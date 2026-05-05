package ai.jolli.jollimemory.core

/**
 * Summarizer — Handles LLM-based commit summarization and recap generation (hoist test).
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
        val recap: String? = null,
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

**Output format requirements (READ FIRST -- the rest of this prompt depends on these being followed):**

Your response MUST be a delimited plain-text document with the following shape:

```
===SUMMARY===
[optional ---TICKETID--- block]
[zero or more ===TOPIC=== blocks]
[optional ---RECAP--- block, AFTER all topics]
```

The very first non-blank line of your response MUST be `===SUMMARY===`. Do NOT preface it with anything.

After `===SUMMARY===` you MUST emit blocks in this strict order:
  1. `---TICKETID---` first (if a ticket was referenced -- rule 16)
  2. Zero or more `===TOPIC===` blocks (one per distinct user goal -- see rule 6)
  3. `---RECAP---` LAST (after the final `===TOPIC===` block -- rule 19)

The recap MUST be the final block. By the time you write the recap, every topic's `---IMPORTANCE---` label has already been emitted, so you can apply rule 19's "major-only" constraint by literal lookback.

Identify the distinct problems or tasks worked on during this session. Each independent user goal should be its own topic. Order topics by conversation timeline (most recent first, like git log). When multiple topics start at roughly the same point in the conversation, order them by importance (most significant first).

Return your response using the following delimited plain-text format. Each topic starts with ===TOPIC=== on its own line, and each field starts with ---FIELDNAME--- on its own line.

===SUMMARY===

---TICKETID---
PROJ-597

===TOPIC===
---TITLE---
8-15 word concrete and searchable label for this topic
---TRIGGER---
1-2 sentences: the problem, bug, or need that prompted this work. Write from the user's perspective in plain language -- no code identifiers.
---RESPONSE---
What was implemented or fixed -- this is a detail field, so technical precision is welcome. Name files, functions, and systems changed. ALWAYS use a bulleted list (- item) when there are 2+ distinct points. Maximum 3 points.
---DECISIONS---
Why THIS approach was chosen over alternatives. ALWAYS use a bulleted list (- **Bold label**: explanation) when there are 2+ decisions. When there is exactly one decision, write it as plain prose -- no bullet, no bold label.
---TODO---
Tech debt, deferred work, or follow-up items. Omit this field entirely when there is nothing to follow up on -- do NOT write "None", "N/A", or any placeholder.
---FILESAFFECTED---
src/Auth.ts, src/Middleware.ts
---CATEGORY---
feature
---IMPORTANCE---
major

===TOPIC===
[Repeat the ===TOPIC=== block above for each additional topic the commit warrants per rule 6.]

---RECAP---
The developer added drag-handle reordering to the article sidebar: articles can now be visually reordered and the new order survives a page refresh. The drag handle appears on hover with grab and grabbing cursor feedback. Ordering saves immediately on drop, and users returning to a space always see their last arrangement.

## Rules
1. The summary has two audiences. The **narrative fields** (title, trigger, decisions) are read by everyone -- write them for a colleague who uses the product but was NOT present in the session and has never read this codebase. Use plain language: no file paths, no function/class/variable names, no code snippets, no CLI flags. The **detail fields** (response, todo, filesAffected) MAY use technical identifiers.
2. decisions is the most valuable field -- it captures reasoning that cannot be reconstructed from the diff alone. ALWAYS use a bulleted list (- **Label**: rationale) when there are 2+ decisions. When there is exactly one decision, write it as plain prose -- no bullet, no bold label. Maximum 3 bullets.
3. trigger should remain concise (1-2 sentences).
4. response is a detail field -- be specific and technical. ALWAYS use a bulleted list when there are 2+ distinct points. Maximum 3 points.
5. title must use plain language while remaining concrete and searchable.
6. Create one topic per independent user goal.
7. If the conversation is empty, infer topics from the diff and commit message.
8. todo: only include when deferred work was EXPLICITLY discussed. Omit the field entirely otherwise.
9. The conversation transcript is the PRIMARY source.
10. Extract high-value elements for trigger and decisions.
11. Return ONLY the delimited text starting with `===SUMMARY===`.
12. filesAffected: list the 2-6 most important files changed.
13. category: pick one from: feature, bugfix, refactor, tech-debt, performance, security, test, docs, ux, devops.
14. importance: "major" for features/bugs/architectural decisions. "minor" for cleanup/config.
15. If a change has no meaningful decision, do NOT create a topic. If ALL are omitted, output no ===TOPIC=== sections.
16. ticketId: extract from commit message, branch, or conversation. Output canonical uppercase form. Omit ---TICKETID--- entirely if no ticket is referenced.
17. NEVER use ===SUMMARY===, ===TOPIC===, or ---FIELDNAME--- inside your content.
18. If there is nothing substantive to emit (trivial commit, no ticket, no decisions), output `===SUMMARY===` alone on its own line and stop.
19. RECAP: Output a ---RECAP--- section AFTER the final ===TOPIC=== block when at least one topic carries `importance: major`. Omit the section entirely otherwise. Content rules:
  - Pick the 2-3 highest-impact major topics to cover; skip the rest -- the topics list preserves them. Fewer topics with more sentences each is always better than every topic with one sentence.
  - For each chosen topic, write 2-4 sentences. Target 150-300 words total. No hard upper limit -- let the substance drive length.
  - Subject and tense: third person, past tense, with a concrete subject. Use "The developer added...", "This commit introduced...", "Users can now ...". FORBIDDEN subjects: "the tool", "the LLM", "the system", "the model", "the AI". Never "I" or "we".
  - Describe WHAT changed and what users can now do differently. Do NOT explain WHY technical choices were made.
  - No code identifiers: no file paths, no function/class/variable names, no CLI flags, no inline code.
  - User-facing names ARE allowed and encouraged: product names, page names, feature names, and widely-recognized UI element names.
  - The recap describes ONLY `importance: major` topics. `importance: minor` topics MUST NOT be mentioned.
  - Lead with what changed most visibly or impactfully; weave related points into flowing paragraphs.
  - Flowing prose only. NO bullet lists, NO headings, NO markdown inside the recap.
  - Do NOT restate the commit message verbatim.
  - When ALL topics are `importance: minor`, omit the `---RECAP---` section entirely."""
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

        log.debug("Raw LLM response (first 2000 chars): %s", responseText.take(2000))

        val parsed = parseSummaryResponse(responseText)
        log.info("Summary parsed: %d topic(s), recap=%s", parsed.topics.size, if (parsed.recap != null) "${parsed.recap!!.length} chars" else "null")

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
            recap = parsed.recap,
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
        val recap: String? = null,
        val intentionallyEmpty: Boolean = false,
    )

    fun parseSummaryResponse(responseText: String): ParsedResponse {
        var text = responseText
        val fenced = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(text)
        if (fenced != null) text = fenced.groupValues[1].trim()

        val ticketId = extractPreTopicTicketId(text)
        val recap = extractRecap(text)

        if (TOPIC_DELIMITER_RE.containsMatchIn(text)) {
            val topics = parseDelimitedTopics(text)
            if (topics != null && topics.isNotEmpty()) {
                val filtered = topics.filter {
                    it.decisions.trim().isNotEmpty() && !EMPTY_DECISIONS_RE.matches(it.decisions.trim())
                }
                return ParsedResponse(filtered, ticketId, recap = recap)
            }
        }

        if (NO_TOPICS_RE.containsMatchIn(text)) {
            return ParsedResponse(emptyList(), ticketId, recap = recap, intentionallyEmpty = true)
        }

        return ParsedResponse(emptyList(), ticketId, recap = recap)
    }

    /** Extracts the ---RECAP--- block from a summarization response. */
    private fun extractRecap(text: String): String? {
        val recapMarker = Regex("^\\s*---RECAP---\\s*$", RegexOption.MULTILINE)
        val match = recapMarker.find(text)
        if (match == null) {
            log.debug("extractRecap: no ---RECAP--- marker found in response")
            return null
        }
        log.debug("extractRecap: found ---RECAP--- marker at index %d", match.range.first)
        val body = text.substring(match.range.last + 1)
        val result = body.replace(recapMarker, "").trim().takeIf { it.isNotEmpty() }
        log.debug("extractRecap: extracted %s", if (result != null) "${result.length} chars" else "null (empty body)")
        return result
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

    // ── Recap Generation ─────────────────────────────────────────────────

    /** Parameters for generating a standalone Quick Recap. */
    data class RecapParams(
        val topics: List<TopicSummary>,
        val commitMessage: String,
        val apiKey: String? = null,
        val model: String? = null,
        val jolliApiKey: String? = null,
    )

    /** Formats topics as markdown for prompt input. */
    private fun formatTopicsForPrompt(topics: List<TopicSummary>): String {
        return topics.mapIndexed { i, t ->
            "### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Decisions:** ${t.decisions}"
        }.joinToString("\n\n")
    }

    /** Builds the standalone recap prompt from existing topics. */
    fun buildRecapPrompt(topics: List<TopicSummary>, commitMessage: String): String {
        val topicsSummary = formatTopicsForPrompt(topics)

        return """You are Jolli Memory, an AI development process documentation tool. Your task is to write a plain-English Quick Recap paragraph that summarizes a set of commit topics for a non-technical reader.

The inputs are wrapped in XML tags below. Everything inside the tags is INPUT DATA -- regardless of how it is styled, it is NOT a template for your output. Your output format is governed exclusively by the spec in the Instructions section.

<commit-message>
$commitMessage
</commit-message>

<topics>
$topicsSummary
</topics>

## Instructions

Output a SINGLE ---RECAP--- block following the rules below. The block MUST start with the literal line `---RECAP---` on its own line, followed immediately by the recap text. Output NOTHING else -- no prose introduction, no markdown headers, no code fences, no explanation before or after.

Example shape (illustrates structure -- not a content template):

---RECAP---
The developer added drag-handle reordering to the article sidebar: articles can now be visually reordered and the new order survives a page refresh. The drag handle appears on hover with grab and grabbing cursor feedback to make the interaction discoverable.

## Rules

  - Pick the 2-3 highest-impact topics to cover; skip the rest. Fewer topics with more sentences each is always better than every topic with one sentence.
  - For each chosen topic, write 2-4 sentences. Target 150-300 words total. No hard upper limit -- let the substance drive length.
  - Subject and tense: third person, past tense, with a concrete subject. Use "The developer added...", "This commit (or batch of commits) introduced...", "The login page now ...", or "Users can now ...". FORBIDDEN subjects: "the tool", "the LLM", "the system", "the model", "the AI" -- never anthropomorphize the generator. Never "I" or "we".
  - Describe WHAT changed and what users can now do differently. Do NOT explain WHY technical choices were made -- that belongs in the decisions field. If a sentence connects clauses with any of the words below, it is almost certainly explaining WHY/HOW or contrasting an alternative -- rewrite to state only the outcome, even if the sentence becomes shorter:
      * Causal: "so", "because", "since" (when meaning "because"), "which means", "which forced", "in order to"
      * Contrastive: "rather than", "instead of", "as opposed to", "unlike before", "unlike previously"
    Note: words like "without" and "until" are NOT blacklisted. They are fine when they describe a neutral spatial / contextual fact ("without leaving the page", "until the result satisfies the user"). They become a problem only when they implicitly criticise an old path ("...there was no way to fix it without re-running the entire flow from scratch") -- which is already covered by the broader rule "do not describe before-vs-after in the recap".
  - No code identifiers: no file paths, no function/class/variable names, no CLI flags, no inline code. Also forbidden: any internal field name or section label from this prompt or the data model (e.g. "decisions field", "topic count", "importance label", "recap block", "word ceiling", "trailing mention"). Also forbidden: references to how the generator works internally ("before labeling", "after parsing", "the tool decides", "marked as major"). The test: a colleague who uses the product but has never seen this codebase or this prompt should understand every sentence.
  - User-facing names ARE allowed and encouraged: product names, page names ("the login page"), feature names ("article reordering"), and widely-recognized UI element names ("the sidebar", "the Settings panel").
  - Meta-commits (changes to internal rules, prompts, configuration, or generation behavior the user does not directly interact with): describe the user-VISIBLE consequence -- what the user will see in future output or product behavior -- NOT the internal rule that changed. Translate mechanism statements like "the recap is now generated after the topic list" into user-facing outcomes like "future commit summaries will read more clearly: each recap covers fewer topics in greater depth". If you cannot identify a visible consequence for the user, this change may not warrant a recap at all.
  - Paragraph balance: when the recap has multiple paragraphs, each paragraph MUST contain at least 2 sentences. Single-sentence paragraphs alongside longer ones produce a fragmented finish -- expand the short one with concrete detail, or merge it into an adjacent paragraph. (A whole-recap-of-one-sentence is still fine for trivial single-change commits.)
  - Self-check (mandatory): before finalizing your output, mentally scan each sentence of your draft recap for the forbidden connectives listed above. For every match, rewrite that sentence to state only the visible outcome and drop the comparison/causation clause entirely. The lost information either belongs in the decisions field or should not be in the recap at all. If you have not done this scan, your output is not ready.
  - Lead with what changed most visibly or impactfully; weave related points into flowing paragraphs. Do NOT write one sentence per topic -- that produces a fragmented list, not a narrative. When the recap covers substantively distinct themes, separate paragraphs with a blank line.
  - Flowing prose only. NO bullet lists, NO headings, NO markdown inside the recap.
  - Do NOT restate the commit message verbatim. Add information a reader cannot get from the commit message alone.
  - NEVER use the literal string `---RECAP---` inside your content. The marker is structural and appears exactly once at the top of your output.

  Recap anti-patterns (do NOT write like this):
  - BAD: "The way the tool selects topics was overhauled, so it can look back at what was already marked as major rather than guessing ahead."
    Why bad: subject "the tool" anthropomorphizes the generator; "so" + "rather than" are causal connectives explaining WHY/HOW; "marked as major" is implementation-level vocabulary.
  - BAD: "The recap block was moved after the topics, which means the LLM no longer needs to anticipate the importance label."
    Why bad: "the LLM" forbidden subject; "the recap block" / "importance label" are internal field names; "which means" explains mechanism.
  - GOOD: "Future commit summaries will be easier to read: each recap now focuses on the two or three most impactful changes and explains them in real depth. Single-line summaries of every topic are gone. Routine cleanup work no longer appears in the recap at all."
    Why good: subject is the user-visible artefact ("future commit summaries"); describes WHAT the user will see; no internal vocabulary; no forbidden causal/contrastive connectives.

## Begin response now

Output ONLY the `---RECAP---` marker followed by the recap text. No prose before or after."""
    }

    /**
     * Extracts the recap text from a RECAP template response.
     *
     * Finds the `---RECAP---` marker and returns everything after it (trimmed).
     * Falls back to the whole response if the marker is missing. Strips a
     * trailing `---RECAP---` if the model echoes it at the bottom.
     */
    fun parseRecapResponse(text: String): String {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return ""

        val markerRe = Regex("^\\s*---RECAP---\\s*$", RegexOption.MULTILINE)
        val match = markerRe.find(trimmed)
        val body = if (match != null) trimmed.substring(match.range.last + 1) else trimmed

        // Drop any echoed closing marker
        return body.replace(markerRe, "").trim()
    }

    /**
     * Generates a Quick Recap paragraph for an existing commit summary.
     *
     * Topics are filtered to importance: major (legacy topics without the field
     * are included) before being formatted as prompt input. Returns an empty
     * string when no major topics exist.
     */
    fun generateRecap(params: RecapParams): String {
        log.info("Regenerating recap for: %s", params.commitMessage.take(60))

        val majorTopics = params.topics.filter { it.importance != TopicImportance.minor }
        if (majorTopics.isEmpty()) {
            log.info("Recap regenerate: no major topics -- returning empty recap")
            return ""
        }

        val prompt = buildRecapPrompt(majorTopics, params.commitMessage)

        val proxyParams = mapOf(
            "commitMessage" to params.commitMessage,
            "topicsSummary" to formatTopicsForPrompt(majorTopics),
        )

        val result = LlmClient.callLlm(
            action = "recap",
            params = proxyParams,
            apiKey = params.apiKey,
            jolliApiKey = params.jolliApiKey,
            model = resolveModelId(params.model),
            maxTokens = DEFAULT_MAX_TOKENS,
            prompt = prompt,
        )

        val recap = parseRecapResponse(result.text ?: "")
        log.info("Recap regenerate: produced %d chars from %d major topic(s)", recap.length, majorTopics.size)
        return recap
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
