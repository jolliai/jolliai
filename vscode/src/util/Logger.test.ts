import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendLine, show, dispose, createOutputChannel } = vi.hoisted(() => {
	const appendLine = vi.fn();
	const show = vi.fn();
	const dispose = vi.fn();
	const createOutputChannel = vi.fn(() => ({ appendLine, show, dispose }));
	return { appendLine, show, dispose, createOutputChannel };
});

vi.mock("vscode", () => ({
	window: {
		createOutputChannel,
	},
}));

const { setLogDir } = vi.hoisted(() => ({
	setLogDir: vi.fn(),
}));

vi.mock("../../../cli/src/Logger.js", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
	setLogDir,
}));

const { getCurrentTraceId } = vi.hoisted(() => ({
	getCurrentTraceId: vi.fn<() => string | undefined>(() => undefined),
}));

vi.mock("../../../cli/src/core/TraceContext.js", () => ({
	getCurrentTraceId,
}));

import { initLogger, log } from "./Logger.js";

describe("Logger", () => {
	beforeEach(() => {
		log.dispose();
		appendLine.mockReset();
		show.mockReset();
		dispose.mockReset();
		createOutputChannel.mockClear();
	});

	it("creates the output channel lazily and reuses it", () => {
		log.info("history", "loaded");
		log.warn("history", "warned");

		expect(createOutputChannel).toHaveBeenCalledTimes(1);
		expect(appendLine).toHaveBeenCalledTimes(2);
		expect(appendLine.mock.calls[0][0]).toContain("[INFO] [history] loaded");
		expect(appendLine.mock.calls[1][0]).toContain("[WARN] [history] warned");
	});

	it("serializes extra metadata when provided", () => {
		log.debug("history", "sequence changed", { head: "abc12345", count: 2 });

		expect(appendLine).toHaveBeenCalledTimes(1);
		expect(appendLine.mock.calls[0][0]).toContain(
			'{"head":"abc12345","count":2}',
		);
	});

	it("writes error-level messages", () => {
		log.error("history", "failed");

		expect(appendLine).toHaveBeenCalledTimes(1);
		expect(appendLine.mock.calls[0][0]).toContain("[ERROR] [history] failed");
	});

	it("shows and disposes the underlying output channel", () => {
		log.info("history", "loaded");
		log.show();
		log.dispose();
		log.info("history", "recreated");

		expect(show).toHaveBeenCalledWith(true);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(createOutputChannel).toHaveBeenCalledTimes(2);
	});

	it("initLogger delegates to setLogDir", () => {
		initLogger("/workspace/root");
		expect(setLogDir).toHaveBeenCalledWith("/workspace/root");
	});

	it("appends the ambient trace tag when a trace id is active", () => {
		// cond-expr L78 truthy arm: an active `runWithTrace` scope makes
		// getCurrentTraceId return an id, which is rendered as ` [trace=<id>]`.
		getCurrentTraceId.mockReturnValueOnce("trace-abc123");
		log.info("history", "traced line");

		expect(appendLine.mock.calls[0][0]).toContain("[trace=trace-abc123]");
	});
});
