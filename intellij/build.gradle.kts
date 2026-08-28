import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import java.util.zip.ZipEntry
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger
import org.jetbrains.changelog.Changelog

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.5.0"
    id("org.jetbrains.kotlinx.kover") version "0.9.1"
    id("org.jetbrains.changelog") version "2.2.1"
}

group = "ai.jolli"
version = "0.99.16"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        // JBR binaries repository so jetbrainsRuntime() can resolve — required for
        // JCEF (the commit-memory webview) when runIde isn't launched on a JBR.
        jetbrainsRuntime()
    }
}

dependencies {
    intellijPlatform {
        // 2025.1 is the minimum: the non-deprecated FileSaverDescriptor(title, description) +
        // withExtensionFilter API only exists from 2025.1 (2024.3 had only the vararg ctor that
        // 2025.1 deprecates), so building against 2025.1 lets us avoid the deprecated API.
        intellijIdeaCommunity("2025.1")
        bundledPlugin("com.intellij.java")
        bundledPlugin("Git4Idea")
        bundledPlugin("org.jetbrains.plugins.terminal")
        pluginVerifier()
        // Use the JetBrains Runtime for runIde/tests so JCEF is available — the
        // commit-memory panel renders via JBCefBrowser and otherwise falls back to
        // a raw-markdown text view (e.g. when launched on a plain Homebrew JDK).
        jetbrainsRuntime()
    }
    // Gson and kotlin-stdlib are compileOnly — IntelliJ bundles both at runtime.
    compileOnly("com.google.code.gson:gson:2.12.1")
    compileOnly("org.jetbrains.kotlin:kotlin-stdlib")
    implementation("org.xerial:sqlite-jdbc:3.49.1.0")
    // 5.12+ is required for junit.jupiter.extensions.autodetection.exclude — the
    // filter that keeps the IDE testFramework.jar's global JUnit extensions out
    // of this suite (see the test task's doFirst below).
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("io.mockk:mockk:1.13.16")
    testImplementation("io.kotest:kotest-assertions-core:5.9.1")
    testImplementation("org.xerial:sqlite-jdbc:3.49.1.0")
}

