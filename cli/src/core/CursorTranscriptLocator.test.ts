import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCursorHomeDir,
	getCursorProjectsDir,
	isCursorJsonlTranscript,
	listCursorProjectBuckets,
	resolveCursorTranscriptPath,
} from "./CursorTranscriptLocator.js";

let root: string;
let projectsDir: string;

/** Creates `projects/<bucket>/agent-transcripts/<uuid>/<uuid>.jsonl`. */
async function plant(bucket: string, uuid: string): Promise<string> {
	const dir = join(projectsDir, bucket, "agent-transcripts", uuid);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${uuid}.jsonl`);
	await writeFile(path, "{}\n");
	return path;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "cursor-locator-"));
	projectsDir = join(root, "projects");
	await mkdir(projectsDir, { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("path helpers", () => {
	it("roots both directories at ~/.cursor on every platform", () => {
		expect(getCursorHomeDir("/home/dev")).toBe(join("/home/dev", ".cursor"));
		expect(getCursorProjectsDir("/home/dev")).toBe(join("/home/dev", ".cursor", "projects"));
	});

	it("recognises a JSONL transcript path but not a synthetic store handle", () => {
		expect(isCursorJsonlTranscript("/x/agent-transcripts/a/a.jsonl")).toBe(true);
		// The shape the composer source carries when no JSONL exists.
		expect(isCursorJsonlTranscript("/x/state.vscdb#composer-1")).toBe(false);
	});
});

describe("listCursorProjectBuckets", () => {
	it("lists the buckets", async () => {
		await plant("bucket-a", "uuid-1");
		expect(await listCursorProjectBuckets(projectsDir)).toEqual(["bucket-a"]);
	});

	it("returns [] for a MISSING directory — benign, no transcript written yet", async () => {
		expect(await listCursorProjectBuckets(join(root, "nope"))).toEqual([]);
	});

	it("returns undefined for any other failure, so a caller can report a real fault", async () => {
		// A FILE where the directory should be: ENOTDIR, not ENOENT. `[]` here would
		// read as "the store was listed and holds nothing", which is the absence-vs-empty
		// distinction the session registry depends on.
		const asFile = join(root, "is-a-file");
		await writeFile(asFile, "x");
		expect(await listCursorProjectBuckets(asFile)).toBeUndefined();
	});
});

describe("resolveCursorTranscriptPath", () => {
	it("finds a transcript by uuid across buckets and reports which bucket held it", async () => {
		await plant("bucket-a", "uuid-1");
		const want = await plant("bucket-b", "uuid-2");
		expect(await resolveCursorTranscriptPath(projectsDir, ["bucket-a", "bucket-b"], "uuid-2")).toEqual({
			path: want,
			bucket: "bucket-b",
		});
	});

	it("tries the preferred bucket first", async () => {
		const want = await plant("bucket-b", "uuid-2");
		// `bucket-a` is not even listed, so a hit can only come from the preference.
		expect(await resolveCursorTranscriptPath(projectsDir, [], "uuid-2", "bucket-b")).toEqual({
			path: want,
			bucket: "bucket-b",
		});
	});

	it("falls through to the full sweep when the preferred bucket misses", async () => {
		const want = await plant("bucket-b", "uuid-2");
		expect(await resolveCursorTranscriptPath(projectsDir, ["bucket-b"], "uuid-2", "stale-bucket")).toEqual({
			path: want,
			bucket: "bucket-b",
		});
	});

	it("answers undefined for a uuid with no transcript", async () => {
		await plant("bucket-a", "uuid-1");
		expect(await resolveCursorTranscriptPath(projectsDir, ["bucket-a"], "uuid-absent")).toBeUndefined();
	});

	it("does not accept a DIRECTORY at the transcript path", async () => {
		// `<uuid>/<uuid>.jsonl` exists as a directory: `stat` succeeds, `isFile` does not.
		await mkdir(join(projectsDir, "b", "agent-transcripts", "u", "u.jsonl"), { recursive: true });
		expect(await resolveCursorTranscriptPath(projectsDir, ["b"], "u")).toBeUndefined();
	});
});
