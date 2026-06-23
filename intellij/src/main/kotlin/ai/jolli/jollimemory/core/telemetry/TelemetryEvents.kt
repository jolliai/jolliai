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
            "ingest_completed" to "A drainIngest run finished.",
            "error_occurred" to "A structured error code was raised.",
            "queue_drained" to "QueueWorker finished a drain.",
            "sync_completed" to "A memory-bank sync round finished.",
        )

    /** `object_action`: lowercase snake_case with at least two words. */
    val TELEMETRY_EVENT_NAME_PATTERN = Regex("^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")

    /** Runtime allowlist guard — `track()` drops any unregistered name. */
    fun isTelemetryEventName(name: String): Boolean = TELEMETRY_EVENTS.containsKey(name)
}
