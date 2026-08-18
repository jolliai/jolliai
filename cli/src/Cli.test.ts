import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { isBareMcpInvocation, isDetachedDaemonInvocation } from "./Cli.js";
import { MCP_DAEMON_COMMAND, MCP_NO_DAEMON_ENV } from "./commands/McpCommand.js";
import { GLOBAL_DAEMON_ENSURE_COMMAND } from "./daemon/EnsureGlobalDaemon.js";
import { GLOBAL_DAEMON_COMMAND } from "./daemon/GlobalDaemonProtocol.js";

describe("isBareMcpInvocation", () => {
	it("routes the bare `jolli mcp` a host spawns per session", () => {
		expect(isBareMcpInvocation(["mcp"], {})).toBe(true);
	});

	it.each([
		["--reindex", ["mcp", "--reindex"]],
		["mcp-serve, the daemon itself", ["mcp-serve", "--cwd", "/repo"]],
		["any other command", ["status"]],
		["no command at all", []],
	])("leaves %s to Commander", (_label, argv) => {
		// A routing shortcut must never guess at option semantics; anything but a
		// bare `mcp` falls through to `main()` where the parser lives.
		expect(isBareMcpInvocation(argv, {})).toBe(false);
	});

	it("honours the in-process escape hatch", () => {
		// Set at the host level to bisect a suspected daemon problem on a real
		// machine; it has to be reachable from the fast path, not only from the
		// command, or the fast path would proxy anyway and defeat it.
		expect(isBareMcpInvocation(["mcp"], { [MCP_NO_DAEMON_ENV]: "1" })).toBe(false);
	});

	it("only treats the exact value '1' as opting out", () => {
		expect(isBareMcpInvocation(["mcp"], { [MCP_NO_DAEMON_ENV]: "0" })).toBe(true);
	});
});

describe("isDetachedDaemonInvocation", () => {
	it("recognises the MCP daemon the proxy spawns", () => {
		expect(isDetachedDaemonInvocation(["mcp-serve", "--cwd", "/repo", "--socket", "/tmp/x.sock"])).toBe(true);
	});

	it("recognises the machine-global daemon EnsureGlobalDaemon spawns", () => {
		// Missing this case burns the one-time telemetry disclosure for good: the
		// global daemon's stderr is `/dev/null`, so showing the notice there marks
		// it shown without ever displaying it, on installs that never ran `jolli` in
		// a terminal first (e.g. bootstrapped from the VS Code extension).
		expect(isDetachedDaemonInvocation(["global-daemon", "--socket", "/tmp/g.sock"])).toBe(true);
	});

	it("recognises the detached global-daemon ensure helper too", () => {
		expect(isDetachedDaemonInvocation(["global-daemon-ensure", "--socket", "/tmp/g.sock"])).toBe(true);
	});

	it.each([[["mcp"]], [["status"]], [[]], [["mcp", "--reindex"]]])("leaves %s alone", (argv) => {
		expect(isDetachedDaemonInvocation(argv)).toBe(false);
	});

	it("does not match a command that merely starts with a daemon's name", () => {
		// argv[0] is a whole command word, not a prefix; a future `mcp-serve-status`
		// or `global-daemon-status` must not inherit either daemon's stderr policy.
		expect(isDetachedDaemonInvocation(["mcp-serve-status"])).toBe(false);
		expect(isDetachedDaemonInvocation(["global-daemon-status"])).toBe(false);
	});
});

