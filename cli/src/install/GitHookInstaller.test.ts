import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installPrePushHook,
	installPrepareMsgHook,
	isHookSectionInstalled,
	PRE_PUSH_MARKER_START,
	PREPARE_MSG_MARKER_START,
	removePrePushHook,
} from "./GitHookInstaller.js";

let cwd: string;

beforeEach(async () => {
	cwd = join(tmpdir(), `git-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(cwd, ".git"), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function hookPath(): string {
	return join(cwd, ".git", "hooks", "pre-push");
}

describe("installPrePushHook / removePrePushHook", () => {
	it("creates a pre-push hook with the Jolli marker and run-hook dispatch", async () => {
		const result = await installPrePushHook(cwd);
		expect(result.path).toBe(hookPath());
		const content = await readFile(hookPath(), "utf-8");
		expect(content).toContain(PRE_PUSH_MARKER_START);
		expect(content).toContain("run-hook");
		expect(content).toContain("pre-push");
		// Forwards git's args + inherits stdin via exec.
		expect(content).toContain('"$@"');
		expect(content).toContain("__jolli_pre_push_previous_status=$?");
		expect(content).toContain('(exit "$__jolli_pre_push_previous_status")');
	});

	it("is source-neutral", async () => {
		await installPrePushHook(cwd);
		const content = await readFile(hookPath(), "utf-8");
		expect(content).not.toContain("JOLLI_DIST_PREFER_SOURCE");
		expect(content).not.toContain("JOLLI_DIST_SOURCE=");
	});

	it("omits the prefer prefix when distSource is absent", async () => {
		await installPrePushHook(cwd);
		const content = await readFile(hookPath(), "utf-8");
		expect(content).not.toContain("JOLLI_DIST_PREFER_SOURCE");
	});

	it("is idempotent — installing twice leaves a single section", async () => {
		await installPrePushHook(cwd);
		await installPrePushHook(cwd);
		const content = await readFile(hookPath(), "utf-8");
		const occurrences = content.split(PRE_PUSH_MARKER_START).length - 1;
		expect(occurrences).toBe(1);
	});

	it("repairs an otherwise canonical hook whose executable bit was removed", async () => {
		await installPrePushHook(cwd);
		await chmod(hookPath(), 0o644);
		expect(await isHookSectionInstalled(cwd, "pre-push", PRE_PUSH_MARKER_START)).toBe(false);

		await installPrePushHook(cwd);

		expect((await stat(hookPath())).mode & 0o111).not.toBe(0);
		expect(await isHookSectionInstalled(cwd, "pre-push", PRE_PUSH_MARKER_START)).toBe(true);
	});

	it("appends to an existing pre-push hook without clobbering it", async () => {
		await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
		await writeFile(hookPath(), "#!/bin/sh\necho existing\n", "utf-8");
		const result = await installPrePushHook(cwd);
		expect(result.warning).toMatch(/existing pre-push hook/i);
		const content = await readFile(hookPath(), "utf-8");
		expect(content).toContain("echo existing");
		expect(content).toContain(PRE_PUSH_MARKER_START);
	});

	it("isHookSectionInstalled reports true after install, false after remove", async () => {
		await installPrePushHook(cwd);
		expect(await isHookSectionInstalled(cwd, "pre-push", PRE_PUSH_MARKER_START)).toBe(true);
		await removePrePushHook(cwd);
		expect(await isHookSectionInstalled(cwd, "pre-push", PRE_PUSH_MARKER_START)).toBe(false);
	});

	it("removePrePushHook removes only the Jolli section, leaving other hook content", async () => {
		await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
		await writeFile(hookPath(), "#!/bin/sh\necho existing\n", "utf-8");
		await installPrePushHook(cwd);
		await removePrePushHook(cwd);
		const content = await readFile(hookPath(), "utf-8");
		expect(content).toContain("echo existing");
		expect(content).not.toContain(PRE_PUSH_MARKER_START);
	});

	it("removePrePushHook removes every duplicated historical Jolli section", async () => {
		await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
		const section = `${PRE_PUSH_MARKER_START}\nold script\n# <<< JolliMemory pre-push hook <<<`;
		await writeFile(hookPath(), `#!/bin/sh\necho existing\n\n${section}\n\n${section}\n`, "utf-8");

		await removePrePushHook(cwd);

		const content = await readFile(hookPath(), "utf-8");
		expect(content).toContain("echo existing");
		expect(content).not.toContain(PRE_PUSH_MARKER_START);
	});

	it("removePrePushHook is a no-op when the hook file is absent", async () => {
		await expect(removePrePushHook(cwd)).resolves.toBeUndefined();
	});
});

describe("installPrepareMsgHook", () => {
	function prepareMsgPath(): string {
		return join(cwd, ".git", "hooks", "prepare-commit-msg");
	}

	it("preserves the preceding command's exit status like pre-push, guarded by [ -x ] + || true", async () => {
		await installPrepareMsgHook(cwd);
		const content = await readFile(prepareMsgPath(), "utf-8");
		expect(content).toContain(PREPARE_MSG_MARKER_START);
		// git aborts the commit on a non-zero prepare-commit-msg exit — an appended
		// section must not mask a preceding failure by always exiting 0.
		expect(content).toContain("__jolli_prepare_msg_previous_status=$?");
		expect(content).toContain('(exit "$__jolli_prepare_msg_previous_status")');
		expect(content).toContain('if [ -x "$HOME/.jolli/jollimemory/run-hook" ]; then');
		expect(content).toContain('run-hook" prepare-commit-msg "$1" "$2" || true; fi');
	});

	it("is source-neutral", async () => {
		await installPrepareMsgHook(cwd);
		const content = await readFile(prepareMsgPath(), "utf-8");
		expect(content).not.toContain("JOLLI_DIST_PREFER_SOURCE");
		expect(content).not.toContain("JOLLI_DIST_SOURCE=");
	});
});
