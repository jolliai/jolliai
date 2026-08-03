import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Two of the discoverer's guards protect against a TOCTOU race — the file or db
// disappearing between the existsSync/statSync probe and the read. The
// filesystem cannot be made to lose that race on demand, so the two holders
// below inject the exact error the race would produce. Both default to
// `undefined`, i.e. fully real behaviour.
const race = vi.hoisted(() => ({
	readStreamError: undefined as Error | undefined,
	sqliteError: undefined as Error | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
			if (race.readStreamError) throw race.readStreamError;
			return actual.createReadStream(...args);
		},
	};
});
vi.mock("./SqliteHelpers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./SqliteHelpers.js")>();
	return {
		...actual,
		withSqliteDb: (...args: Parameters<typeof actual.withSqliteDb>) => {
			if (race.sqliteError) throw race.sqliteError;
			return actual.withSqliteDb(...args);
		},
	};
});

import { buildMetadataBlob, createAntigravityConvo, REAL_TRANSCRIPT_FULL } from "../testUtils/antigravityFixture.js";
import { symlinksSupported } from "../testUtils/symlinkSupport.js";
import {
	discoverAntigravitySessions,
	extractWorkspacePath,
	scanAntigravitySessions,
} from "./AntigravitySessionDiscoverer.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

function enoent(message: string): Error {
	return Object.assign(new Error(message), { code: "ENOENT" });
}

const sqliteOnly = hasNodeSqliteSupport() ? describe : describe.skip;
// The non-ENOENT-stat case needs a self-referential symlink (ELOOP); symlink()
// throws EPERM on a non-elevated Windows account, so skip it there.
const itIfSymlinks = symlinksSupported ? it : it.skip;

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Overwrites a conversation's transcript_full.jsonl with raw (possibly malformed) text. */
function overwriteTranscript(transcriptPath: string, text: string): void {
	writeFileSync(transcriptPath, text);
}

describe("extractWorkspacePath", () => {
	it("reads the first file:// uri from a real-shaped blob", () => {
		const blob = buildMetadataBlob("/Users/x/repo", "gh/x", "main");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/repo");
	});

	it("returns undefined when no file:// present", () => {
		expect(extractWorkspacePath(new Uint8Array([0x08, 0x01]))).toBeUndefined();
	});

	it("percent-decodes spaced / non-ASCII path segments", () => {
		// Antigravity is VS Code-based; Uri.toString() percent-encodes the path,
		// so a repo path with a space or CJK char arrives as %XX in the blob.
		const blob = buildMetadataBlob("/Users/x/my%20repo%E6%9F%A5");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/my repo查");
	});

	it("strips the leading slash before a Windows drive letter", () => {
		// VS Code's Uri.file("e:\\jollimemory").toString() === "file:///e%3A/jollimemory";
		// the extra slash must be dropped or the path never matches native "e:/jollimemory".
		const blob = buildMetadataBlob("/e%3A/jollimemory");
		expect(extractWorkspacePath(blob)).toBe("e:/jollimemory");
	});

	// A `file://` uri longer than 127 bytes needs a MULTI-byte protobuf length
	// varint, so the backward walk over its continuation bytes (MSB set) has to
	// run — a single-byte-only reader would misread the length and bail.
	it("reads a length varint that spans multiple bytes (uri > 127 chars)", () => {
		const deep = `/Users/x/${"nested-package-directory/".repeat(6)}repo`;
		expect(`file://${deep}`.length).toBeGreaterThan(127);
		expect(extractWorkspacePath(buildMetadataBlob(deep))).toBe(deep);
	});

	it("returns undefined when the length prefix is shorter than 'file://'", () => {
		// tag 0x0a + length 0x03 — too short to be a uri, so the field is not one.
		const blob = Buffer.concat([Buffer.from([0x0a, 0x03]), Buffer.from("file:///tmp/x")]);
		expect(extractWorkspacePath(blob)).toBeUndefined();
	});

	it("returns undefined when the length prefix runs past the end of the blob", () => {
		// tag 0x0a + length 0x7f (127) against a 12-byte payload — a truncated blob.
		const blob = Buffer.concat([Buffer.from([0x0a, 0x7f]), Buffer.from("file://short")]);
		expect(extractWorkspacePath(blob)).toBeUndefined();
	});

	it("keeps the raw slice when the uri carries a malformed %-escape", () => {
		// `%zz` is not a valid escape — decodeURIComponent throws, and the extractor
		// must fall back to the undecoded path rather than dropping the workspace.
		const blob = buildMetadataBlob("/Users/x/repo%zz");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/repo%zz");
	});
});

