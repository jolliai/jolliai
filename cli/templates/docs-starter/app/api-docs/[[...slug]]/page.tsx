import { redirect, notFound } from "next/navigation"
import ApiReference from "../../../components/ApiReference"

const VALID_SLUGS = ["petstore"]

export function generateStaticParams() {
	return [{ slug: [] }, { slug: ["petstore"] }]
}

export default async function ApiDocsPage(props) {
	const params = await props.params
	const slugArray = params.slug || []

	if (slugArray.length === 0) {
		redirect("/api-docs/petstore")
	}

	const slug = slugArray[0]
	if (!VALID_SLUGS.includes(slug)) {
		notFound()
	}

	return <ApiReference slug={slug} />
}
