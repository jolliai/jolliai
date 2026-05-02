/**
 * KbFoldersService
 *
 * Provides a lazy view of the knowledge-base root directory for the sidebar's
 * Folders tab. The webview asks for one level at a time; we read fs and emit
 * a FolderNode whose `children` array contains direct entries with their own
 * `children` left as `undefined` (so the client knows they're unloaded).
 *
 * Hides `.jolli/` at the root only (subdirectories named `.jolli` are visible
 * since they're not the kbRoot's bookkeeping folder).
 *
 * File classification (`fileKind` / `fileKey`) is read from
 * `<kbRoot>/.jolli/manifest.json`, the authoritative KB index. The
 * manifest's `type: "commit" | "plan" | "note"` maps to UI-level
 * `fileKind: "memory" | "plan" | "note"`; entries absent from the manifest get
 * `"other"` (typically user-dropped markdown notes).
 *
 * `fileTitle` priority for `.md` files:
 *   1. Manifest entry `title` (if present) — authoritative; commit message for
 *      memories, hand-written for plan/note.
 *   2. First H1 (or YAML frontmatter `title:`) inside the file — fallback for
 *      orphan user MDs and pre-title-field manifest rows. Read of head ~1 KB
 *      only, so a folder of large MDs doesn't tank listing latency.
 *   3. Bare filename — final fallback in the renderer.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Manifest, ManifestEntry } from "../../../cli/src/core/KBTypes.js";
import type { FolderFileKind, FolderNode } from "../views/SidebarMessages.js";

export class KbFoldersService {
	constructor(private readonly getKbRoot: () => string) {}

	async listChildren(relPath: string): Promise<FolderNode> {
		const safe = this.validateRelPath(relPath);
		const kbRoot = this.getKbRoot();
		const abs = safe === "" ? kbRoot : join(kbRoot, safe);

		// NOTE: fs.stat/readdir follow symlinks. If the user has a symlink in
		// kbRoot pointing outside (e.g. kbRoot/link -> /etc), this service will
		// list the target's contents. Treated as intentional — users may legitimately
		// organize their KB with symlinks — but it means the kbRoot boundary is
		// soft, not enforced at the fs layer. Don't rely on this service alone as
		// an authoritative sandbox against an adversarial KB.
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(abs);
		} catch (err) {
			// Root listing on a missing kbRoot is the "fresh KB / post-wipe" case:
			// return an empty root so the sidebar can render "no files yet" instead
			// of getting stuck on Loading. Subpath misses still throw — they signal
			// a stale or invalid client request that the caller should surface.
			if (safe === "" && (err as NodeJS.ErrnoException)?.code === "ENOENT") {
				return { name: "", relPath: "", isDirectory: true, children: [] };
			}
			throw err;
		}
		if (!stat.isDirectory()) {
			const lookup = await this.buildManifestLookup(kbRoot);
			const entry = lookup.get(safe);
			const name = relPathName(safe);
			const title = entry?.title ?? (await deriveMdTitle(abs, name));
			return {
				name,
				relPath: safe,
				isDirectory: false,
				children: [],
				fileKind: classify(entry),
				fileKey: entry?.fileId,
				fileTitle: title,
				fileBranch: entry?.source?.branch,
			};
		}

		const entries = await fs.readdir(abs, { withFileTypes: true });
		// Hide all dotfiles/dotdirs at every level: `.jolli/` (bookkeeping),
		// `.git/`, `.DS_Store`, `.gitignore`, `.vscode/`, etc. Users who want
		// to see specific dotfiles can navigate to them directly via VSCode's
		// Explorer; the sidebar's Folders tab is for the user-visible KB.
		const filtered = entries.filter((e) => !e.name.startsWith("."));
		filtered.sort((a, b) => {
			const ad = a.isDirectory();
			const bd = b.isDirectory();
			if (ad !== bd) return ad ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		// Read manifest once per listChildren call. Files-only branch skips it
		// (no children to classify); the small per-listing IO cost is preferable
		// to a stale cache that could mis-label a freshly written memory.
		const lookup = filtered.some((e) => !e.isDirectory())
			? await this.buildManifestLookup(kbRoot)
			: new Map<string, ManifestEntry>();

		const children: FolderNode[] = await Promise.all(
			filtered.map(async (e): Promise<FolderNode> => {
				const childRelPath = safe === "" ? e.name : `${safe}/${e.name}`;
				if (e.isDirectory()) {
					return {
						name: e.name,
						relPath: childRelPath,
						isDirectory: true,
						children: undefined,
					};
				}
				const entry = lookup.get(childRelPath);
				const title =
					entry?.title ?? (await deriveMdTitle(join(abs, e.name), e.name));
				return {
					name: e.name,
					relPath: childRelPath,
					isDirectory: false,
					children: [],
					fileKind: classify(entry),
					fileKey: entry?.fileId,
					fileTitle: title,
					fileBranch: entry?.source?.branch,
				};
			}),
		);

		return {
			name: relPathName(safe),
			relPath: safe,
			isDirectory: true,
			children,
		};
	}

	private async buildManifestLookup(
		kbRoot: string,
	): Promise<Map<string, ManifestEntry>> {
		const path = join(kbRoot, ".jolli", "manifest.json");
		let raw: string;
		try {
			raw = await fs.readFile(path, "utf8");
		} catch {
			// No manifest yet (fresh KB, or KB used only for user-dropped files):
			// every file naturally falls through to `fileKind: "other"`.
			return new Map();
		}
		let parsed: Manifest;
		try {
			parsed = JSON.parse(raw) as Manifest;
		} catch {
			return new Map();
		}
		const map = new Map<string, ManifestEntry>();
		for (const e of parsed.files ?? []) map.set(e.path, e);
		return map;
	}

	private validateRelPath(p: string): string {
		if (isAbsolute(p)) {
			throw new Error(`Invalid path: absolute paths not allowed (${p})`);
		}
		const norm = normalize(p)
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");
		if (
			norm.startsWith("..") ||
			norm.includes("/../") ||
			norm.endsWith("/..")
		) {
			throw new Error(`Invalid path: outside kbRoot (${p})`);
		}
		if (norm === "." || norm === "") return "";
		return norm;
	}
}

function classify(entry: ManifestEntry | undefined): FolderFileKind {
	if (!entry) return "other";
	if (entry.type === "commit") return "memory";
	return entry.type;
}

function relPathName(rel: string): string {
	if (rel === "") return "";
	const parts = rel.split("/");
	return parts[parts.length - 1] ?? "";
}

/**
 * Title-extraction head size. ~1 KB is enough for a YAML frontmatter block
 * plus the first heading of any reasonably-formatted markdown file. We cap
 * the read because `listChildren` runs N IOs per .md file in the listing,
 * and an unbounded read would amplify that cost on folders full of large
 * notes.
 */