intellijPlatform {
    // This is a 100% Kotlin plugin: no .java sources and no GUI .form files, so the
    // IntelliJ NotNull/form bytecode instrumentation has nothing to process. Disabling
    // it skips the buggy `instrumentCode` Ant task, which in plugin 2.5.0 joins
    // classpath/srcdir with ":" — fine on Linux/macOS (CI), but on Windows ":" is the
    // drive separator, so it mis-parses absolute paths (e.g. C:\...\jdk\Packages) and
    // fails with "... does not exist". The produced artifact is identical to CI's.
    instrumentCode = false

    pluginConfiguration {
        id = "ai.jolli.jollimemory"
        name = "Jolli Memory"
        version = project.version.toString()
        description = """
            <p>
                <b>Every commit deserves a Memory. Every memory deserves a Recall.</b>
            </p>
            <p>
                <b>Jolli Memory</b> automatically turns your AI coding sessions into structured
                development documentation attached to every commit, without any extra effort.
            </p>
            <p>
                When you work with AI agents like <b>Claude Code</b>, <b>Codex</b>, <b>Gemini</b>,
                <b>Cursor</b>, <b>Copilot</b>, <b>Cline</b>, <b>Devin</b>, <b>OpenCode</b> or
                <b>Antigravity</b>,
                the reasoning behind every decision lives in the conversation &mdash;
                <em>why this approach was chosen, what alternatives were considered, what problems came up along the way</em>.
                The moment you commit, that context is gone. Jolli Memory captures it automatically.
            </p>

            <h3>How It Works</h3>
            <p>
                After each commit, Jolli Memory reads your AI session transcripts and the code diff,
                calls the LLM to produce a structured summary, and stores it alongside the commit
                silently in the background. Your commit returns instantly &mdash; the summary is generated
                in ~10&ndash;20 seconds.
            </p>
            <p>
                Every memory is written twice: to a git orphan branch that is completely separate from
                your code history, and to a <b>Memory Bank</b> folder on disk that keeps a plain-Markdown
                copy you can read, search, or feed to any other tool.
            </p>
            <p>
                <b>Requires Node.js 22.13+</b> on your PATH, which the plugin uses to drive its
                bundled Jolli CLI. That is the release where Node's built-in
                <code>node:sqlite</code> loads without an extra startup flag &mdash; the CLI reads
                AI session databases through it, and the git hooks the plugin installs deliberately
                pass no flags. Below that floor the tool window reports the versions it found and
                stays blocked until a newer Node is available.
            </p>

            <h3>Key Features</h3>
            <ul>
                <li><b>AI Commit</b> &mdash; generate commit messages from staged diffs using the Anthropic API.
                    Review and edit before committing, with support for commit, amend, and amend-keep-message modes</li>
                <li><b>Squash</b> &mdash; select two or more commits and squash them with an LLM-generated combined
                    message. The memories themselves are consolidated into one rich summary that preserves the
                    decision detail from every source commit, with a mechanical merge as the offline fallback</li>
                <li><b>Summary Viewer</b> &mdash; rich HTML viewer for each commit showing properties, AI summaries
                    (structured as <em>Why This Change &rarr; Decisions Behind the Code &rarr; What Was Implemented</em>),
                    E2E test guides, associated plans, and source commits</li>
                <li><b>Plans &amp; Notes</b> &mdash; auto-detect Claude Code plans from <code>~/.claude/plans/</code>,
                    import Markdown files, or write quick text snippets. Plans are archived with each commit</li>
                <li><b>E2E Test Generation</b> &mdash; AI-generated test scenarios with preconditions, steps, and
                    expected results, editable inline in the Summary Viewer</li>
                <li><b>Session Context Recall</b> &mdash; a lightweight briefing (~300 tokens) is injected at each
                    Claude Code session start. The <code>jolli-recall</code> and <code>jolli-search</code> skills
                    are installed for you, so your AI agent can load a branch's full history or search every
                    branch's memories and pick up where you left off</li>
                <li><b>Ask your agent directly (MCP)</b> &mdash; enabling a repo registers a local
                    <code>jollimemory</code> MCP server into every AI host found on your machine, exposing ten built-in tools
                    (search, recall, decision timeline, branch list, PR description, queue and install status, and
                    Jolli Space binding / listing / push). The seven memory tools answer entirely
                    from local storage; the three Jolli Space tools talk to your Jolli tenant, as their
                    names imply</li>
                <li><b>Memory Bank</b> &mdash; a browsable, cross-branch and cross-repo view of every memory on disk,
                    in tree or timeline mode, with search. Point it anywhere you like from Settings</li>
                <li><b>Knowledge wiki</b> &mdash; folds work scattered across many commits into per-topic pages, so a
                    feature touched by ten commits reads as one evolving page. Built incrementally in the background</li>
                <li><b>Backfill</b> &mdash; write memories for the commits you made before installing Jolli, so your
                    existing history shows up too</li>
                <li><b>Issue, page and conversation references</b> &mdash; Linear, Jira, GitHub, Notion, Slack,
                    Confluence, Asana, monday.com and Zoom (meetings and docs) items mentioned in your AI
                    conversation are captured and attached to the relevant memory, with deep links back to the
                    source, alongside Context7 library-documentation lookups and Jolli's own memory lookups</li>
                <li><b>Cross-device sync</b> &mdash; a status-bar widget keeps your personal Memory Bank consistent
                    across every device you sign in to</li>
                <li><b>Create &amp; Update PR</b> &mdash; create or update GitHub PRs via <code>gh</code> CLI with
                    auto-generated descriptions and <code>&lt;!-- jollimemory-summary --&gt;</code> markers for
                    in-place updates</li>
                <li><b>Push to Jolli Space</b> &mdash; publish summaries, plans, and notes to your team knowledge
                    base. Recall individual or shared memories across devices and team members</li>
            </ul>

            <h3>Multi-Agent Support</h3>
            <p>
                Twelve transcript sources are supported. Only two install a hook; the rest are discovered
                automatically by scanning the tool's own local session store, so there is nothing to set up per tool.
            </p>
            <table>
                <tr><td><b>Claude Code</b></td><td>StopHook after each response + SessionStartHook briefing at startup</td></tr>
                <tr><td><b>Gemini</b></td><td>AfterAgent hook after each agent completion</td></tr>
                <tr><td><b>Codex</b></td><td>Automatic filesystem discovery &mdash; no hook needed</td></tr>
                <tr><td><b>OpenCode</b></td><td>Automatic discovery from its local database &mdash; no hook needed</td></tr>
                <tr><td><b>Cursor</b></td><td>Automatic discovery &mdash; covers both the Composer IDE and the <code>cursor-agent</code> CLI</td></tr>
                <tr><td><b>GitHub Copilot</b></td><td>Automatic discovery &mdash; covers both the Copilot CLI and VS Code Copilot Chat</td></tr>
                <tr><td><b>Cline</b></td><td>Automatic discovery &mdash; covers both the VS Code extension and the CLI</td></tr>
                <tr><td><b>Devin CLI</b></td><td>Automatic discovery from its local database, scoped by working directory</td></tr>
                <tr><td><b>Antigravity</b></td><td>Automatic discovery from its per-conversation store and transcript log</td></tr>
            </table>

            <h3>Tool Window</h3>
            <p>
                A right-sidebar tool window with a <b>Current Branch / Memory Bank</b> view switch.
                Current Branch stacks three collapsible sections:
            </p>
            <table>
                <tr><td><b>PINNED</b></td><td>Memories you have pinned for quick access</td></tr>
                <tr><td><b>WORKING MEMORY</b></td><td>Everything feeding the next commit's memory: AI conversations, plans and notes, and changed files with staging checkboxes and the AI Commit button</td></tr>
                <tr><td><b>COMMITTED MEMORIES</b></td><td>Every commit on the branch not yet in main, with click-to-open summaries and multi-select for squash</td></tr>
            </table>
            <p>
                <b>Memory Bank</b> browses every stored memory across branches and repos, in tree or timeline mode.
                A <b>Status</b> card covers hook state, active AI sessions, stored-memory counts and detected
                integrations, and a dismissible card offers to backfill a repo that already has history.
            </p>

            <h3>Configuration</h3>
            <p>
                A five-tab dialog in the tool window (gear icon) covers <b>AI Agents</b> (nine toggles, one per source:
                Claude Code, Codex, Gemini, OpenCode, Cursor IDE, Devin, GitHub Copilot, Cline, Antigravity),
                <b>AI Summary</b> (provider &mdash; an Anthropic key, Jolli, or a local agent CLI such as
                Claude Code, Codex, Cursor, OpenCode, or Kimi Code driven by its own login &mdash; plus model and token budget),
                <b>Sync to Jolli</b>, <b>Memory Bank</b>
                (folder location) and <b>Others</b> (exclude patterns, telemetry, pause).
            </p>
            <p>
                <b>Settings &gt; Tools &gt; Jolli Memory</b> additionally holds:
            </p>
            <ul>
                <li><b>Account</b> &mdash; sign in or out of Jolli with browser OAuth</li>
                <li><b>Anthropic API Key</b> &mdash; for AI summarization (falls back to <code>${'$'}ANTHROPIC_API_KEY</code> env var)</li>
                <li><b>Model</b> &mdash; aliases (<code>haiku</code>, <code>sonnet</code>, <code>opus</code>) or full model ID</li>
                <li><b>Jolli API Key</b> &mdash; for Push to Jolli Space (sign up at <a href="https://jolli.ai">jolli.ai</a>)</li>
                <li><b>Slack Workspace URL</b> &mdash; used to build deep links for captured Slack references</li>
            </ul>
            <p>
                Settings are stored in <code>~/.jolli/jollimemory/config.json</code>, shared with the Jolli CLI and
                the VS Code extension, so signing in once works everywhere.
            </p>

            <h3>Privacy</h3>
            <p>
                <b>Read locally.</b> Gemini's hook records only a session ID and file path.
                Claude's hook also scans the transcript as you work, to pick up plan files and
                issue references. The scan-based sources read transcript content too &mdash; at
                commit time to build the summary, and on the sidebar's refresh to title your
                recent conversations. All of that happens on your machine.
            </p>
            <p>
                <b>Sent when a memory is generated.</b> Writing a summary is an LLM call, so at
                commit time the transcript slice for that commit and the diff go to whichever
                provider you configured: Anthropic directly, the Jolli LLM proxy, or a local
                agent CLI. The Jolli proxy holds the payload in memory for the request only and
                never persists or logs it.
            </p>
            <p>
                <b>Never sent to a team Jolli Space.</b> Sharing a memory uploads the summary,
                its plans, notes and captured issue references &mdash; never the raw transcript.
                Mirroring transcripts into your own personal space is a separate opt-in
                (<code>syncTranscripts</code>), off by default.
            </p>

            <h3>Links</h3>
            <ul>
                <li><a href="https://github.com/jolliai/jolliai">Source code</a> (Apache-2.0)</li>
                <li><a href="https://docs.jolli.ai/jolli-memory/getting-started-with-jolli-memory">Documentation</a></li>
                <li><a href="https://jolli.ai/privacy">Privacy policy</a></li>
                <li><a href="https://github.com/jolliai/jolliai/issues">Report an issue</a></li>
            </ul>
        """.trimIndent()
        // Source the marketplace "What's New" from CHANGELOG.md (single source of
        // truth). Render every released section so the full history ships with each build.
        changeNotes = provider {
            changelog.getAll().values.joinToString("\n") { item ->
                changelog.renderItem(
                    item.withHeader(true).withEmptySections(false),
                    Changelog.OutputType.HTML,
                )
            }
        }
        vendor {
            name = "Jolli"
            url = "https://jolli.ai"
            email = "support@jolli.ai"
        }
        ideaVersion {
            sinceBuild = "251"
            untilBuild = "262.*"
        }
    }

    pluginVerification {
        // Verify the supported range only (sinceBuild = 251). 2024.3 was dropped because the
        // non-deprecated FileSaverDescriptor API doesn't exist before 2025.1. Cover the low end
        // (2025.1) and a recent build so both ends of 251–262.* are checked.
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.1.3")
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2")
        }
    }

    // Plugin signing for JetBrains Marketplace (env vars provided by CI or local shell)
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    // Publishing to JetBrains Marketplace
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
}

