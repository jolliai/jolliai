import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyOptionalFlags,
	attributeUnsupportedFlag,
	flagStoreKey,
	loadUnsupportedFlagIds,
	type OptionalFlag,
	recordUnsupportedFlagIds,
	UNSUPPORTED_FLAGS_FILE,
	UNSUPPORTED_FLAGS_VERSION,
} from "./OptionalFlags.js";

/**
 * Real failure text, captured by running each CLI with a bogus flag. These are
 * the whole reason attribution cannot be one shared regex — three arg parsers,
 * three phrasings, two exit codes, and one CLI that names nothing at all.
 */
const REAL_STDERR = {
	// claude 2.1.220 (commander), exit 1
	claude: "Local agent exited with code 1. error: unknown option '--disable-slash-commands'",
	// codex 0.146.0-alpha.3 (clap), exit 2 — note "unexpected argument", not "unknown option"
	codexUnknownFlag: "Local agent exited with code 2. error: unexpected argument '--disable' found",
	// codex 0.146.0-alpha.3, flag exists but the feature name does not, exit 1
	codexUnknownFeature: "Local agent exited with code 1. Error: Unknown feature flag: plugins",
	// opencode (yargs), exit 1 — the entire help text, naming nothing. This is the
	// 2 KB TAIL the runner keeps, i.e. what attribution actually sees: the
	// `Positionals:` header at the top is already truncated away.
	opencode:
		"Local agent exited with code 1.       --thinking     show thinking blocks                    [boolean]\n" +
		"  -i, --interactive  run in direct interactive split-footer mode   [boolean] [default: false]",
} as const;

const CLAUDE_FLAGS: readonly OptionalFlag[] = [
	{ id: "--strict-mcp-config", args: ["--strict-mcp-config"] },
	{ id: "--disable-slash-commands", args: ["--disable-slash-commands"] },
	{ id: "--setting-sources", args: ["--setting-sources", ""] },
];

describe("applyOptionalFlags", () => {
	it("expands every flag when nothing is disabled", () => {
		expect(applyOptionalFlags(CLAUDE_FLAGS, undefined)).toEqual([
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--setting-sources",
			"",
		]);
	});

	it("drops only the named flag, keeping the rest of the isolation", () => {
		// The whole point of per-flag granularity: one unsupported flag must not
		// cost the token savings the other two still provide.
		const out = applyOptionalFlags(CLAUDE_FLAGS, new Set(["--disable-slash-commands"]));
		expect(out).toEqual(["--strict-mcp-config", "--setting-sources", ""]);
	});

	it("drops a flag together with its value argument", () => {
		// `--setting-sources` carries a separate "" arg; leaving that behind would
		// feed an empty positional to the CLI.
		expect(applyOptionalFlags(CLAUDE_FLAGS, new Set(["--setting-sources"]))).toEqual([
			"--strict-mcp-config",
			"--disable-slash-commands",
		]);
	});

	it("yields nothing when all are disabled", () => {
		expect(applyOptionalFlags(CLAUDE_FLAGS, new Set(CLAUDE_FLAGS.map((f) => f.id)))).toEqual([]);
	});

	it("yields nothing for a backend with no optional flags", () => {
		expect(applyOptionalFlags([], undefined)).toEqual([]);
	});
});

describe("attributeUnsupportedFlag", () => {
	it("names the flag from claude's commander phrasing", () => {
		expect(attributeUnsupportedFlag(REAL_STDERR.claude, CLAUDE_FLAGS)?.flag.id).toBe("--disable-slash-commands");
	});

	// Mirrors CODEX_OPTIONAL_FLAGS. Both codex failures must reach the same flag.
	const codexFlags: OptionalFlag[] = [
		{ id: "--disable", args: ["--disable", "plugins"], matches: ["--disable", "Unknown feature flag: plugins"] },
	];

	it("names the flag from codex's clap phrasing", () => {
		const attribution = attributeUnsupportedFlag(REAL_STDERR.codexUnknownFlag, codexFlags);
		expect(attribution?.flag.id).toBe("--disable");
		expect(attribution?.matched).toBe("--disable");
	});

	it("names the flag from codex's unknown-FEATURE phrasing, which never writes the flag itself", () => {
		// `--disable` exists but the `plugins` feature does not — exit 1, and the
		// message contains no `--disable` anywhere. Matching the id alone misses a
		// failure whose remedy is identical, which is what `matches` exists for.
		expect(REAL_STDERR.codexUnknownFeature).not.toContain("--disable");
		const attribution = attributeUnsupportedFlag(REAL_STDERR.codexUnknownFeature, codexFlags);
		expect(attribution?.flag.id).toBe("--disable");
		// The reported evidence is what separates this from the clap case above: same
		// flag dropped, but "the flag is unknown" and "the feature is unknown" are
		// different diagnoses, and the log line is the only place that shows which.
		expect(attribution?.matched).toBe("Unknown feature flag: plugins");
	});

	it("does not indict the codex flag for an unrelated message mentioning plugins", () => {
		// Why `matches` carries the full phrase rather than the bare value.
		const message = "Local agent exited with code 1. error: unknown option '--load-plugins'";
		expect(attributeUnsupportedFlag(message, codexFlags)).toBeUndefined();
	});

	it("returns undefined for opencode, which names nothing — the wholesale-drop path", () => {
		const openCodeFlags: OptionalFlag[] = [{ id: "--pure", args: ["--pure"] }];
		expect(attributeUnsupportedFlag(REAL_STDERR.opencode, openCodeFlags)).toBeUndefined();
	});

	it("does not attribute a prefix flag to a longer flag's error", () => {
		// `--disable` is a prefix of `--disable-slash-commands`. A plain substring
		// test would blame codex's flag for claude's failure; the right-hand
		// boundary is what prevents it.
		const mixed: OptionalFlag[] = [{ id: "--disable", args: ["--disable", "plugins"] }];
		expect(attributeUnsupportedFlag(REAL_STDERR.claude, mixed)).toBeUndefined();
	});

	it("ignores a failure that is not about argument parsing", () => {
		// An unrelated crash that happens to quote a flag must not get it dropped:
		// degradation would be silent and permanent for that tool+version.
		const message = "Local agent exited with code 1. TypeError: cannot read '--strict-mcp-config' of undefined";
		expect(attributeUnsupportedFlag(message, CLAUDE_FLAGS)).toBeUndefined();
	});

	it("returns undefined when the named flag is not a candidate", () => {
		expect(attributeUnsupportedFlag("error: unknown option '--something-else'", CLAUDE_FLAGS)).toBeUndefined();
	});
});

