/**
 * Pinned Cursor CLI (cursor-agent) fixture.
 *
 * Shape verified against a live cursor-agent install on macOS — see
 * docs/superpowers/specs/2026-07-21-cursor-cli-transcript-source-design.md
 * ("Observed Reality"). Field names, epoch-MILLISECOND timestamps, the
 * `<timestamp>`/`<user_query>` user-text wrappers, and the trailing
 * `{type,status}` control line are reproduced verbatim from real data;
 * only the free-text content is neutralized for this open-source repo.
 */

/** A real ~/.cursor/chats/<md5(cwd)>/<uuid>/meta.json (cwd neutralized). */
export const CURSOR_CLI_META_JSON = JSON.stringify({
	schemaVersion: 1,
	createdAtMs: 1784631439335,
	hasConversation: true,
	title: "Hello There",
	updatedAtMs: 1784631456880,
	cwd: "/Users/example/proj",
});

/** A real ~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl (3 lines: user, assistant, control). */
export const CURSOR_CLI_TRANSCRIPT_JSONL = [
	'{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Tuesday, Jul 21, 2026, 6:57 PM (UTC+8)</timestamp>\\n<user_query>\\nhello\\n</user_query>"}]}}',
	'{"role":"assistant","message":{"content":[{"type":"text","text":"Hello! How can I help you today?"}]}}',
	'{"type":"turn_ended","status":"success"}',
	"",
].join("\n");
