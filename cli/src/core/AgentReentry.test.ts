import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLocalAgentCwd,
	isLocalAgentChild,
	LOCAL_AGENT_CHILD_ENV,
	LOCAL_AGENT_SENTINEL,
	LOCAL_AGENT_TMP_PREFIX,
} from "./AgentReentry.js";

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A plain temp dir with no sentinel — stands in for an arbitrary cwd. */
function plainTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-reentry-test-"));
	created.push(dir);
	return dir;
}

describe("AgentReentry", () => {
	describe("isLocalAgentChild — env channel", () => {
		it("is false when neither channel signals", () => {
			expect(isLocalAgentChild({}, plainTempDir())).toBe(false);
		});

		it("is true only for the exact '1' value the backend sets", () => {
			const cwd = plainTempDir();
			expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "1" }, cwd)).toBe(true);
			// Guard against accidental truthiness of other values.
			expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "0" }, cwd)).toBe(false);
			expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "true" }, cwd)).toBe(false);
		});
	});

	describe("isLocalAgentChild — cwd sentinel channel", () => {
		// Codex spawns MCP servers with an 11-variable allowlist (HOME LANG LOGNAME
		// PATH PWD SHELL SHLVL TMPDIR USER _ __CF_USER_TEXT_ENCODING), so the env
		// marker never reaches `jolli mcp`. cwd DOES survive. These are the
		// regression tests for the 136 spurious Memory Bank repos that produced.
		it("detects a local-agent cwd from the sentinel alone, with the env marker stripped", () => {
			const cwd = createLocalAgentCwd();
			created.push(cwd);
			expect(isLocalAgentChild({}, cwd)).toBe(true);
		});

		it("does not treat an arbitrary temp dir as a local-agent cwd", () => {
			// The prefix alone must not be the signal — a stale dir left by an older
			// build (or a user's own `jolli-localagent-*` folder) is not a live child.
			const dir = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
			created.push(dir);
			rmSync(join(dir, LOCAL_AGENT_SENTINEL), { force: true });
			expect(isLocalAgentChild({}, dir)).toBe(false);
		});

		it("ignores the sentinel entirely when no cwd is passed", () => {
			// Opt-in by design: hook / `jolli enable` call sites are spawned by the
			// agent CLI itself (env is reliable there) and pass no cwd, so the guard
			// cannot be flipped by a caller that stubs `existsSync` wholesale for
			// unrelated reasons — which is exactly what the hook test suites do.
			const cwd = createLocalAgentCwd();
			created.push(cwd);
			const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
			try {
				expect(isLocalAgentChild({})).toBe(false);
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		it("does not walk up to a parent's sentinel", () => {
			// Scoped to the cwd itself: a sentinel higher up must not silently
			// disable jollimemory for every repo nested beneath it.
			const parent = createLocalAgentCwd();
			created.push(parent);
			const child = join(parent, "nested");
			mkdtempSync(join(parent, "nested-"));
			expect(isLocalAgentChild({}, parent)).toBe(true);
			expect(isLocalAgentChild({}, `${child}-does-not-exist`)).toBe(false);
		});
	});

	describe("createLocalAgentCwd", () => {
		it("creates a fresh prefixed dir under tmpdir carrying the sentinel", () => {
			const cwd = createLocalAgentCwd();
			created.push(cwd);
			expect(cwd.startsWith(tmpdir())).toBe(true);
			expect(basename(cwd).startsWith(LOCAL_AGENT_TMP_PREFIX)).toBe(true);
			expect(existsSync(join(cwd, LOCAL_AGENT_SENTINEL))).toBe(true);
		});

		it("returns a distinct dir per call", () => {
			const a = createLocalAgentCwd();
			const b = createLocalAgentCwd();
			created.push(a, b);
			expect(a).not.toBe(b);
		});

		it("keeps the sentinel a dotfile so it cannot be read as agent context", () => {
			// `claude` folds a cwd CLAUDE.md into its system prompt; the temp cwd is
			// deliberately empty for that reason. A dotfile is inert to every backend.
			expect(LOCAL_AGENT_SENTINEL.startsWith(".")).toBe(true);
		});
	});
});
