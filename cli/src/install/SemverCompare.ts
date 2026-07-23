import { coerce as semverCoerce, compare as semverCompare, valid as semverValid } from "semver";

/**
 * Compares runtime versions. Valid semver follows semver ordering, loose
 * numeric forms such as `1.0` are zero-filled, and non-numeric sentinels rank
 * below every numeric version.
 */
export function compareSemver(a: string, b: string): number {
	if (a.includes("-") || a.includes("+") || b.includes("-") || b.includes("+")) {
		const normalize = (version: string): string | null => {
			const exact = semverValid(version);
			if (exact) return exact;
			return /^\d+(\.\d+)*$/.test(version) ? (semverCoerce(version)?.version ?? null) : null;
		};
		const aSemver = normalize(a);
		const bSemver = normalize(b);
		if (aSemver && bSemver) return semverCompare(aSemver, bSemver);
		if (aSemver) return 1;
		if (bSemver) return -1;
	}

	const aValid = /^\d+(\.\d+)*$/.test(a);
	const bValid = /^\d+(\.\d+)*$/.test(b);
	if (!aValid && !bValid) return 0;
	if (!aValid) return -1;
	if (!bValid) return 1;

	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let index = 0; index < Math.max(aParts.length, bParts.length); index++) {
		const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}