// Bundle the FULL self-contained CLI dist (esbuild output — every dep inlined, no
// node_modules): Cli.js plus the per-hook entry scripts (PostCommitHook.js /
// PrepareMsgHook.js / …). The plugin runs `node Cli.js enable` to install ALL hooks
// + MCP + skills without depending on a global CLI install. Cli.js alone covers MCP
// + skills, but the shared `run-hook` dispatcher execs the per-hook .js files by
// name, so a single-file bundle would break node git hooks whenever the IntelliJ
// dist wins dist-paths arbitration (mixed installs). Source is vscode/dist/*.js
// (produced by `npm run build`); Extension.js (the VS Code extension-host bundle) is
// excluded. Placed under the plugin's cli-dist/, off the classloader path, so the
// Plugin Verifier skips it.
//
// Wired into prepareSandbox (a Sync task) rather than a bespoke copy task so runIde
// and buildPlugin share ONE path: the bundle lands in the version-scoped sandbox the
// IDE actually loads (…/idea-sandbox/<IDE>/plugins/<plugin>/), and buildPlugin zips it
// straight from there — no separate inject step. The prior bespoke task wrote to an
// unversioned …/idea-sandbox/plugins/<plugin>/ path that runIde never loads from, so
// dev sandboxes launched with an empty cli-dist and enable aborted with BundleMissing.
// Scoped to the main prepareSandbox only (not prepareTestSandbox), so the unit-test
// run keeps its current independence from the vscode/dist build.
val vscodeDistDir = rootProject.layout.projectDirectory.dir("../vscode/dist")
tasks.named<PrepareSandboxTask>("prepareSandbox") {
    // Fail fast with an actionable message instead of silently syncing an empty
    // cli-dist (which only surfaces much later as a runtime BundleMissing).
    doFirst {
        // Both are checked, because Gradle's `from(<missing dir>)` is a silent
        // no-op: a vscode/dist produced before the dashboard existed — or by
        // `build:watch`, which used to skip the asset copy — has Cli.js but no
        // dashboard-assets/, and that ships a plugin whose `jolli dashboard`
        // throws "Dashboard assets not found" at runtime instead of failing here
        // where the message is actionable.
        // index.html stands in for the tree: the copy is all-or-nothing, and the
        // per-file inventory is asserted by the plugins' own publish scripts.
        val required = listOf(
            vscodeDistDir.file("Cli.js").asFile,
            vscodeDistDir.file("dashboard-assets/index.html").asFile,
        )
        val missing = required.filterNot { it.exists() }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Bundled CLI incomplete — missing ${missing.joinToString(", ") { it.path }}. " +
                    "Run `npm run build` at the repo root first (it builds vscode/dist/ including " +
                    "dashboard-assets/), then re-run the Gradle build.",
            )
        }
    }
    from(vscodeDistDir) {
        into("${rootProject.name}/cli-dist")
        include("*.js")
        exclude("Extension.js")
    }
    // The dashboard page runtime is a DIRECTORY, so the `include("*.js")` filter
    // above skips it entirely — and Cli.js reads these files from disk beside
    // itself (resolveDashboardAssetsDir), so a dist without them serves a broken
    // page. Copied as its own spec, preserving the subtree.
    from(vscodeDistDir.dir("dashboard-assets")) {
        into("${rootProject.name}/cli-dist/dashboard-assets")
    }
}

