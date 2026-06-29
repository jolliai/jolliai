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
	isNonFastForwardError,
} from "./ForcePushPrompt.js";

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
});
