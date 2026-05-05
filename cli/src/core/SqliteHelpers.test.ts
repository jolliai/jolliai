import { describe, expect, it } from "vitest";

import { classifyScanError, hasNodeSqliteSupport, NODE_SQLITE_MIN_VERSION } from "./SqliteHelpers.js";

describe("hasNodeSqliteSupport", () => {
	const { major, minor } = NODE_SQLITE_MIN_VERSION;

	it("returns true on exactly the minimum version", () => {
		expect(hasNodeSqliteSupport(`${major}.${minor}.0`)).toBe(true);
	});

	it("returns true on a later major", () => {
		expect(hasNodeSqliteSupport(`${major + 1}.0.0`)).toBe(true);
	});

	it("returns true on a later minor within the same major", () => {
		expect(hasNodeSqliteSupport(`${major}.${minor + 1}.0`)).toBe(true);
	});

	it("returns false on an earlier minor within the same major", () => {
		// minor=0 covers the "earlier minor" branch even when NODE_SQLITE_MIN_VERSION.minor is 0
		// (the comparison is `>=`, so 22.0.0 < 22.5.0 returns false).
		expect(hasNodeSqliteSupport(`${major}.0.0`)).toBe(false);
	});

	it("returns false on an earlier major", () => {
		expect(hasNodeSqliteSupport(`${major - 1}.99.0`)).toBe(false);
	});

	it("treats prerelease tags correctly (major.minor extracted from prefix)", () => {
		expect(hasNodeSqliteSupport("22.5.0-nightly20260101")).toBe(true);
		expect(hasNodeSqliteSupport("20.15.0-nightly20260101")).toBe(false);
	});
});

describe("classifyScanError", () => {
	function err(message: string, code?: string): Error & { code?: string } {
		const e = new Error(message) as Error & { code?: string };
		if (code !== undefined) e.code = code;
		return e;
	}

	it("returns null for ENOENT (silent 'not installed')", () => {
		expect(classifyScanError(err("…", "ENOENT"))).toBeNull();
	});

	it("classifies EACCES and EPERM as permission", () => {
		expect(classifyScanError(err("denied", "EACCES"))?.kind).toBe("permission");
		expect(classifyScanError(err("denied", "EPERM"))?.kind).toBe("permission");
	});

	it("classifies SQLITE_CANTOPEN / 'unable to open' as permission", () => {
		expect(classifyScanError(err("SQLITE_CANTOPEN: file failed to open"))?.kind).toBe("permission");
		expect(classifyScanError(err("unable to open database file"))?.kind).toBe("permission");
	});

	it("classifies SQLITE_CORRUPT and similar as corrupt", () => {
		expect(classifyScanError(err("SQLITE_CORRUPT: database disk image is malformed"))?.kind).toBe("corrupt");
		expect(classifyScanError(err("file is not a database"))?.kind).toBe("corrupt");
		expect(classifyScanError(err("SQLITE_NOTADB"))?.kind).toBe("corrupt");
	});

	it("classifies SQLITE_BUSY / SQLITE_LOCKED as locked", () => {
		expect(classifyScanError(err("SQLITE_BUSY: database is locked"))?.kind).toBe("locked");
		expect(classifyScanError(err("database is locked"))?.kind).toBe("locked");
		expect(classifyScanError(err("SQLITE_LOCKED"))?.kind).toBe("locked");
	});

	it("classifies 'no such table'/'no such column' as schema drift", () => {
		expect(classifyScanError(err("no such table: session"))?.kind).toBe("schema");
		expect(classifyScanError(err("no such column: time_updated"))?.kind).toBe("schema");
	});

	it("falls back to 'unknown' for unrecognized errors", () => {
		const classified = classifyScanError(err("totally unexpected disk failure"));
		expect(classified?.kind).toBe("unknown");
		expect(classified?.message).toBe("totally unexpected disk failure");
	});

	it("handles non-Error throws by stringifying", () => {
		const classified = classifyScanError("raw string rejection");
		expect(classified?.kind).toBe("unknown");
		expect(classified?.message).toBe("raw string rejection");
	});
});