// After buildPlugin creates the zip, strip unused sqlite-jdbc natives from lib/. The
// CLI bundle (cli-dist/) is already inside the archive: prepareSandbox placed it in
// the sandbox and buildPlugin zips the sandbox verbatim, so no separate inject step.
tasks.named("buildPlugin") {
    val buildPluginArchive = layout.buildDirectory.file("distributions/jollimemory-intellij-${project.version}.zip")
    doLast {
        // Target THIS build's archive by exact name. Using listFiles().firstOrNull { .zip }
        // grabbed a stale prior-version (or already-signed) zip when build/distributions/
        // still held old artifacts, leaving the real output unstripped.
        val zipFile = buildPluginArchive.get().asFile.takeIf { it.exists() } ?: return@doLast

        // Strip sqlite-jdbc native libraries in lib/ for platforms IntelliJ never runs on.
        // The lib/ copy is used by the IDE plugin classloader (OpenCode/Cursor SQLite reads).
        val keepNativePrefixes = listOf(
            "org/sqlite/native/Mac/",
            "org/sqlite/native/Linux/aarch64/",
            "org/sqlite/native/Linux/x86_64/",
            "org/sqlite/native/Windows/aarch64/",
            "org/sqlite/native/Windows/x86_64/",
        )
        val sizeBefore = zipFile.length() / 1024
        val tmpZip = File(zipFile.parentFile, "${zipFile.name}.tmp")
        val zipIn = ZipFile(zipFile)
        val zipOut = ZipOutputStream(FileOutputStream(tmpZip))
        try {
            val entries = zipIn.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val name = entry.name
                // Repack the lib/sqlite-jdbc JAR inline, stripping unused natives
                if (name.matches(Regex("jollimemory-intellij/lib/sqlite-jdbc-.*\\.jar"))) {
                    val originalBytes = zipIn.getInputStream(entry).readBytes()
                    val tmpSqlite = File.createTempFile("sqlite-jdbc", ".jar")
                    tmpSqlite.writeBytes(originalBytes)
                    val strippedBytes = ByteArrayOutputStream()
                    val sqliteIn = ZipFile(tmpSqlite)
                    val sqliteOut = ZipOutputStream(strippedBytes)
                    try {
                        val sqliteEntries = sqliteIn.entries()
                        while (sqliteEntries.hasMoreElements()) {
                            val se = sqliteEntries.nextElement()
                            val sn = se.name
                            if (sn.startsWith("org/sqlite/native/") &&
                                keepNativePrefixes.none { prefix -> sn.startsWith(prefix) }
                            ) continue
                            sqliteOut.putNextEntry(ZipEntry(sn))
                            if (!se.isDirectory) {
                                val buf = ByteArray(8192)
                                val stream = sqliteIn.getInputStream(se)
                                var len = stream.read(buf)
                                while (len >= 0) {
                                    sqliteOut.write(buf, 0, len)
                                    len = stream.read(buf)
                                }
                                stream.close()
                            }
                            sqliteOut.closeEntry()
                        }
                    } finally {
                        sqliteOut.close()
                        sqliteIn.close()
                        tmpSqlite.delete()
                    }
                    zipOut.putNextEntry(ZipEntry(name))
                    zipOut.write(strippedBytes.toByteArray())
                    zipOut.closeEntry()
                    continue
                }
                zipOut.putNextEntry(ZipEntry(name))
                if (!entry.isDirectory) {
                    val buf = ByteArray(8192)
                    val stream = zipIn.getInputStream(entry)
                    var len = stream.read(buf)
                    while (len >= 0) {
                        zipOut.write(buf, 0, len)
                        len = stream.read(buf)
                    }
                    stream.close()
                }
                zipOut.closeEntry()
            }
        } finally {
            zipOut.close()
            zipIn.close()
        }
        zipFile.delete()
        tmpZip.renameTo(zipFile)
        val sizeAfter = zipFile.length() / 1024
        logger.lifecycle("Stripped sqlite-jdbc natives in zip: ${sizeBefore}K -> ${sizeAfter}K")
    }
}

