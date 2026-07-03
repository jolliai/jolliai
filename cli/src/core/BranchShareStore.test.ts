import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import { type BranchShareRecord, getShare, putBranchShare, removeShare } from "./BranchShareStore.js";

let cwd: string;

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
		expect(await getShare(cwd, "feature/x")).toBeUndefined();
	});

	it("round-trips a public record", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		const got = await getShare(cwd, "feature/x");
		expect(got?.shareId).toBe("sh_pub");
		expect(got?.visibility).toBe("public");
	});

	it("single-slot: a re-put overwrites the subject's one record (flip public → member)", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/x", MEMBER);
		const got = await getShare(cwd, "feature/x");
		expect(got?.shareId).toBe("sh_member");
		expect(got?.visibility).toBe("org");
		expect(got?.recipients).toEqual(["ada@example.com"]);
	});

	it("flips the tier in place (org → people) without spawning a second record", async () => {
		await putBranchShare(cwd, "feature/x", MEMBER); // org
		await putBranchShare(cwd, "feature/x", { ...MEMBER, visibility: "people", recipients: ["tom@jolli.ai"] });
		const got = await getShare(cwd, "feature/x");
		expect(got?.visibility).toBe("people");
		expect(got?.recipients).toEqual(["tom@jolli.ai"]);
	});

	it("keeps separate subjects per branch", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/y", { ...PUB, shareId: "sh_2" });
		expect((await getShare(cwd, "feature/x"))?.shareId).toBe("sh_pub");
		expect((await getShare(cwd, "feature/y"))?.shareId).toBe("sh_2");
	});

	it("keeps a commit share separate from the branch share on the same branch", async () => {
		const commitHash = "c".repeat(40);
		await putBranchShare(cwd, "feature/x", PUB); // branch share
		await putBranchShare(cwd, "feature/x", { ...PUB, shareId: "sh_commit" }, commitHash); // commit share
		expect((await getShare(cwd, "feature/x"))?.shareId).toBe("sh_pub");
		expect((await getShare(cwd, "feature/x", commitHash))?.shareId).toBe("sh_commit");
		// removing the commit share leaves the branch share intact
		await removeShare(cwd, "feature/x", commitHash);
		expect(await getShare(cwd, "feature/x", commitHash)).toBeUndefined();
		expect((await getShare(cwd, "feature/x"))?.shareId).toBe("sh_pub");
	});

	it("removes a subject's record; idempotent for already-removed / never-shared", async () => {
		await putBranchShare(cwd, "feature/x", PUB);
		await putBranchShare(cwd, "feature/y", { ...PUB, shareId: "sh_y" });
		await removeShare(cwd, "feature/x");
		expect(await getShare(cwd, "feature/x")).toBeUndefined();
		expect((await getShare(cwd, "feature/y"))?.shareId).toBe("sh_y"); // untouched
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
		const got = await getShare(cwd, "feature/x");
		expect(got?.visibility).toBe("org");
		expect(got?.recipients).toEqual(["ada@example.com"]);
		expect(got?.ref).toEqual(live.ref);
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
		expect(await getShare(cwd, "feature/x")).toBeUndefined();
	});

	it("ignores a file with an unrecognized version (no migration)", async () => {
		// Older two-slot (v3) and single-record (v2) shapes were never released; any
		// non-current version is ignored and re-created on the next share.
		await writeFile(filePath(), JSON.stringify({ version: 3, subjects: { "feature/x": { public: PUB } } }), "utf8");
		expect(await getShare(cwd, "feature/x")).toBeUndefined();
	});

	it("ignores a file whose subjects field is not an object", async () => {
		// Current version so it reaches the shape check (not short-circuited by version mismatch).
		await writeFile(filePath(), JSON.stringify({ version: 4, subjects: "nope" }), "utf8");
		expect(await getShare(cwd, "feature/x")).toBeUndefined();
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
		expect((await getShare(cwd, "a"))?.shareId).toBe("a");
		expect((await getShare(cwd, "b"))?.shareId).toBe("b");
		expect((await getShare(cwd, "c"))?.shareId).toBe("c");
	});
});
