import { Footer, Layout, Navbar } from "nextra-theme-docs"
import { Head } from "nextra/components"
import { getPageMap } from "nextra/page-map"
import "nextra-theme-docs/style.css"

export const metadata = {
	title: "{{PROJECT_NAME}}",
	description: "{{PROJECT_NAME}} — powered by Nextra",
}

export default async function RootLayout({ children }) {
	return (
		<html lang="en" dir="ltr" suppressHydrationWarning>
			<Head />
			<body>
				<Layout
					navbar={<Navbar logo={<b>{{PROJECT_NAME}}</b>} />}
					pageMap={await getPageMap()}
					footer={<Footer>MIT {new Date().getFullYear()} © {{PROJECT_NAME}}.</Footer>}
				>
					{children}
				</Layout>
			</body>
		</html>
	)
}
