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
 */
export type RefreshKind = "queue" | "orphan-ref" | "memory-bank";

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
	};
}

export type DaemonNotification = DaemonReadyNotification | DaemonRefreshNotification;
