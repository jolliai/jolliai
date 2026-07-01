import { describe, expect, it } from "vitest";
import { buildShareCopyMessage, buildShareEmail, buildSocialShareUrl } from "./ShareMessage.js";

const BASE = { branch: "feature/sidebar", url: "https://acme.jolli.ai/b/x", decisionCount: 4 };

describe("buildShareEmail", () => {
	it("teases the branch, decision count, and decision titles", () => {
		const { subject, body } = buildShareEmail({ ...BASE, titles: ["Add dark mode", "Cache results"] });
		expect(subject).toBe('How we built "feature/sidebar" — 4 decisions on Jolli Memory');
		expect(body).toContain("4 decisions");
		expect(body).toContain("• Add dark mode");
		expect(body).toContain("• Cache results");
		expect(body).toContain(BASE.url);
		expect(body).toContain("no login, no install");
	});

	it("singularizes one decision and omits the bullet list when there are no titles", () => {
		const { subject, body } = buildShareEmail({ ...BASE, decisionCount: 1, titles: [] });
		expect(subject).toContain("1 decision on Jolli Memory");
		expect(body).not.toContain("A few of the decisions inside:");
		expect(body).toContain(BASE.url);
	});
});

describe("buildShareCopyMessage", () => {
	it("includes up to two teaser titles and the link", () => {
		const msg = buildShareCopyMessage({ ...BASE, titles: ["Add dark mode", "Cache results", "Third"] });
		expect(msg).toContain("feature/sidebar");
		expect(msg).toContain("4 decisions");
		expect(msg).toContain("Add dark mode");
		expect(msg).toContain("Cache results");
		expect(msg).not.toContain("Third"); // capped at 2
		expect(msg).toContain(BASE.url);
	});

	it("drops the 'incl.' clause when there are no titles", () => {
		const msg = buildShareCopyMessage({ ...BASE, titles: [] });
		expect(msg).not.toContain("incl.");
		expect(msg).toContain("4 decisions");
		expect(msg).toContain(BASE.url);
	});
});

describe("buildSocialShareUrl", () => {
	const input = {
		branch: "feature/x",
		url: "https://acme.jolli.ai/b/abc",
		decisionCount: 4,
		titles: ["Drop Redux for signals", "Cache at the edge"],
	};
	const enc = encodeURIComponent(input.url);

	it("X copy is punchy and teases concrete decisions (no emoji crutch)", () => {
		const u = buildSocialShareUrl("x", input);
		expect(u).toContain("https://twitter.com/intent/tweet?text=");
		expect(u).toContain(`url=${enc}`);
		const text = decodeURIComponent(u);
		expect(text).toContain("Drop Redux for signals");
		expect(text).toContain("not just the diff");
		expect(text).not.toContain("👀");
	});

	it("LinkedIn carries only the URL (it renders from OG tags)", () => {
		expect(buildSocialShareUrl("linkedin", input)).toBe(
			`https://www.linkedin.com/sharing/share-offsite/?url=${enc}`,
		);
	});

	it("Reddit gets a title-style headline", () => {
		const u = buildSocialShareUrl("reddit", input);
		expect(u).toContain("https://www.reddit.com/submit?url=");
		expect(decodeURIComponent(u)).toContain("feature/x: 4 decisions");
	});

	it("WhatsApp copy is casual and embeds the URL", () => {
		const u = buildSocialShareUrl("whatsapp", input);
		expect(u).toContain("https://wa.me/?text=");
		expect(decodeURIComponent(u)).toContain(input.url);
		expect(decodeURIComponent(u)).toContain("How we built feature/x");
	});

	it("Telegram passes url + text separately", () => {
		const u = buildSocialShareUrl("telegram", input);
		expect(u).toContain("https://t.me/share/url?url=");
		expect(u).toContain(enc);
		expect(u).toContain("text=");
	});

	it("omits the 'incl.' teaser when there are no titles", () => {
		const u = buildSocialShareUrl("x", { ...input, titles: [] });
		expect(decodeURIComponent(u)).not.toContain("incl.");
	});

	it("commit-kind copy leads with 'A commit on' across platforms", () => {
		expect(decodeURIComponent(buildSocialShareUrl("x", { ...input, kind: "commit" }))).toContain(
			"A commit on feature/x",
		);
		expect(decodeURIComponent(buildSocialShareUrl("reddit", { ...input, kind: "commit" }))).toContain(
			"A commit on feature/x: 4 decisions",
		);
		expect(decodeURIComponent(buildSocialShareUrl("whatsapp", { ...input, kind: "commit" }))).toContain(
			"A commit on feature/x",
		);
		expect(decodeURIComponent(buildSocialShareUrl("telegram", { ...input, kind: "commit" }))).toContain(
			"A commit on feature/x",
		);
	});
});

describe("commit-kind email + copy message", () => {
	it("email leads with 'A commit on' and reasons about a commit", () => {
		const { subject, body } = buildShareEmail({ ...BASE, titles: ["Add dark mode"], kind: "commit" });
		expect(subject).toBe('A commit on "feature/sidebar" — 4 decisions on Jolli Memory');
		expect(body).toContain("reasoning behind a commit");
	});

	it("copy message leads with 'A commit on'", () => {
		const msg = buildShareCopyMessage({ ...BASE, titles: [], kind: "commit" });
		expect(msg).toContain("A commit on feature/sidebar");
	});
});
