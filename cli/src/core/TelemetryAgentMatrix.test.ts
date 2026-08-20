/**
 * The `agent` × `surface` truth table, as one data-driven suite.
 *
 * Every row is a real way someone can reach Jolli, and the two dimensions only
 * mean something together: `surface` says which of our builds sent the event,
 * `agent` says which AI host the work happened in. Several rows share an
 * expected `agent` and are told apart purely by `surface` (a human typing in a
 * terminal and a human clicking in VS Code both have NO agent), and one pair is
 * the reverse — same `surface`, different `agent` — which is why nothing may
 * decide env-trust by looking at the surface.
 *
 * Kept as a table rather than prose because the interesting rows are the ones
 * that answer "nothing": ambiguity, conflict, a long-lived host, an outbound
 * summarizer. Those are decisions, and a decision with no test is a comment.
 *
 * `surface` cannot be varied from inside a unit test — it comes from a build-time
 * `define` that vitest pins to `cli` — so the surface half is asserted through
 * `parseSurface` on each bundle's real client header, and the agent half through
 * envelopes actually written to a buffer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_AGENT_CHILD_ENV } from "./AgentReentry.js";
import {
	getTelemetryContext,
	initTelemetry,
	parseSurface,
	shutdownTelemetry,
	TELEMETRY_SURFACES,
	track,
	trackAs,
} from "./Telemetry.js";
import { TELEMETRY_AGENTS } from "./TelemetryAgent.js";
import { readTelemetryEvents } from "./TelemetryBuffer.js";
import { bootstrapTelemetry } from "./TelemetryStartup.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-matrix-"));
});
afterEach(async () => {
	shutdownTelemetry();
	await rm(cwd, { recursive: true, force: true });
});

const deps = {
	loadConfig: async () => ({}),
	getOrCreateInstallId: async () => ({ installId: "11111111-1111-4111-8111-111111111111", created: false }),
	getJolliUrl: () => "https://acme.jolli.ai",
};

/** Bring telemetry up the way a given process would, then report the resolved agent. */
async function agentFor(opts: {
	readonly env?: NodeJS.ProcessEnv;
	readonly agent?: string;
	readonly inferAgentFromEnv?: boolean;
}): Promise<string | undefined> {
	await bootstrapTelemetry({ cwd, env: opts.env ?? {}, ...opts, deps });
	return getTelemetryContext()?.agent;
}

// ─────────────────── the agent half, per emitting process ───────────────────

interface Row {
	/** What the user actually did. */
	readonly scenario: string;
	/** Does this process trust its env markers? Short-lived yes, long-lived no. */
	readonly inferAgentFromEnv?: boolean;
	/** A host the caller knows structurally. */
	readonly agent?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly expected: string | undefined;
	/** Why the expectation is what it is, when that is not obvious. */
	readonly because?: string;
}

