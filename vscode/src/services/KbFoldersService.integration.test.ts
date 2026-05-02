import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataManager } from "../../../cli/src/core/MetadataManager.js";
import { KbFoldersService } from "./KbFoldersService";

// Cross-store contract: CLI's MetadataManager is the producer of the KB
// metadata layout (`<kbRoot>/.jolli/`); KbFoldersService is the consumer that
// surfaces it to the sidebar webview. They must agree on layout — if either
// side independently changes where manifest.json lives or how entries are
// keyed, listChildren() falls back to fileKind:"other" silently and KB rows
// in the UI lose their type-specific icon/chip styling. (This was the actual
// regression: KbFoldersService briefly read `<kbRoot>/.jolli/jollimemory/`
// while MetadataManager always wrote `<kbRoot>/.jolli/`. Unit tests on either
// side passed because each side's fixture matched its own buggy path.)
//
// IntelliJ's MetadataManager.kt mirrors the same `.jolli` layout — see
// intellij/src/main/kotlin/ai/jolli/jollimemory/core/MetadataManager.kt. If
// this test fails, check that intellij side and this side still agree.
describe("KbFoldersService ↔ MetadataManager (cross-store contract)", () => {
	let tmpRoot: string;
	let svc: KbFoldersService;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "kbfolders-xstore-"));
		svc = new KbFoldersService(() => tmpRoot);
	});
	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("classifies files using the manifest written by CLI MetadataManager", async () => {
		// Producer: write manifest the same way StorageFactory.ts does at
		// runtime — `new MetadataManager(join(kbRoot, ".jolli"))`.
		const mm = new MetadataManager(join(tmpRoot, ".jolli"));
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

		// The user-visible markdown files corresponding to the manifest entries.
		writeFileSync(join(tmpRoot, "summary-of-feature-x.md"), "# X");
		writeFileSync(join(tmpRoot, "design-doc.md"), "# Design");
		writeFileSync(join(tmpRoot, "scratch-note.md"), "# Note");
		// Plus an unrelated user-dropped markdown not in the manifest — must
		// fall through to fileKind:"other".
		writeFileSync(join(tmpRoot, "user-dropped.md"), "# random");

		// Consumer: KbFoldersService reads the manifest from the same
		// `<kbRoot>/.jolli/manifest.json` location.
		const root = await svc.listChildren("");
		const byName = new Map((root.children ?? []).map((c) => [c.name, c]));

		expect(byName.get("summary-of-feature-x.md")?.fileKind).toBe("memory");
		expect(byName.get("design-doc.md")?.fileKind).toBe("plan");
		expect(byName.get("scratch-note.md")?.fileKind).toBe("note");
		expect(byName.get("user-dropped.md")?.fileKind).toBe("other");
	});
});