sqliteOnly("AntigravitySessionDiscoverer", () => {
	it("discovers a conversation scoped to projectDir", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "1bbaa61e",
			workspacePath: ws,
			gitRemote: "https://github.com/jolliai/jolliai.git",
			branch: "feature/x",
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("1bbaa61e");
		expect(sessions[0].source).toBe("antigravity");
		expect(sessions[0].transcriptPath.endsWith("transcript_full.jsonl")).toBe(true);
		expect(sessions[0].title).toContain("查看当前分支");
	});

	it("skips conversations for other workspaces", async () => {
		const home = freshDir("agy-home-");
		createAntigravityConvo(home, {
			convId: "other",
			workspacePath: "/some/other/repo",
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		expect(await discoverAntigravitySessions(freshDir("repo-"), home)).toHaveLength(0);
	});

	it("skips a matching conversation whose transcript is not materialized yet", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "pending",
			workspacePath: ws,
			transcriptLines: [],
			writeTranscript: false,
		});
		expect(await discoverAntigravitySessions(ws, home)).toHaveLength(0);
	});

	it("scans all variants and returns sessions across them", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "a",
			variant: "antigravity",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		createAntigravityConvo(home, {
			convId: "b",
			variant: "antigravity-ide",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const { sessions } = await scanAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
	});

	it("matches a conversation recorded against a sibling worktree of the same repo", async () => {
		// Real Antigravity setups open the IDE on one checkout (often the main
		// worktree) while commits happen from a linked worktree. Exact-match on
		// projectDir would drop the conversation; worktree-aware matching keeps it.
		const home = freshDir("agy-home-");
		const mainRepo = realpathSync(freshDir("repo-main-"));
		const git = (args: string[]) => execFileSync("git", args, { cwd: mainRepo, stdio: "pipe" });
		git(["init", "-q", "-b", "main"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		const wt = join(realpathSync(freshDir("repo-wt-")), "wt");
		git(["worktree", "add", "-q", wt, "-b", "feature"]);

		// Conversation opened in the MAIN checkout...
		createAntigravityConvo(home, {
			convId: "cross-wt",
			workspacePath: mainRepo,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});

		// ...discovered while running from the sibling WORKTREE.
		const sessions = await discoverAntigravitySessions(wt, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["cross-wt"]);
	});

	// JOLLI-2015: a conversation recorded in a subdirectory of the project (the IDE
	// opened on a subpackage, or a CLI variant run from `cd packages/foo`) IS
	// attributed to the repo via prefix/containment matching — shared with the other
	// hookless sources.
	it("discovers a conversation recorded in a subdirectory of the project (prefix match)", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "in-subdir",
			workspacePath: join(ws, "packages", "foo"),
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["in-subdir"]);
	});

	// A conversation living in a NESTED git repo / submodule inside the worktree
	// belongs to the inner repo, not this one — an intervening `.git` excludes it.
	it("skips a conversation inside a nested git repo under the project", async () => {
		const home = freshDir("agy-home-");
		const ws = realpathSync(freshDir("repo-"));
		const nested = join(ws, "vendor", "lib");
		mkdirSync(join(nested, ".git"), { recursive: true });
		createAntigravityConvo(home, {
			convId: "nested",
			workspacePath: nested,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		expect(await discoverAntigravitySessions(ws, home)).toHaveLength(0);
	});

	it("de-duplicates a conversation present under multiple variants, keeping the newest", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const mk = (variant: string) =>
			createAntigravityConvo(home, {
				convId: "dup",
				variant,
				workspacePath: ws,
				transcriptLines: REAL_TRANSCRIPT_FULL,
			});
		// Relative to now so the conversations stay inside the 48h window whenever
		// the suite runs. antigravity-ide is newest → kept; -cli is oldest → the
		// `>=` guard skips its SQLite open; antigravity is replaced when -ide wins.
		const now = Date.now();
		const at = (hoursAgo: number) => {
			const d = new Date(now - hoursAgo * 3600_000);
			return [d, d] as const;
		};
		utimesSync(mk("antigravity").dbPath, ...at(2));
		utimesSync(mk("antigravity-ide").dbPath, ...at(1));
		utimesSync(mk("antigravity-cli").dbPath, ...at(3));

		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].transcriptPath).toContain("antigravity-ide");
	});

	it("skips a conversation whose db was last touched more than 48h ago", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const { dbPath } = createAntigravityConvo(home, {
			convId: "stale",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const old = new Date(Date.now() - 49 * 3600_000);
		utimesSync(dbPath, old, old);
		expect(await discoverAntigravitySessions(ws, home)).toHaveLength(0);
	});

	it("skips a variant whose conversations path is not a directory", async () => {
		// existsSync() is happy with a FILE at conversations/, so the variant is
		// listed; readdirSync then fails with ENOTDIR and the variant is skipped
		// rather than aborting the whole scan.
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
		writeFileSync(join(home, ".gemini", "antigravity-cli", "conversations"), "not a dir");
		createAntigravityConvo(home, {
			convId: "healthy",
			variant: "antigravity",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const { sessions, error } = await scanAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["healthy"]);
		expect(error).toBeUndefined();
	});

	itIfSymlinks("skips a listed .db that cannot be stat'ed", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const { dbPath } = createAntigravityConvo(home, {
			convId: "healthy",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		// Self-referential symlink — readdirSync lists it, statSync chases the link
		// into itself and throws ELOOP. Models the real race where a conversation
		// is deleted between the listing and the stat.
		const loop = join(dbPath, "..", "loop.db");
		symlinkSync(loop, loop, "file");
		const { sessions } = await scanAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["healthy"]);
	});

	it("surfaces a scan error for an unreadable db while keeping the healthy ones", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const { dbPath } = createAntigravityConvo(home, {
			convId: "healthy",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		// A .db that is not a SQLite file at all — node:sqlite throws on the query.
		writeFileSync(join(dbPath, "..", "garbage.db"), "this is not a database");
		const { sessions, error } = await scanAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["healthy"]);
		expect(error).toBeDefined();
	});

	// The db passed statSync but was gone by the time SQLite opened it (the user
	// deleted the conversation mid-scan). classifyScanError returns null for
	// ENOENT, so this is benign: skip the conversation, surface NO error.
	it("silently skips a conversation whose db vanished between the stat and the open", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "vanished",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		race.sqliteError = enoent("no such file or directory, open db");
		try {
			const { sessions, error } = await scanAntigravitySessions(ws, home);
			expect(sessions).toEqual([]);
			expect(error).toBeUndefined();
		} finally {
			race.sqliteError = undefined;
		}
	});

	it("skips a db whose trajectory_metadata_blob has no 'main' row", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const convDir = join(home, ".gemini", "antigravity", "conversations");
		mkdirSync(convDir, { recursive: true });
		const db = new DatabaseSync(join(convDir, "no-main.db"));
		db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
		db.close();
		const { sessions, error } = await scanAntigravitySessions(ws, home);
		expect(sessions).toEqual([]);
		expect(error).toBeUndefined();
	});
});

