import { Footer, Layout, Navbar, ThemeSwitch } from "nextra-theme-blog"
import { Head, Search } from "nextra/components"
import { getPageMap } from "nextra/page-map"
import "nextra-theme-blog/style.css"

export const metadata = {
	title: "{{PROJECT_NAME}}",
	description: "{{PROJECT_NAME}} — powered by Nextra",
}

export default async function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<Head />
			<body>
				<Layout>
					<Navbar pageMap={await getPageMap()}>
						<Search />
						<ThemeSwitch />
					</Navbar>
					{children}
					<Footer>
						MIT {new Date().getFullYear()} © {{PROJECT_NAME}}.
					</Footer>
				</Layout>
			</body>
		</html>
	)
}
