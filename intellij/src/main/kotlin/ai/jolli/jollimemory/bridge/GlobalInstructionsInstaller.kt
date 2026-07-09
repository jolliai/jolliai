package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CodexSessionDiscoverer
import ai.jolli.jollimemory.core.GeminiSupport
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import java.io.File

/**
 * Writes Jolli Memory's "prefer these skills by default" standing instruction into
 * each detected AI host's GLOBAL instruction file:
 *
 *   - Claude Code → ~/.claude/CLAUDE.md
 *   - Gemini CLI  → ~/.gemini/GEMINI.md
 *   - Codex       → ~/.codex/AGENTS.md
 *
 * Kotlin port of `cli/src/install/GlobalInstructionsInstaller.ts` — keep the two in
 * lockstep (block markers, heading, and prose must match byte-for-byte so a file
 * co-managed by the CLI / VS Code and IntelliJ never flip-flops). The rule tells the
 * host LLM to reach for the jolli-pr / jolli-search / jolli-recall skills by default
 * for PR creation / search / recall.
 *
 * Managed-block strategy: a marker-bracketed section is upserted, everything outside
 * the markers is preserved verbatim, and the whole operation is fail-soft — a broken
 * or read-only global file never breaks enable.
 *
 * These files are machine-GLOBAL (one per host, shared by every repo), so uninstall
 * deliberately does NOT remove the block — the same policy as global-scope MCP
 * registration. A global `AGENTS.md` is only read by Codex; Cursor / OpenCode /
 * Copilot read AGENTS.md at the project root, so they are intentionally out of reach.
 */
object GlobalInstructionsInstaller {

    private val log = JmLogger.create("GlobalInstructionsInstaller")

    /**
     * Marker pair bracketing Jolli's managed block. Lines between the markers belong
     * to Jolli and may be rewritten on future installs; anything outside is untouched.
     * HTML comments so the block is invisible when the markdown renders.
     */
    const val BLOCK_START = "<!-- >>> jolli memory instructions >>> -->"
    const val BLOCK_END = "<!-- <<< jolli memory instructions <<< -->"

    /**
     * Markdown heading Jolli's block leads with. Also used to detect a pre-existing
     * *unmarked* section a user added by hand so we adopt it in place instead of
     * appending a duplicate.
     */
    const val MANAGED_HEADING = "## Jolli Memory"

    /**
     * Benefit-led confirmation message shown before Jolli writes its skill-preference
     * block. SINGLE SOURCE OF TRUTH — identical wording to the CLI prompt and the
     * VS Code notification, so it never drifts between surfaces.
     */
    const val GLOBAL_INSTRUCTIONS_PROMPT =
        "Let your AI assistants use Jolli's memory automatically? This adds a small " +
            "skill-preference block to your global instruction files (~/.claude/CLAUDE.md, " +
            "~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you " +
            "create PRs, search past decisions, or recall a branch's history — no need to ask each time."

    /** Which hosts to write the global instruction file for (per-host gated). */
    data class InstructionHosts(val claude: Boolean, val gemini: Boolean, val codex: Boolean)

    private data class Target(val host: String, val relPath: List<String>)

    private val TARGETS = listOf(
        Target("claude", listOf(".claude", "CLAUDE.md")),
        Target("gemini", listOf(".gemini", "GEMINI.md")),
        Target("codex", listOf(".codex", "AGENTS.md")),
    )

    /**
     * Outcome of consulting the switch:
     *  - [write]   — write the block now.
     *  - [remove]  — actively remove any previously-written block (opt-out).
     *  - [persist] — when non-null, the caller must persist this to the shared config's
     *                `globalInstructions` field (set only when a fresh decision was made).
     */
    data class Decision(val write: Boolean, val remove: Boolean = false, val persist: String? = null)

