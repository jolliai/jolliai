import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two seams for the recovery path, both defaulting to real behaviour:
//  - `rename` so the "could not preserve the unreadable store" arm is reachable
//    without making the whole directory unwritable (the rebuild must still run);
//  - the file lock so the "never silently drop a toggle" fallback can be
//    exercised without waiting out a real lock timeout.
const seam = vi.hoisted(() => ({ renameError: undefined as unknown, lockUnavailable: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		// Scoped to the corrupt-store BACKUP rename only: `atomicWriteFile` renames
		// too, and failing that would break the rebuild this test needs to observe.
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (seam.renameError !== undefined && String(args[1]).includes(".corrupt-")) throw seam.renameError;
			return actual.rename(...args);
		},
	};
});
vi.mock("./Locks.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./Locks.js")>();
	return {
		...actual,
		withPushControlLock: async <T>(
			fn: () => Promise<T>,
			opts?: Parameters<typeof actual.withPushControlLock>[1],
		) => (seam.lockUnavailable ? { acquired: false as const } : actual.withPushControlLock(fn, opts)),
	};
});

import {
	CORRUPT_SUFFIX,
	getPushControlPath,
	isRepoPushDisabled,
	loadDisabledRepos,
	PUSH_CONTROL_VERSION,
	setRepoPushDisabled,
} from "./PushControlStore.js";

