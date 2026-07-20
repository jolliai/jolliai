import { describe, expect, it } from "vitest";
import { classifyCompileError } from "./CompileErrors.js";

/** Builds an Error with an attached HTTP `status`, mimicking an Anthropic SDK error. */
function httpError(status: number, message = "http"): Error {
	return Object.assign(new Error(message), { status });
}

/** Builds an Error with a specific `name`, mimicking the SDK's typed subclasses. */
function namedError(name: string, message = "named"): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

describe("classifyCompileError", () => {
	it("classifies non-Error inputs as internal", () => {
		expect(classifyCompileError("boom")).toBe("internal");
		expect(classifyCompileError(undefined)).toBe("internal");
		expect(classifyCompileError({ status: 429 })).toBe("internal"); // not an Error → status ignored
	});

	it("classifies by HTTP status (status wins over everything)", () => {
		expect(classifyCompileError(httpError(401))).toBe("auth");
		expect(classifyCompileError(httpError(403))).toBe("auth");
		expect(classifyCompileError(httpError(402))).toBe("quotaExhausted");
		expect(classifyCompileError(httpError(429))).toBe("rateLimit");
		expect(classifyCompileError(httpError(529))).toBe("overloaded");
		expect(classifyCompileError(httpError(500))).toBe("serverError");
		expect(classifyCompileError(httpError(503))).toBe("serverError");
	});

	it("does not misclassify non-mapped statuses (falls through to message/name/internal)", () => {
		expect(classifyCompileError(httpError(404, "nope"))).toBe("internal");
	});

	it("classifies by SDK error name when no status is present", () => {
		expect(classifyCompileError(namedError("AuthenticationError"))).toBe("auth");
		expect(classifyCompileError(namedError("PermissionDeniedError"))).toBe("auth");
		expect(classifyCompileError(namedError("RateLimitError"))).toBe("rateLimit");
		expect(classifyCompileError(namedError("APIConnectionError"))).toBe("network");
		expect(classifyCompileError(namedError("APIConnectionTimeoutError"))).toBe("network");
		expect(classifyCompileError(namedError("InternalServerError"))).toBe("serverError");
	});

	it("classifies a TimeoutError DOMException (AbortSignal.timeout) as network", () => {
		// AbortSignal.timeout() aborts with a DOMException named "TimeoutError" — a
		// wall-clock timeout with no HTTP response, i.e. a transport failure.
		expect(classifyCompileError(namedError("TimeoutError", "The operation timed out"))).toBe("network");
		// A real DOMException, if the runtime provides one, classifies the same way.
		if (typeof DOMException !== "undefined") {
			expect(classifyCompileError(new DOMException("timed out", "TimeoutError"))).toBe("network");
		}
	});

	it("classifies TypeError transport fingerprints as network", () => {
		expect(classifyCompileError(namedError("TypeError", "fetch failed"))).toBe("network");
		expect(classifyCompileError(namedError("TypeError", "network error"))).toBe("network");
		expect(classifyCompileError(namedError("TypeError", "request timeout"))).toBe("network");
		// A TypeError without a transport fingerprint is not network.
		expect(classifyCompileError(namedError("TypeError", "cannot read x"))).toBe("internal");
	});

	it("classifies raw socket-level messages as network", () => {
		for (const m of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "socket hang up"]) {
			expect(classifyCompileError(new Error(`connect ${m} 1.2.3.4:443`))).toBe("network");
		}
	});

	it("classifies CLI wrapper messages by pattern", () => {
		expect(classifyCompileError(new Error("API key invalid"))).toBe("auth");
		expect(classifyCompileError(new Error("Unauthorized: bad api key"))).toBe("auth");
		// "api key" alone (no invalid/unauthorized) is not enough.
		expect(classifyCompileError(new Error("your api key is fine"))).toBe("internal");
		expect(classifyCompileError(new Error("Rate limit exceeded"))).toBe("rateLimit");
		expect(classifyCompileError(new Error("insufficient credit"))).toBe("quotaExhausted");
		expect(classifyCompileError(new Error("insufficient quota remaining"))).toBe("quotaExhausted");
		expect(classifyCompileError(new Error("insufficient balance"))).toBe("quotaExhausted");
		// "insufficient" without a billing noun is not quotaExhausted.
		expect(classifyCompileError(new Error("insufficient permissions"))).toBe("internal");
		expect(classifyCompileError(new Error("No text content in API response"))).toBe("invalidResponse");
		expect(classifyCompileError(new Error("response was malformed"))).toBe("invalidResponse");
	});

	it("defaults to internal for an unrecognized error", () => {
		expect(classifyCompileError(new Error("something unexpected happened"))).toBe("internal");
	});
});
