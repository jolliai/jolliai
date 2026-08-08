/**
 * DbDetection — the plan's acceptance rows: five file combinations, three
 * identity cases, and the inode check that catches deletion under a live
 * handle (where every file-listing self-check keeps passing).
 */

import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDbFiles, classifyIdentity, isDbFileDetachedAt, isHandleDetached } from "./DbDetection.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-detect-"));
	dbPath = join(dir, "jollimemory.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("file combinations", () => {
	it("classifies all five states, alarming only on sidecars without .db", () => {
		expect(classifyDbFiles(dbPath)).toBe("absent");
		writeFileSync(dbPath, "db");
		// Only .db: a cleanly closed database LEGITIMATELY has no sidecars —
		// this must never read as damage.
		expect(classifyDbFiles(dbPath)).toBe("healthy-clean");
		writeFileSync(`${dbPath}-wal`, "w");
		expect(classifyDbFiles(dbPath)).toBe("healthy-recoverable");
		writeFileSync(`${dbPath}-shm`, "s");
		expect(classifyDbFiles(dbPath)).toBe("healthy-active");
		unlinkSync(dbPath);
		expect(classifyDbFiles(dbPath)).toBe("alarm-sidecars-only");
	});
});

describe("inode liveness", () => {
	it("sees a healthy attached handle as attached", () => {
		writeFileSync(dbPath, "db");
		const fd = openSync(dbPath, "r");
		try {
			expect(isHandleDetached(fd, dbPath)).toBe(false);
		} finally {
			closeSync(fd);
		}
		expect(isDbFileDetachedAt(dbPath)).toBe(false);
	});

	it("catches deletion and replacement under a live handle", () => {
		writeFileSync(dbPath, "db");
		const fd = openSync(dbPath, "r");
		try {
			unlinkSync(dbPath);
			// nlink drops to 0: we would be writing into a ghost inode.
			expect(isHandleDetached(fd, dbPath)).toBe(true);
			writeFileSync(dbPath, "impostor");
			// The path exists again but names a DIFFERENT inode.
			expect(isHandleDetached(fd, dbPath)).toBe(true);
		} finally {
			closeSync(fd);
		}
	});

	it("a swapped-in file is detached even while the old one survives elsewhere", () => {
		writeFileSync(dbPath, "db");
		const fd = openSync(dbPath, "r");
		try {
			renameSync(dbPath, join(dir, "moved-aside.db"));
			writeFileSync(dbPath, "impostor");
			expect(isHandleDetached(fd, dbPath)).toBe(true);
		} finally {
			closeSync(fd);
		}
	});

	it("an unopenable path reads as detached", () => {
		expect(isDbFileDetachedAt(join(dir, "never-existed.db"))).toBe(true);
		mkdirSync(join(dir, "as-dir.db"));
		// A directory opens with O_RDONLY on Linux but is not the database;
		// fstat/stat still agree, so this stays a non-alarm — the OPEN path
		// itself fails loudly elsewhere. Only assert it does not throw.
		expect(typeof isDbFileDetachedAt(join(dir, "as-dir.db"))).toBe("boolean");
	});
});

describe("identity matching", () => {
	it("no id anywhere is a fresh install", () => {
		expect(classifyIdentity(null, null)).toBe("fresh-install");
	});
	it("agreeing ids prove deletion", () => {
		expect(classifyIdentity("id-1", "id-1")).toBe("deleted");
		expect(classifyIdentity("id-1", null)).toBe("deleted");
		expect(classifyIdentity(null, "id-1")).toBe("deleted");
	});
	it("disagreeing ids are residue for doctor --recover, not a rebuild license", () => {
		expect(classifyIdentity("id-1", "id-2")).toBe("ambiguous-residue");
	});
});
