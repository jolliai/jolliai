package ai.jolli.jollimemory.core

/**
 * SourceHeadline — single source of truth for the one-line headline shape the
 * route classifier consumes. The route prompt joins headlines as `[i] …` and
 * maps the ordinal back to the source, so every branch-bearing source type
 * (summary / plan / note) MUST emit the identical `(type, branch, timestamp) title`
 * layout. (Userfiles use a distinct branchless shape, formatted inline.)
 *
 * Kotlin port of `cli/src/core/SourceHeadline.ts`.
 */
fun formatSourceHeadline(type: String, branch: String, timestamp: String, title: String): String =
    "($type, $branch, $timestamp) $title"
