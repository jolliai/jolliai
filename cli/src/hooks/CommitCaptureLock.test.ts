import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCommitCaptureLock } from "./CommitCaptureLock.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("withCommitCaptureLock", () => {
	it("serializes generation for the same hash and releases for the next owner", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-capture-lock-"));
		roots.push(cwd);
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markEntered!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});

		const first = withCommitCaptureLock(cwd, "abc123", "fail-fast", async () => {
			markEntered();
			await firstBlocked;
			return "first";
		});
		await firstEntered;

		expect(await withCommitCaptureLock(cwd, "abc123", "fail-fast", async () => "second")).toEqual({
			ran: false,
		});

		releaseFirst();
		expect(await first).toEqual({ ran: true, value: "first" });
		expect(await withCommitCaptureLock(cwd, "abc123", "fail-fast", async () => "third")).toEqual({
			ran: true,
			value: "third",
		});
	});

	it("uses distinct locks for distinct hashes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-capture-lock-"));
		roots.push(cwd);
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markEntered!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});

		const first = withCommitCaptureLock(cwd, "abc123", "fail-fast", async () => {
			markEntered();
			await firstBlocked;
		});
		await firstEntered;

		expect(await withCommitCaptureLock(cwd, "def456", "fail-fast", async () => "other")).toEqual({
			ran: true,
			value: "other",
		});
		releaseFirst();
		await first;
	});
});
