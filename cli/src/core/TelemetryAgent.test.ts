import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareSemver } from "../install/SemverCompare.js";
import { LOCAL_AGENT_CHILD_ENV } from "./AgentReentry.js";
import type { PluginBootstrapHost } from "./localagent/PluginDefaults.js";
import { SESSION_SOURCES } from "./sessions/SessionSources.js";
import {
	AGENT_DIMENSION_SINCE_VERSION,
	AGENT_ENV_MARKERS,
	AMBIGUOUS_AGENT_ENV_KEYS,
	detectAgentFromEnv,
	resolveTelemetryAgent,
	TELEMETRY_AGENTS,
	type TelemetryAgent,
} from "./TelemetryAgent.js";

describe("TELEMETRY_AGENTS vocabulary", () => {
	// The point of the whole module: a fourteenth host cannot ship with a stale
	// list here. Asserted from BOTH directions, because each catches a different
	// mistake — a hand-copied list going stale, and a host registered for
	// discovery that the telemetry dimension cannot spell.
	it("covers every registered session source", () => {
		const missing = SESSION_SOURCES.map((s) => s.source).filter(
			(source) => !(TELEMETRY_AGENTS as readonly string[]).includes(source),
		);
		expect(missing).toEqual([]);
	});

	it("includes gemini, which has no session discoverer (push-based AfterAgent hook)", () => {
		expect(TELEMETRY_AGENTS).toContain("gemini");
		expect(SESSION_SOURCES.map((s) => s.source)).not.toContain("gemini");
	});

	it("keeps the cursor IDE and cursor-agent as separate tokens", () => {
		// `surface` can never draw this distinction, which is part of why the
		// dimension is worth adding — collapsing them would spend that value.
		expect(TELEMETRY_AGENTS).toContain("cursor");
		expect(TELEMETRY_AGENTS).toContain("cursor-cli");
	});

	it("holds no duplicates and only lowercase kebab tokens (low-cardinality, never free-form)", () => {
		expect(new Set(TELEMETRY_AGENTS).size).toBe(TELEMETRY_AGENTS.length);
		for (const agent of TELEMETRY_AGENTS) expect(agent).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
	});

	it("spells every plugin bootstrap host, so a structural claim is always expressible", () => {
		// `pluginBootstrapAgent` returns a PluginBootstrapHost straight into the
		// telemetry `agent` slot. TS accepts that only while the union is a subset;
		// this asserts the runtime side of the same thing.
		const hosts: ReadonlyArray<PluginBootstrapHost> = ["claude", "codex", "cursor"];
		for (const host of hosts) expect(resolveTelemetryAgent(host)).toBe(host);
	});

	it("records the watershed as a concrete version", () => {
		expect(AGENT_DIMENSION_SINCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("does not let the watershed fall behind the version being built", () => {
		// The watershed starts as a prediction — which release this lands in is not
		// knowable while writing it — and a stale prediction fails silently, in a
		// PUBLIC doc. This is the one half that can be checked: the dimension cannot
		// ship in a release older than the constant, so the constant must never sit
		// below `cli/package.json`. If main's version overtakes it while this is
		// still unreleased, the guess was overtaken and someone has to look.
		//
		// Resolved from this file rather than `process.cwd()` so it does not depend
		// on which directory vitest was invoked from.
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
		const { version } = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		expect(compareSemver(AGENT_DIMENSION_SINCE_VERSION, version)).toBeGreaterThanOrEqual(0);
	});
});

describe("resolveTelemetryAgent", () => {
	it("accepts every member of the vocabulary verbatim", () => {
		for (const agent of TELEMETRY_AGENTS) expect(resolveTelemetryAgent(agent)).toBe(agent);
	});

	it("rejects an unknown host rather than passing it through", () => {
		expect(resolveTelemetryAgent("windsurf")).toBeUndefined();
		expect(resolveTelemetryAgent("Claude")).toBeUndefined();
		expect(resolveTelemetryAgent("claude-code")).toBeUndefined();
	});

	it("rejects free-form and non-string input (the value can never become free-form)", () => {
		for (const bad of [
			"",
			"   ",
			"/Users/someone/secret/path",
			"user@example.com",
			"sk-live-abcdef",
			"claude; rm -rf /",
			undefined,
			null,
			42,
			true,
			{ agent: "claude" },
			["claude"],
		]) {
			expect(resolveTelemetryAgent(bad)).toBeUndefined();
		}
	});
});

describe("detectAgentFromEnv", () => {
	it("maps each unambiguous marker to its host", () => {
		for (const [key, agent] of AGENT_ENV_MARKERS) {
			expect(detectAgentFromEnv({ [key]: "1" })).toBe(agent);
		}
	});

	it("answers nothing for an environment with no marker", () => {
		expect(detectAgentFromEnv({})).toBeUndefined();
		expect(detectAgentFromEnv({ PATH: "/usr/bin", TERM: "xterm" })).toBeUndefined();
	});

	it("applies the same truthiness rule as the commit-feedback gate", () => {
		for (const falsey of ["", "0", "false", "FALSE"]) {
			expect(detectAgentFromEnv({ CLAUDECODE: falsey })).toBeUndefined();
		}
		expect(detectAgentFromEnv({ CLAUDECODE: "true" })).toBe("claude");
	});

	it("refuses to guess from a marker that names a family rather than a host", () => {
		// AI_AGENT is generic; CURSOR_TRACE_ID cannot separate `cursor` from
		// `cursor-cli`. A partially-known case must not fall through to a value.
		for (const key of AMBIGUOUS_AGENT_ENV_KEYS) {
			expect(detectAgentFromEnv({ [key]: "abc" })).toBeUndefined();
		}
		expect(AMBIGUOUS_AGENT_ENV_KEYS).toContain("CURSOR_TRACE_ID");
	});

	it("still answers when an ambiguous marker sits beside a decisive one", () => {
		// Claude Code sets AI_AGENT as well as CLAUDECODE; the generic marker adds
		// nothing but must not veto the specific one.
		expect(detectAgentFromEnv({ AI_AGENT: "1", CLAUDECODE: "1" })).toBe("claude");
	});

	it("answers nothing when two hosts' markers disagree (one agent shelled out to another)", () => {
		expect(detectAgentFromEnv({ CLAUDECODE: "1", CODEX_THREAD_ID: "t-1" })).toBeUndefined();
		expect(detectAgentFromEnv({ GEMINI_CLI: "1", OPENCODE: "1" })).toBeUndefined();
	});

	it("answers nothing inside a local-agent child, which is the outbound dimension", () => {
		// A summarizer we spawned sets its own marker in every descendant. Counting
		// it would conflate `agent` with `LocalAgentToolId`.
		expect(detectAgentFromEnv({ CLAUDECODE: "1", [LOCAL_AGENT_CHILD_ENV]: "1" })).toBeUndefined();
	});

	it("only ever answers a member of the vocabulary", () => {
		for (const [key] of AGENT_ENV_MARKERS) {
			const agent: TelemetryAgent | undefined = detectAgentFromEnv({ [key]: "1" });
			expect(TELEMETRY_AGENTS).toContain(agent);
		}
	});
});
