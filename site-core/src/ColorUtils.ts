/**
 * ColorUtils — hex-to-HSL conversion and accent colour resolution for
 * the site theme pipeline.
 */

import type { ThemeConfig } from "./Types.js";

/** Parsed HSL values (hue 0–360, saturation 0–100, lightness 0–100). */
export interface HslColor {
	h: number;
	s: number;
	l: number;
}

/**
 * Parses a hex colour string (`#RGB`, `#RRGGBB`, or without `#`) into
 * normalised 0–255 RGB components. Returns `undefined` for invalid input.
 */
function parseHex(hex: string): { r: number; g: number; b: number } | undefined {
	let h = hex.startsWith("#") ? hex.slice(1) : hex;
	if (h.length === 3) {
		h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	}
	if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
	return {
		r: Number.parseInt(h.slice(0, 2), 16),
		g: Number.parseInt(h.slice(2, 4), 16),
		b: Number.parseInt(h.slice(4, 6), 16),
	};
}

/** Converts a hex colour to HSL. Returns `undefined` for invalid input. */
export function hexToHsl(hex: string): HslColor | undefined {
	const rgb = parseHex(hex);
	if (!rgb) return undefined;

	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;

	if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };

	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;

	return {
		h: Math.round(h * 360),
		s: Math.round(s * 100),
		l: Math.round(l * 100),
	};
}

/** Resolved accent colour for a theme pack's CSS generator. */
export interface ResolvedAccent {
	hue: number;
	saturation: number;
	lightness: number;
	/** HSL for the light variant (hover/soft backgrounds). */
	light?: HslColor;
	/** HSL for the dark-mode variant. */
	dark?: HslColor;
}

/**
 * Resolves the accent colour from `ThemeConfig`, applying precedence:
 *   1. `theme.colors.primary` (hex → HSL)
 *   2. `theme.primaryColor` (hex → HSL)
 *   3. `theme.primaryHue` (deprecated; hue only, pack supplies S/L)
 *   4. `defaultHue` (pack default)
 *
 * When `colors.primary` or `primaryColor` is set, the full HSL triple
 * is extracted from the hex value.
 */
export function resolveAccent(
	theme: ThemeConfig | undefined,
	defaultHue: number,
	defaultSat: number,
	defaultLit: number,
): ResolvedAccent {
	const colors = theme?.colors;
	if (colors?.primary) {
		const primary = hexToHsl(colors.primary);
		if (primary) {
			return {
				hue: primary.h,
				saturation: primary.s,
				lightness: primary.l,
				light: colors.light ? hexToHsl(colors.light) : undefined,
				dark: colors.dark ? hexToHsl(colors.dark) : undefined,
			};
		}
	}

	if (theme?.primaryColor) {
		const primary = hexToHsl(theme.primaryColor);
		if (primary) {
			return { hue: primary.h, saturation: primary.s, lightness: primary.l };
		}
	}

	const hue = theme?.primaryHue ?? defaultHue;
	return { hue, saturation: defaultSat, lightness: defaultLit };
}
