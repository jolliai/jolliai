/**
 * The Cursor third-party-extensibility reader.
 *
 * Driven against a REAL sqlite file rather than a mocked `node:sqlite`: the whole
 * value of this module is that it matches a contract observed in another
 * application's database (table name, key spelling, and the fact that the value is
 * bare text rather than JSON), and a mock would assert our own assumptions back at us.
 * The fixture is built with the same `node:sqlite` the reader uses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorGlobalStorageDb, isThirdPartyExtensibilityEnabled } from "./CursorSettings.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jolli-cursor-settings-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

let dbSeq = 0;

/**
 * Build a `state.vscdb` shaped like Cursor's, optionally holding the toggle. Each
 * call gets its own file so a single case can compare several stored encodings.
 */
function makeDb(value?: string): string {
	const dbPath = join(tempDir, `state-${dbSeq++}.vscdb`);
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
	if (value !== undefined) {
		const stmt = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
		stmt.run("cursor/thirdPartyExtensibilityEnabled", value);
	}
	db.close();
	return dbPath;
}

/**
 * Point the reader at a fixture, by INJECTION rather than by spying the exported path
 * resolver — these are ES modules, so a `vi.spyOn` there does not rebind what the
 * function already closed over, and the read silently falls through to the developer's
 * live Cursor database. That is exactly how the first version of this file passed on
 * one machine and failed on another. Production path resolution is covered separately.
 */
function readWithDb(dbPath: string): Promise<boolean> {
	return isThirdPartyExtensibilityEnabled({}, dbPath);
}

describe("isThirdPartyExtensibilityEnabled", () => {
	/*
	 * The load-bearing half of the contract. Flipping the toggle in Cursor took the
	 * table from 183 to 184 rows, so the default is expressed by the row's ABSENCE.
	 * Reading "no row" as disabled would put every default install — which is nearly
	 * all of them — on the narrow branch.
	 */
	it("answers enabled when the key was never written", async () => {
		expect(await readWithDb(makeDb())).toBe(true);
	});

	// Observed value: sqlite `text`, the bare five characters — NOT JSON.
	it("answers disabled for the bare text `false` Cursor actually stores", async () => {
		expect(await readWithDb(makeDb("false"))).toBe(false);
	});

	it("answers enabled for `true`", async () => {
		expect(await readWithDb(makeDb("true"))).toBe(true);
	});

	// Tolerated shapes, in case a later build starts JSON-encoding the value or
	// storing a numeric flag. Neither is observed today; both are cheap to accept.
	it("tolerates a quoted or numeric encoding", async () => {
		expect(await readWithDb(makeDb('"false"'))).toBe(false);
		expect(await readWithDb(makeDb("0"))).toBe(false);
	});

	/*
	 * Every failure answers `true`, which is both Cursor's default and the behaviour
	 * of not reading at all. That is what makes consulting a foreign application's
	 * private database acceptable: a missing file, a renamed table, a locked handle
	 * and an old runtime all degrade to today's behaviour rather than to a wrong one.
	 */
	it("answers enabled when the database does not exist", async () => {
		expect(await readWithDb(join(tempDir, "absent", "state.vscdb"))).toBe(true);
	});

	it("answers enabled when the table is not the shape we expect", async () => {
		const dbPath = join(tempDir, "state.vscdb");
		const db = new DatabaseSync(dbPath);
		db.exec("CREATE TABLE SomethingElse (k TEXT)");
		db.close();
		expect(await readWithDb(dbPath)).toBe(true);
	});
});

describe("cursorGlobalStorageDb", () => {
	// Not asserting the absolute path (it is platform-dependent and the test runs on
	// one platform); asserting the invariant tail, which is the part shared with the
	// VS Code layout Cursor forked and the part a wrong guess would get wrong.
	it("resolves inside Cursor's user-data directory", () => {
		const resolved = cursorGlobalStorageDb({});
		expect(resolved).toMatch(/Cursor[/\\]User[/\\]globalStorage[/\\]state\.vscdb$/u);
	});

	/*
	 * `??` lets a variable that is SET BUT EMPTY through, and `join("", "Cursor", …)` is
	 * a RELATIVE path — resolved against whatever cwd the caller has, which for a plugin
	 * hook is the bundle. The open then fails on every call, the reader answers its
	 * documented default forever, and the setting this module exists to read is silently
	 * never read on that machine. Nothing surfaces it: failing to `true` is
	 * indistinguishable from a genuine "enabled".
	 *
	 * Both rejections match what resolves this path inside Cursor. The XDG spec defines
	 * an empty `XDG_CONFIG_HOME` as equivalent to unset, and Chromium's
	 * `base::nix::GetXDGDirectory` also ignores a relative one — so Cursor reads
	 * `~/.config` in both cases, and a reader that did otherwise would be opening a
	 * different file than the one Cursor writes.
	 *
	 * Driven with an INJECTED platform, not the running one. Each variable is read from
	 * inside its own `platform()` branch, so on any single machine one of the two is
	 * dead code — and a guard asserted only by whichever OS CI happens to run is how
	 * this shipped wrong. Paths are POSIX-absolute for both branches on purpose:
	 * `isAbsolute` still answers by the running platform, and the subject here is the
	 * blank/relative rejection, not Windows path syntax.
	 */
	it.each([
		["linux", "XDG_CONFIG_HOME"],
		["win32", "APPDATA"],
	])("on %s, treats a blank or relative %s exactly as unset", (os, key) => {
		const unset = cursorGlobalStorageDb({}, os);
		for (const value of ["", "   ", "relative/dir"]) {
			expect(cursorGlobalStorageDb({ [key]: value }, os)).toBe(unset);
		}
		// The other half — an absolute value is still honoured, so the guard rejects the
		// unusable values rather than the variable.
		expect(cursorGlobalStorageDb({ [key]: "/elsewhere" }, os)).toBe(
			join("/elsewhere", "Cursor", "User", "globalStorage", "state.vscdb"),
		);
	});

	// darwin reads neither variable — the path is fixed under ~/Library. Asserted so the
	// case above cannot be read as "every platform consults an env var".
	it("ignores both variables on darwin", () => {
		expect(cursorGlobalStorageDb({ XDG_CONFIG_HOME: "/xdg", APPDATA: "/roaming" }, "darwin")).toBe(
			cursorGlobalStorageDb({}, "darwin"),
		);
	});
});