describe("PushControlStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-pcstore-"));
		seam.renameError = undefined;
		seam.lockUnavailable = false;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty set when the file does not exist", async () => {
		expect((await loadDisabledRepos(dir)).size).toBe(0);
		expect(await isRepoPushDisabled("https://github.com/acme/x", dir)).toBe(false);
	});

	it("adds and removes an identity, persisting a versioned, sorted file of self-describing entries", async () => {
		await setRepoPushDisabled("https://github.com/acme/b", true, { globalDir: dir, trigger: "vscode" });
		await setRepoPushDisabled("https://github.com/acme/a", true, { globalDir: dir, trigger: "cli" });
		expect(await isRepoPushDisabled("https://github.com/acme/a", dir)).toBe(true);
		expect(await isRepoPushDisabled("https://github.com/acme/b", dir)).toBe(true);

		const raw = JSON.parse(await readFile(getPushControlPath(dir), "utf-8"));
		expect(raw.version).toBe(1);
		expect(raw.disabled.map((d: { identity: string }) => d.identity)).toEqual([
			"https://github.com/acme/a",
			"https://github.com/acme/b",
		]);
		expect(raw.disabled[0]).toMatchObject({ repo: "a", identity: "https://github.com/acme/a", trigger: "cli" });
		expect(typeof raw.disabled[0].disabledAt).toBe("string");
		expect(raw.disabled[0].disabledAt.length).toBeGreaterThan(0);

		await setRepoPushDisabled("https://github.com/acme/a", false, { globalDir: dir });
		expect(await isRepoPushDisabled("https://github.com/acme/a", dir)).toBe(false);
		expect(await isRepoPushDisabled("https://github.com/acme/b", dir)).toBe(true);
	});

	it("persists in code-point order, independent of the ambient ICU locale", async () => {
		// The on-disk byte order must not depend on the machine's locale, and
		// case-distinct identities must keep a stable relative order (a collator with
		// sensitivity:"base" would call these equal). Code-point order puts uppercase
		// first — a locale-aware collator would not.
		for (const id of ["https://github.com/acme/b", "https://github.com/acme/A", "https://github.com/acme/a"]) {
			await setRepoPushDisabled(id, true, { globalDir: dir });
		}
		const raw = JSON.parse(await readFile(getPushControlPath(dir), "utf-8"));
		expect(raw.disabled.map((d: { identity: string }) => d.identity)).toEqual([
			"https://github.com/acme/A",
			"https://github.com/acme/a",
			"https://github.com/acme/b",
		]);
	});

	it("refuses an EMPTY identity rather than writing a silently-inert entry", async () => {
		// The read path skips entries with an empty identity, so writing one would
		// land on disk, report success, and read back as "not disabled" — a toggle
		// that appears to work and does nothing. Refuse at the write instead, in
		// BOTH directions, and leave the store untouched.
		await expect(setRepoPushDisabled("", true, { globalDir: dir })).rejects.toThrow(/must not be empty/i);
		await expect(setRepoPushDisabled("", false, { globalDir: dir })).rejects.toThrow(/must not be empty/i);
		expect((await loadDisabledRepos(dir)).size).toBe(0);
	});

	it("is idempotent (disabling twice keeps one entry; enabling an absent id is a no-op)", async () => {
		await setRepoPushDisabled("id", true, { globalDir: dir });
		await setRepoPushDisabled("id", true, { globalDir: dir });
		expect([...(await loadDisabledRepos(dir))]).toEqual(["id"]);
		await setRepoPushDisabled("absent", false, { globalDir: dir });
		expect([...(await loadDisabledRepos(dir))]).toEqual(["id"]);
	});

	it("propagates on a corrupt file (so the gate can fail closed, not silently allow)", async () => {
		// A present-but-unparseable store is a real fault, NOT "nothing disabled":
		// it must throw so isOutboundPushAllowed can fail closed instead of leaking.
		writeFileSync(getPushControlPath(dir), "{ not json");
		await expect(loadDisabledRepos(dir)).rejects.toThrow();
		await expect(isRepoPushDisabled("https://github.com/acme/x", dir)).rejects.toThrow();
	});

	it("names the absolute store path in the corrupt-file error (so the user can find it)", async () => {
		writeFileSync(getPushControlPath(dir), "{ not json");
		await expect(loadDisabledRepos(dir)).rejects.toThrow(getPushControlPath(dir));
	});

	it("enable (--enable) SELF-HEALS a corrupt store from an empty set; disable stays strict", async () => {
		// The corrupt store must not strand the user: `jolli push-control --enable`
		// is the documented recovery, so enabling rebuilds a fresh, valid file.
		writeFileSync(getPushControlPath(dir), "{ not json");
		await setRepoPushDisabled("https://github.com/acme/x", false, { globalDir: dir });
		// Store is now valid and empty (only loosens — never keeps a hidden opt-out).
		expect((await loadDisabledRepos(dir)).size).toBe(0);

		// Disabling against a corrupt store still FAILS CLOSED rather than wiping it.
		writeFileSync(getPushControlPath(dir), "{ not json");
		await expect(setRepoPushDisabled("https://github.com/acme/x", true, { globalDir: dir })).rejects.toThrow();
	});

	it("reports the rebuild AND preserves the unreadable file, so a reset can't pass as a plain success", async () => {
		// The enable-path rebuild drops EVERY other repo's opt-out and is one GUI
		// checkbox click away, so it must be (a) reported to the caller and (b) not
		// destroy the only record of what was opted out.
		await setRepoPushDisabled("https://github.com/acme/other", true, { globalDir: dir });
		writeFileSync(getPushControlPath(dir), "{ not json");

		const result = await setRepoPushDisabled("https://github.com/acme/x", false, { globalDir: dir });
		expect(result).toMatchObject({ disabled: false, recoveredFromCorrupt: true });
		expect(result.preservedAt).toContain(CORRUPT_SUFFIX);
		// The bad bytes are still on disk under the backup name...
		expect(readFileSync(result.preservedAt as string, "utf-8")).toBe("{ not json");
		// ...and the rebuilt store is valid but empty — the other repo's opt-out is
		// gone, which is exactly why the flag above has to be surfaced.
		expect((await loadDisabledRepos(dir)).size).toBe(0);
	});

	it("propagates a read fault that is not a missing file, naming the path", async () => {
		// A DIRECTORY where the store should be → EISDIR. Unlike ENOENT ("nothing
		// disabled yet") this is a real fault, so the gate must fail closed.
		mkdirSync(getPushControlPath(dir), { recursive: true });
		await expect(loadDisabledRepos(dir)).rejects.toThrow(getPushControlPath(dir));
	});

	it("treats a JSON `null` store as empty rather than dereferencing it", async () => {
		writeFileSync(getPushControlPath(dir), "null");
		expect((await loadDisabledRepos(dir)).size).toBe(0);
	});

	it("still rebuilds when the unreadable store cannot be moved aside", async () => {
		// Preserving the bad bytes is best-effort. If the rename fails the user
		// still asked to enable, so the rebuild must proceed — just without a
		// `preservedAt` to report.
		await setRepoPushDisabled("https://github.com/acme/other", true, { globalDir: dir });
		writeFileSync(getPushControlPath(dir), "{ not json");
		seam.renameError = Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });

		const result = await setRepoPushDisabled("https://github.com/acme/x", false, { globalDir: dir });
		expect(result).toMatchObject({ disabled: false, recoveredFromCorrupt: true });
		expect(result.preservedAt).toBeUndefined();
		expect((await loadDisabledRepos(dir)).size).toBe(0);
	});

	it("writes the toggle anyway when the store lock cannot be acquired", async () => {
		// Losing the lock must never silently drop a user's toggle — the write is
		// re-run unlocked rather than skipped.
		seam.lockUnavailable = true;
		const result = await setRepoPushDisabled("https://github.com/acme/x", true, { globalDir: dir });
		expect(result.disabled).toBe(true);
		expect(await isRepoPushDisabled("https://github.com/acme/x", dir)).toBe(true);
	});

	it("refuses a NEWER-schema store both ways, and never rebuilds it", async () => {
		// Valid data this build can't interpret. Reading it with v1 rules could drop
		// opt-outs whose shape changed (fail-open), and the enable-path rebuild would
		// destroy them outright — so both directions must refuse instead.
		writeFileSync(getPushControlPath(dir), JSON.stringify({ version: PUSH_CONTROL_VERSION + 1, disabled: [] }));
		await expect(loadDisabledRepos(dir)).rejects.toThrow(/newer version/i);
		await expect(setRepoPushDisabled("id", true, { globalDir: dir })).rejects.toThrow(/newer version/i);
		await expect(setRepoPushDisabled("id", false, { globalDir: dir })).rejects.toThrow(/newer version/i);
		// Still intact — no `.corrupt-` rebuild happened on the enable path.
		expect(JSON.parse(readFileSync(getPushControlPath(dir), "utf-8")).version).toBe(PUSH_CONTROL_VERSION + 1);
	});

	it("tolerates an older or absent version (v1 is the only shipped format)", async () => {
		writeFileSync(
			getPushControlPath(dir),
			JSON.stringify({ disabled: [{ identity: "https://github.com/acme/keep" }] }),
		);
		expect([...(await loadDisabledRepos(dir))]).toEqual(["https://github.com/acme/keep"]);
	});

	it("does not claim a rebuild on the ordinary paths", async () => {
		// Missing file (first run) and a healthy file are both plain successes.
		expect(await setRepoPushDisabled("id", true, { globalDir: dir })).toMatchObject({
			disabled: true,
			recoveredFromCorrupt: false,
		});
		expect(await setRepoPushDisabled("id", false, { globalDir: dir })).toMatchObject({
			disabled: false,
			recoveredFromCorrupt: false,
		});
	});

	it("ignores a non-array disabled field (readable, just nothing actionable)", async () => {
		writeFileSync(getPushControlPath(dir), JSON.stringify({ version: 1, disabled: "nope" }));
		expect((await loadDisabledRepos(dir)).size).toBe(0);
	});

	it("skips malformed entries (non-object, or missing a string identity)", async () => {
		writeFileSync(
			getPushControlPath(dir),
			JSON.stringify({
				version: 1,
				disabled: [
					"just-a-string",
					null,
					{ repo: "x" }, // no identity
					{ identity: "" }, // empty identity
					{ identity: "https://github.com/acme/keep" },
				],
			}),
		);
		expect([...(await loadDisabledRepos(dir))]).toEqual(["https://github.com/acme/keep"]);
	});

	it("tolerates entries missing the display-only fields (identity still counts)", async () => {
		writeFileSync(
			getPushControlPath(dir),
			JSON.stringify({ version: 1, disabled: [{ identity: "https://github.com/acme/bare" }] }),
		);
		expect(await isRepoPushDisabled("https://github.com/acme/bare", dir)).toBe(true);
	});
});
