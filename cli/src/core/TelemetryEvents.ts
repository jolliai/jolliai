/**
 * TelemetryEvents — the append-only allowlist of telemetry event names plus a
 * one-line description for each (JOLLI-1785 Phase 2 / JOLLI-1786 §9). This is
 * the single source of truth for:
 *
 *   - the runtime allowlist `track()` enforces — an unregistered name is a
 *     programming error and is dropped before it ever reaches the buffer;
 *   - the auto-generated transparency doc `TELEMETRY.md` (Phase 4);
 *   - the IntelliJ Kotlin port (`Telemetry.kt`), which mirrors this list
 *     verbatim — keep the two in lockstep.
 *
 * Conventions (asserted by `TelemetryEvents.test.ts`):
 *   - Names are **append-only contracts**: never rename or repurpose a name,
 *     because old dashboards and stored rows reference it forever. Add new
 *     names; don't mutate existing ones.
 *   - Names follow the `object_action` convention (snake_case, two-plus
 *     lowercase words joined by `_`), matched by `TELEMETRY_EVENT_NAME_PATTERN`.
 *   - Event-specific fields live in the envelope's `properties` bag, never in
 *     the name — so adding a property is migration-free server-side (JSONB).
 */

/**
 * The frozen event registry. Key = event name (`object_action`); value = the
 * human-readable line that flows into `TELEMETRY.md`.
 */
export const TELEMETRY_EVENTS = {
	// ── lifecycle & conversion funnel (the primary goal) ──
	app_installed:
		"First run after install; installId minted (once per machine). Props: none — count distinct install_id.",
	client_activated:
		"A GUI surface activated (VS Code activate / IntelliJ project open), carrying `surface_version`. First-seen (install_id, surface_version) ≈ new + upgrade installs that launched. GUI-only — CLI new/upgrade is read from any event's surface_version.",
	surface_enabled: "A surface was enabled in a repo. Props: trigger.",
	surface_disabled: "A surface was disabled / opted out. Props: trigger, reason.",
	signin_started: "User initiated OAuth sign-in. Props: trigger.",
	signin_completed: "jolliApiKey minted — the conversion event. Props: api_key_minted.",
	signed_out: "User logged out. Props: none.",
	ai_provider_selected: "User chose jolli vs anthropic for LLM. Props: provider (discriminator).",
	memory_bank_migrated: "Migrate-to-Memory-Bank run. Props: outcome, repos, entries_bucket.",
	// ── feature usage / adoption ──
	command_invoked:
		'Any CLI command ran (auto-emitted). Props: command (discriminator), ok, duration_ms. MCP tool calls carry a `tool` property and are emitted per call (not per session); the session-level `command:"mcp"` event is suppressed.',
	recall_performed: "A recall was run. Props: hit, result_count_bucket.",
	search_performed: "A search was run. Props: query_len_bucket, result_count_bucket.",
	memory_pushed: "Memories pushed to a Space. Props: kind, created, plans_bucket.",
	export_performed: "Export run. Props: format (discriminator).",
	ai_source_detected:
		"A new AI source transcript was detected. Props: source (discriminator: claude/codex/cursor/…).",
	settings_opened: "Settings UI opened (vscode/intellij). Props: tab (discriminator).",
	// ── pipeline health ──
	ingest_completed:
		"A drainIngest run finished. Props: outcome, ingested, idle (no-op when ingested=0), batches, route_calls, reconcile_calls, touched_slugs, topic_failures, duration_ms. Filter idle=true out for real-ingest latency/health metrics.",
	error_occurred:
		"A structured error was raised. Content-free schema: { where (stage/subsystem), code (enumerated), source? , retryable? }. Emitted via trackError(); never carries a message/stack/path.",
	queue_drained: "QueueWorker finished a drain. Props: ops, duration_ms.",
	sync_completed: "A memory-bank sync round finished. Props: outcome (discriminator), duration_ms.",
	// ── IDE tool-window UI / engagement (IntelliJ, VS Code) ──
	toolwindow_opened: "The memory tool window was opened. Props: view.",
	view_switched: "Tool window view switched (current/bank/knowledge). Props: view (discriminator).",
	memory_committed:
		"User committed a memory via the Commit button. Props: files_bucket (bucketed changed-file count), has_conversations (bool), context_bucket (bucketed plans/context count).",
	memory_expanded: "A committed memory's details were expanded. Props: expanded.",
	memory_item_opened:
		"An item inside a memory was opened. Props: item_type (discriminator: conversation/file/plan/note/reference/shipped); render (conversation only: live/stored — whether the source transcript was reopened or the stored copy was shown); source (conversation only: the transcript source, e.g. claude/codex); status (file only: the git status code, e.g. A/M/D).",
	session_resumed: "A conversation session was resumed in a terminal. Props: source (discriminator).",
	recall_prompt_copied: "A recall prompt was copied to the clipboard. Props: none.",
	memory_pinned: "An item was pinned. Props: kind (discriminator).",
	memory_unpinned: "An item was unpinned. Props: kind (discriminator).",
	repo_switched: "User switched the active repo in the tool window's breadcrumb. Props: is_foreign (bool).",
	branch_switched: "User switched the active branch in the tool window's breadcrumb. Props: is_foreign (bool).",
	squash_performed: "User squashed commits. Props: count_bucket (bucketed number of commits squashed).",
	pr_created: "User created or updated a PR from the tool window. Props: action (discriminator: created/updated).",
	memory_shared: "User invoked Share for a branch's memories (read-only share link). Props: none.",
	key_rejected: "The server rejected the API key (401/403). Props: retried, where.",
	reauth_completed: "Re-authentication after a rejected key finished. Props: outcome.",
} as const;

/** Union of every registered event name. */
export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS;

/**
 * `object_action` naming convention: lowercase snake_case with at least two
 * words. Enforced by the registry test so a malformed name can never be added.
 */
export const TELEMETRY_EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * Runtime allowlist guard. `track()` calls this before buffering: a name that
 * isn't in the registry is a caller bug, so the event is dropped rather than
 * silently shipping an unknown name to the backend (which also allowlists).
 */
const REGISTERED_NAMES: ReadonlySet<string> = new Set(Object.keys(TELEMETRY_EVENTS));

export function isTelemetryEventName(name: string): name is TelemetryEventName {
	return REGISTERED_NAMES.has(name);
}
