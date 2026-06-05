import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { discoverCodexReferences } from "./CodexReferenceDiscovery.js";
import { discoverCodexSessions } from "./CodexSessionDiscoverer.js";
import { loadDiscoveryCursor, upsertReferenceEntry } from "./SessionTracker.js";

const TS = "2026-06-05T10:24:53.000Z";
const jsonl = (o: unknown) => JSON.stringify(o);
const fnCall = (namespace: string, name: string, callId: string) =>
	jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call", name, namespace, arguments: "{}", call_id: callId },
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

describe("discoverCodexReferences — integration (real parser + scan + cursor)", () => {
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

		await discoverCodexReferences(dir);

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
		await discoverCodexReferences(dir);
		expect(upsertReferenceEntry).not.toHaveBeenCalled();
		// Cursor was NOT advanced past the in-flight request.
		expect(await loadDiscoveryCursor(rollout, dir)).toBeNull();

		// Poll 2: the output arrives; the re-scan recovers the Jira ref (tenant webUrl).
		appendFileSync(rollout, `${fnOutput("j1", JIRA, "bare")}\n`, "utf-8");
		await discoverCodexReferences(dir);
		expect(upsertedKeys()).toEqual(["jira:KAN-4"]);
		expect(vi.mocked(upsertReferenceEntry).mock.calls[0][0].url).toBe(
			"https://jolli-team-kr0v9z0x.atlassian.net/browse/KAN-4",
		);
	});
});
