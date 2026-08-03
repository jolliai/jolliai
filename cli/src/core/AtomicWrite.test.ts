import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	randomUUID: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	rm: vi.fn(),
}));

vi.mock("node:crypto", () => ({
	randomUUID: h.randomUUID,
}));

vi.mock("node:fs/promises", () => ({
	writeFile: h.writeFile,
	rename: h.rename,
	rm: h.rm,
}));

import { atomicWriteFile } from "./AtomicWrite.js";

describe("atomicWriteFile", () => {
	beforeEach(() => {
		for (const fn of Object.values(h)) fn.mockReset();
		h.randomUUID.mockReturnValue("uuid");
		h.writeFile.mockResolvedValue(undefined);
		h.rename.mockResolvedValue(undefined);
		h.rm.mockResolvedValue(undefined);
	});

	it("writes through a unique tmp file and renames it into place", async () => {
		await atomicWriteFile("/repo/state.json", '{"ok":true}');

		const tmpPath = `/repo/state.json.${process.pid}.uuid.tmp`;
		expect(h.writeFile).toHaveBeenCalledWith(tmpPath, '{"ok":true}', "utf-8");
		expect(h.rename).toHaveBeenCalledWith(tmpPath, "/repo/state.json");
		expect(h.rm).not.toHaveBeenCalled();
	});

	it.each(["EPERM", "EACCES"])("falls back to direct overwrite and removes tmp on %s", async (code) => {
		h.rename.mockRejectedValueOnce(Object.assign(new Error(code), { code }));

		await atomicWriteFile("/repo/state.json", "next");

		const tmpPath = `/repo/state.json.${process.pid}.uuid.tmp`;
		expect(h.writeFile).toHaveBeenNthCalledWith(1, tmpPath, "next", "utf-8");
		expect(h.writeFile).toHaveBeenNthCalledWith(2, "/repo/state.json", "next", "utf-8");
		expect(h.rm).toHaveBeenCalledWith(tmpPath, { force: true });
	});

	it("rethrows non-recoverable rename failures", async () => {
		const err = Object.assign(new Error("nope"), { code: "EISDIR" });
		h.rename.mockRejectedValueOnce(err);

		await expect(atomicWriteFile("/repo/state.json", "next")).rejects.toBe(err);
		expect(h.rm).not.toHaveBeenCalled();
	});
});

/*
 * `mode` is applied to the TMPFILE so the rename carries it onto the target — the
 * opposite of `writeFile(..., { mode })`, where mode is creation-only and an existing
 * file keeps its permissions. That inversion is the whole reason the parameter exists
 * (CodexTomlWriter needs to set 0600 on a file it creates while preserving the mode of
 * one it does not own), and it is easy to "simplify" back into a plain writeFile mode,
 * so both arms are pinned here.
 */
describe("atomicWriteFile — mode", () => {
	it("applies mode to the tmpfile, so the rename carries it to the target", async () => {
		await atomicWriteFile("/repo/state.json", "next", 0o600);

		const tmpPath = `/repo/state.json.${process.pid}.uuid.tmp`;
		expect(h.writeFile).toHaveBeenCalledWith(tmpPath, "next", { encoding: "utf-8", mode: 0o600 });
	});

	it("omits the mode option entirely when no mode is given", async () => {
		await atomicWriteFile("/repo/state.json", "next");

		const tmpPath = `/repo/state.json.${process.pid}.uuid.tmp`;
		expect(h.writeFile).toHaveBeenCalledWith(tmpPath, "next", "utf-8");
	});

	// The win32 fallback cannot carry mode onto an existing target, but it must still
	// pass it — the branch is also reached when the target does not exist.
	it("passes mode through the EPERM fallback too", async () => {
		h.rename.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }));

		await atomicWriteFile("/repo/state.json", "next", 0o600);

		expect(h.writeFile).toHaveBeenNthCalledWith(2, "/repo/state.json", "next", {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
});
