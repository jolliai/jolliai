package ai.jolli.jollimemory.core

/**
 * Local LLM prompt templates for direct (Anthropic) mode — the Kotlin counterpart
 * of the route/reconcile templates the CLI ships in `cli/src/core/PromptTemplates.ts`.
 *
 * In proxy mode the Jolli backend owns these templates; in direct mode (the user
 * has only an Anthropic API key, no Jolli sign-in) the ingest pipeline renders them
 * here so the wiki can still be built. Kept byte-faithful to the TS originals.
 */
object PromptTemplates {

    private val PLACEHOLDER = Regex("""\{\{\s*(\w+)\s*\}\}""")

    private val ROUTE = """You are a knowledge-base router for a software project's development history. A topic-organized knowledge base already exists; new source items have arrived. Decide which topic pages each source should update, and propose new topics where none fit.

## Existing topics
{{topicIndex}}
(If this is empty, the knowledge base has no topics yet -- everything will be a new topic.)

## New sources (numbered)
{{sources}}

## Task
- For each EXISTING topic that any new source informs, list the source numbers that belong to it.
- For sources that fit no existing topic, group them into NEW topics you name.
- A single source MAY belong to multiple topics if it genuinely spans them.
- A source that carries no durable, topical knowledge may be left out entirely.

## stableSlug rules
lowercase kebab-case, 3-40 chars, encodes the concept (not the wording). REUSE an existing topic's slug when a source belongs to it. New-topic slugs must be unique in your output and must not collide with an existing slug.

## Output
Output ONLY a JSON object -- no prose, no markdown fences:
{"updates":[{"stableSlug":"<existing-slug>","sourceIndexes":[<n>,...]}],"newTopics":[{"stableSlug":"<new-slug>","title":"<Title>","sourceIndexes":[<n>,...]}]}
Use [] for empty arrays. Every sourceIndex MUST be an integer within the numbered list above."""

    private val RECONCILE = """You are a knowledge synthesizer maintaining ONE topic page in a software project's knowledge base. Rewrite the page so it states the CURRENT truth about this topic, folding in new source material.

## Topic
{{topicTitle}}

## Current page (may be empty for a new topic)
{{currentPage}}

## New source material (oldest first; newer supersedes older)
{{sources}}

## Rules
1. Produce a self-contained page describing the CURRENT state of this topic.
2. Newer sources override older ones on conflict. Code evolves: if a newer source contradicts a claim on the current page or in an older source, REWRITE or DELETE the stale claim. Do NOT keep outdated statements and do NOT write a changelog -- the page is a current-truth snapshot, not a history.
3. Keep only durable knowledge: decisions, architecture, behavior, rationale. Drop transient chatter and process noise.
4. Be specific -- name the components, files, and decisions.

## Output format (exactly one block)
===TOPIC===
---TITLE---
<topic title>
---STABLESLUG---
<the topic's stable slug, unchanged>
---SUMMARY---
<one-line summary for the index, max 140 chars, no newlines>
---CONTENT---
<the full markdown page body>
---KEYDECISIONS---
- <one key decision per line> (omit this section entirely if there are none)
---RELATEDBRANCHES---
<comma-separated branch names> (omit if unknown)
---SOURCECOMMITS---
<comma-separated commit hashes drawn from the sources> (omit if none)"""

    private val TEMPLATES = mapOf("route" to ROUTE, "reconcile" to RECONCILE)

    /**
     * Renders the local template for [action] with [params] (`{{key}}` substitution,
     * unknown placeholders left as-is), or null when there is no local template for
     * the action (the caller then relies on proxy mode).
     */
    fun render(action: String, params: Map<String, String>): String? {
        val template = TEMPLATES[action] ?: return null
        return PLACEHOLDER.replace(template) { m -> params[m.groupValues[1]] ?: m.value }
    }
}