describe("unsupported-flag store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-flagstore-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const read = () => JSON.parse(readFileSync(join(dir, UNSUPPORTED_FLAGS_FILE), "utf8"));

	it("reports nothing unsupported when no store exists", async () => {
		expect(await loadUnsupportedFlagIds("claude-code", "2.1.220", dir)).toEqual(new Set());
	});

	it("round-trips recorded ids for the same tool+version", async () => {
		await recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--disable-slash-commands"]), dir);
		expect(await loadUnsupportedFlagIds("claude-code", "2.0.30", dir)).toEqual(
			new Set(["--disable-slash-commands"]),
		);
	});

	it("scopes by version so upgrading the CLI re-enables the flags", () => {
		// The reason the key is versioned: without it, one old install would strand
		// the machine on a degraded invocation forever, including after the fix.
		expect(flagStoreKey("claude-code", "2.0.30")).not.toBe(flagStoreKey("claude-code", "2.1.220"));
	});

	it("does not report an older version's findings against a newer one", async () => {
		await recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--strict-mcp-config"]), dir);
		expect(await loadUnsupportedFlagIds("claude-code", "2.1.220", dir)).toEqual(new Set());
	});

	it("keeps tools separate", async () => {
		await recordUnsupportedFlagIds("codex", "0.140.0", new Set(["--disable"]), dir);
		expect(await loadUnsupportedFlagIds("opencode", "0.140.0", dir)).toEqual(new Set());
	});

	it("merges with what another run already recorded", async () => {
		// Two repos' workers can learn different flags concurrently; the second
		// write must not erase the first one's finding.
		await recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--strict-mcp-config"]), dir);
		await recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--setting-sources"]), dir);
		expect(await loadUnsupportedFlagIds("claude-code", "2.0.30", dir)).toEqual(
			new Set(["--strict-mcp-config", "--setting-sources"]),
		);
	});

	it("writes sorted ids and a version stamp so repeated writes are byte-stable", async () => {
		await recordUnsupportedFlagIds(
			"claude-code",
			"2.0.30",
			new Set(["--setting-sources", "--strict-mcp-config"]),
			dir,
		);
		const file = read();
		expect(file.version).toBe(UNSUPPORTED_FLAGS_VERSION);
		expect(file.tools["claude-code@2.0.30"]).toEqual(["--setting-sources", "--strict-mcp-config"]);
	});

	it("writes nothing when there is nothing to record", async () => {
		await recordUnsupportedFlagIds("claude-code", "2.1.220", new Set(), dir);
		expect(() => read()).toThrow();
	});

	it("treats a corrupt store as empty rather than failing the call", async () => {
		// This is an optimization cache; an unreadable one must degrade to
		// "retry the flags", never to a thrown error on the summary path.
		writeFileSync(join(dir, UNSUPPORTED_FLAGS_FILE), "{ not json");
		expect(await loadUnsupportedFlagIds("claude-code", "2.1.220", dir)).toEqual(new Set());
	});

	it("tolerates a store whose shape is wrong", async () => {
		writeFileSync(join(dir, UNSUPPORTED_FLAGS_FILE), JSON.stringify({ version: 1, tools: "not-an-object" }));
		expect(await loadUnsupportedFlagIds("claude-code", "2.1.220", dir)).toEqual(new Set());
	});

	it("ignores non-string entries inside a tool's list", async () => {
		writeFileSync(
			join(dir, UNSUPPORTED_FLAGS_FILE),
			JSON.stringify({ version: 1, tools: { "claude-code@2.1.220": ["--pure", 42, null] } }),
		);
		expect(await loadUnsupportedFlagIds("claude-code", "2.1.220", dir)).toEqual(new Set(["--pure"]));
	});

	it("recovers a corrupt store on the next write instead of propagating", async () => {
		writeFileSync(join(dir, UNSUPPORTED_FLAGS_FILE), "{ not json");
		await recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--pure"]), dir);
		expect(read().tools["claude-code@2.0.30"]).toEqual(["--pure"]);
	});

	it("never throws when the store cannot be written", async () => {
		// A failed write costs one extra probe next time; it must not fail the
		// summary that just succeeded.
		const unwritable = join(dir, "does", "not", "exist");
		await expect(
			recordUnsupportedFlagIds("claude-code", "2.0.30", new Set(["--pure"]), unwritable),
		).resolves.toBeUndefined();
	});
});
