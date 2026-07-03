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
