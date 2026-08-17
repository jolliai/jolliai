import { describe, expect, it } from "vitest";
import { splitSkillId } from "./SkillId.js";

/**
 * The module exists because two scanners owned copies of this grammar and had already
 * drifted, so the cases that matter are the ones the two copies disagreed about — the
 * degenerate colons — not the happy path.
 *
 * Worth pinning rather than obvious: the return shape is what keys a registry row
 * (`<source>:<skill>`), so an id that folds to an empty `skill` keys a row on the source
 * alone and collides with every other such id from that source.
 */
describe("splitSkillId", () => {
	it("splits a namespaced id into its two halves", () => {
		expect(splitSkillId("documents:documents")).toEqual({ plugin: "documents", skill: "documents" });
	});

	it("returns an unnamespaced id whole, with no plugin key at all", () => {
		// Absent rather than `undefined`: `SkillStore`'s merge is `use.plugin ?? prior?.plugin`,
		// and a spread of an explicit `undefined` would still create the key.
		expect(splitSkillId("review")).toEqual({ skill: "review" });
		expect(splitSkillId("review")).not.toHaveProperty("plugin");
	});

	it("keeps a TRAILING colon's id whole rather than reporting a namespace that names nothing", () => {
		// The one case the two copies disagreed about, and the deliberate change on the Claude
		// side: `foo:` used to report `plugin: "foo"` with an empty skill name. Empty is the
		// harmful half — it keys the registry row on the source alone.
		expect(splitSkillId("foo:")).toEqual({ skill: "foo:" });
	});

	it("keeps a LEADING colon's id whole, since nothing precedes it to be a namespace", () => {
		expect(splitSkillId(":review")).toEqual({ skill: ":review" });
	});

	it("splits on the FIRST colon, leaving any others inside the skill name", () => {
		// Not a `split(":")`: the namespace is one segment and the remainder is the name, so a
		// second colon belongs to the name rather than starting a third field.
		expect(splitSkillId("a:b:c")).toEqual({ plugin: "a", skill: "b:c" });
	});

	it("returns the empty id unchanged", () => {
		expect(splitSkillId("")).toEqual({ skill: "" });
	});
});
