/**
 * ShareMessage
 *
 * Builds the human-facing share payloads (email subject/body, IM copy message)
 * for a branch share. Pure and content-teasing: the recipient should see *what*
 * is being shared and feel pulled to open it — the link is the hook, install is
 * the conversion (the growth loop). Kept dependency-free for easy testing.
 */

export interface ShareMessageInput {
	readonly branch: string;
	readonly url: string;
	readonly decisionCount: number;
	/** A few decision titles to tease (already trimmed to a sensible count). */
	readonly titles: ReadonlyArray<string>;
	/** "branch" (whole branch) or "commit" (single commit). Defaults to "branch". */
	readonly kind?: "branch" | "commit";
}

function decisionsLabel(n: number): string {
	return `${n} decision${n === 1 ? "" : "s"}`;
}

/** Leading phrase, kind-aware: "How we built X" (branch) vs "A commit on X" (commit). */
function lead(branch: string, kind: "branch" | "commit" | undefined, quoted = false): string {
	const name = quoted ? `"${branch}"` : branch;
	return kind === "commit" ? `A commit on ${name}` : `How we built ${name}`;
}

/** Email subject + body — the richer of the two, with a bulleted teaser. */
export function buildShareEmail(input: ShareMessageInput): { subject: string; body: string } {
	const decisions = decisionsLabel(input.decisionCount);
	const subject = `${lead(input.branch, input.kind, true)} — ${decisions} on Jolli Memory`;

	const intro =
		input.kind === "commit"
			? `Here's the reasoning behind a commit on the "${input.branch}" branch — ${decisions}, auto-captured as we built it.`
			: `Here's the full story behind the "${input.branch}" branch — ${decisions}, auto-captured as we built it.`;
	const lines: string[] = [intro, ""];
	if (input.titles.length > 0) {
		lines.push("A few of the decisions inside:");
		for (const t of input.titles) lines.push(`  • ${t}`);
		lines.push("");
	}
	lines.push(
		"Open the read-only view — no login, no install:",
		input.url,
		"",
		"You'll see the intent, the reasoning, and the trade-offs behind each change — not just the diff.",
		"",
		"— Shared via Jolli Memory",
	);
	return { subject, body: lines.join("\n") };
}

/** "incl. “A” & “B”" teaser clause from the first couple of decision titles. */
function inclClause(titles: ReadonlyArray<string>): string {
	const picked = titles
		.slice(0, 2)
		.map((t) => `“${t}”`)
		.join(" & ");
	return picked ? ` incl. ${picked}` : "";
}

/** Compact, concrete one-liner for pasting into Slack / IM (URL kept for unfurl). */
export function buildShareCopyMessage(input: ShareMessageInput): string {
	const decisions = decisionsLabel(input.decisionCount);
	return `${lead(input.branch, input.kind)} — ${decisions}${inclClause(input.titles)}. The reasoning, not just the diff — read-only, no login:\n${input.url}`;
}

/** Social platforms we offer a one-click share-intent for. */
export type SocialPlatform = "x" | "linkedin" | "reddit" | "whatsapp" | "telegram";

export interface SocialShareInput {
	readonly branch: string;
	readonly url: string;
	readonly decisionCount: number;
	/** Decision titles to tease (per-platform copy leads with the first couple). */
	readonly titles: ReadonlyArray<string>;
	/** "branch" (whole branch) or "commit" (single commit). Defaults to "branch". */
	readonly kind?: "branch" | "commit";
}

/**
 * Builds a public web-intent share URL for a social platform, with copy tailored
 * to each channel's voice (X punchy, Reddit title-style, WhatsApp/Telegram casual;
 * LinkedIn renders from the page's OG tags so it carries only the URL). No API
 * auth — the platform's compose screen opens pre-filled. Opened via openExternal.
 */
export function buildSocialShareUrl(platform: SocialPlatform, input: SocialShareInput): string {
	const decisions = decisionsLabel(input.decisionCount);
	const incl = inclClause(input.titles);
	const u = encodeURIComponent(input.url);
	switch (platform) {
		case "x": {
			const text = `${lead(input.branch, input.kind)}: ${decisions}${incl} — the reasoning behind each change, not just the diff.`;
			return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${u}`;
		}
		case "linkedin":
			// LinkedIn ignores text/title params now — it renders from the page's OG tags.
			return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
		case "reddit": {
			const subject = input.kind === "commit" ? `A commit on ${input.branch}` : input.branch;
			const title = `${subject}: ${decisions}${incl} — read-only dev memory (the reasoning, not just the diff)`;
			return `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(title)}`;
		}
		case "whatsapp": {
			const text = `${lead(input.branch, input.kind)} — ${decisions}${incl}. The reasoning, not just the diff (read-only, no login): ${input.url}`;
			return `https://wa.me/?text=${encodeURIComponent(text)}`;
		}
		case "telegram": {
			const text = `${lead(input.branch, input.kind)} — ${decisions}${incl}. The reasoning, not just the diff (read-only, no login).`;
			return `https://t.me/share/url?url=${u}&text=${encodeURIComponent(text)}`;
		}
	}
}
