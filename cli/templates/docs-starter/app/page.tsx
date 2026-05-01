import { importPage } from "nextra/pages"
import { useMDXComponents } from "../mdx-components"

export default async function RootPage() {
	const { default: MDXContent, toc, metadata } = await importPage([])
	const Wrapper = useMDXComponents({}).wrapper

	return (
		<Wrapper toc={toc} metadata={metadata}>
			<MDXContent />
		</Wrapper>
	)
}