    /**
     * Renders the managed block including marker lines and a trailing newline. Joined
     * with "\n" (not the platform EOL) so the file reads identically for a team sharing
     * dotfiles across OSes.
     */
    fun renderInstructionsBlock(): String {
        val lines = listOf(
            BLOCK_START,
            MANAGED_HEADING,
            "",
            "When Jolli Memory is enabled in a repository, prefer its skills by default:",
            "",
            "- **Creating or updating a pull request** → use the `jolli-pr` skill (its",
            "  description comes from Jolli Memory's recorded commit history), unless the",
            "  user explicitly asks for another method.",
            "- **Searching prior work, decisions, or related commits** → use the",
            "  `jolli-search` skill.",
            "- **Recalling or resuming prior context on a branch** → use the `jolli-recall`",
            "  skill.",
            "",
            "If a skill is not available (Jolli Memory is not enabled in that repository),",
            "fall back to normal behavior.",
            BLOCK_END,
        )
        return lines.joinToString("\n") + "\n"
    }

    /**
     * Resolves what to do with the block from the current switch value plus an optional
     * confirm callback (supplied only by interactive surfaces):
     *  - "enabled"   → write, no persist.
     *  - "disabled"  → remove any existing block, no persist (heals a stale block).
     *  - undecided + callback   → ask; persist + write/remove per the answer.
     *  - undecided + no callback → skip, stay undecided (safe default for non-interactive).
     *    Undecided never removes — the block was never written on the user's behalf.
     */
    fun resolveDecision(current: String?, confirm: (() -> Boolean)?): Decision {
        if (current == "enabled") return Decision(write = true)
        if (current == "disabled") return Decision(write = false, remove = true)
        if (confirm == null) return Decision(write = false)
        return if (confirm()) {
            Decision(write = true, persist = "enabled")
        } else {
            Decision(write = false, remove = true, persist = "disabled")
        }
    }

    /**
     * Upserts the managed block into [existing], preserving all other content verbatim.
     * Resolution order: (1) a marker-bracketed block → replaced in place; (2) an unmarked
     * hand-pasted `## Jolli Memory` section → adopted; (3) otherwise → appended.
     */
    fun applyInstructionsBlock(existing: String, block: String): String {
        val lines = existing.split("\n")
        val startIdx = lines.indexOf(BLOCK_START)
        val endIdx = lines.indexOf(BLOCK_END)

        // renderInstructionsBlock always appends a trailing "\n"; strip it before
        // splitting so the spliced lines don't carry an empty trailing element.
        val newBlockLines = block.substring(0, block.length - 1).split("\n")

        if (startIdx != -1 && endIdx != -1 && endIdx > startIdx) {
            val next = lines.subList(0, startIdx) + newBlockLines + lines.subList(endIdx + 1, lines.size)
            return next.joinToString("\n")
        }

        // Adopt an unmarked, hand-pasted section rather than appending a second copy.
        val headingIdx = lines.indexOf(MANAGED_HEADING)
        if (headingIdx != -1) {
            // Section runs to the next same-or-higher-level heading (#/##) or EOF.
            var sectionEnd = lines.size
            for (i in headingIdx + 1 until lines.size) {
                if (Regex("^#{1,2} ").containsMatchIn(lines[i])) {
                    sectionEnd = i
                    break
                }
            }
            val before = lines.subList(0, headingIdx).joinToString("\n")
            val after = lines.subList(sectionEnd, lines.size).joinToString("\n")
            return (if (before.isNotEmpty()) "$before\n" else "") + block + after
        }

        if (existing.isEmpty()) return block
        val sep = if (existing.endsWith("\n")) "" else "\n"
        return "$existing$sep$block"
    }

    /**
     * Removes Jolli's marker-bracketed block from [existing], preserving all other
     * content verbatim. Returns the input unchanged when no block is present.
     */
    fun removeInstructionsBlock(existing: String): String {
        val lines = existing.split("\n")
        val startIdx = lines.indexOf(BLOCK_START)
        val endIdx = lines.indexOf(BLOCK_END)
        if (startIdx == -1 || endIdx == -1 || endIdx < startIdx) return existing
        // Also drop a single blank separator line the block was appended after.
        val spliceStart = if (startIdx > 0 && lines[startIdx - 1] == "") startIdx - 1 else startIdx
        return (lines.subList(0, spliceStart) + lines.subList(endIdx + 1, lines.size)).joinToString("\n")
    }

