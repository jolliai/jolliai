import { beforeEach, describe, expect, it, vi } from "vitest";

const { showWarningMessage } = vi.hoisted(() => ({
	showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
	window: { showWarningMessage },
}));

import {
	FORCE_PUSH_CONFIRM_LABEL,
	confirmForcePush,
	gateForcePush,
	isNonFastForwardError,
} from "./ForcePushPrompt.js";
import { inspectForcePushSafety } from "./ForcePushSafety.js";

/**
 * Builds a fake GitRunner from a map of `git <args joined by space>` → stdout.
 * `rev-list --count A..B` lookups read the joined-args key. Unknown commands
 * (e.g. `fetch origin <branch>`) resolve to "" so the fetch is a no-op success;
 * a key mapped to the THROW sentinel rejects, exercising the catch path.
 */
const THROW = Symbol("throw");
function fakeGit(table: Record<string, string | typeof THROW>) {
	return (args: ReadonlyArray<string>): Promise<string> => {
		const key = args.join(" ");
		const v = table[key];
		if (v === THROW) {
			return Promise.reject(new Error(`git failed: ${key}`));
		}
		return Promise.resolve(v ?? "");
	};
}

describe("ForcePushPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("isNonFastForwardError", () => {
		it.each([
			["! [rejected] HEAD -> main (non-fast-forward)"],
			["hint: Updates were rejected; fetch first"],
			["error: [rejected] main"],
			["the tip of your current branch is behind its remote counterpart"],
		])("returns true for the git rejection phrase: %s", (message) => {
			expect(isNonFastForwardError(new Error(message))).toBe(true);
		});

		it("is case-insensitive (matches upper-cased stderr)", () => {
			expect(isNonFastForwardError(new Error("NON-FAST-FORWARD"))).toBe(true);
		});

		it("returns false for an unrelated push error (auth/network)", () => {
			expect(
				isNonFastForwardError(new Error("fatal: Authentication failed")),
			).toBe(false);
		});

		it("coerces a non-Error throw via String() before matching", () => {
			// A bare string rejection still classifies correctly.
			expect(isNonFastForwardError("push rejected: fetch first")).toBe(true);
			expect(isNonFastForwardError({ nope: 1 })).toBe(false);
		});
	});

	describe("confirmForcePush", () => {
		it("returns true only when the user clicks the force-push button", async () => {
			showWarningMessage.mockResolvedValue(FORCE_PUSH_CONFIRM_LABEL);
			await expect(confirmForcePush()).resolves.toBe(true);
		});

		it("returns false when the user dismisses the modal", async () => {
			showWarningMessage.mockResolvedValue(undefined);
			await expect(confirmForcePush()).resolves.toBe(false);
		});

		it("shows a modal with the default diverged-branch reason and no detail line when called with no opts", async () => {
			showWarningMessage.mockResolvedValue(undefined);

			await confirmForcePush();

			const [message, options, label] = showWarningMessage.mock.calls[0];
			expect(message).toContain("This operation may rewrite remote history.");
			expect(message).toContain(
				"Remote branch has diverged. Force push will overwrite remote history.",
			);
			expect(message).toContain(
				"This may affect collaborators on the same branch.",
			);
			expect(options).toEqual({ modal: true });
			expect(label).toBe(FORCE_PUSH_CONFIRM_LABEL);
		});

		it("inserts caller-supplied detail lines and a custom reason between the lead-in and collaborators warning", async () => {
			showWarningMessage.mockResolvedValue(FORCE_PUSH_CONFIRM_LABEL);

			await confirmForcePush({
				detailLines: ["HEAD (3 commits): abc123 do a thing"],
				reason: "HEAD is already on remote.",
			});

			const message = showWarningMessage.mock.calls[0][0] as string;
			expect(message).toContain("HEAD (3 commits): abc123 do a thing");
			expect(message).toContain("HEAD is already on remote.");
			// The default reason must be replaced, not appended.
			expect(message).not.toContain("Remote branch has diverged");
			// Ordering: lead-in → detail → reason → collaborators.
			const leadIdx = message.indexOf("rewrite remote history");
			const detailIdx = message.indexOf("HEAD (3 commits)");
			const reasonIdx = message.indexOf("HEAD is already on remote.");
			const collabIdx = message.indexOf("affect collaborators");
			expect(leadIdx).toBeLessThan(detailIdx);
			expect(detailIdx).toBeLessThan(reasonIdx);
			expect(reasonIdx).toBeLessThan(collabIdx);
		});
	});

	describe("inspectForcePushSafety", () => {
		it("returns null for a detached HEAD / empty branch (no remote ref to compare)", async () => {
			const git = fakeGit({});
			expect(await inspectForcePushSafety(git, "HEAD")).toBeNull();
			expect(await inspectForcePushSafety(git, "")).toBeNull();
		});

		it("flags behind-only when the remote is strictly ahead (rewrite NOT detected)", async () => {
			const git = fakeGit({
				"rev-list --count HEAD..origin/feature": "3",
				"rev-list --count origin/feature..HEAD": "0",
			});
			expect(await inspectForcePushSafety(git, "feature")).toEqual({
				branch: "feature",
				remoteOnly: 3,
				localOnly: 0,
				behindOnly: true,
			});
		});

		it("reports a true divergence (both sides have unique commits) without flagging behind-only", async () => {
			const git = fakeGit({
				"rev-list --count HEAD..origin/feature": "2",
				"rev-list --count origin/feature..HEAD": "5",
			});
			expect(await inspectForcePushSafety(git, "feature")).toEqual({
				branch: "feature",
				remoteOnly: 2,
				localOnly: 5,
				behindOnly: false,
			});
		});

		it("reports no remote-only commits when local is the superset (pure rewrite)", async () => {
			const git = fakeGit({
				"rev-list --count HEAD..origin/feature": "0",
				"rev-list --count origin/feature..HEAD": "4",
			});
			const safety = await inspectForcePushSafety(git, "feature");
			expect(safety).toMatchObject({ remoteOnly: 0, behindOnly: false });
		});

		it("returns null when fetch fails (inconclusive → caller keeps prior behavior)", async () => {
			const git = fakeGit({ "fetch origin feature": THROW });
			expect(await inspectForcePushSafety(git, "feature")).toBeNull();
		});

		it("returns null when a rev-list count is non-numeric", async () => {
			const git = fakeGit({
				"rev-list --count HEAD..origin/feature": "not-a-number",
				"rev-list --count origin/feature..HEAD": "0",
			});
			expect(await inspectForcePushSafety(git, "feature")).toBeNull();
		});
	});

	describe("gateForcePush", () => {
		it("blocks (no force-push offered) when the branch is merely behind", async () => {
			const outcome = await gateForcePush({
				inspect: async () => ({
					branch: "feature",
					remoteOnly: 2,
					localOnly: 0,
					behindOnly: true,
				}),
			});
			expect(outcome).toBe("blocked");
			const [message, options] = showWarningMessage.mock.calls[0];
			expect(message).toContain('Remote branch "feature" has 2 commits');
			expect(message).toContain("simply behind");
			expect(options).toEqual({ modal: true });
			// The force-push confirm button must NOT be offered in the blocked path:
			// the call has exactly (message, {modal:true}) and no label argument.
			expect(showWarningMessage.mock.calls[0]).toHaveLength(2);
		});

		it("appends a lost-commits warning line to the confirm modal on a true divergence", async () => {
			showWarningMessage.mockResolvedValue(FORCE_PUSH_CONFIRM_LABEL);
			const outcome = await gateForcePush({
				inspect: async () => ({
					branch: "feature",
					remoteOnly: 2,
					localOnly: 5,
					behindOnly: false,
				}),
				detailLines: ["Commit: abc123 do a thing"],
			});
			expect(outcome).toBe("confirmed");
			const message = showWarningMessage.mock.calls[0][0] as string;
			expect(message).toContain("Commit: abc123 do a thing");
			expect(message).toContain(
				"this will permanently delete 2 commits that exist only on the remote",
			);
		});

		it("falls back to the plain confirm modal when divergence is inconclusive (null)", async () => {
			showWarningMessage.mockResolvedValue(undefined);
			const outcome = await gateForcePush({ inspect: async () => null });
			expect(outcome).toBe("declined");
			const message = showWarningMessage.mock.calls[0][0] as string;
			// No lost-commits line when the probe is inconclusive.
			expect(message).not.toContain("permanently delete");
		});

		it("uses singular wording when exactly one commit would be lost", async () => {
			showWarningMessage.mockResolvedValue(FORCE_PUSH_CONFIRM_LABEL);
			// behindOnly path: blocked message singular.
			const blocked = await gateForcePush({
				inspect: async () => ({
					branch: "feature",
					remoteOnly: 1,
					localOnly: 0,
					behindOnly: true,
				}),
			});
			expect(blocked).toBe("blocked");
			expect(showWarningMessage.mock.calls[0][0]).toContain(
				'has 1 commit you don\'t have',
			);
			showWarningMessage.mockClear();
			// diverged path: lost-commits line singular.
			await gateForcePush({
				inspect: async () => ({
					branch: "feature",
					remoteOnly: 1,
					localOnly: 2,
					behindOnly: false,
				}),
			});
			expect(showWarningMessage.mock.calls[0][0]).toContain(
				"delete 1 commit that exist only on the remote",
			);
		});

		it("returns confirmed when no remote-only commits would be lost", async () => {
			showWarningMessage.mockResolvedValue(FORCE_PUSH_CONFIRM_LABEL);
			const outcome = await gateForcePush({
				inspect: async () => ({
					branch: "feature",
					remoteOnly: 0,
					localOnly: 4,
					behindOnly: false,
				}),
			});
			expect(outcome).toBe("confirmed");
			const message = showWarningMessage.mock.calls[0][0] as string;
			expect(message).not.toContain("permanently delete");
		});
	});
});
