import { describe, expect, it } from "vitest";

import {
	decodePreviewRef,
	encodePreviewRef,
	sanitizeTitleForUriPath,
} from "./PreviewUri.js";

describe("sanitizeTitleForUriPath", () => {
	it("replaces path- and fragment-significant characters", () => {
		// `#` would be parsed as a URI fragment and truncate the name; `/` and `:`
		// would fabricate path segments.
		expect(sanitizeTitleForUriPath('feat/thing: #12 "quoted" <b>|{x}')).toBe(
			"feat-thing- -12 -quoted- -b---x-",
		);
	});

	it("truncates to 80 characters", () => {
		expect(sanitizeTitleForUriPath("x".repeat(200))).toBe("x".repeat(80));
	});

	it("leaves an ordinary title untouched", () => {
		expect(sanitizeTitleForUriPath("Skills used — uncommitted")).toBe(
			"Skills used — uncommitted",
		);
	});
});

describe("encodePreviewRef / decodePreviewRef", () => {
	it("round-trips a multi-field ref", () => {
		const query = encodePreviewRef({
			ns: "reference",
			source: "linear",
			id: "linear:PROJ-1-aaaaaaaa",
		});

		expect(decodePreviewRef(query)).toEqual({
			ns: "reference",
			source: "linear",
			id: "linear:PROJ-1-aaaaaaaa",
		});
	});

	it("survives the percent-decode Uri.parse performs when restoring a tab", () => {
		// This is the whole reason the payload is base64url rather than
		// percent-encoded params: VS Code decodes the query once when it
		// reconstructs a Uri from its string form (window reload, preview tab
		// restore). A percent-encoded `&` inside a value would decode back into a
		// real separator there and split one param into two.
		const query = encodePreviewRef({ ns: "reference", id: "a&b=c d" });

		expect(decodePreviewRef(decodeURIComponent(query))).toEqual({
			ns: "reference",
			id: "a&b=c d",
		});
	});

	it("emits a query whose payload needs no percent-encoding at all", () => {
		// base64url's alphabet (A-Za-z0-9-_) plus the `ref=` key — nothing here is
		// touched by either percent-encoding or form-urlencoded space handling.
		expect(encodePreviewRef({ ns: "reference", id: "a&b=c d" })).toMatch(
			/^ref=[A-Za-z0-9\-_]+$/,
		);
	});

	it("orders keys so the same ref always yields the same cache key", () => {
		// The query string doubles as the body-cache key, so two spellings of the
		// same ref must not produce two cache entries (and two provider misses).
		expect(encodePreviewRef({ source: "linear", ns: "reference" })).toBe(
			encodePreviewRef({ ns: "reference", source: "linear" }),
		);
	});

	it("omits undefined values rather than encoding the string 'undefined'", () => {
		expect(decodePreviewRef(encodePreviewRef({ ns: "skills", repo: undefined }))).toEqual({
			ns: "skills",
		});
	});

	it("returns undefined for a query with no ref param", () => {
		expect(decodePreviewRef("")).toBeUndefined();
	});

	it("returns undefined for a ref that is not valid base64url JSON", () => {
		// Reachable via a hand-typed or truncated URI; must not throw inside the
		// content provider.
		expect(decodePreviewRef("ref=not-base64-json")).toBeUndefined();
	});

	it("returns undefined for a payload that decodes to a non-object", () => {
		const query = `ref=${Buffer.from('"a string"').toString("base64url")}`;

		expect(decodePreviewRef(query)).toBeUndefined();
	});
});
