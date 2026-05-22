import { describe, expect, it } from "vitest";
import { buildConversationDetailsScript } from "./ConversationDetailsScriptBuilder";

describe("ConversationDetailsScriptBuilder", () => {
	it("returns a non-empty JS string", () => {
		const js = buildConversationDetailsScript();
		expect(typeof js).toBe("string");
		expect(js.length).toBeGreaterThan(0);
	});

	it("kicks off the initial transcript request on load", () => {
		const js = buildConversationDetailsScript();
		expect(js).toContain("type: 'requestTranscript'");
	});

	// P2 contract: the host posts `panelReshown` when the user clicks the
	// same row again; the webview re-fetches the transcript only when there
	// is no pending state — otherwise unsaved edits would be silently
	// discarded by resetPendingState() inside the transcriptLoaded handler.
	it("handles panelReshown and gates the re-fetch on pending state being empty", () => {
		const js = buildConversationDetailsScript();
		expect(js).toContain("msg.type === 'panelReshown'");
		// The gate must check both edited and deleted counters — gating on
		// only one would still discard pending work on a refresh.
		expect(js).toContain("c.edited === 0");
		expect(js).toContain("c.deleted === 0");
		// And on the empty-pending branch the webview must re-post
		// requestTranscript so the host actually pushes a fresh
		// transcriptLoaded back. Sliced from the reshown branch so the
		// initial-load requestTranscript at the top of the file can't
		// falsely satisfy this assertion.
		const reshownBlock = js.slice(js.indexOf("'panelReshown'"));
		expect(reshownBlock).toContain("type: 'requestTranscript'");
	});

	it("toggles the edited notice from transcriptLoaded.isEdited", () => {
		const js = buildConversationDetailsScript();
		expect(js).toContain("const editedNoticeEl = document.getElementById('editedNotice');");
		expect(js).toContain("function setEditedNoticeVisible(isEdited)");
		expect(js).toContain("editedNoticeEl.classList.toggle('hidden', !isEdited);");
		expect(js).toContain("setEditedNoticeVisible(msg.isEdited === true);");
	});
});
