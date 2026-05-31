import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractTarGz } from "./ThemeCommand.js";

// ── Helpers to build minimal tar archives in memory ────────────────────────

/** Write a NUL-terminated string into a buffer at the given offset. */
function writeString(buf: Buffer, offset: number, length: number, value: string): void {
	const bytes = Buffer.from(value, "ascii");
	bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

/** Write an octal number as a NUL-terminated ASCII string. */
function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
	const str = value.toString(8).padStart(length - 1, "0");
	writeString(buf, offset, length, str);
}

/**
 * Compute and write a valid POSIX tar header checksum.
 * The checksum field (offset 148, 8 bytes) is treated as spaces during calculation.
 */
function writeChecksum(header: Buffer): void {
	// Fill checksum field with spaces (per POSIX spec)
	for (let i = 148; i < 156; i++) header[i] = 0x20;
	let sum = 0;
	for (let i = 0; i < 512; i++) sum += header[i];
	writeOctal(header, 148, 7, sum);
	header[155] = 0x20; // trailing space per convention
}

/** Build a single 512-byte tar header + data blocks. */
function buildTarEntry(name: string, typeflag: number, data: Buffer = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(512);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, 0o644); // mode
	writeOctal(header, 108, 8, 0); // uid
	writeOctal(header, 116, 8, 0); // gid
	writeOctal(header, 124, 12, data.length); // size
	writeOctal(header, 136, 12, 0); // mtime
	header[156] = typeflag;
	writeString(header, 257, 6, "ustar"); // magic
	writeString(header, 263, 2, "00"); // version
	writeChecksum(header);

	const dataBlocks = Math.ceil(data.length / 512) * 512;
	const paddedData = Buffer.alloc(dataBlocks);
	data.copy(paddedData);
	return Buffer.concat([header, paddedData]);
}