const MD_TITLE_HEAD_BYTES = 1024;

/**
 * Reads the head of an `.md` file and returns its title — frontmatter
 * `title:` first, then the first H1. Non-`.md` files, missing files, and
 * files with no recognizable title resolve to `undefined` (renderer falls
 * back to filename).
 */
async function deriveMdTitle(
	absPath: string,
	name: string,
): Promise<string | undefined> {
	if (!name.toLowerCase().endsWith(".md")) return undefined;
	let head: string;
	try {
		const handle = await fs.open(absPath, "r");
		try {
			const buf = Buffer.alloc(MD_TITLE_HEAD_BYTES);
			const { bytesRead } = await handle.read(buf, 0, MD_TITLE_HEAD_BYTES, 0);
			head = buf.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
	return parseMdTitle(head);
}

export function parseMdTitle(text: string): string | undefined {
	let s = text.replace(/^﻿/, "");
	// YAML frontmatter `---\n ... \n---` — extract `title: ...` if present
	// and strip the block before scanning for an H1, so we don't mistake a
	// frontmatter line beginning with `#` (a YAML comment) for a heading.
	const fmMatch = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (fmMatch) {
		const titleLine = (fmMatch[1] ?? "").match(
			/^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/im,
		);
		if (titleLine) {
			const v = stripQuotes(titleLine[1] ?? "").trim();
			if (v) return v;
		}
		s = s.slice(fmMatch[0].length);
	}
	for (const rawLine of s.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "") continue;
		const h1 = line.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
		if (h1) {
			const v = (h1[1] ?? "").trim();
			return v || undefined;
		}
		// First non-blank line isn't an H1 → no title; keep filename.
		return undefined;
	}
	return undefined;
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}