kover {
    reports {
        filters {
            excludes {
                // Exclude UI/IDE-dependent classes from coverage
                classes(
                    "ai.jolli.jollimemory.actions.*",
                    "ai.jolli.jollimemory.toolwindow.CollapsiblePanel*",
                    "ai.jolli.jollimemory.toolwindow.PanelRegistry*",
                    "ai.jolli.jollimemory.toolwindow.SummaryEditorProvider*",
                    "ai.jolli.jollimemory.toolwindow.SummaryFileEditor*",
                    "ai.jolli.jollimemory.toolwindow.SummaryPanel*",
                    "ai.jolli.jollimemory.toolwindow.ShareWebviewDialog*",
                    "ai.jolli.jollimemory.toolwindow.ShareContextFactory*",
                    "ai.jolli.jollimemory.toolwindow.views.ShareWebview*",
                    "ai.jolli.jollimemory.toolwindow.SummaryViewerDialog*",
                    "ai.jolli.jollimemory.toolwindow.SummaryVirtualFile*",
                    "ai.jolli.jollimemory.toolwindow.CommitsPanel*",
                    "ai.jolli.jollimemory.toolwindow.StatusPanel*",
                    "ai.jolli.jollimemory.toolwindow.PlansPanel*",
                    "ai.jolli.jollimemory.toolwindow.ChangesPanel*",
                    "ai.jolli.jollimemory.toolwindow.JolliMemoryToolWindowFactory*",
                    "ai.jolli.jollimemory.settings.*",
                    "ai.jolli.jollimemory.JolliMemoryIcons*",
                    "ai.jolli.jollimemory.services.JolliMemoryStartupActivity*",
                    "ai.jolli.jollimemory.services.JolliMemoryService*",
                )
            }
        }
    }
}

