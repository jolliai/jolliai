/**
 * Template utilities — code-generated files that need conditional logic,
 * and variable substitution for template placeholders.
 */

export type Theme = "docs" | "blog";
export type Template = "minimal" | "starter";

/**
 * Substitutes `{{VAR_NAME}}` placeholders in template content.
 */
export function substituteVars(content: string, vars: Record<string, string>): string {
	let result = content;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

/**
 * Generates package.json — stays as code because it has conditional
 * dependencies based on theme and template.
 */
export function generatePackageJson(name: string, theme: Theme, template: Template = "minimal"): string {
	const themePackage = theme === "docs" ? "nextra-theme-docs" : "nextra-theme-blog";
	const dependencies: Record<string, string> = {
		next: "^16.2.4",
		nextra: "^4.6.1",
		[themePackage]: "^4.6.1",
		react: "^19.1.0",
		"react-dom": "^19.1.0",
	};
	if (template === "starter") {
		dependencies["next-themes"] = "^0.4.4";
	}
	const pkg = {
		name,
		private: true,
		type: "module",
		scripts: {
			dev: "next dev --webpack",
			build: "next build --webpack && pagefind --site .next/server/app --output-path public/_pagefind",
			start: "next start",
		},
		dependencies,
		devDependencies: {
			"@types/node": "^22.0.0",
			"@types/react": "^19.0.0",
			pagefind: "^1.3.0",
			typescript: "^5.0.0",
		},
	};
	return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Generates next.config.mjs — stays as code because blog theme adds
 * extra options (readingTime).
 */
export function generateNextConfig(theme: Theme): string {
	const extraOptions = theme === "blog" ? "\n\treadingTime: true," : "";
	return `import nextra from "nextra"

const withNextra = nextra({
\tmdxOptions: {
\t\tformat: "detect",
\t},${extraOptions}
})

export default withNextra({
\treactStrictMode: true,
})
`;
}
