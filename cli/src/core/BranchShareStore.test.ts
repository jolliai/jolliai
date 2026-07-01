import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import {
	type BranchShareRecord,
	getBranchShare,
	isPublicConfirmed,
	markPublicConfirmed,
	putBranchShare,
	removeBranchShare,
} from "./BranchShareStore.js";

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

const REC: Omit<BranchShareRecord, "confirmedPublic"> = {
	shareId: "sh_1",
	shareUrl: "https://acme.jolli.ai/b/feature-x-tok12345",
	visibility: "public",
	token8: "tok12345",
	headCommitHash: "a".repeat(40),
	expiresAt: "2026-09-01T00:00:00.000Z",
	decisionCount: 4,
};

describe("BranchShareStore", () => {
	it("returns undefined for a missing file", async () => {
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
	});

	it("round-trips a share record", async () => {
		await putBranchShare(cwd, "feature/x", REC);
		const got = await getBranchShare(cwd, "feature/x");
		expect(got?.shareId).toBe("sh_1");
		expect(got?.token8).toBe("tok12345");
		expect(got?.decisionCount).toBe(4);
		expect(got?.confirmedPublic).toBeUndefined();
	});

	it("round-trips a `people` share with its recipients allowlist (no token)", async () => {
		await putBranchShare(cwd, "feature/x", {
			...REC,
			shareId: "sh_people",
			visibility: "people",
			token8: undefined,
			recipients: ["marta@jolli.ai", "tom@jolli.ai"],
		});
		const got = await getBranchShare(cwd, "feature/x");
		expect(got?.visibility).toBe("people");
		expect(got?.recipients).toEqual(["marta@jolli.ai", "tom@jolli.ai"]);
		expect(got?.token8).toBeUndefined();
	});

	it("keeps separate records per branch", async () => {
		await putBranchShare(cwd, "feature/x", REC);
		await putBranchShare(cwd, "feature/y", { ...REC, shareId: "sh_2" });
		expect((await getBranchShare(cwd, "feature/x"))?.shareId).toBe("sh_1");
		expect((await getBranchShare(cwd, "feature/y"))?.shareId).toBe("sh_2");
	});

	it("keeps a commit share separate from the branch share on the same branch", async () => {
		const commitHash = "c".repeat(40);
		await putBranchShare(cwd, "feature/x", REC); // branch share
		await putBranchShare(cwd, "feature/x", { ...REC, shareId: "sh_commit" }, commitHash); // commit share
		expect((await getBranchShare(cwd, "feature/x"))?.shareId).toBe("sh_1");
		expect((await getBranchShare(cwd, "feature/x", commitHash))?.shareId).toBe("sh_commit");
		// removing the commit share leaves the branch share intact
		await removeBranchShare(cwd, "feature/x", commitHash);
		expect(await getBranchShare(cwd, "feature/x", commitHash)).toBeUndefined();
		expect((await getBranchShare(cwd, "feature/x"))?.shareId).toBe("sh_1");
	});

	it("shares the public-confirmation flag (branch-level) across both kinds", async () => {
		const commitHash = "c".repeat(40);
		await markPublicConfirmed(cwd, "feature/x");
		// confirmation is keyed on the bare branch, so a commit share on it is also confirmed
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(true);
		await putBranchShare(cwd, "feature/x", { ...REC, shareId: "sh_commit" }, commitHash);
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(true);
	});

	it("removes a record and tolerates removing a missing one", async () => {
		await putBranchShare(cwd, "feature/x", REC);
		await removeBranchShare(cwd, "feature/x");
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
		// idempotent
		await removeBranchShare(cwd, "feature/x");
		await removeBranchShare(cwd, "never-shared");
	});

	it("tracks the public-confirmation flag independently of the share", async () => {
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(false);
		await markPublicConfirmed(cwd, "feature/x");
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(true);
		// a share with no record yet still carries the placeholder + flag
		const rec = await getBranchShare(cwd, "feature/x");
		expect(rec?.confirmedPublic).toBe(true);
		expect(rec?.shareId).toBe("");
	});

	it("preserves confirmedPublic across a later putBranchShare", async () => {
		await markPublicConfirmed(cwd, "feature/x");
		await putBranchShare(cwd, "feature/x", REC);
		const rec = await getBranchShare(cwd, "feature/x");
		expect(rec?.shareId).toBe("sh_1");
		expect(rec?.confirmedPublic).toBe(true);
	});

	it("preserves confirmedPublic when the share is revoked (removeBranchShare)", async () => {
		await markPublicConfirmed(cwd, "feature/x");
		await putBranchShare(cwd, "feature/x", REC);
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(true);

		await removeBranchShare(cwd, "feature/x"); // "Stop sharing"
		// the share itself is gone (blank placeholder), but the confirmation survives,
		// so the next share on this branch won't re-prompt the PUBLIC confirmation.
		expect((await getBranchShare(cwd, "feature/x"))?.shareId).toBe("");
		expect(await isPublicConfirmed(cwd, "feature/x")).toBe(true);
	});

	it("treats a malformed file as empty", async () => {
		await writeFile(filePath(), "{not json", "utf8");
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
	});

	it("round-trips a live org record (no token8, with a branchCollection ref + recipients)", async () => {
		const live: Omit<BranchShareRecord, "confirmedPublic"> = {
			shareId: "sh_org",
			shareUrl: "https://acme.jolli.ai/share/branch/7/view",
			visibility: "org",
			recipients: ["ada@example.com", "grace@example.com"],
			ref: {
				kind: "branchCollection",
				relativePath: "feature/x",
				covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12, 13] }],
			},
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 2,
		};
		await putBranchShare(cwd, "feature/x", live);
		const got = await getBranchShare(cwd, "feature/x");
		expect(got?.visibility).toBe("org");
		expect(got?.token8).toBeUndefined();
		expect(got?.recipients).toEqual(["ada@example.com", "grace@example.com"]);
		expect(got?.ref).toEqual(live.ref);
	});

	it("drops an old v1 file on the version bump (no migration)", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 1, branches: { "feature/x": REC } }), "utf8");
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
	});

	it("ignores a file with an unrecognized version", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 99, branches: { "feature/x": REC } }), "utf8");
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
	});

	it("ignores a file whose branches field is not an object", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 1, branches: "nope" }), "utf8");
		expect(await getBranchShare(cwd, "feature/x")).toBeUndefined();
	});

	it("cleans up and propagates when the atomic rename fails", async () => {
		// Make the target path a directory so the temp→target rename fails; this
		// drives the cleanup-and-rethrow arm and the non-ENOENT read warning.
		await mkdir(filePath(), { recursive: true });
		await expect(putBranchShare(cwd, "feature/x", REC)).rejects.toBeTruthy();
	});

	it("serializes concurrent writes without losing updates", async () => {
		await Promise.all([
			putBranchShare(cwd, "a", { ...REC, shareId: "a" }),
			putBranchShare(cwd, "b", { ...REC, shareId: "b" }),
			putBranchShare(cwd, "c", { ...REC, shareId: "c" }),
		]);
		expect((await getBranchShare(cwd, "a"))?.shareId).toBe("a");
		expect((await getBranchShare(cwd, "b"))?.shareId).toBe("b");
		expect((await getBranchShare(cwd, "c"))?.shareId).toBe("c");
	});
});
