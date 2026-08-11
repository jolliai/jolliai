import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isBareMcpInvocation, isDetachedDaemonInvocation } from "./Cli.js";
import { MCP_DAEMON_COMMAND, MCP_NO_DAEMON_ENV } from "./commands/McpCommand.js";

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
	it("recognises the daemon the proxy spawns", () => {
		expect(isDetachedDaemonInvocation(["mcp-serve", "--cwd", "/repo", "--socket", "/tmp/x.sock"])).toBe(true);
	});

	it.each([[["mcp"]], [["status"]], [[]], [["mcp", "--reindex"]]])("leaves %s alone", (argv) => {
		expect(isDetachedDaemonInvocation(argv)).toBe(false);
	});

	it("does not match a command that merely starts with the daemon's name", () => {
		// argv[0] is a whole command word, not a prefix; a future `mcp-serve-status`
		// must not inherit the daemon's stderr policy.
		expect(isDetachedDaemonInvocation(["mcp-serve-status"])).toBe(false);
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
