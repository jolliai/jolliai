import { describe, expect, it } from "vitest";
import { DaemonNotifier } from "./DaemonNotifier.js";
import { DAEMON_PROTOCOL } from "./DaemonProtocol.js";

describe("DaemonNotifier", () => {
	it("serializes ready notifications with a trailing newline", () => {
		const lines: string[] = [];
		const notifier = new DaemonNotifier((line) => lines.push(line));

		notifier.emit({
			jsonrpc: "2.0",
			method: "ready",
			params: { protocol: DAEMON_PROTOCOL, pid: 42 },
		});

		expect(lines).toHaveLength(1);
		expect(lines[0].endsWith("\n")).toBe(true);
		expect(JSON.parse(lines[0])).toEqual({
			jsonrpc: "2.0",
			method: "ready",
			params: { protocol: DAEMON_PROTOCOL, pid: 42 },
		});
	});

	it("serializes refresh notifications and preserves the kind + cwd", () => {
		const lines: string[] = [];
		const notifier = new DaemonNotifier((line) => lines.push(line));

		notifier.emit({
			jsonrpc: "2.0",
			method: "refresh",
			params: { kind: "queue", cwd: "/repo" },
		});
		notifier.emit({
			jsonrpc: "2.0",
			method: "refresh",
			params: { kind: "orphan-ref", cwd: "/repo" },
		});

		expect(lines.map((l) => JSON.parse(l).params.kind)).toEqual(["queue", "orphan-ref"]);
		expect(lines.every((l) => JSON.parse(l).params.cwd === "/repo")).toBe(true);
	});
});