describe("serveMcpInProcess (the fast path's fallback)", () => {
	it("primes telemetry before serving, so a fallback session still reports per-tool events", async () => {
		// The fast path skips `main()`, which is where telemetry is bootstrapped. Every
		// proxy terminal that cannot reach a daemon serves in-process IN THIS PROCESS —
		// and that server does run tools, so the "the proxy runs no tool, so it emits
		// no telemetry" reasoning does not cover it.
		const order: string[] = [];
		vi.doMock("./core/TelemetryStartup.js", () => ({
			bootstrapTelemetry: vi.fn(async () => void order.push("bootstrap")),
			flushTelemetryNow: vi.fn(async () => {}),
			maybeShowCliTelemetryNotice: vi.fn(async () => {}),
			// The exit flush reads this off the module handle, so the mock has to
			// carry it: an ESM namespace throws on an export the factory omitted.
			BOUNDED_FLUSH_BUDGET_MS: 2_000,
		}));
		vi.doMock("./mcp/McpServer.js", () => ({
			startMcpServer: vi.fn(async () => void order.push("serve")),
		}));
		const { serveMcpInProcess } = await import("./Cli.js");

		await serveMcpInProcess("/repo");

		expect(order).toEqual(["bootstrap", "serve"]);
		vi.doUnmock("./core/TelemetryStartup.js");
		vi.doUnmock("./mcp/McpServer.js");
		vi.resetModules();
	});

	it("serves even when priming telemetry fails", async () => {
		// Telemetry is never allowed to cost a session its MCP server.
		vi.doMock("./core/TelemetryStartup.js", () => ({
			bootstrapTelemetry: vi.fn(async () => {
				throw new Error("no install id");
			}),
			flushTelemetryNow: vi.fn(async () => {}),
			maybeShowCliTelemetryNotice: vi.fn(async () => {}),
			BOUNDED_FLUSH_BUDGET_MS: 2_000,
		}));
		const startMcpServer = vi.fn(async () => {});
		vi.doMock("./mcp/McpServer.js", () => ({ startMcpServer }));
		const { serveMcpInProcess } = await import("./Cli.js");

		await serveMcpInProcess("/repo");

		expect(startMcpServer).toHaveBeenCalledWith("/repo");
		vi.doUnmock("./core/TelemetryStartup.js");
		vi.doUnmock("./mcp/McpServer.js");
		vi.resetModules();
	});
});

describe("Cli entry — cold-start import graph", () => {
	it("keeps the env-var name in lockstep with McpCommand's canonical constant", () => {
		// Restated in Cli.ts rather than imported, to keep that file's static import
		// list leaf-only. A silent divergence would make the escape hatch work for
		// the command and not for the fast path — i.e. not at all.
		expect(MCP_NO_DAEMON_ENV).toBe("JOLLI_MCP_NO_DAEMON");
	});

	it("keeps the daemon subcommand in lockstep with McpCommand's canonical constant", async () => {
		// Same restatement, same reason — but asserted against the SOURCE, because a
		// divergence here is silent and one-sided: the daemon would go back to
		// printing the one-time telemetry disclosure into its `/dev/null` stderr,
		// marking it shown and denying it to the user forever, with nothing failing.
		const source = await readFile(new URL("./Cli.ts", import.meta.url), "utf-8");
		expect(source).toContain(`const MCP_DAEMON_COMMAND = "${MCP_DAEMON_COMMAND}";`);
	});

	it("keeps the global-daemon subcommand in lockstep with GlobalDaemon's canonical constant", async () => {
		// Same reasoning as the MCP restatement above, and the same silent,
		// one-sided failure mode: a divergence here would make the global daemon
		// print (and burn) the one-time telemetry disclosure into its own
		// `/dev/null` stderr instead of leaving it owed for the next real terminal
		// invocation, with nothing failing to say so.
		const source = await readFile(new URL("./Cli.ts", import.meta.url), "utf-8");
		expect(source).toContain(`const GLOBAL_DAEMON_COMMAND = "${GLOBAL_DAEMON_COMMAND}";`);
	});

	it("keeps the detached ensure subcommand in lockstep with EnsureGlobalDaemon's canonical constant", async () => {
		const source = await readFile(new URL("./Cli.ts", import.meta.url), "utf-8");
		expect(source).toContain(`const GLOBAL_DAEMON_ENSURE_COMMAND = "${GLOBAL_DAEMON_ENSURE_COMMAND}";`);
	});

	it("loads Api.js and the telemetry stack by dynamic import only", async () => {
		// Vite emits this entry as a ~1 KB shim over chunks. A static
		// `import { main } from "./Api.js"` here makes EVERY invocation evaluate
		// every command module, the storage stack and the plugin loader — measured
		// at ~200 MB, which is what the MCP proxy fast path exists to avoid paying
		// once per AI session.
		const source = await readFile(new URL("./Cli.ts", import.meta.url), "utf-8");
		expect(source).toContain('await import("./Api.js")');
		expect(source).toContain('await import("./mcp/McpProxy.js")');

		const importStatements = [...source.matchAll(/^import\b/gm)].length;
		const specifiers = [...source.matchAll(/^import\b[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
		expect(specifiers).toHaveLength(importStatements);

		const ALLOWED_LEAF_MODULES = new Set([
			"./core/ProjectDir.js",
			"./core/SqliteWarning.js",
			"./core/TraceContext.js",
			"./Logger.js",
		]);
		const offenders = specifiers.filter((s) => !s.startsWith("node:") && !ALLOWED_LEAF_MODULES.has(s));
		expect(offenders).toEqual([]);
	});
});
