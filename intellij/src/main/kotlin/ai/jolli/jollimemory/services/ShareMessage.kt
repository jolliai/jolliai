package ai.jolli.jollimemory.services

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * ShareMessage — Kotlin port of vscode/src/services/ShareMessage.ts
 *
 * Builds the human-facing share payloads (email subject/body, IM copy message,
 * social web-intent URLs) for a branch or single-commit share. Pure and
 * content-teasing: the recipient should see *what* is being shared and feel
 * pulled to open it — the link is the hook, install is the conversion (the
 * growth loop). Kept dependency-free for easy testing.
 */
object ShareMessage {

    /** Whether a share covers a whole branch or a single commit. */
    enum class ShareKind { BRANCH, COMMIT }

    /** Social platforms we offer a one-click share-intent for. */
    enum class SocialPlatform { X, LINKEDIN, REDDIT, WHATSAPP, TELEGRAM }

    data class ShareMessageInput(
        val branch: String,
        val url: String,
        val decisionCount: Int,
        /** A few decision titles to tease (already trimmed to a sensible count). */
        val titles: List<String>,
        /** "branch" (whole branch) or "commit" (single commit). Defaults to BRANCH. */
        val kind: ShareKind = ShareKind.BRANCH,
    )

    data class EmailMessage(val subject: String, val body: String)

    private fun decisionsLabel(n: Int): String = "$n decision${if (n == 1) "" else "s"}"

    /** Leading phrase, kind-aware: "How we built X" (branch) vs "A commit on X" (commit). */
    private fun lead(branch: String, kind: ShareKind, quoted: Boolean = false): String {
        val name = if (quoted) "\"$branch\"" else branch
        return if (kind == ShareKind.COMMIT) "A commit on $name" else "How we built $name"
    }

    /** Email subject + body — the richer of the two, with a bulleted teaser. */
    fun buildShareEmail(input: ShareMessageInput): EmailMessage {
        val decisions = decisionsLabel(input.decisionCount)
        val subject = "${lead(input.branch, input.kind, quoted = true)} — $decisions on Jolli Memory"

        val intro = if (input.kind == ShareKind.COMMIT) {
            "Here's the reasoning behind a commit on the \"${input.branch}\" branch — $decisions, auto-captured as we built it."
        } else {
            "Here's the full story behind the \"${input.branch}\" branch — $decisions, auto-captured as we built it."
        }
        val lines = mutableListOf(intro, "")
        if (input.titles.isNotEmpty()) {
            lines.add("A few of the decisions inside:")
            for (t in input.titles) lines.add("  • $t")
            lines.add("")
        }
        lines.add("Open the read-only view — no login, no install:")
        lines.add(input.url)
        lines.add("")
        lines.add("You'll see the intent, the reasoning, and the trade-offs behind each change — not just the diff.")
        lines.add("")
        lines.add("— Shared via Jolli Memory")
        return EmailMessage(subject, lines.joinToString("\n"))
    }

    /** "incl. “A” & “B”" teaser clause from the first couple of decision titles. */
    private fun inclClause(titles: List<String>): String {
        val picked = titles.take(2).joinToString(" & ") { "“$it”" }
        return if (picked.isNotEmpty()) " incl. $picked" else ""
    }

    /** Compact, concrete one-liner for pasting into Slack / IM (URL kept for unfurl). */
    fun buildShareCopyMessage(input: ShareMessageInput): String {
        val decisions = decisionsLabel(input.decisionCount)
        return "${lead(input.branch, input.kind)} — $decisions${inclClause(input.titles)}. " +
            "The reasoning, not just the diff — read-only, no login:\n${input.url}"
    }

    data class SocialShareInput(
        val branch: String,
        val url: String,
        val decisionCount: Int,
        /** Decision titles to tease (per-platform copy leads with the first couple). */
        val titles: List<String>,
        /** "branch" (whole branch) or "commit" (single commit). Defaults to BRANCH. */
        val kind: ShareKind = ShareKind.BRANCH,
    )

    /** Mirrors JS `encodeURIComponent`: percent-encode, but emit spaces as %20 (not +). */
    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")

    /**
     * Builds a public web-intent share URL for a social platform, with copy tailored
     * to each channel's voice (X punchy, Reddit title-style, WhatsApp/Telegram casual;
     * LinkedIn renders from the page's OG tags so it carries only the URL). No API
     * auth — the platform's compose screen opens pre-filled. Opened via BrowserUtil.
     */
    fun buildSocialShareUrl(platform: SocialPlatform, input: SocialShareInput): String {
        val decisions = decisionsLabel(input.decisionCount)
        val incl = inclClause(input.titles)
        val u = enc(input.url)
        return when (platform) {
            SocialPlatform.X -> {
                val text = "${lead(input.branch, input.kind)}: $decisions$incl — the reasoning behind each change, not just the diff."
                "https://twitter.com/intent/tweet?text=${enc(text)}&url=$u"
            }
            // LinkedIn ignores text/title params now — it renders from the page's OG tags.
            SocialPlatform.LINKEDIN -> "https://www.linkedin.com/sharing/share-offsite/?url=$u"
            SocialPlatform.REDDIT -> {
                val subject = if (input.kind == ShareKind.COMMIT) "A commit on ${input.branch}" else input.branch
                val title = "$subject: $decisions$incl — read-only dev memory (the reasoning, not just the diff)"
                "https://www.reddit.com/submit?url=$u&title=${enc(title)}"
            }
            SocialPlatform.WHATSAPP -> {
                val text = "${lead(input.branch, input.kind)} — $decisions$incl. " +
                    "The reasoning, not just the diff (read-only, no login): ${input.url}"
                "https://wa.me/?text=${enc(text)}"
            }
            SocialPlatform.TELEGRAM -> {
                val text = "${lead(input.branch, input.kind)} — $decisions$incl. " +
                    "The reasoning, not just the diff (read-only, no login)."
                "https://t.me/share/url?url=$u&text=${enc(text)}"
            }
        }
    }
}
