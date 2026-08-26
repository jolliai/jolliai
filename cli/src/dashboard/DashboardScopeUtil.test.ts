import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	clampLabel,
	isOpaqueMcpServerId,
	mcpServerFoldedIdentifierSql,
	mcpServerKeySql,
	stripOpaqueMcpServerIdPrefix,
	UNIDENTIFIED_MCP_SERVER,
} from "./DashboardScopeUtil.js";

describe("clampLabel", () => {
	it("cuts English on a word boundary, not where the pixel runs out", () => {
		// `text-overflow: ellipsis` alone cuts mid-word — "…recorded a de…" is what a
		// reader reports. This runs first so the visible cut is a whole word.
		expect(clampLabel("dashboard decisions card recorded a decision heatmap", 48)).toBe(
			"dashboard decisions card recorded a decision…",
		);
	});

	it("cuts CJK on a character boundary, because there is no other one", () => {
		// No spaces, so `lastIndexOf(" ")` finds nothing and the character boundary is
		// exactly right: a Chinese character IS the unit. Same rule, opposite outcome.
		const zh =
			"限流器在突发流量下的处理方式以及为什么要按组织维度做配额而不是按用户维度做配额这件事的来龙去脉和后续影响";
		expect(clampLabel(zh, 48)).toBe(
			"限流器在突发流量下的处理方式以及为什么要按组织维度做配额而不是按用户维度做配额这件事的来龙去脉和…",
		);
	});

	it("cuts a mixed string at its last space", () => {
		expect(clampLabel("为什么 rate limiter 要按 org 维度做配额而不是按 user 维度这件事情的完整背景说明", 48)).toBe(
			"为什么 rate limiter 要按 org 维度做配额而不是按 user…",
		);
	});

	it("leaves anything already short enough alone, trimmed", () => {
		expect(clampLabel("  rate limiter  ", 48)).toBe("rate limiter");
	});

	it("takes the character boundary when honouring the word one would gut the label", () => {
		// One very long token followed by a space: cutting back to the boundary would
		// leave almost nothing, so the floor keeps the fallback honest.
		expect(clampLabel(`${"x".repeat(40)} tail`, 20)).toBe(`${"x".repeat(20)}…`);
	});
});

/**
 * The opaque-id fold, in both of its spellings.
 *
 * The SQL half is run against a REAL in-memory database rather than compared as
 * text: what is being asserted is what SQLite does with the expression (GLOB's
 * character classes, `replace`'s dash count), which a string comparison cannot
 * see. The TS half is asserted over the SAME corpus, because the two answer the
 * same question in two places — the row folds through the SQL and its label is
 * stripped through the TS — and a drift between them shows up as neither an
 * error nor a wrong number, only as a tool row still carrying an id.
 */
