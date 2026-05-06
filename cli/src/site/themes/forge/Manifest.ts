/**
 * Forge theme pack manifest — declares the pack's identity and the defaults
 * applied when a customer-overridable field on `theme` (in `site.json`) is
 * absent.
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
