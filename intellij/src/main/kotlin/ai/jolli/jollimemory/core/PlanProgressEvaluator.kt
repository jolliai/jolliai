package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.JsonObject

/**
 * PlanProgressEvaluator — Kotlin port of PlanProgressEvaluator.ts
 *
 * Pure, single-plan evaluator that calls the LLM to assess which plan steps
 * moved forward in a commit. No registry access, no filesystem writes.
 */
object PlanProgressEvaluator {

    private val log = JmLogger.create("PlanProgressEvaluator")
    private val gson = Gson()
    private const val MAX_TOKENS = 4096

    private val VALID_STATUSES = setOf("completed", "in_progress", "not_started")

    private val PLAN_PROGRESS_PROMPT = """You are JolliMemory, an AI development process documentation tool. Your task is to evaluate how much progress a developer made on a plan during a single coding session, based on the code diff, conversation summary topics, and the raw conversation transcript.

## Plan (Markdown)
{{planContent}}

## Code Changes (git diff)
```diff
{{diff}}
```

## Conversation Summary Topics
{{topics}}

## Conversation Transcript
{{conversation}}

## Instructions

Analyze the plan above and determine which steps moved forward in this session. You MUST:

1. Produce a brief "summary" (1-2 sentences) of what the developer was working on overall in this session.
2. For EVERY step in the plan, determine its status based on the diff:
   - "completed" -- the diff fully implements this step
   - "in_progress" -- the diff partially addresses this step
   - "not_started" -- no evidence of progress on this step in the diff
3. For steps that are "completed" or "in_progress", write a rationale-rich note:
   - Cite specific decisions and trade-offs from the conversation topics (not just file names)
   - Reference what triggered the work and any alternatives considered
   - Scan the conversation transcript for human-flagged signals: things to revisit, questions to ask someone, concerns raised, deferred ideas -- and surface them in the relevant step note
4. For steps that are "not_started", set note to null.

## Output Format

Return a single JSON object (no markdown fences, no explanation):

{
  "summary": "1-2 sentence summary of what the developer worked on",
  "steps": [
    { "id": "1", "description": "Step description from plan", "status": "completed", "note": "Rationale..." },
    { "id": "2", "description": "Step description from plan", "status": "not_started", "note": null }
  ]
}

## Rules
1. Discover step IDs and descriptions directly from the plan markdown. Steps may be numbered (1, 2, 3), lettered (a, b, c), use headings (## Step 1), or checkboxes (- [ ]). Assign IDs in the order they appear.
2. The diff is the PRIMARY evidence for status -- do not mark a step as "completed" unless the code changes clearly implement it.
3. The topics and transcript provide CONTEXT for notes -- cite decisions, trade-offs, and reasoning that cannot be reconstructed from code alone.
4. Keep notes concise (1-3 sentences each). Focus on the "why" and any flagged signals, not on restating what the code does.
5. Return ONLY the JSON object. No surrounding text, no markdown fences."""

    /** Renders topic summaries into a compact text block for the LLM prompt */
    fun renderTopics(topics: List<TopicSummary>): String {
        if (topics.isEmpty()) return "(no topics available)"

        return topics.mapIndexed { i, t ->
            val lines = mutableListOf(
                "Topic ${i + 1}: ${t.title}",
                "  Trigger: ${t.trigger}",
                "  Decisions: ${t.decisions}",
            )
            if (!t.todo.isNullOrBlank()) lines.add("  Todo: ${t.todo}")
            lines.joinToString("\n")
        }.joinToString("\n\n")
    }

    /**
     * Evaluates plan progress for a single plan against a commit's diff and conversation.
     *
     * Returns a partial PlanProgressArtifact (commit metadata fields are empty — caller fills them in),
     * or null on any failure (fire-and-forget).
     */
    fun evaluatePlanProgress(
        planMarkdown: String,
        diff: String,
        topics: List<TopicSummary>,
        conversation: String,
        apiKey: String?,
        model: String? = null,
        jolliApiKey: String? = null,
        aiProvider: String? = null,
    ): PlanProgressEvalResult? {
        val topicsText = renderTopics(topics)

        val prompt = PLAN_PROGRESS_PROMPT
            .replace("{{planContent}}", planMarkdown)
            .replace("{{diff}}", diff)
            .replace("{{topics}}", topicsText)
            .replace("{{conversation}}", conversation)

        val proxyParams = mapOf(
            "planContent" to planMarkdown,
            "diff" to diff,
            "topics" to topicsText,
            "conversation" to conversation,
        )

        val result = try {
            LlmClient.callLlm(
                action = "plan-progress",
                params = proxyParams,
                apiKey = apiKey,
                jolliApiKey = jolliApiKey,
                model = Summarizer.resolveModelId(model ?: "haiku"),
                maxTokens = MAX_TOKENS,
                prompt = prompt,
                aiProvider = aiProvider,
            )
        } catch (e: Exception) {
            log.warn("Plan progress LLM call failed: %s", e.message)
            return null
        }

        val responseText = result.text
        if (responseText.isNullOrEmpty()) {
            log.warn("Plan progress LLM returned empty text")
            return null
        }

        // Strip markdown code fences if present
        var jsonText = responseText
        val fenced = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(responseText)
        if (fenced != null) {
            jsonText = fenced.groupValues[1].trim()
        }

        // Parse JSON response
        val parsed: JsonObject = try {
            gson.fromJson(jsonText, JsonObject::class.java)
        } catch (e: Exception) {
            log.warn("Plan progress LLM returned invalid JSON: %s", responseText.take(200))
            return null
        }

        // Validate structure
        val summary = parsed.get("summary")?.takeIf { it.isJsonPrimitive }?.asString
        val stepsArray = parsed.getAsJsonArray("steps")
        if (summary == null || stepsArray == null) {
            log.warn("Plan progress LLM response missing required fields (summary, steps)")
            return null
        }

        // Validate and normalize steps
        val steps = mutableListOf<PlanStep>()
        for (element in stepsArray) {
            if (!element.isJsonObject) continue
            val stepObj = element.asJsonObject
            val id = stepObj.get("id")?.takeIf { it.isJsonPrimitive }?.asString ?: continue
            val description = stepObj.get("description")?.takeIf { it.isJsonPrimitive }?.asString ?: continue
            val statusStr = stepObj.get("status")?.takeIf { it.isJsonPrimitive }?.asString ?: continue
            val status = if (statusStr in VALID_STATUSES) {
                PlanStepStatus.valueOf(statusStr)
            } else {
                PlanStepStatus.not_started
            }
            val note = stepObj.get("note")?.takeIf { it.isJsonPrimitive && !it.isJsonNull }?.asString

            steps.add(PlanStep(id = id, description = description, status = status, note = note))
        }

        val llm = LlmCallMetadata(
            model = result.model ?: Summarizer.resolveModelId(model ?: "haiku"),
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            apiLatencyMs = result.apiLatencyMs,
            stopReason = result.stopReason,
        )

        return PlanProgressEvalResult(
            summary = summary,
            steps = steps,
            llm = llm,
        )
    }
}
