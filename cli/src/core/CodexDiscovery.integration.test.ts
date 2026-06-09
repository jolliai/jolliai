import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY session discovery (filesystem scan) + persistence of the markdown
// (upsertReferenceEntry needs storage config). Everything else is REAL: the
// CodexEnvelopeParser, the shared scanReferencesFrom, and the discovery-cursors
// read/write — so this exercises the true parser → discovery → cursor path that
// the unit test (which stubs scanReferencesFrom) cannot.
vi.mock("./CodexSessionDiscoverer.js", () => ({
	discoverCodexSessions: vi.fn(),
	isCodexInstalled: vi.fn().mockResolvedValue(true),
}));
vi.mock("./SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./SessionTracker.js")>();
	return {
		...actual,
		loadConfig: vi.fn().mockResolvedValue({}),
		upsertReferenceEntry: vi.fn().mockResolvedValue(undefined),
	};
});

import { existsSync } from "node:fs";
import { discoverCodexConversations } from "./CodexDiscovery.js";
import { discoverCodexSessions } from "./CodexSessionDiscoverer.js";
import { loadDiscoveryCursor, loadPlansRegistry, savePlansRegistry, upsertReferenceEntry } from "./SessionTracker.js";

const TS = "2026-06-05T10:24:53.000Z";
const jsonl = (o: unknown) => JSON.stringify(o);
const fnCall = (namespace: string, name: string, callId: string) =>
	jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call", name, namespace, arguments: "{}", call_id: callId },
	});
const applyPatch = (input: string) =>
	jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input },
	});
const fnOutput = (callId: string, inner: unknown, wrap: "array" | "bare") =>
	jsonl({
		type: "response_item",
		timestamp: TS,
		payload: {
			type: "function_call_output",
			call_id: callId,
			output: `Wall time: 1s\nOutput:\n${wrap === "array" ? JSON.stringify([{ type: "text", text: JSON.stringify(inner) }]) : JSON.stringify(inner)}`,
		},
	});

const LINEAR = { id: "JOLLI-1657", title: "L", url: "https://linear.app/jolliai/issue/JOLLI-1657/x" };
const NOTION = {
	metadata: { type: "page" },
	title: "N",
	url: "https://app.notion.com/p/36c4fc101d34805ab1fdfb3e69144580",
	text: "x",
};
const GITHUB = {
	issue: {
		issue_number: 959,
		title: "G",
		url: "https://github.com/jolliai/jolli/issues/959",
		labels: [{ name: "bug" }],
	},
};
const JIRA = {
	issues: {
		nodes: [
			{
				key: "KAN-4",
				webUrl: "https://jolli-team-kr0v9z0x.atlassian.net/browse/KAN-4",
				fields: { summary: "J" },
			},
		],
	},
};

let dir: string;
let rollout: string;

beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "codex-int-"));
	rollout = join(dir, "rollout.jsonl");
	vi.mocked(discoverCodexSessions).mockResolvedValue([
		{ sessionId: "s1", transcriptPath: rollout, source: "codex", updatedAt: TS },
	]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const upsertedKeys = () =>
	vi
		.mocked(upsertReferenceEntry)
		.mock.calls.map((c) => `${c[0].source}:${c[0].nativeId}`)
		.sort();

describe("discoverCodexConversations — integration (real parser + scan + cursor)", () => {
	it("extracts all four sources from a complete rollout and advances the cursor to EOF", async () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
			fnOutput("c1", LINEAR, "array"),
			fnCall("mcp__codex_apps__notion", "_fetch", "c2"),
			fnOutput("c2", NOTION, "array"),
			fnCall("mcp__codex_apps__github", "_fetch_issue", "c3"),
			fnOutput("c3", GITHUB, "bare"),
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "c4"),
			fnOutput("c4", JIRA, "bare"),
		];
		writeFileSync(rollout, `${lines.join("\n")}\n`, "utf-8");

		await discoverCodexConversations(dir);

		expect(upsertedKeys()).toEqual([
			"github:jolliai/jolli#959",
			"jira:KAN-4",
			"linear:JOLLI-1657",
			"notion:36c4fc101d34805ab1fdfb3e69144580",
		]);
		const cursor = await loadDiscoveryCursor(rollout, dir);
		expect(cursor?.lineNumber).toBe(8);
	});

	it("recovers a straddling fetch across two polls without losing the ref (P1)", async () => {
		// Poll 1: only the Jira request is on disk (output not yet written).
		writeFileSync(rollout, `${fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1")}\n`, "utf-8");
		await discoverCodexConversations(dir);
		expect(upsertReferenceEntry).not.toHaveBeenCalled();
		// Cursor was NOT advanced past the in-flight request.
		expect(await loadDiscoveryCursor(rollout, dir)).toBeNull();

		// Poll 2: the output arrives; the re-scan recovers the Jira ref (tenant webUrl).
		appendFileSync(rollout, `${fnOutput("j1", JIRA, "bare")}\n`, "utf-8");
		await discoverCodexConversations(dir);
		expect(upsertedKeys()).toEqual(["jira:KAN-4"]);
		expect(vi.mocked(upsertReferenceEntry).mock.calls[0][0].url).toBe(
			"https://jolli-team-kr0v9z0x.atlassian.net/browse/KAN-4",
		);
	});

	it("ingests a markdown plan written by apply_patch into plans.json (title from first #)", async () => {
		// The plan file must exist on disk: the driver's existsSync guard reads it.
		mkdirSync(join(dir, "docs"), { recursive: true });
		writeFileSync(join(dir, "docs", "foo-plan.md"), "# Foo Plan Title\n\nbody\n", "utf-8");
		writeFileSync(
			rollout,
			`${applyPatch(["*** Begin Patch", "*** Add File: docs/foo-plan.md", "+# Foo Plan Title", "*** End Patch"].join("\n"))}\n`,
			"utf-8",
		);

		await discoverCodexConversations(dir);

		const registry = await loadPlansRegistry(dir);
		const entries = Object.values(registry.plans);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.title).toBe("Foo Plan Title");
		expect(entries[0]?.sourcePath).toBe(join(dir, "docs", "foo-plan.md"));
		// Plan + reference share one cursor; with no refs here it advances to EOF (1 line).
		expect((await loadDiscoveryCursor(rollout, dir))?.lineNumber).toBe(1);
	});

	it("does not churn plans.json while a straddling fetch caps the plan window, then ingests on the next poll (High)", async () => {
		mkdirSync(join(dir, "docs"), { recursive: true });
		writeFileSync(join(dir, "docs", "later-plan.md"), "# Later Plan\n", "utf-8");
		// Poll 1: an in-flight Jira fetch (request, no output) comes BEFORE the plan
		// write, so the reference safe cursor stops at the request line → the plan is
		// beyond refLine and must NOT be ingested this pass.
		writeFileSync(
			rollout,
			`${fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1")}\n${applyPatch(
				["*** Begin Patch", "*** Add File: docs/later-plan.md", "+# Later Plan", "*** End Patch"].join("\n"),
			)}\n`,
			"utf-8",
		);

		// Repeated polls (simulating multiple 60s ticks) must not write the plan or
		// advance the cursor while the fetch is in-flight.
		await discoverCodexConversations(dir);
		await discoverCodexConversations(dir);
		expect(Object.keys((await loadPlansRegistry(dir)).plans)).toHaveLength(0);
		expect(await loadDiscoveryCursor(rollout, dir)).toBeNull();
		expect(existsSync(join(dir, ".jolli", "jollimemory", "plans.json"))).toBe(false); // never written

		// Poll N: the fetch output lands → safe cursor advances past the plan line →
		// the plan is finally ingested.
		appendFileSync(rollout, `${fnOutput("j1", JIRA, "bare")}\n`, "utf-8");
		await discoverCodexConversations(dir);
		const entries = Object.values((await loadPlansRegistry(dir)).plans);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.title).toBe("Later Plan");
		expect((await loadDiscoveryCursor(rollout, dir))?.lineNumber).toBe(3);
	});

	it("ingests every .md file of a multi-file apply_patch into its own plans.json entry", async () => {
		mkdirSync(join(dir, "docs"), { recursive: true });
		writeFileSync(join(dir, "docs", "alpha.md"), "# Alpha\n", "utf-8");
		writeFileSync(join(dir, "docs", "beta.md"), "# Beta\n", "utf-8");
		writeFileSync(
			rollout,
			`${applyPatch(
				[
					"*** Begin Patch",
					"*** Add File: docs/alpha.md",
					"+# Alpha",
					"*** Update File: src/code.ts",
					"+code",
					"*** Add File: docs/beta.md",
					"+# Beta",
					"*** End Patch",
				].join("\n"),
			)}\n`,
			"utf-8",
		);

		await discoverCodexConversations(dir);

		const titles = Object.values((await loadPlansRegistry(dir)).plans)
			.map((p) => p.title)
			.sort();
		expect(titles).toEqual(["Alpha", "Beta"]); // both .md ingested, the .ts ignored
	});

	it("drops a stale Move-to source (no longer on disk) while keeping the move target", async () => {
		mkdirSync(join(dir, "docs"), { recursive: true });
		// Only the move TARGET exists on disk; the source was renamed away.
		writeFileSync(join(dir, "docs", "renamed.md"), "# Renamed\n", "utf-8");
		writeFileSync(
			rollout,
			`${applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: docs/original.md",
					"*** Move to: docs/renamed.md",
					"*** End Patch",
				].join("\n"),
			)}\n`,
			"utf-8",
		);

		await discoverCodexConversations(dir);

		const entries = Object.values((await loadPlansRegistry(dir)).plans);
		expect(entries).toHaveLength(1); // stale source dropped by existsSync guard
		expect(entries[0]?.sourcePath).toBe(join(dir, "docs", "renamed.md"));
	});

	it("does NOT register a Codex apply_patch .md that is already a markdown note", async () => {
		mkdirSync(join(dir, "docs"), { recursive: true });
		const noteFile = join(dir, "docs", "noted.md");
		writeFileSync(noteFile, "# Noted\n", "utf-8");
		// Pre-seed plans.json with a note pointing at the same file.
		await savePlansRegistry(
			{
				version: 1,
				plans: {},
				notes: {
					n1: {
						id: "n1",
						title: "Noted",
						format: "markdown",
						addedAt: TS,
						updatedAt: TS,
						commitHash: null,
						sourcePath: noteFile,
					},
				},
			},
			dir,
		);
		writeFileSync(
			rollout,
			`${applyPatch(["*** Begin Patch", "*** Add File: docs/noted.md", "+# Noted", "*** End Patch"].join("\n"))}\n`,
			"utf-8",
		);

		await discoverCodexConversations(dir);

		// The note suppresses plan auto-registration — plans stays empty, note intact.
		const registry = await loadPlansRegistry(dir);
		expect(Object.keys(registry.plans)).toHaveLength(0);
		expect(Object.keys(registry.notes ?? {})).toEqual(["n1"]);
	});
});