    /** Upserts the managed block into a single absolute file path. Fail-soft. */
    private fun upsertTarget(file: File, block: String) {
        val existing = if (file.exists()) {
            try {
                file.readText(Charsets.UTF_8)
            } catch (e: Exception) {
                log.warn("Failed to read %s: %s — skipping", file.absolutePath, e.message)
                return
            }
        } else {
            ""
        }

        val updated = applyInstructionsBlock(existing, block)
        if (updated == existing) return // No change needed.

        try {
            file.parentFile?.mkdirs()
            file.writeText(updated, Charsets.UTF_8)
            log.info("Updated %s with Jolli Memory instructions", file.absolutePath)
        } catch (e: Exception) {
            log.warn("Failed to write %s: %s", file.absolutePath, e.message)
        }
    }

    /** Strips the managed block from a single absolute file path. Fail-soft; never creates a file. */
    private fun removeTarget(file: File) {
        if (!file.exists()) return
        val existing = try {
            file.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            log.warn("Failed to read %s: %s — skipping", file.absolutePath, e.message)
            return
        }
        val updated = removeInstructionsBlock(existing)
        if (updated == existing) return // No block present.
        try {
            file.writeText(updated, Charsets.UTF_8)
            log.info("Removed Jolli Memory instructions from %s", file.absolutePath)
        } catch (e: Exception) {
            log.warn("Failed to write %s: %s", file.absolutePath, e.message)
        }
    }

    /** Writes the instruction block into the global file of every host whose flag is true. */
    fun installGlobalInstructions(hosts: InstructionHosts) {
        val block = renderInstructionsBlock()
        val home = System.getProperty("user.home")
        for (target in TARGETS) {
            val enabled = when (target.host) {
                "claude" -> hosts.claude
                "gemini" -> hosts.gemini
                "codex" -> hosts.codex
                else -> false
            }
            if (!enabled) continue
            upsertTarget(File(home, target.relPath.joinToString(File.separator)), block)
        }
    }

    /**
     * Removes the instruction block from every host's global file. Unlike
     * [installGlobalInstructions], removal is NOT host-gated: a user who opts out must
     * have the block erased everywhere it might have been written.
     */
    fun removeGlobalInstructions() {
        val home = System.getProperty("user.home")
        for (target in TARGETS) {
            removeTarget(File(home, target.relPath.joinToString(File.separator)))
        }
    }

    /**
     * Resolves and applies the machine-global skill-preference block: reads the persisted
     * `globalInstructions` switch, consults the optional [confirm] callback, persists a
     * fresh decision to the shared config, then writes OR removes the block accordingly.
     *
     * Host detection defaults to the live detectors but can be injected (tests / callers
     * that already ran detection). Fail-soft throughout.
     */
    fun sync(
        confirm: (() -> Boolean)? = null,
        geminiDetected: Boolean? = null,
        codexDetected: Boolean? = null,
    ) {
        val config = SessionTracker.loadConfig()
        val decision = resolveDecision(config.globalInstructions, confirm)
        if (decision.persist != null) {
            SessionTracker.saveGlobalInstructions(decision.persist)
        }
        if (decision.write) {
            val gemini = geminiDetected ?: GeminiSupport.isGeminiInstalled()
            val codex = codexDetected ?: CodexSessionDiscoverer.isCodexInstalled()
            installGlobalInstructions(
                InstructionHosts(
                    claude = config.claudeEnabled != false,
                    gemini = gemini && config.geminiEnabled != false,
                    codex = codex && config.codexEnabled != false,
                ),
            )
        } else if (decision.remove) {
            removeGlobalInstructions()
        }
    }
}
