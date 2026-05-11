import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataManager } from "../../../cli/src/core/MetadataManager.js";
import { KbFoldersService } from "./KbFoldersService";

// Cross-store contract: CLI's MetadataManager is the producer of the KB
// metadata layout (`<repoRoot>/.jolli/`); KbFoldersService is the consumer
// that surfaces it to the sidebar webview. They must agree on layout — if
// either side independently changes where manifest.json lives or how entries
// are keyed, listChildren() falls back to fileKind:"other" silently and KB
// rows in the UI lose their type-specific icon/chip styling.
//
// IntelliJ's MetadataManager.kt mirrors the same `.jolli` layout — see
// intellij/src/main/kotlin/ai/jolli/jollimemory/core/MetadataManager.kt. If
// this test fails, check that intellij side and this side still agree.
describe("KbFoldersService ↔ MetadataManager (cross-store contract)", () => {
	let tmpParent: string;
	let repoDir: string;
	let svc: KbFoldersService;

	beforeEach(() => {
		tmpParent = mkdtempSync(join(tmpdir(), "kbfolders-xstore-"));
		// Real multi-repo wiring: <kbParent>/<repoDir>/.jolli/config.json
		// is what KBRepoDiscoverer scans for. Seed one repo so the service
		// has somewhere to read from.
		repoDir = join(tmpParent, "myrepo");
		mkdirSync(join(repoDir, ".jolli"), { recursive: true });
		writeFileSync(
			join(repoDir, ".jolli", "config.json"),
			JSON.stringify({ version: 1, sortOrder: "date", repoName: "myrepo" }),
			"utf-8",
		);
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "myrepo",
			currentRemoteUrl: null,
		}));
	});
	afterEach(() => {
		rmSync(tmpParent, { recursive: true, force: true });
	});

	it("classifies files using the manifest written by CLI MetadataManager", async () => {
		// Producer: write manifest the same way StorageFactory.ts does at
		// runtime — `new MetadataManager(join(repoRoot, ".jolli"))`.
		const mm = new MetadataManager(join(repoDir, ".jolli"));
		mm.ensure();
		mm.updateManifest({
			path: "summary-of-feature-x.md",
			fileId: "abc123",
			type: "commit",
			fingerprint: "sha256:fp1",
			source: { branch: "main", commitHash: "abc123" },
			title: "Summary of feature X",
		});
		mm.updateManifest({
			path: "design-doc.md",
			fileId: "plan-1",
			type: "plan",
			fingerprint: "sha256:fp2",
			source: { branch: "main" },
			title: "Design Doc",
		});
		mm.updateManifest({
			path: "scratch-note.md",
			fileId: "note-1",
			type: "note",
			fingerprint: "sha256:fp3",
			source: { branch: "main" },
			title: "Scratch Note",
		});

		// The user-visible markdown files corresponding to the manifest entries,
		// placed inside the repo's KB root (not the kbParent).
		writeFileSync(join(repoDir, "summary-of-feature-x.md"), "# X");
		writeFileSync(join(repoDir, "design-doc.md"), "# Design");
		writeFileSync(join(repoDir, "scratch-note.md"), "# Note");
		// Plus an unrelated user-dropped markdown not in the manifest — must
		// fall through to fileKind:"other".
		writeFileSync(join(repoDir, "user-dropped.md"), "# random");

		// Consumer: KbFoldersService reads the manifest from the same
		// `<repoRoot>/.jolli/manifest.json` location. With the multi-repo
		// protocol, the listing path prefixes the repo directory name.
		const repoRoot = await svc.listChildren("myrepo");
		const byName = new Map((repoRoot.children ?? []).map((c) => [c.name, c]));

		expect(byName.get("summary-of-feature-x.md")?.fileKind).toBe("memory");
		expect(byName.get("design-doc.md")?.fileKind).toBe("plan");
		expect(byName.get("scratch-note.md")?.fileKind).toBe("note");
		expect(byName.get("user-dropped.md")?.fileKind).toBe("other");
	});
});
