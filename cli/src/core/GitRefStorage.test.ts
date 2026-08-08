/**
 * GitRefStorage — the pinning mechanism itself.
 *
 * The property under test is that every read goes through the CONSTRUCTED
 * commit sha, never through a branch name that can move. The drift test
 * simulates exactly the race the class exists to close: a branch that advances
 * between "resolve the tip" and "read the files" — the pinned view must keep
 * answering from the old tip. Simulated plumbing rather than a real repo keeps
 * this in the fast tier; the property is about which ref the class passes down,
 * which a fake observes more directly than a subprocess would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GitOps.js", () => ({
	execGit: vi.fn(),
	readFileFromBranch: vi.fn(),
	batchReadFilesFromBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
}));

import { batchReadFilesFromBranch, execGit, listFilesInBranch, readFileFromBranch } from "./GitOps.js";
import { GitRefStorage, resolveCommittish } from "./GitRefStorage.js";

const TIP = "a".repeat(40);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveCommittish", () => {
	it("peels to a commit and returns the full sha", async () => {
		vi.mocked(execGit).mockResolvedValue({ stdout: `${TIP}\n`, stderr: "", exitCode: 0 });
		expect(await resolveCommittish("jollimemory/summaries/v3", "/repo")).toBe(TIP);
		// ^{commit} is what makes a tag answer with its commit and a blob fail.
		expect(execGit).toHaveBeenCalledWith(["rev-parse", "--verify", "jollimemory/summaries/v3^{commit}"], "/repo");
	});

	it("returns null when the committish does not resolve", async () => {
		vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "fatal: needed a single revision", exitCode: 128 });
		expect(await resolveCommittish("no-such-branch", "/repo")).toBeNull();
	});

	it("returns null on output that is not a commit sha", async () => {
		// A porcelain surprise (warning line, truncated output) must not become a
		// "pinned" ref that every later read fails on.
		vi.mocked(execGit).mockResolvedValue({ stdout: "warning: something\n", stderr: "", exitCode: 0 });
		expect(await resolveCommittish("weird", "/repo")).toBeNull();
	});
});

describe("GitRefStorage", () => {
	it("passes the pinned sha — never a branch name — to every read", async () => {
		const storage = new GitRefStorage(TIP, "/repo");
		vi.mocked(readFileFromBranch).mockResolvedValue("content");
		vi.mocked(batchReadFilesFromBranch).mockResolvedValue(new Map([["a", "1"]]));
		vi.mocked(listFilesInBranch).mockResolvedValue(["summaries/x.json"]);

		await storage.readFile("summaries/x.json");
		await storage.batchReadFiles(["a"]);
		await storage.listFiles("summaries/");

		expect(readFileFromBranch).toHaveBeenCalledWith(TIP, "summaries/x.json", "/repo");
		expect(batchReadFilesFromBranch).toHaveBeenCalledWith(TIP, ["a"], "/repo");
		expect(listFilesInBranch).toHaveBeenCalledWith(TIP, "summaries/", "/repo");
	});

	it("keeps answering from the pinned tip after the branch moves on", async () => {
		// The race this class closes: list at T, branch advances to T', read.
		// A by-name reader would see T' files (and a seed reconciliation would
		// prune rows for paths T' dropped); the pinned view must stay at T.
		const atT = new Map([
			["summaries/old.json", "old-content"],
			["summaries/kept.json", "kept-v1"],
		]);
		// The branch name resolves to T' from the start — the fake models a repo
		// where the advance already happened. Only a reader that asks BY SHA can
		// still see T; a reader that asks by anything else gets T'.
		const atTPrime = new Map([["summaries/kept.json", "kept-v2"]]);

		vi.mocked(listFilesInBranch).mockImplementation(async (ref) => {
			const view = ref === TIP ? atT : atTPrime;
			return [...view.keys()];
		});
		vi.mocked(readFileFromBranch).mockImplementation(async (ref, path) => {
			const view = ref === TIP ? atT : atTPrime;
			return view.get(path) ?? null;
		});

		const storage = new GitRefStorage(TIP, "/repo");
		const listed = await storage.listFiles("summaries/");
		expect(await storage.readFile("summaries/old.json")).toBe("old-content");
		expect(await storage.readFile("summaries/kept.json")).toBe("kept-v1");
		expect(listed).toContain("summaries/old.json");
	});

	it("rejects writes loudly — a silent no-op would fake a landed write", async () => {
		const storage = new GitRefStorage(TIP, "/repo");
		await expect(storage.writeFiles([], "msg")).rejects.toThrow(/read-only/);
	});

	it("cannot be ensured into existence", async () => {
		// `ensure` on the branch backend CREATES the ref; a pinned snapshot must
		// never grow that power, or an importer could conjure the thing it is
		// supposed to be reading.
		const storage = new GitRefStorage(TIP, "/repo");
		await expect(storage.ensure()).rejects.toThrow(/cannot be initialized/);
	});

	it("exists() only verifies the commit resolves", async () => {
		vi.mocked(execGit).mockResolvedValue({ stdout: `${TIP}\n`, stderr: "", exitCode: 0 });
		expect(await new GitRefStorage(TIP, "/repo").exists()).toBe(true);
		vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "fatal", exitCode: 128 });
		expect(await new GitRefStorage(TIP, "/repo").exists()).toBe(false);
	});
});