describe("the unidentified-MCP-server fold", () => {
	/** `name` → what the SQL expression answers, through a real database. */
	const foldSql = (name: string): string => {
		const db = new DatabaseSync(":memory:");
		try {
			const row = db.prepare(`SELECT ${mcpServerKeySql("v")} AS key FROM (SELECT :v AS v)`).get({ v: name }) as {
				key: string;
			};
			return row.key;
		} finally {
			db.close();
		}
	};

	const cases: ReadonlyArray<{ name: string; opaque: boolean; why: string }> = [
		// The report's own row: a claude.ai connector whose name never came back
		// from the OAuth handshake (anthropics/claude-code#58015).
		{ name: "c781d8b5-a5fc-4bbe-a50a-7c046078108e", opaque: true, why: "the reported connector UUID" },
		{ name: "C781D8B5-A5FC-4BBE-A50A-7C046078108E", opaque: true, why: "hex is case-insensitive" },
		// The same id namespace spelled the other way — read off a real
		// `~/.claude/mcp-needs-auth-cache.json`.
		{ name: "mcpsrv_014EPfMfdQAH73iQbMiZHob1", opaque: true, why: "the mcpsrv_ id form" },
		// Real servers that must survive. The first two are Claude Code's own
		// app-internal servers and sit beside the UUID in the bug report, which is
		// exactly why the test names them.
		{ name: "ccd_session", opaque: false, why: "an app-internal server, not an id" },
		{ name: "Claude_Browser", opaque: false, why: "an app-internal server, not an id" },
		{ name: "claude_ai_Linear", opaque: false, why: "the resolved name of the same connector class" },
		{ name: "codex_apps", opaque: false, why: "a connector gateway" },
		{ name: "jollimemory", opaque: false, why: "a bare server" },
		// Shape boundaries. The dash TOTAL is pinned at four, so a 36-character
		// run of separators is not a UUID — without that test the `?` wildcards
		// admit it.
		{ name: "------------------------------------", opaque: false, why: "36 dashes is not a UUID" },
		{ name: "c781d8b5-a5fc-4bbe-a50a-7c04607810", opaque: false, why: "too short" },
		{ name: "c781d8b5-a5fc-4bbe-a50a-7c046078108eX", opaque: false, why: "too long" },
		{ name: "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", opaque: false, why: "shaped like one, but not hex" },
		{ name: "mcpsrv_short", opaque: false, why: "the id body is a fixed 24 characters" },
		{ name: "mcpsrv_014EPfMfdQAH73iQbMiZHob!", opaque: false, why: "the id body is alphanumeric" },
	];

	it.each(cases)("SQL folds $name → opaque=$opaque ($why)", ({ name, opaque }) => {
		expect(foldSql(name)).toBe(opaque ? UNIDENTIFIED_MCP_SERVER : name);
	});

	it("answers the same in TypeScript as it does in SQL", () => {
		for (const { name, opaque } of cases) {
			expect({ name, opaque: isOpaqueMcpServerId(name) }).toEqual({ name, opaque });
			expect({ name, opaque: foldSql(name) === UNIDENTIFIED_MCP_SERVER }).toEqual({ name, opaque });
		}
	});

	it("still folds a plugin registration alias, and folds an id hiding behind one", () => {
		// The two folds compose in one expression, in this order: strip the host's
		// plugin prefix, then judge what is left.
		expect(foldSql("plugin_jolli_jollimemory")).toBe("jollimemory");
		expect(foldSql("plugin_jolli_c781d8b5-a5fc-4bbe-a50a-7c046078108e")).toBe(UNIDENTIFIED_MCP_SERVER);
	});

	it("guards the row against every kind but mcp", () => {
		// A skill or builtin named like an id is a name somebody chose — the same
		// reason `mcpFoldedIdentifierSql` exists for the plugin prefix.
		const db = new DatabaseSync(":memory:");
		try {
			const sql = `SELECT ${mcpServerFoldedIdentifierSql("v", "k")} AS key FROM (SELECT :v AS v, :k AS k)`;
			const read = (v: string, k: string) => (db.prepare(sql).get({ v, k }) as { key: string }).key;
			const id = "c781d8b5-a5fc-4bbe-a50a-7c046078108e";
			expect(read(id, "mcp")).toBe(UNIDENTIFIED_MCP_SERVER);
			expect(read(id, "skill")).toBe(id);
			expect(read(id, "builtin")).toBe(id);
		} finally {
			db.close();
		}
	});

	it("strips a tool name's own id prefix, and nothing else's", () => {
		expect(stripOpaqueMcpServerIdPrefix("c781d8b5-a5fc-4bbe-a50a-7c046078108e.get_issue")).toBe("get_issue");
		expect(stripOpaqueMcpServerIdPrefix("mcpsrv_014EPfMfdQAH73iQbMiZHob1.list_issues")).toBe("list_issues");
		// A real server keeps its prefix here: the pane strips that one by equality
		// against the row it was opened with.
		expect(stripOpaqueMcpServerIdPrefix("jollimemory.recall")).toBe("jollimemory.recall");
		// Nothing to split, and a leading dot is not a server segment.
		expect(stripOpaqueMcpServerIdPrefix("recall")).toBe("recall");
		expect(stripOpaqueMcpServerIdPrefix(".recall")).toBe(".recall");
	});
});
