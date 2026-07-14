import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point getGlobalConfigDir at a throwaway temp dir; everything else (atomicWrite,
// fs) runs for real so the load/save round-trip is genuinely exercised.
const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("./SessionTracker.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./SessionTracker.js")>()),
	getGlobalConfigDir: () => h.dir,
}));

import { loadUserProfile, saveUserProfile } from "./UserProfile.js";

describe("UserProfile", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-profile-"));
		h.dir = dir;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns an empty profile when the file is missing", async () => {
		expect(await loadUserProfile()).toEqual({});
	});

	it("returns an empty profile on unparseable JSON", async () => {
		await writeFile(join(dir, "profile.json"), "{ not json", "utf-8");
		expect(await loadUserProfile()).toEqual({});
	});

	it("returns an empty profile on well-formed but non-object JSON", async () => {
		// External tampering could leave a bare number / array / null; none of these
		// is a valid profile, so we fall back to {} rather than let it leak through.
		for (const junk of ["42", "null", "[]", '"nope"']) {
			await writeFile(join(dir, "profile.json"), junk, "utf-8");
			expect(await loadUserProfile()).toEqual({});
		}
	});

	it("saves then loads a flag round-trip", async () => {
		await saveUserProfile({ signInPromptDeclined: true });
		expect(await loadUserProfile()).toEqual({ signInPromptDeclined: true });
	});

	it("shallow-merges updates, preserving existing fields", async () => {
		await saveUserProfile({ email: "joe@acme.dev" });
		await saveUserProfile({ signInPromptDeclined: true });
		expect(await loadUserProfile()).toEqual({ email: "joe@acme.dev", signInPromptDeclined: true });
	});

	it("creates the config directory when it does not exist yet", async () => {
		h.dir = join(dir, "nested", "config");
		await saveUserProfile({ signInPromptDeclined: true });
		expect(await loadUserProfile()).toEqual({ signInPromptDeclined: true });
	});
});
