import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "./TraceContext.js";

export interface LiveSharePayload {
	readonly repoUrl: string;
	readonly repoName: string;
	readonly branch: string;
	readonly kind: string;
	readonly visibility: string;
	readonly decisionCount: number;
	readonly headCommitHash: string;
	readonly commitHashes: readonly string[];
	readonly branchSlug?: string;
	readonly ref: unknown;
	readonly recipients?: readonly string[];
}

export interface LiveShareResult {
	readonly shareId: string;
	readonly shareUrl: string;
	readonly expiresAt: string;
	readonly visibility: string;
	readonly token?: string;
	readonly recipients?: readonly string[];
}

export interface LiveSharePatch {
	readonly visibility?: string;
	readonly expiresAt?: string;
	readonly ref?: unknown;
	readonly recipients?: readonly string[];
}

export interface LiveShareUpdateResult {
	readonly shareId?: string;
	readonly shareUrl?: string;
	readonly expiresAt?: string;
	readonly visibility?: string;
	readonly token?: string;
	readonly recipients?: readonly string[];
}

export class ShareRevokedError extends Error {
	constructor(message = "This share has been stopped.") {
		super(message);
		this.name = "ShareRevokedError";
	}
}

type JsonObject = Record<string, unknown>;

function stringValue(json: JsonObject, key: string): string | undefined {
	return typeof json[key] === "string" ? json[key] : undefined;
}

function identifierValue(json: JsonObject, key: string): string | undefined {
	const value = json[key];
	if (typeof value === "string") return value;
	return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function stringList(json: JsonObject, key: string): string[] | undefined {
	const value = json[key];
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function errorMessage(status: number, json: JsonObject | undefined, raw: string): string {
	const detail = [json && stringValue(json, "error"), json && stringValue(json, "message")]
		.filter((value): value is string => Boolean(value))
		.join(" — ");
	return `${detail || "request failed"} (HTTP ${status})${json ? "" : `: ${raw.slice(0, 200)}`}`;
}

export class JolliShareClient {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrlOverride?: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async create(payload: LiveSharePayload): Promise<LiveShareResult> {
		const { status, json, raw } = await this.request("POST", "/api/share/branch", payload);
		if (status >= 200 && status < 300) {
			const shareId = json && identifierValue(json, "shareId");
			const shareUrl = json && stringValue(json, "shareUrl");
			if (!shareId || !shareUrl) {
				throw new Error(
					`Share endpoint returned an unexpected response (missing shareId/shareUrl). HTTP ${status}: ${raw.slice(0, 300)}`,
				);
			}
			return {
				shareId,
				shareUrl,
				expiresAt: stringValue(json, "expiresAt") ?? "",
				visibility: stringValue(json, "visibility") ?? payload.visibility,
				...(stringValue(json, "token") ? { token: stringValue(json, "token") } : {}),
				...(stringList(json, "recipients") ? { recipients: stringList(json, "recipients") } : {}),
			};
		}
		throw this.toError(status, json, raw);
	}

	async update(shareId: string, patch: LiveSharePatch): Promise<LiveShareUpdateResult> {
		const { status, json, raw } = await this.request(
			"PATCH",
			`/api/share/branch/${encodeURIComponent(shareId)}`,
			patch,
		);
		if (status >= 200 && status < 300 && json) {
			const responseShareId = identifierValue(json, "shareId");
			return {
				...(responseShareId ? { shareId: responseShareId } : {}),
				...(stringValue(json, "shareUrl") ? { shareUrl: stringValue(json, "shareUrl") } : {}),
				...(stringValue(json, "expiresAt") ? { expiresAt: stringValue(json, "expiresAt") } : {}),
				...(stringValue(json, "visibility") ? { visibility: stringValue(json, "visibility") } : {}),
				...(stringValue(json, "token") ? { token: stringValue(json, "token") } : {}),
				...(stringList(json, "recipients") ? { recipients: stringList(json, "recipients") } : {}),
			};
		}
		throw this.toError(status, json, raw);
	}

	async revoke(shareId: string): Promise<void> {
		const { status, json, raw } = await this.request("DELETE", `/api/share/branch/${encodeURIComponent(shareId)}`);
		if (status === 200 || status === 204 || status === 404) return;
		throw this.toError(status, json, raw);
	}

	async invite(
		shareId: string,
		recipients: readonly string[],
		message?: string,
	): Promise<{ sent: string[]; failed: string[] }> {
		const { status, json, raw } = await this.request(
			"POST",
			`/api/share/branch/${encodeURIComponent(shareId)}/invite`,
			{
				recipients,
				...(message ? { message } : {}),
			},
		);
		if (status >= 200 && status < 300) {
			return {
				sent: (json && stringList(json, "sent")) ?? [],
				failed: (json && stringList(json, "failed")) ?? [],
			};
		}
		throw this.toError(status, json, raw);
	}

	async listOrgMembers(): Promise<Array<{ name: string; email: string }>> {
		try {
			const { status, json } = await this.request("GET", "/api/jolli-memory/org-members");
			if (status < 200 || status >= 300 || !json || !Array.isArray(json.members)) return [];
			return json.members.flatMap((row) => {
				if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
				const member = row as JsonObject;
				const email = stringValue(member, "email")?.trim();
				return email ? [{ name: stringValue(member, "name") ?? "", email }] : [];
			});
		} catch {
			return [];
		}
	}

	private resolveBaseUrl(): string {
		const baseUrl = this.baseUrlOverride ?? parseJolliApiKey(this.apiKey)?.u;
		if (!baseUrl)
			throw new Error(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again.",
			);
		return baseUrl;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; json?: JsonObject; raw: string }> {
		const baseUrl = this.resolveBaseUrl();
		const parsed = parseBaseUrl(baseUrl);
		const keyMeta = parseJolliApiKey(this.apiKey);
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.apiKey}`,
			"x-jolli-client": JOLLI_CLIENT_HEADER,
			[TRACE_HEADER_NAME]: currentTraceHeader() ?? newTraceHeader(),
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (parsed.tenantSlug) headers["x-tenant-slug"] = parsed.tenantSlug;
		if (keyMeta?.o) headers["x-org-slug"] = keyMeta.o;
		const response = await this.fetchImpl(new URL(path, parsed.origin), {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(method === "DELETE" || method === "GET" ? 30_000 : 60_000),
		});
		const raw = await response.text();
		let json: JsonObject | undefined;
		try {
			const parsedBody: unknown = raw ? JSON.parse(raw) : undefined;
			if (typeof parsedBody === "object" && parsedBody !== null && !Array.isArray(parsedBody))
				json = parsedBody as JsonObject;
		} catch {
			// The status mapper includes a bounded raw response when JSON is malformed.
		}
		return { status: response.status, json, raw };
	}

	private toError(status: number, json: JsonObject | undefined, raw: string): Error {
		if (status === 410 || json?.revoked === true) return new ShareRevokedError();
		if (status === 426) {
			const error = new Error(stringValue(json ?? {}, "message") ?? "Client outdated — update Jolli Memory.");
			error.name = "ClientOutdatedError";
			return error;
		}
		return new Error(errorMessage(status, json, raw));
	}
}