sqliteOnly("AntigravitySessionDiscoverer titles", () => {
	/** Creates a matching conversation and rewrites its transcript with raw text. */
	function convoWithRawTranscript(text: string): { ws: string; home: string; transcriptPath: string } {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const { transcriptPath } = createAntigravityConvo(home, {
			convId: "titled",
			workspacePath: ws,
			transcriptLines: [],
		});
		overwriteTranscript(transcriptPath, text);
		return { ws, home, transcriptPath };
	}

	it("skips blank lines, malformed JSON and non-USER_INPUT rows when reading the title", async () => {
		const { ws, home } = convoWithRawTranscript(
			[
				"",
				"   ",
				'{"type":"USER_INPUT","content":',
				JSON.stringify({ type: "CHECKPOINT", content: "{{ CHECKPOINT 0 }}" }),
				// USER_INPUT whose content is not a string — cannot be a title.
				JSON.stringify({ type: "USER_INPUT", content: { text: "structured" } }),
				// An empty envelope yields no text, so the scan keeps looking.
				JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST></USER_REQUEST>" }),
				JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nthe real one\n</USER_REQUEST>" }),
			].join("\n"),
		);
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions[0].title).toBe("the real one");
	});

	it("truncates a long title at 120 chars with an ellipsis", async () => {
		const long = "查".repeat(200);
		const { ws, home } = convoWithRawTranscript(
			JSON.stringify({ type: "USER_INPUT", content: `<USER_REQUEST>${long}</USER_REQUEST>` }),
		);
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions[0].title).toBe(`${"查".repeat(120)}…`);
	});

	it("leaves the title undefined when the transcript holds no USER_INPUT", async () => {
		const { ws, home } = convoWithRawTranscript(
			JSON.stringify({ type: "PLANNER_RESPONSE", content: "no user turn here" }),
		);
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].title).toBeUndefined();
	});

	// The transcript passed existsSync but was gone by the time the stream opened.
	// ENOENT is the expected shape of that race, so readTitle stays silent (no
	// debug log) and the session still surfaces — just without a title.
	it("leaves the title undefined, without logging, when the transcript vanished mid-scan", async () => {
		const { ws, home } = convoWithRawTranscript(
			JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>gone</USER_REQUEST>" }),
		);
		race.readStreamError = enoent("no such file or directory, open transcript_full.jsonl");
		try {
			const sessions = await discoverAntigravitySessions(ws, home);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].title).toBeUndefined();
		} finally {
			race.readStreamError = undefined;
		}
	});

	it("leaves the title undefined when the transcript path is unreadable", async () => {
		// A DIRECTORY named transcript_full.jsonl: existsSync() passes the
		// materialization gate, then the read stream fails with EISDIR — a
		// non-ENOENT error, so readTitle logs and degrades to no title.
		const { ws, home, transcriptPath } = convoWithRawTranscript("");
		rmSync(transcriptPath);
		mkdirSync(transcriptPath);
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].title).toBeUndefined();
	});
});
