import { describe, expect, it } from "vitest";
import { buildSandboxFailureCaptureText } from "./SandboxRemediation.js";

describe("blocked-sandbox capture remediation", () => {
	const text = buildSandboxFailureCaptureText("codex");

	it("names the sandbox as the cause and the setting that fixes it", () => {
		expect(text).toContain("Codex sandbox");
		expect(text).toContain("blocking network access");
		expect(text).toContain("[sandbox_workspace_write]");
		expect(text).toContain("network_access = true");
	});

	// The env marker proves the sandbox is ACTIVE, never that it caused this
	// particular failure — a git or filesystem error before the LLM call is ever
	// attempted reaches this same line. The hedge plus the log pointer is what keeps
	// that case diagnosable; the generic line this replaces was the only one that
	// said where the real error is.
	it("hedges the attribution and still says where the real error is", () => {
		expect(text).toContain("most likely");
		expect(text).toContain(".jolli/jollimemory/debug.log");
	});

	// There is no recovery path: a sandbox failure that classifies as
	// `local-agent-auth` still stores a placeholder summary, and backfill skips every
	// commit that already has one. Promising a retry would be a lie.
	it("promises no recovery command", () => {
		expect(text).not.toContain("backfill");
	});

	// The whole point of this variant: the two generic endings both mislead here.
	// "did not complete" invites a retry that will fail the same way, and the
	// background line promises work the sandboxed worker provably cannot do.
	it("states the memory is gone rather than pending, and offers a second way out", () => {
		expect(text).toContain("cannot finish either");
		expect(text).toContain("not retried later");
		expect(text).toContain("outside Codex");
		expect(text).not.toContain("continues in the background");
	});
});
