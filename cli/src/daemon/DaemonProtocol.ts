/**
 * Jolli daemon wire protocol — one-way, notification-only.
 *
 * The daemon watches a project's write outputs (queue drain, orphan branch
 * ref, memory bank folder) and pushes a compact `refresh` notification when
 * anything completes. It does NOT accept requests; read-path request/response
 * belongs to a later slice, and folding that into this command would blur
 * responsibilities. The wire format is JSON-RPC 2.0 notifications, one JSON
 * object per line on stdout, so a future request channel can be layered on
 * without breaking clients that only care about notifications.
 *
 * Startup handshake: the daemon emits exactly one `ready` notification with
 * the protocol id + pid before any watchers arm. Clients that receive an
 * unrecognized protocol should disconnect — a version bump here means the
 * refresh payload shape has changed in a way old clients would misinterpret.
 */

export const DAEMON_PROTOCOL = "jolli-daemon-notify-v1";

/**
 * `refresh` payloads carry an intentionally coarse `kind` — the client treats
 * a notification as "reload from source of truth" rather than a diff. Adding
 * a finer kind is a compatible extension for clients that only branch on the
 * ones they know.
 *
 * `working-context` and `claude-plans` are the mid-session pair: the first
 * fires when `plans.json` is rewritten (StopHook discovery, an archive, a
 * removal), the second when a file appears in the machine-global
 * `~/.claude/plans/`. They exist because the original three kinds all describe
 * COMMIT-time outputs, which left a JVM host with no push signal at all for
 * context the user creates while a session is still running — it had to wait
 * for the agent's turn to end. See `params.names` for why the second one is
 * the only kind that carries a payload.
 *
 * `memory-db` is `orphan-ref`'s successor, and both are watched because a repo
 * can be on either side of the cutover: before it, memories land on the orphan
 * ref and the database is a projection; after it, the ref is FROZEN and the
 * only file that moves is the database. Watching just the ref meant a cut-over
 * repo pushed nothing at all — a JVM host's sidebar simply stopped updating,
 * with no error anywhere. Deliberately NOT given a Kotlin constant: clients
 * branch only on the two mid-session kinds and everything else falls through to
 * the status refresh, which is exactly the handling this kind wants.
 */
export type RefreshKind = "queue" | "orphan-ref" | "memory-db" | "memory-bank" | "working-context" | "claude-plans";

export interface DaemonReadyNotification {
	readonly jsonrpc: "2.0";
	readonly method: "ready";
	readonly params: {
		readonly protocol: string;
		readonly pid: number;
	};
}

export interface DaemonRefreshNotification {
	readonly jsonrpc: "2.0";
	readonly method: "refresh";
	readonly params: {
		readonly kind: RefreshKind;
		readonly cwd: string;
		/**
		 * Filenames the burst touched — present only for `claude-plans`, and the
		 * one place this channel is not purely "reload from source of truth".
		 *
		 * `~/.claude/plans/` is machine-global and holds every project's plans
		 * ever, so a client cannot answer "what is new?" by re-listing it. The
		 * OS create event is the only thing that distinguishes a plan authored
		 * seconds ago from one authored last month, and that information dies
		 * with the event unless it rides along here. Absent (not empty) for
		 * every other kind; empty when the platform reported no filename.
		 *
		 * Names are raw directory entries, NOT slugs: turning `foo.md` into the
		 * slug `foo` is a rule, and rules stay CLI-side (`plans-register-new`).
		 */
		readonly names?: ReadonlyArray<string>;
	};
}

export type DaemonNotification = DaemonReadyNotification | DaemonRefreshNotification;