const SHORT_LIVED: ReadonlyArray<Row> = [
	{
		scenario: "human types `jolli recall` in their own terminal",
		inferAgentFromEnv: true,
		env: {},
		expected: undefined,
		because: "no agent was involved; `surface: cli` already says where it came from",
	},
	{
		scenario: "Claude Code runs `jolli recall`",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1", AI_AGENT: "claude-code_2-1-234_agent" },
		expected: "claude",
	},
	{
		scenario: "Codex runs a command",
		inferAgentFromEnv: true,
		env: { CODEX_THREAD_ID: "t-1" },
		expected: "codex",
	},
	{
		scenario: "Gemini's AfterAgent hook fires",
		inferAgentFromEnv: true,
		env: { GEMINI_CLI: "1" },
		expected: "gemini",
	},
	{ scenario: "OpenCode runs a command", inferAgentFromEnv: true, env: { OPENCODE: "1" }, expected: "opencode" },
	{
		scenario: "Cursor IDE's agent runs a command",
		inferAgentFromEnv: true,
		env: { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "c1", CURSOR_WORKSPACE_LABEL: "snake-game" },
		expected: "cursor",
	},
	{
		scenario: "cursor-agent CLI runs a command",
		inferAgentFromEnv: true,
		env: { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "c1", CURSOR_INVOKED_AS: "cursor-agent" },
		expected: "cursor-cli",
		because: "the IDE/CLI split `surface` can never draw, and the reason the family shape exists",
	},
	{
		scenario: "human types in Cursor's own integrated terminal",
		inferAgentFromEnv: true,
		env: {},
		expected: undefined,
		because: "measured: no CURSOR_* var reaches a human shell, so no agent is claimed for a person's own command",
	},
	{
		scenario: "a Cursor build that renamed both variant markers",
		inferAgentFromEnv: true,
		env: { CURSOR_AGENT: "1" },
		expected: undefined,
		because: "a family present but unresolved abandons the answer rather than picking a side",
	},
	{
		scenario: "Kimi / Copilot / Cline / Devin / Antigravity runs a command",
		inferAgentFromEnv: true,
		env: {},
		expected: undefined,
		because: "these hosts set no marker we have measured; they are attributed at commit time instead",
	},
	{
		scenario: "Claude Code shells out to Codex, which runs a command",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1", CODEX_THREAD_ID: "t-1" },
		expected: undefined,
		because: '"which host is the user working in" genuinely has no single answer here',
	},
	{
		scenario: "a summarizer WE spawned runs jolli internally",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1", [LOCAL_AGENT_CHILD_ENV]: "1" },
		expected: undefined,
		because: "that is the outbound dimension (LocalAgentToolId), not the user's host",
	},
	{
		scenario: "MCP server Claude Code spawned (measured: it does inherit CLAUDECODE)",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1" },
		expected: "claude",
	},
	{
		scenario: "MCP server Cursor spawned (measured: not even a CURSOR_* var)",
		inferAgentFromEnv: true,
		env: {},
		expected: undefined,
	},
	{
		scenario: "post-commit hook resolving a commit's origin, running from the VS Code bundle's dist",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1" },
		expected: "claude",
		because:
			"reports `surface: vscode` yet MUST trust its env — this is why nothing may gate env-trust on the surface. " +
			"(The QueueWorker used to hold this row and no longer infers at all: it chain-drains entries OTHER commits " +
			"enqueued, so its env belongs to whichever commit spawned the chain — each entry now carries its own stamp, " +
			"resolved by this hook at enqueue time.)",
	},
];

const LONG_LIVED: ReadonlyArray<Row> = [
	{
		scenario: "VS Code extension host, cold-started with `code .` from inside a Claude session",
		env: { CLAUDECODE: "1", AI_AGENT: "claude-code_2-1-234_agent" },
		expected: undefined,
		because:
			"the regression this flag exists for — the window would otherwise claim `claude` for days of button clicks",
	},
	{
		scenario: "VS Code extension host, launched normally",
		env: {},
		expected: undefined,
	},
	{
		scenario: "ide-bridge server forwarding a JVM-host UI event",
		env: { CLAUDECODE: "1" },
		expected: undefined,
		because: "long-lived, and the event describes the IDE's own UI",
	},
];

const STRUCTURAL: ReadonlyArray<Row> = [
	{
		scenario: "Claude plugin SessionStart bootstrap",
		agent: "claude",
		inferAgentFromEnv: true,
		env: {},
		expected: "claude",
		because: "structural — the manifest hook only ever runs inside its own host",
	},
	{
		scenario: "Codex plugin bootstrap, running under a stale CLAUDECODE",
		agent: "codex",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1" },
		expected: "codex",
		because: "the structural claim beats any marker",
	},
	{
		scenario: "Cursor plugin bootstrap",
		agent: "cursor",
		inferAgentFromEnv: true,
		env: {},
		expected: "cursor",
		because:
			"still the only thing that attributes a Cursor MCP session — those servers carry no CURSOR_* var at all (measured)",
	},
	{
		scenario: "hand-run `jolli enable --repo-hooks-only` (no source tag) inside Claude Code",
		agent: undefined,
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1" },
		expected: "claude",
		because:
			"no structural host, but still a short-lived CLI process — env is valid, and must survive the re-bootstrap",
	},
	{
		scenario: "a caller passes a host we do not know",
		agent: "windsurf",
		inferAgentFromEnv: true,
		env: { CLAUDECODE: "1" },
		expected: undefined,
		because:
			"an unrecognised explicit value is rejected AND suppresses the fallback — the caller claimed to know, and was wrong",
	},
];

describe.each([
	["short-lived processes (env markers trusted)", SHORT_LIVED],
	["long-lived hosts (env markers NOT trusted)", LONG_LIVED],
	["structural attribution", STRUCTURAL],
])("%s", (_group, rows) => {
	it.each(
		rows.map((r) => [r.because ? `${r.scenario} → ${r.expected ?? "no agent"} (${r.because})` : r.scenario, r]),
	)("%s", async (_label, row) => {
		const resolved = await agentFor(row);
		expect(resolved).toBe(row.expected);
		// Whatever came out, it can only ever be a known token.
		if (resolved !== undefined) expect(TELEMETRY_AGENTS).toContain(resolved);
	});
});

