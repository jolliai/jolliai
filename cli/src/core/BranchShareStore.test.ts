import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import {
	type BranchShareRecord,
	getShare,
	getShareWithBranchLatest,
	putBranchShare,
	removeShare,
} from "./BranchShareStore.js";

let cwd: string;

// Backend key (`deriveJolliBackendKey` form — registrable domain) a record's
// `shareUrl` resolves to. Fixtures' shareUrl lives on `acme.jolli.ai`, whose backend
// is `https://jolli.ai`; reads pass ENV so they resolve. OTHER_ENV models a
// since-swapped API key pointing at a different backend.
const ENV = "https://jolli.ai";
const OTHER_ENV = "https://jolli-local.me";

beforeEach(async () => {
	cwd = join(tmpdir(), `branch-share-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function filePath(): string {
	return join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR, "branch-shares.json");
}

const PUB: BranchShareRecord = {
	shareId: "sh_pub",
	shareUrl: "https://acme.jolli.ai/share/tok12345",
	visibility: "public",
	headCommitHash: "a".repeat(40),
	expiresAt: "2026-09-01T00:00:00.000Z",
	decisionCount: 4,
};

const MEMBER: BranchShareRecord = {
	shareId: "sh_member",
	shareUrl: "https://acme.jolli.ai/share/branch/7/view",
	visibility: "org",
	recipients: ["ada@example.com"],
	expiresAt: "2026-09-01T00:00:00.000Z",
	decisionCount: 4,
};

describe("BranchShareStore", () => {
	it("returns undefined for a missing file", async () => {
		expect(await getShare(cwd, "feature/x", ENV)).toBeUndefined();
	});

	it("round-trips a public record", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		const got = await getShare(cwd, "feature/x", ENV);
		expect(got?.shareId).toBe("sh_pub");
		expect(got?.visibility).toBe("public");
	});

	it("single-slot: a re-put overwrites the subject's one record (flip public → member)", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/x", MEMBER);
		const got = await getShare(cwd, "feature/x", ENV);
		expect(got?.shareId).toBe("sh_member");
		expect(got?.visibility).toBe("org");
		expect(got?.recipients).toEqual(["ada@example.com"]);
	});

	it("flips the tier in place (org → people) without spawning a second record", async () => {
		await putBranchShare(cwd, "feature/x", MEMBER); // org
		await putBranchShare(cwd, "feature/x", { ...MEMBER, visibility: "people", recipients: ["tom@jolli.ai"] });
		const got = await getShare(cwd, "feature/x", ENV);
		expect(got?.visibility).toBe("people");
		expect(got?.recipients).toEqual(["tom@jolli.ai"]);
	});

	it("keeps separate subjects per branch", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/y", { ...PUB, shareId: "sh_2" });
		expect((await getShare(cwd, "feature/x", ENV))?.shareId).toBe("sh_pub");
		expect((await getShare(cwd, "feature/y", ENV))?.shareId).toBe("sh_2");
	});

	it("keeps a commit share separate from the branch share on the same branch", async () => {
		const commitHash = "c".repeat(40);
		await putBranchShare(cwd, "feature/x", PUB); // branch share
		await putBranchShare(cwd, "feature/x", { ...PUB, shareId: "sh_commit" }, commitHash); // commit share
		expect((await getShare(cwd, "feature/x", ENV))?.shareId).toBe("sh_pub");
		expect((await getShare(cwd, "feature/x", ENV, commitHash))?.shareId).toBe("sh_commit");
		// removing the commit share leaves the branch share intact
		await removeShare(cwd, "feature/x", commitHash);
		expect(await getShare(cwd, "feature/x", ENV, commitHash)).toBeUndefined();
		expect((await getShare(cwd, "feature/x", ENV))?.shareId).toBe("sh_pub");
	});

	it("removes a subject's record; idempotent for already-removed / never-shared", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/y", { ...PUB, shareId: "sh_y" });
		await removeShare(cwd, "feature/x");
		expect(await getShare(cwd, "feature/x", ENV)).toBeUndefined();
		expect((await getShare(cwd, "feature/y", ENV))?.shareId).toBe("sh_y"); // untouched
		// idempotent — already-removed and never-shared are both no-ops
		await removeShare(cwd, "feature/x");
		await removeShare(cwd, "never-shared");
	});

	it("drops the subject entry entirely when its record is removed", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await removeShare(cwd, "feature/x");
		const raw = JSON.parse(await readFile(filePath(), "utf8")) as { subjects: Record<string, unknown> };
		expect(raw.subjects["feature/x"]).toBeUndefined();
	});

	it("round-trips a live record (with a branchCollection ref + recipients)", async () => {
		const live: BranchShareRecord = {
			...MEMBER,
			ref: {
				kind: "branchCollection",
				relativePath: "feature/x",
				covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12, 13] }],
			},
		};
		await putBranchShare(cwd, "feature/x", live);
		const got = await getShare(cwd, "feature/x", ENV);
		expect(got?.visibility).toBe("org");
		expect(got?.recipients).toEqual(["ada@example.com"]);
		expect(got?.ref).toEqual(live.ref);
	});

	describe("env scoping", () => {
		it("treats a record minted against a DIFFERENT backend as absent (foreign shareId never reused)", async () => {
			await putBranchShare(cwd, "feature/x", PUB); // minted against ENV
			// A since-swapped API key now targets OTHER_ENV — the cached ENV record is a
			// cross-environment stale entry and must not surface (else its shareId 404s).
			expect(await getShare(cwd, "feature/x", OTHER_ENV)).toBeUndefined();
			// The original backend still resolves it.
			expect((await getShare(cwd, "feature/x", ENV))?.shareId).toBe("sh_pub");
		});

		it("treats a record as absent when the current env key is undefined/blank (unknown backend)", async () => {
			await putBranchShare(cwd, "feature/x", PUB);
			expect(await getShare(cwd, "feature/x", undefined)).toBeUndefined();
			expect(await getShare(cwd, "feature/x", "")).toBeUndefined();
		});

		it("does not seed a fresh subject from a stranded record on a different backend", async () => {
			await putBranchShare(
				cwd,
				"feature/x",
				{ ...MEMBER, shareId: "foreign", shareUrl: "https://jolli-local.me/share/x" },
				"a".repeat(40),
			);
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV, "b".repeat(40));
			expect(record).toBeUndefined();
			expect(seed).toBeUndefined(); // the stranded record belongs to another backend
		});
	});

	it("persists a single record per subject on disk (no slot nesting)", async () => {
		await putBranchShare(cwd, "feature/x", MEMBER);
		const raw = JSON.parse(await readFile(filePath(), "utf8")) as {
			version: number;
			subjects: Record<string, BranchShareRecord>;
		};
		expect(raw.version).toBe(4);
		expect(raw.subjects["feature/x"].shareId).toBe("sh_member");
		expect(raw.subjects["feature/x"].visibility).toBe("org");
	});

	it("treats a malformed file as empty", async () => {
		await writeFile(filePath(), "{not json", "utf8");
		expect(await getShare(cwd, "feature/x", ENV)).toBeUndefined();
	});

	it("ignores a file with an unrecognized version (no migration)", async () => {
		// Only the dev-only shapes (v2/v3) are unrecognized; v4 is the current shape. A
		// non-current version is ignored and re-created on the next share.
		await writeFile(filePath(), JSON.stringify({ version: 3, subjects: { "feature/x": PUB } }), "utf8");
		expect(await getShare(cwd, "feature/x", ENV)).toBeUndefined();
	});

	it("matches a record purely by its shareUrl backend (no separate env field)", async () => {
		// An older record that also carried an `envKey` field still reads fine — the field
		// is ignored and the backend is derived from shareUrl.
		await writeFile(
			filePath(),
			JSON.stringify({
				version: 4,
				subjects: { "feature/x": { ...PUB, envKey: "https://stale.example" } },
			}),
			"utf8",
		);
		expect((await getShare(cwd, "feature/x", ENV))?.shareId).toBe("sh_pub");
		// A since-swapped key on a different backend still reads it as foreign.
		expect(await getShare(cwd, "feature/x", OTHER_ENV)).toBeUndefined();
	});

	it("ignores a file whose subjects field is not an object", async () => {
		// Current version so it reaches the shape check (not short-circuited by version mismatch).
		await writeFile(filePath(), JSON.stringify({ version: 4, subjects: "nope" }), "utf8");
		expect(await getShare(cwd, "feature/x", ENV)).toBeUndefined();
	});

	it("cleans up and propagates when the atomic rename fails", async () => {
		// Make the target path a directory so the temp→target rename fails; this
		// drives the cleanup-and-rethrow arm and the non-ENOENT read warning.
		await mkdir(filePath(), { recursive: true });
		await expect(putBranchShare(cwd, "feature/x", PUB)).rejects.toBeTruthy();
	});

	it("serializes concurrent writes without losing updates", async () => {
		await Promise.all([
			putBranchShare(cwd, "a", { ...PUB, shareId: "a" }),
			putBranchShare(cwd, "b", { ...PUB, shareId: "b" }),
			putBranchShare(cwd, "c", { ...PUB, shareId: "c" }),
		]);
		expect((await getShare(cwd, "a", ENV))?.shareId).toBe("a");
		expect((await getShare(cwd, "b", ENV))?.shareId).toBe("b");
		expect((await getShare(cwd, "c", ENV))?.shareId).toBe("c");
	});

	describe("getShareWithBranchLatest", () => {
		it("both undefined when the branch has no subjects at all", async () => {
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV);
			expect(record).toBeUndefined();
			expect(seed).toBeUndefined();
		});

		it("returns a commit subject's own record and no seed when it's the only commit share", async () => {
			const hash = "a".repeat(40);
			await putBranchShare(cwd, "feature/x", { ...MEMBER, shareId: "own" }, hash);
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV, hash);
			expect(record?.shareId).toBe("own");
			expect(seed).toBeUndefined(); // no OTHER commit share to seed from
		});

		it("seeds a fresh commit subject from a stranded (same-kind) commit share, latest expiry wins", async () => {
			await putBranchShare(
				cwd,
				"feature/x",
				{ ...MEMBER, shareId: "old", recipients: ["ada@jolli.ai"], expiresAt: "2026-08-01T00:00:00.000Z" },
				"a".repeat(40),
			);
			await putBranchShare(
				cwd,
				"feature/x",
				{ ...MEMBER, shareId: "new", recipients: ["tom@jolli.ai"], expiresAt: "2026-10-01T00:00:00.000Z" },
				"b".repeat(40),
			);
			// Open a brand-new commit subject (no record): seed is the newest stranded commit share.
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV, "c".repeat(40));
			expect(record).toBeUndefined();
			expect(seed?.shareId).toBe("new");
			expect(seed?.recipients).toEqual(["tom@jolli.ai"]);
		});

		it("does NOT seed a commit subject from a live branch share (cross-kind → no duplicate grant)", async () => {
			// The branch share grants branch-wide access; seeding a commit modal from it and
			// auto-staging its people would double-grant. A commit subject only seeds from
			// other commit shares.
			await putBranchShare(cwd, "feature/x", { ...MEMBER, shareId: "branch", recipients: ["ada@jolli.ai"] });
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV, "a".repeat(40));
			expect(record).toBeUndefined();
			expect(seed).toBeUndefined(); // the branch share is not a seed source for a commit subject
		});

		it("a branch subject never seeds (its key is stable, never stranded)", async () => {
			await putBranchShare(cwd, "feature/x", { ...MEMBER, shareId: "branch" });
			await putBranchShare(cwd, "feature/x", { ...MEMBER, shareId: "commit" }, "a".repeat(40));
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV);
			expect(record?.shareId).toBe("branch"); // its own record
			expect(seed).toBeUndefined(); // does not seed from the commit share (cross-kind)
		});

		it("excludes the queried commit subject itself when picking the seed", async () => {
			await putBranchShare(
				cwd,
				"feature/x",
				{ ...MEMBER, shareId: "self", expiresAt: "2026-10-01T00:00:00.000Z" },
				"a".repeat(40),
			);
			await putBranchShare(
				cwd,
				"feature/x",
				{ ...MEMBER, shareId: "other", expiresAt: "2026-08-01T00:00:00.000Z" },
				"b".repeat(40),
			);
			// Query the newer subject: its own record is returned; the seed is the OTHER one,
			// even though the queried subject has a later expiry.
			const { record, seed } = await getShareWithBranchLatest(cwd, "feature/x", ENV, "a".repeat(40));
			expect(record?.shareId).toBe("self");
			expect(seed?.shareId).toBe("other");
		});

		it("does not match a branch whose name is a prefix of another (feat vs feature/x)", async () => {
			await putBranchShare(cwd, "feature/x", PUB, "a".repeat(40));
			const { seed } = await getShareWithBranchLatest(cwd, "feat", ENV, "b".repeat(40));
			expect(seed).toBeUndefined();
		});
	});
});
