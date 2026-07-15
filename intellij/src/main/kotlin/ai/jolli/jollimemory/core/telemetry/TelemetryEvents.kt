package ai.jolli.jollimemory.core.telemetry

/**
 * TelemetryEvents — Kotlin port of cli/src/core/TelemetryEvents.ts (JOLLI-1785).
 *
 * The append-only allowlist of telemetry event names plus a one-line
 * description for each. Single source of truth for the runtime allowlist
 * `Telemetry.track` enforces, kept in **lockstep** with the TypeScript original
 * — add names, never rename or repurpose them (old dashboards/rows reference a
 * name forever). Names follow the `object_action` convention
 * (`TELEMETRY_EVENT_NAME_PATTERN`); event-specific fields live in the envelope's
 * `properties` bag, never in the name.
 */
object TelemetryEvents {
    /** Event name → human-readable line (flows into TELEMETRY.md). Insertion-ordered. */
    val TELEMETRY_EVENTS: Map<String, String> =
        linkedMapOf(
            // ── lifecycle & conversion funnel (the primary goal) ──
            "app_installed" to "First run after install; installId minted (once per machine).",
            "client_activated" to
                "A GUI surface activated (VS Code activate / IntelliJ project open), carrying `surface_version`. " +
                "First-seen (install_id, surface_version) ≈ new + upgrade installs that launched.",
            "surface_enabled" to "A surface was enabled in a repo.",
            "surface_disabled" to "A surface was disabled / opted out.",
            "signin_started" to "User initiated OAuth sign-in.",
            "signin_completed" to "jolliApiKey minted — the conversion event.",
            "signed_out" to "User logged out.",
            "ai_provider_selected" to "User chose jolli vs anthropic for LLM.",
            "memory_bank_migrated" to "Migrate-to-Memory-Bank run.",
            // ── feature usage / adoption ──
            "command_invoked" to "Any CLI command ran (auto-emitted).",
            "recall_performed" to "A recall was run.",
            "search_performed" to "A search was run.",
            "memory_pushed" to "Memories pushed.",
            "export_performed" to "Export run.",
            "ai_source_detected" to "A new AI source transcript was detected.",
            "settings_opened" to "Settings UI opened (vscode/intellij).",
            // ── pipeline health ──
            "ingest_completed" to
                "A drainIngest run finished. Carries `idle:true` for a no-op drain (ingested=0); " +
                "filter those out for real-ingest latency/health metrics.",
            "error_occurred" to
                "A structured error was raised. Content-free schema: { where, code, source?, retryable? }. " +
                "Emitted via Telemetry.trackError(); never carries a message/stack/path.",
            "queue_drained" to "QueueWorker finished a drain.",
            "sync_completed" to "A memory-bank sync round finished.",
            // ── IDE tool-window UI / engagement (IntelliJ, VS Code) ──
            "toolwindow_opened" to "The memory tool window was opened.",
            "view_switched" to "Tool window view switched (current/bank/knowledge).",
            "memory_committed" to "User committed a memory via the Commit button.",
            "memory_expanded" to "A committed memory's details were expanded.",
            "memory_item_opened" to "An item inside a memory was opened (conversation/file/context/shipped).",
            "session_resumed" to "A conversation session was resumed in a terminal.",
            "recall_prompt_copied" to "A recall prompt was copied to the clipboard.",
            "memory_pinned" to "An item was pinned.",
            "memory_unpinned" to "An item was unpinned.",
            "key_rejected" to "The server rejected the API key (401/403).",
            "reauth_completed" to "Re-authentication after a rejected key finished.",
        )

    /** `object_action`: lowercase snake_case with at least two words. */
    val TELEMETRY_EVENT_NAME_PATTERN = Regex("^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")

    /** Runtime allowlist guard — `track()` drops any unregistered name. */
    fun isTelemetryEventName(name: String): Boolean = TELEMETRY_EVENTS.containsKey(name)
}
