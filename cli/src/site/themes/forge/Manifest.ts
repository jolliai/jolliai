/**
 * Forge theme pack manifest — declares the pack's identity and the defaults
 * applied when a customer-overridable field on `theme` (in `site.json`) is
 * absent.
 *
 * Mirrors `FORGE_MANIFEST` from the SaaS Forge pack
 * (`tools/nextra-generator/src/themes/forge/Manifest.ts` in jolli.ai/jolli)
 * post-JOLLI-1392. Customer fields the CLI doesn't surface yet (e.g.
 * `requiredPackages` for SaaS deploy validation) are omitted — the CLI runs
 * `npm install` against the same `nextra-theme-docs` deps the default pack
 * already declares in `package.json`.
 */

import type { DefaultThemeMode, FontFamily } from "../../Types.js";

export const FORGE_MANIFEST = {
	name: "forge",
	displayName: "Forge",
	tagline: "Clean developer docs",
	defaults: {
		/** Default accent hue when `theme.primaryHue` is unset. */
		primaryHue: 228,
		/** Forge ships in light mode by default. */
		defaultTheme: "light" as DefaultThemeMode,
		/** Default body font when `theme.fontFamily` is unset. */
		fontFamily: "inter" as FontFamily,
	},
} as const;

export type ForgeManifest = typeof FORGE_MANIFEST;
