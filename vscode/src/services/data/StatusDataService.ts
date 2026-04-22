/**
 * StatusDataService — pure derivations for the Status panel.
 *
 * Currently the status provider renders rows directly from bridge data; the
 * interesting derivations are small enough to fit here without an elaborate
 * snapshot shape. Kept as a namespace of static helpers for symmetry with the
 * other panels and to give the Store a place to route its data through.
 */

import type {
	JolliMemoryConfig,
	StatusInfo,
} from "../../../../cli/src/Types.js";

export interface StatusDerived {
	readonly hasApiKey: boolean;
	readonly signedIn: boolean;
	readonly allHooksInstalled: boolean;
	readonly hooksDescription: string;
}

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class StatusDataService {
	static derive(
		status: StatusInfo | null,
		config: JolliMemoryConfig | null,
	): StatusDerived {
		const parts: Array<string> = [];
		if (status?.gitHookInstalled) {
			parts.push("3 Git");
		}
		if (status?.claudeHookInstalled) {
			parts.push("2 Claude");
		}
		if (status?.geminiHookInstalled) {
			parts.push("1 Gemini CLI");
		}
		return {
			hasApiKey: !!config?.apiKey,
			signedIn: !!config?.authToken,
			allHooksInstalled: !!status?.gitHookInstalled,
			hooksDescription: parts.length > 0 ? parts.join(" + ") : "none installed",
		};
	}
}
