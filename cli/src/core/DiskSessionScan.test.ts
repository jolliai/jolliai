import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../Types.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";

const entry = (id: string, dirs: string[]): DiskSession => ({
	session: { sessionId: id, transcriptPath: `/t/${id}`, updatedAt: "2026-07-30T08:00:00.000Z", source: "kimi" },
	dirs,
});

const ids = (sessions: ReadonlyArray<SessionInfo>) => sessions.map((s) => s.sessionId);

describe("sessionsForRepo", () => {
	it("keeps a session when any of its recorded directories matches", () => {
		// Multi-directory sessions are the reason `dirs` is a list: Claude follows the
		// user across `cd`, and Devin carries attached workspaces alongside its primary
		// one. Matching only the first would drop every session started from an
		// attached worktree.
		const scanned = [entry("a", ["/other", "/repo"]), entry("b", ["/other"])];
		expect(ids(sessionsForRepo(scanned, (d) => d === "/repo"))).toEqual(["a"]);
	});

	it("drops a session that recorded no directory at all", () => {
		// The tempting reading of an empty list — no directories, therefore no
		// objection, therefore keep it — would attach the session to every repo on the
		// machine. `some` on an empty array is false, which is the behaviour wanted.
		expect(sessionsForRepo([entry("a", [])], () => true)).toEqual([]);
	});

	it("filters rather than partitions: two repos may both claim one session", () => {
		// Two clones or two worktrees of one project legitimately share a session.
		// Assigning it to exactly one would silently drop it from the other.
		const scanned = [entry("shared", ["/repo"])];
		expect(ids(sessionsForRepo(scanned, (d) => d === "/repo"))).toEqual(["shared"]);
		expect(ids(sessionsForRepo(scanned, (d) => d.startsWith("/re")))).toEqual(["shared"]);
	});

	it("returns the session verbatim, without rebuilding it", () => {
		// Ids, synthetic transcript paths and native titles are per-source rules that
		// live next to the store that produced them. Narrowing must not re-derive them.
		const one = entry("a", ["/repo"]);
		expect(sessionsForRepo([one], () => true)[0]).toBe(one.session);
	});

	it("stops testing a session's directories at the first match", () => {
		// Not an optimisation detail: a predicate that hits the filesystem (the
		// nested-repo `.git` walk does) would otherwise pay for directories that cannot
		// change the answer.
		const seen: string[] = [];
		sessionsForRepo([entry("a", ["/repo", "/other"])], (d) => {
			seen.push(d);
			return d === "/repo";
		});
		expect(seen).toEqual(["/repo"]);
	});

	it("propagates a throwing predicate instead of dropping the session", () => {
		// Every real attribution rule here is a pure path comparison, so a throw means
		// the closure captured something it should not have. Swallowing it would turn a
		// programming error into silently missing sessions.
		expect(() =>
			sessionsForRepo([entry("a", ["/repo"])], () => {
				throw new Error("predicate blew up");
			}),
		).toThrow("predicate blew up");
	});
});
