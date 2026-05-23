/**
 * Edge-triggered popup state-machine tests for `SymlinkPopupGate`. No
 * `vscode` mock needed — the gate intentionally takes plain data in and
 * returns plain data out.
 */

import { describe, expect, it } from "vitest";
import type { SyncRoundResult } from "../../../cli/src/sync/SyncTypes.js";
import { SymlinkPopupGate } from "./SymlinkPopupGate.js";

function failed(): SyncRoundResult {
	return {
		fetched: true,
		pulled: false,
		pushed: false,
		conflicts: [],
		newState: "offline",
		lastError: { code: "symlink_quarantine_failed", message: "pre-round: failed=1" },
	};
}

function synced(): SyncRoundResult {
	return {
		fetched: true,
		pulled: true,
		pushed: true,
		conflicts: [],
		newState: "synced",
	};
}

function otherTerminal(): SyncRoundResult {
	return {
		fetched: true,
		pulled: false,
		pushed: false,
		conflicts: [],
		newState: "offline",
		lastError: { code: "push_rejected", message: "denied" },
	};
}

describe("SymlinkPopupGate", () => {
	it("fires on first symlink failure", () => {
		const gate = new SymlinkPopupGate();
		const popup = gate.consume(failed());
		expect(popup).not.toBeNull();
		expect(popup?.message).toContain("Memory Bank sync paused");
		expect(popup?.message).toContain("pre-round: failed=1");
		expect(popup?.actions).toEqual(["Open Memory Bank Folder"]);
	});

	it("silences repeated symlink failures within the same session", () => {
		// Round 1 fires the popup; rounds 2 and 3 stay silent. Without this
		// the user would see a popup every poll tick (default 90 s) until
		// they fix the symlink — that's the "noisy" failure mode the gate
		// exists to prevent.
		const gate = new SymlinkPopupGate();
		expect(gate.consume(failed())).not.toBeNull();
		expect(gate.consume(failed())).toBeNull();
		expect(gate.consume(failed())).toBeNull();
	});

	it("re-arms after a clean (failed=0) round and fires again on recurrence", () => {
		// User fixes the symlink, sync goes green, then a NEW symlink is
		// dropped later in the session. That deserves its own popup
		// because the user has no other signal that a new hostile link
		// appeared.
		const gate = new SymlinkPopupGate();
		expect(gate.consume(failed())).not.toBeNull();
		expect(gate.consume(synced())).toBeNull();
		expect(gate.consume(failed())).not.toBeNull();
	});

	it("treats other terminal codes as re-arming events (not failures)", () => {
		// `push_rejected` is unrelated — should NOT fire the symlink popup
		// AND should re-arm the gate so the next genuine symlink failure
		// pops. The gate only cares about its own code.
		const gate = new SymlinkPopupGate();
		expect(gate.consume(failed())).not.toBeNull();
		expect(gate.consume(otherTerminal())).toBeNull();
		expect(gate.consume(failed())).not.toBeNull();
	});

	it("omits the trailing message when lastError.message is empty", () => {
		// Defensive: the engine always sets a message today, but the gate
		// must not synthesise "undefined" / "null" into the user-visible
		// string if a future change leaves it empty.
		const gate = new SymlinkPopupGate();
		const result: SyncRoundResult = {
			fetched: true,
			pulled: false,
			pushed: false,
			conflicts: [],
			newState: "offline",
			lastError: { code: "symlink_quarantine_failed", message: "" },
		};
		const popup = gate.consume(result);
		expect(popup?.message.endsWith(":")).toBe(false);
		expect(popup?.message).not.toContain("undefined");
	});
});