/** Build a complete tar archive from entries + two 512-byte zero end blocks. */
function buildTar(entries: Buffer[]): Buffer {
	const endMarker = Buffer.alloc(1024); // two zero blocks
	return Buffer.concat([...entries, endMarker]);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("extractTarGz", () => {
	it("extracts files and directories from a valid tar.gz", () => {
		const fileData = Buffer.from("hello world", "utf-8");
		const tar = buildTar([buildTarEntry("root/", 0x35), buildTarEntry("root/readme.txt", 0x30, fileData)]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({ path: "root/", type: "dir", data: Buffer.alloc(0) });
		expect(entries[1]).toEqual({ path: "root/readme.txt", type: "file", data: fileData });
	});

	it("handles typeflag 0 (NUL) as regular file", () => {
		const data = Buffer.from("content", "utf-8");
		const tar = buildTar([buildTarEntry("file.txt", 0, data)]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe("file");
		expect(entries[0].data.toString()).toBe("content");
	});

	it("returns empty array for an empty archive", () => {
		const tar = Buffer.alloc(1024); // two zero blocks only
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(0);
	});

	it("throws on GNU LongName typeflag 'L'", () => {
		const tar = buildTar([
			buildTarEntry("././@LongLink", 0x4c, Buffer.from("a".repeat(200))), // 'L' = 0x4C
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/Unsupported tar entry type 'L'/);
	});

	it("throws on PAX extended header typeflag 'x'", () => {
		const tar = buildTar([
			buildTarEntry("PaxHeader/file.txt", 0x78, Buffer.from("key=value")), // 'x' = 0x78
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/Unsupported tar entry type 'x'/);
	});

	it("skips PAX global header typeflag 'g' carrying only comment= and keeps parsing later entries", () => {
		// GitHub's codeload.github.com prepends a `pax_global_header` entry
		// (typeflag 'g') with a single `comment=<sha>` record to every
		// tarball. `comment` is in the allowlist, so this must extract the
		// real entries that follow. The record length "25" includes the
		// length digits, the separator, the key=value pair, and the LF.
		const paxPayload = Buffer.from("25 comment=abc1234567890\n", "ascii");
		const fileData = Buffer.from("hello world", "utf-8");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload), // 'g' = 0x67
			buildTarEntry("repo-main/", 0x35),
			buildTarEntry("repo-main/readme.txt", 0x30, fileData),
		]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({ path: "repo-main/", type: "dir", data: Buffer.alloc(0) });
		expect(entries[1]).toEqual({ path: "repo-main/readme.txt", type: "file", data: fileData });
	});

	it("skips PAX global header carrying multiple allowlisted records", () => {
		// Two records back-to-back inside one global header data block.
		// `comment` and `mtime` are both safe to ignore; the extractor must
		// parse the length prefixes correctly and continue with the rest of
		// the archive.
		const recordA = "15 comment=abc\n"; // 15 bytes total
		const recordB = "30 mtime=1234567890.000000000\n"; // 30 bytes total
		const paxPayload = Buffer.from(recordA + recordB, "ascii");
		const fileData = Buffer.from("payload", "utf-8");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload),
			buildTarEntry("repo-main/file.txt", 0x30, fileData),
		]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe("repo-main/file.txt");
		expect(entries[0].data).toEqual(fileData);
	});

	it("throws when a PAX global header record uses path=", () => {
		// `path=` in a global header would silently rewrite every later
		// entry's path. Ignoring it (the previous behaviour) could let a
		// malicious tarball redirect every file into an attacker-controlled
		// directory while the parser thought it was just skipping metadata.
		const paxPayload = Buffer.from("17 path=evil/dir\n", "ascii");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload),
			buildTarEntry("repo-main/readme.txt", 0x30, Buffer.from("ok")),
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/PAX global header key "path"/);
	});

	it("throws when a PAX global header record uses linkpath=", () => {
		const paxPayload = Buffer.from("18 linkpath=other\n", "ascii");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload),
			buildTarEntry("repo-main/readme.txt", 0x30, Buffer.from("ok")),
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/PAX global header key "linkpath"/);
	});

	it("throws when a PAX global header record uses size=", () => {
		// `size=` in a global header overrides the ustar header size of
		// every later entry — ignoring it lets the archive misrepresent
		// file lengths.
		const paxPayload = Buffer.from("12 size=999\n", "ascii");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload),
			buildTarEntry("repo-main/readme.txt", 0x30, Buffer.from("ok")),
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/PAX global header key "size"/);
	});

	it("throws on an unknown PAX global header key (fail loud rather than guess)", () => {
		// Anything outside the allowlist is rejected so unfamiliar tarball
		// sources can't slip past the allowlist with a key we haven't
		// reasoned about.
		const paxPayload = Buffer.from("11 foo=bar\n", "ascii");
		const tar = buildTar([
			buildTarEntry("pax_global_header", 0x67, paxPayload),
			buildTarEntry("repo-main/readme.txt", 0x30, Buffer.from("ok")),
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/PAX global header key "foo"/);
	});

	it("throws on symlink typeflag '2'", () => {
		const tar = buildTar([
			buildTarEntry("link.txt", 0x32), // '2' = 0x32
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/Unsupported tar entry type '2'/);
	});

	it("throws on hardlink typeflag '1'", () => {
		const tar = buildTar([
			buildTarEntry("hardlink.txt", 0x31), // '1' = 0x31
		]);
		const gz = gzipSync(tar);

		expect(() => extractTarGz(gz)).toThrow(/Unsupported tar entry type '1'/);
	});

	it("handles two consecutive zero blocks as end-of-archive", () => {
		const data = Buffer.from("first", "utf-8");
		const entry = buildTarEntry("file.txt", 0x30, data);
		// After the entry, add two zero blocks then another entry that should be ignored
		const endMarker = Buffer.alloc(1024);
		const extraEntry = buildTarEntry("extra.txt", 0x30, Buffer.from("extra"));
		const tar = Buffer.concat([entry, endMarker, extraEntry]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe("file.txt");
	});

	it("skips a single zero block mid-archive", () => {
		const entry1 = buildTarEntry("a.txt", 0x30, Buffer.from("aaa"));
		const zeroBlock = Buffer.alloc(512);
		const entry2 = buildTarEntry("b.txt", 0x30, Buffer.from("bbb"));
		const endMarker = Buffer.alloc(1024);
		const tar = Buffer.concat([entry1, zeroBlock, entry2, endMarker]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(2);
		expect(entries[0].path).toBe("a.txt");
		expect(entries[1].path).toBe("b.txt");
	});

	it("handles files with data spanning multiple 512-byte blocks", () => {
		const largeData = Buffer.alloc(1500, 0x42); // 'B' repeated, spans 3 blocks
		const tar = buildTar([buildTarEntry("large.bin", 0x30, largeData)]);
		const gz = gzipSync(tar);

		const entries = extractTarGz(gz);
		expect(entries).toHaveLength(1);
		expect(entries[0].data).toEqual(largeData);
	});
});

describe("downloadTheme path-traversal guard", () => {
	// We test the guard logic inline since downloadTheme hits the network.
	// The guard: dest !== destDir && !dest.startsWith(destDir + sep)

	it("rejects sibling-prefix paths", () => {
		const { normalize, join, sep } = require("node:path");
		// Normalize the base so the separators match the host platform —
		// otherwise `destDir + sep` mixes `/` and `\` on Windows and the
		// startsWith check below spuriously fails.
		const destDir = normalize("/Users/x/.jolli/themes/foo");
		const destDirWithSep = destDir + sep;

		// Sibling "foobar" shares the "foo" prefix but is a different directory
		const siblingPath = normalize(join(destDir, "../foobar/evil.txt"));
		expect(siblingPath.startsWith(destDirWithSep)).toBe(false);
		expect(siblingPath).not.toBe(destDir);

		// Legitimate child path should pass
		const childPath = normalize(join(destDir, "styles/main.css"));
		expect(childPath.startsWith(destDirWithSep)).toBe(true);
	});

	it("rejects parent traversal paths", () => {
		const { normalize, join, sep } = require("node:path");
		const destDir = normalize("/Users/x/.jolli/themes/foo");
		const destDirWithSep = destDir + sep;

		const traversal = normalize(join(destDir, "../../etc/passwd"));
		expect(traversal.startsWith(destDirWithSep)).toBe(false);
		expect(traversal).not.toBe(destDir);
	});
});