tasks {
    withType<JavaCompile> {
        sourceCompatibility = "21"
        targetCompatibility = "21"
    }

    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        }
    }

    // Workaround: IntelliJ Platform Gradle Plugin 2.5.0 fails to parse the Java
    // version from the downloaded IDE runtime, producing "JavaLanguageVersion must
    // be a positive integer, not ''". Explicitly set the JVM launcher for affected tasks.
    // EXCEPT runIde: it must launch on the JetBrains Runtime (resolved via
    // jetbrainsRuntime()) so JCEF is available for the commit-memory webview —
    // forcing the toolchain JDK here would drop JCEF and fall back to raw markdown.
    withType<JavaExec> {
        if (name != "runIde") {
            javaLauncher.set(
                project.the<JavaToolchainService>().launcherFor {
                    languageVersion.set(JavaLanguageVersion.of(21))
                }
            )
        }
    }

    // Bake project.version into jollimemory-plugin-version.txt at build time so
    // JolliApiClient can read it from the classpath without depending on the
    // IntelliJ Platform API. The inputs.property line makes the task properly
    // re-run when the version changes (otherwise Gradle would cache stale output).
    processResources {
        val pluginVersion = project.version.toString()
        inputs.property("pluginVersion", pluginVersion)
        filesMatching("jollimemory-plugin-version.txt") {
            expand("version" to pluginVersion)
        }
    }

    // Global-state gate: fails the build when production code touches JVM
    // globals outside core/HookEnv.kt, or a test mutates global state (or uses
    // mockk) without the required guards. Wired as a dependency of `test`, so
    // it runs on every local test invocation AND in CI (build-intellij.yaml
    // calls `./gradlew test`) with no extra pipeline step. Ratcheting
    // baselines live in scripts/; see check-global-state.sh for the rules.
    val checkGlobalState = register<Exec>("checkGlobalState") {
        group = "verification"
        description = "Enforce HookEnv / global-state / mockk-guard rules"
        commandLine("bash", "scripts/check-global-state.sh")
        // The gate is a bash script; skip on Windows dev machines (CI is Linux).
        onlyIf { !System.getProperty("os.name").lowercase().contains("win") }
    }

    // LLM-migration gate: keeps production Kotlin off api.anthropic.com and
    // out of java.net.http (outside the three legitimate Jolli / auth /
    // telemetry HTTP consumers listed in the script's ALLOWLIST). Wired the
    // same way as checkGlobalState so it runs on every test invocation with
    // no extra CI pipeline step. See scripts/check-no-direct-llm-http.sh for
    // the rationale.
    val checkNoDirectLlmHttp = register<Exec>("checkNoDirectLlmHttp") {
        group = "verification"
        description = "Enforce that LLM traffic routes through the bundled CLI, not Kotlin"
        commandLine("bash", "scripts/check-no-direct-llm-http.sh")
        onlyIf { !System.getProperty("os.name").lowercase().contains("win") }
    }

    // DumbAware gate: every action class in actions/ must declare DumbAware, or
    // the platform disables it for the whole of indexing regardless of what
    // update() computes. Wired like the two gates above so it runs on every test
    // invocation with no extra CI step. Nothing else can see this regress — a
    // missing marker compiles, lints and passes the suite. See
    // scripts/check-actions-dumbaware.sh.
    val checkActionsDumbAware = register<Exec>("checkActionsDumbAware") {
        group = "verification"
        description = "Enforce that every action in actions/ declares DumbAware"
        commandLine("bash", "scripts/check-actions-dumbaware.sh")
        onlyIf { !System.getProperty("os.name").lowercase().contains("win") }
    }

    test {
        useJUnitPlatform()
        dependsOn(checkGlobalState, checkNoDirectLlmHttp, checkActionsDumbAware)
        // Parallelism now lives INSIDE one JVM: JUnit 5 runs test classes
        // concurrently on a work-stealing pool (src/test/resources/
        // junit-platform.properties). This is safe because tests no longer
        // mutate JVM-global state — global dependencies are injected via
        // HookEnv (core/HookEnv.kt) and tests pass fakes (TestEnvs.kt);
        // legacy offenders carry @Isolated until migrated, and
        // scripts/check-global-state.sh keeps new offenders out. One fork
        // means a single classloader/JIT warm-up and one heap instead of six.
        // (History: the previous multi-fork setup existed precisely because
        // tests swapped System.out / used mockkStatic — that constraint is
        // being removed at the root. A NUL byte in test output once broke
        // Gradle's XML report on the serial single-fork run; tests emitting
        // raw binary to stdout should keep it out of assertions.)
        maxParallelForks = 1
        // One heap now hosts N concurrent test classes; size it accordingly.
        maxHeapSize = "2g"
        javaLauncher.set(
            project.the<JavaToolchainService>().launcherFor {
                languageVersion.set(JavaLanguageVersion.of(21))
            }
        )
        // IntelliJ auto-registers JUnit5 extensions (e.g. ThreadLeakTracker) whose
        // afterEach initializes UIUtil → JBUIScale. On Windows the JRE-HiDPI code path
        // lazily computes the system scale and logs an "Must be precomputed" error, which
        // the platform's TestLogger escalates into a spurious test failure. Disabling
        // JRE-HiDPI makes JBUIScale resolve to 1.0 without that path. Linux/CI never hits
        // this (headless scale is already 1.0 there), so the flags are a harmless no-op
        // elsewhere and keep the pure-logic unit tests green on Windows.
        systemProperty("java.awt.headless", "true")
        systemProperty("sun.java2d.uiScale.enabled", "false")
        // Keep the IntelliJ platform's auto-detected JUnit5 extensions OUT of
        // this suite. They are built for serial full-IDE integration tests and
        // misbehave here: UncaughtExceptionExtension swaps the JVM-global
        // default uncaught-exception handler (races under parallel execution),
        // and ThreadLeakTracker fails whatever innocent test happens to finish
        // while a background thread (e.g. jollimemory-log-writer) is alive —
        // waiting 10s per check on top.
        //
        // "enabled=false" alone CANNOT hold: the IDE's lib/testFramework.jar
        // ships JUnit5TestEnvironmentInitializer, a LauncherSessionListener
        // that JUnit loads unconditionally via ServiceLoader (session listeners
        // ignore the autodetection flag) and that force-resets the property to
        // "true" from INSIDE the test JVM at session start — after every
        // Gradle-side write, doFirst included. The line that actually holds is
        // the exclude filter (JUnit 5.12+): it is applied at extension
        // registration time and is out of that listener's reach, so the
        // com.intellij.* extensions stay out even with autodetection forced
        // on. Keep enabled=false as defence in depth. Both properties are
        // asserted by JUnitConfigurationGateTest; applied in doFirst so
        // nothing in the configuration phase can overwrite them.
        doFirst {
            systemProperty("junit.jupiter.extensions.autodetection.enabled", "false")
            systemProperty("junit.jupiter.extensions.autodetection.exclude", "com.intellij.*")
        }
        // Surface failures (and the full stack trace) in the console; pass `-i` for a
        // live per-test ticker. Deliberately no "passed" event — 1094 lines is noise.
        testLogging {
            events("failed", "skipped")
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
        // Live progress without the per-test spam: a running counter aggregated across
        // all forks (events land in the Gradle daemon, so the AtomicInteger is safe).
        // Prints "… N tests done" every 50 tests on the console, AND mirrors the count to
        // build/test-progress.txt so a backgrounded run can be polled (scripts/test-progress.sh).
        // Gradle only flushes the per-class TEST-*.xml files at the end of the task, so that
        // file — not the XML — is the source of truth for live progress.
        val testProgress = AtomicInteger(0)
        val progressFile = layout.buildDirectory.file("test-progress.txt").get().asFile
        doFirst {
            progressFile.parentFile.mkdirs()
            progressFile.writeText("0")
        }
        afterTest(
            org.gradle.kotlin.dsl.KotlinClosure2<TestDescriptor, TestResult, Unit>({ _, _ ->
                val n = testProgress.incrementAndGet()
                synchronized(testProgress) { progressFile.writeText(n.toString()) }
                if (n % 50 == 0) logger.lifecycle("  … $n tests done")
            }),
        )
        afterSuite(
            org.gradle.kotlin.dsl.KotlinClosure2<TestDescriptor, TestResult, Unit>({ desc, _ ->
                if (desc.parent == null) logger.lifecycle("  ✓ ${testProgress.get()} tests done")
            }),
        )
    }
}

// Changelog config: CHANGELOG.md is the single source of truth for the
// marketplace change notes (rendered into patchPluginXml.changeNotes above).
// Headers are bare "## <version>"; sections use custom group names, so we
// disable the standard-group templating.
changelog {
    version = project.version.toString()
    path = file("CHANGELOG.md").canonicalPath
    header = provider { version.get() }
    headerParserRegex = """(\d+\.\d+\.\d+)""".toRegex()
    groups = emptyList()
    keepUnreleasedSection = false
}
