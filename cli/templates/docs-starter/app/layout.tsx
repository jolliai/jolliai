import { Footer, Layout, Navbar } from "nextra-theme-docs"
import { Head } from "nextra/components"
import { getPageMap } from "nextra/page-map"
import "nextra-theme-docs/style.css"

export const metadata = {
	title: {
		default: "{{PROJECT_NAME}}",
		template: "%s — {{PROJECT_NAME}}",
	},
	description: "{{PROJECT_NAME}} — powered by Jolli",
}

const logo = (
	<span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
		<img src="/favicon.svg" alt="" width={24} height={24} />
		<b>{{PROJECT_NAME}}</b>
	</span>
)

export default async function RootLayout({ children }) {
	return (
		<html lang="en" dir="ltr" suppressHydrationWarning>
			<Head>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
			</Head>
			<body>
				<Layout
					navbar={<Navbar logo={logo} />}
					pageMap={await getPageMap()}
					footer={<Footer>MIT {new Date().getFullYear()} © Jolli.</Footer>}
					editLink={null}
					feedback={{ content: null }}
					sidebar={{ defaultMenuCollapseLevel: 2 }}
					toc={{ title: "On This Page" }}
				>
					{children}
				</Layout>
			</body>
		</html>
	)
}
