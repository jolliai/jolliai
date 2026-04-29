import { useMDXComponents as getBlogMDXComponents } from "nextra-theme-blog"

const blogComponents = getBlogMDXComponents()

export function useMDXComponents(components) {
	return {
		...blogComponents,
		...components,
	}
}
