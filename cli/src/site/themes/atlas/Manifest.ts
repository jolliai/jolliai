/**
 * Atlas theme pack manifest — editorial handbook visual style.
 *
 * Designed to feel materially different from Forge so users have a real
 * reason to pick. Top-nav layout (vs Forge's sidebar-dominant), serif
 * headlines, dark-default mode, airy spacing, masthead-style footer.
 *
 * Mirrors `ATLAS_MANIFEST` from the SaaS Atlas pack
 * (`tools/nextra-generator/src/themes/atlas/Manifest.ts` in jolli.ai/jolli)
 * post-JOLLI-1392.
 */

import type { DefaultThemeMode, FontFamily } from "../../Types.js";

export const ATLAS_MANIFEST = {
	name: "atlas",
	displayName: "Atlas",
	tagline: "Editorial handbook",
	defaults: {
		/** Atlas leans cooler — neutral mid-blue when `theme.primaryHue` is unset. */
		primaryHue: 200,
		/** Editorial mood reads better at night; default dark, light is the warm cream variant. */
		defaultTheme: "dark" as DefaultThemeMode,
		/**
		 * Default body font — Source Serif 4 is the most decisive visual signal vs
		 * Forge. Customer can still override via `theme.fontFamily`.
		 */
		fontFamily: "source-serif" as FontFamily,
	},
} as const;

export type AtlasManifest = typeof ATLAS_MANIFEST;
