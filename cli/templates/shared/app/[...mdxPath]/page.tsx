import { generateStaticParamsFor, importPage } from "nextra/pages"
import { useMDXComponents } from "../../mdx-components"

export const generateStaticParams = generateStaticParamsFor("mdxPath")

export async function generateMetadata(props) {
	const params = await props.params
	const { metadata } = await importPage(params.mdxPath)
	return metadata
}

export default async function Page(props) {
	const params = await props.params
	const { default: MDXContent, toc, metadata } = await importPage(params.mdxPath)
	const Wrapper = useMDXComponents({}).wrapper

	return (
		<Wrapper toc={toc} metadata={metadata}>
			<MDXContent />
		</Wrapper>
	)
}