// ─────────────── the two dimensions read together ───────────────

describe("surface × agent read together", () => {
	it("distinguishes a human in a terminal from a human clicking in an IDE", async () => {
		// Both have NO agent. `surface` is the only thing that separates them, which
		// is why the dimension must not be defaulted into something surface-like.
		const terminal = await agentFor({ inferAgentFromEnv: true, env: {} });
		const ide = await agentFor({ env: { CLAUDECODE: "1" } });
		expect(terminal).toBeUndefined();
		expect(ide).toBeUndefined();
		expect(parseSurface("cli/0.99.14").surface).toBe("cli");
		expect(parseSurface("vscode-plugin/0.99.14").surface).toBe("vscode");
	});

	it("exposes the misattribution the dimension exists for", async () => {
		// Measured on a real machine: Claude Code was serving MCP out of the CODEX
		// plugin's dist, because dist arbitration picks the highest core version and
		// plugin tags are absent from the tie-break order. `surface` names the wrong
		// host; `agent` names the right one, and only both together are readable.
		const agent = await agentFor({ inferAgentFromEnv: true, env: { CLAUDECODE: "1" } });
		expect(parseSurface("codex-plugin/1.0.2").surface).toBe("codex-plugin");
		expect(agent).toBe("claude");
	});

	it("covers every surface the doc discloses with a known emitter or a documented reason", () => {
		// Guards against a surface being added to the disclosure with nothing behind it.
		const emitted = new Set(["cli", "vscode", "claude-plugin", "codex-plugin", "cursor-plugin", "web-local"]);
		const notFromThisRepo = new Set(["intellij", "web"]);
		for (const surface of TELEMETRY_SURFACES) {
			expect(emitted.has(surface) || notFromThisRepo.has(surface)).toBe(true);
		}
		expect(emitted.size + notFromThisRepo.size).toBe(TELEMETRY_SURFACES.length);
	});
});

// ─────────────── per-event overrides, on real envelopes ───────────────

describe("per-event attribution on real envelopes", () => {
	const init = (agent?: string) =>
		initTelemetry({
			cwd,
			installId: "install-1",
			origin: "https://acme.jolli.ai",
			config: {},
			...(agent ? { agent } : {}),
		});

	it("attributes each walked transcript to its own source, not the worker's env", async () => {
		// The post-commit case: one worker, several sessions, thirteen possible hosts.
		init("claude");
		for (const source of ["gemini", "kimi", "cline-cli", "antigravity"]) {
			track("ai_source_detected", { source, agent: source });
		}
		const events = await readTelemetryEvents(cwd);
		expect(events.map((e) => e.properties.agent)).toEqual(["gemini", "kimi", "cline-cli", "antigravity"]);
	});

	it("drops a per-event value that is not a known host, and does not fall back", async () => {
		init("claude");
		for (const bad of ["windsurf", "../../etc/passwd", "", "Claude"]) {
			track("ai_source_detected", { source: "claude", agent: bad });
		}
		const events = await readTelemetryEvents(cwd);
		for (const e of events) expect(e.properties).not.toHaveProperty("agent");
	});

	it("does not attribute a dashboard browser click to the shell that launched the server", async () => {
		// `jolli dashboard` was started from inside a Claude session, so the process
		// really is `agent: claude` — but a click in the web view is not.
		init("claude");
		track("command_invoked", { command: "dashboard", ok: true });
		trackAs("web-local", "dashboard_opened", { first_run: true });
		trackAs("web-local", "range_changed", { range: "30d" });
		const [invoked, opened, ranged] = await readTelemetryEvents(cwd);
		expect(invoked).toMatchObject({ surface: "cli", properties: { agent: "claude" } });
		expect(opened.surface).toBe("web-local");
		expect(opened.properties).not.toHaveProperty("agent");
		expect(ranged.properties).not.toHaveProperty("agent");
	});

	it("still lets a trackAs caller state the event's own host explicitly", async () => {
		init("claude");
		trackAs("web-local", "dashboard_opened", { agent: "codex" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties.agent).toBe("codex");
	});

	it("never puts agent in the envelope, on either path", async () => {
		init("claude");
		track("recall_performed");
		trackAs("web-local", "dashboard_opened");
		for (const e of await readTelemetryEvents(cwd)) expect(e).not.toHaveProperty("agent");
	});
});
