import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import java.util.zip.ZipEntry
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.5.0"
    id("com.gradleup.shadow") version "9.0.0-beta12"
    id("org.jetbrains.kotlinx.kover") version "0.9.1"
}

group = "ai.jolli"
version = "0.99.2"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        // JBR binaries repository so jetbrainsRuntime() can resolve — required for
        // JCEF (the commit-memory webview) when runIde isn't launched on a JBR.
        jetbrainsRuntime()
    }
}

// Standalone configuration for the hooks fat JAR (includes kotlin-stdlib)
val hooksRuntime: Configuration by configurations.creating

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3")
        bundledPlugin("com.intellij.java")
        bundledPlugin("Git4Idea")
        pluginVerifier()
        instrumentationTools()
        // Use the JetBrains Runtime for runIde/tests so JCEF is available — the
        // commit-memory panel renders via JBCefBrowser and otherwise falls back to
        // a raw-markdown text view (e.g. when launched on a plain Homebrew JDK).
        jetbrainsRuntime()
    }
    // Gson and kotlin-stdlib are compileOnly — IntelliJ bundles both at runtime.
    // The standalone hooks JAR bundles its own copies via the hooksRuntime configuration.
    compileOnly("com.google.code.gson:gson:2.12.1")
    compileOnly("org.jetbrains.kotlin:kotlin-stdlib")
    implementation("org.xerial:sqlite-jdbc:3.49.1.0")
    hooksRuntime("com.google.code.gson:gson:2.12.1")
    hooksRuntime("org.jetbrains.kotlin:kotlin-stdlib:2.1.20")
    hooksRuntime("org.xerial:sqlite-jdbc:3.49.1.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
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
                When you work with AI agents like <b>Claude Code</b>, <b>Codex</b>, or <b>Gemini CLI</b>,
                the reasoning behind every decision lives in the conversation &mdash;
                <em>why this approach was chosen, what alternatives were considered, what problems came up along the way</em>.
                The moment you commit, that context is gone. Jolli Memory captures it automatically.
            </p>

            <h3>How It Works</h3>
            <p>
                After each commit, Jolli Memory reads your AI session transcripts and the code diff,
                calls the LLM to produce a structured summary, and stores it alongside the commit
                silently in the background. Your commit returns instantly &mdash; the summary is generated
                in ~10&ndash;20 seconds. Everything is stored in a git orphan branch, completely separate
                from your code history.
            </p>

            <h3>Key Features</h3>
            <ul>
                <li><b>AI Commit</b> &mdash; generate commit messages from staged diffs using the Anthropic API.
                    Review and edit before committing, with support for commit, amend, and amend-keep-message modes</li>
                <li><b>Squash</b> &mdash; select two or more commits and squash them with an LLM-generated combined
                    message. Existing memories are automatically merged &mdash; no extra AI call needed</li>
                <li><b>Summary Viewer</b> &mdash; rich HTML viewer for each commit showing properties, AI summaries
                    (structured as <em>Why This Change &rarr; Decisions Behind the Code &rarr; What Was Implemented</em>),
                    E2E test guides, associated plans, and source commits</li>
                <li><b>Plans &amp; Notes</b> &mdash; auto-detect Claude Code plans from <code>~/.claude/plans/</code>,
                    import Markdown files, or write quick text snippets. Plans are archived with each commit</li>
                <li><b>E2E Test Generation</b> &mdash; AI-generated test scenarios with preconditions, steps, and
                    expected results, editable inline in the Summary Viewer</li>
                <li><b>Session Context Recall</b> &mdash; a lightweight briefing (~300 tokens) is injected at each
                    Claude Code session start. Run <code>/jolli-recall</code> for full branch history
                    recall (~30,000 tokens) so your AI agent can pick up where you left off</li>
                <li><b>Create &amp; Update PR</b> &mdash; create or update GitHub PRs via <code>gh</code> CLI with
                    auto-generated descriptions and <code>&lt;!-- jollimemory-summary --&gt;</code> markers for
                    in-place updates</li>
                <li><b>Push to Jolli Space</b> &mdash; publish summaries, plans, and notes to your team knowledge
                    base. Recall individual or shared memories across devices and team members</li>
                <li><b>Search &amp; Filter</b> &mdash; search memories by commit message or branch name with
                    real-time filtering</li>
            </ul>

            <h3>Multi-Agent Support</h3>
            <table>
                <tr><td><b>Claude Code</b></td><td>StopHook after each response + SessionStartHook briefing at startup</td></tr>
                <tr><td><b>Gemini CLI</b></td><td>AfterAgent hook after each agent completion</td></tr>
                <tr><td><b>Codex CLI</b></td><td>Automatic filesystem discovery &mdash; no hook needed</td></tr>
            </table>

            <h3>Tool Window</h3>
            <p>
                A right-sidebar tool window with collapsible, resizable panels:
            </p>
            <table>
                <tr><td><b>STATUS</b></td><td>Enable/disable hooks, active AI sessions, memory count, Jolli Space connection</td></tr>
                <tr><td><b>MEMORIES</b></td><td>Every commit on the branch with click-to-open summaries and search/filter</td></tr>
                <tr><td><b>PLANS &amp; NOTES</b></td><td>Auto-detected plans and custom notes with add/edit/remove</td></tr>
                <tr><td><b>CHANGES</b></td><td>Changed files with staging checkboxes and AI Commit button</td></tr>
                <tr><td><b>COMMITS</b></td><td>Branch commits with multi-select for squash operations</td></tr>
            </table>

            <h3>Configuration</h3>
            <p>
                <b>Settings &gt; Tools &gt; Jolli Memory</b> (or gear icon in the STATUS panel):
            </p>
            <ul>
                <li><b>Anthropic API Key</b> &mdash; for AI summarization (falls back to <code>${'$'}ANTHROPIC_API_KEY</code> env var)</li>
                <li><b>Model</b> &mdash; aliases (<code>haiku</code>, <code>sonnet</code>, <code>opus</code>) or full model ID</li>
                <li><b>Jolli API Key</b> &mdash; for Push to Jolli Space (sign up at <a href="https://jolli.ai">jolli.ai</a>)</li>
            </ul>

            <h3>Privacy</h3>
            <p>
                AI agent hooks <b>only record session metadata</b> (session ID and file path) &mdash;
                they never read your conversation content. Transcripts are only read at commit time
                by the background summary worker.
            </p>
        """.trimIndent()
        changeNotes = """
            <h3>0.99.2</h3>

            <h4>New Features</h4>
            <ul>
                <li><b>Reference extraction</b> &mdash; automatically extracts Linear, Jira, GitHub, and
                    Notion references from Claude and Codex transcripts and surfaces them in summaries.
                    Includes per-source envelope parsers, a persistent <code>ReferenceStore</code>, and
                    transcript-level discovery at both StopHook and post-commit time</li>
                <li><b>References in Plans panel</b> &mdash; plan entries now show clickable
                    "Open in &lt;Source&gt;" links instead of static source labels, with a Select All
                    toolbar action</li>
                <li><b>PR history strip</b> &mdash; the summary viewer shows previously merged or closed
                    PRs for the same branch alongside the active PR. Uses <code>gh pr list --state all</code>
                    so reopened or multi-PR branches no longer lose history</li>
                <li><b>Conversation multi-select</b> &mdash; active conversation rows now have a checkbox
                    ("Include in next memory") and a Select All toolbar action</li>
            </ul>

            <h4>Fixes &amp; Improvements</h4>
            <ul>
                <li>Removed periodic polling timer for branch updates; the tool window now updates on
                    events only</li>
                <li>Resolved JetBrains Marketplace Plugin Verifier internal-API warnings &mdash; plugin
                    version and install path are derived from pure JVM APIs instead of
                    <code>PluginManager</code></li>
                <li>Commit selection state is now tracked via <code>CommitSelectionStore</code></li>
            </ul>

            <h3>0.99.1</h3>

            <h4>New Features</h4>
            <ul>
                <li><b>Active Conversations</b> &mdash; a new panel showing in-progress AI agent
                    sessions live, with inline transcript editing, message counts, and the ability
                    to hide sessions</li>
                <li><b>Knowledge Wiki</b> &mdash; build a browsable topic wiki from your Memory Bank
                    via an LLM ingest pipeline. Trigger it with the <b>Build Knowledge Wiki</b> button
                    or let it auto-compile after each commit; supports both Anthropic and Jolli
                    summarization providers</li>
                <li><b>Full-text search &amp; MCP server</b> &mdash; search across all memories, plus
                    an MCP server that exposes your memory to AI tools, with ingest-phase progress UI</li>
                <li><b>Full vault sync pipeline</b> &mdash; sync your Memory Bank to your Jolli space
                    with live UI feedback, a space-binding dialog, and binding-required (412) handling</li>
                <li><b>Quick Recap</b> &mdash; generate, regenerate, and edit a branch recap section</li>
                <li><b>Memory scope filter</b> &mdash; filter the Memories panel by scope; auto-refreshes
                    on branch switch</li>
                <li><b>Discard selected</b> &mdash; discard multiple selected files at once in the
                    Changes panel</li>
                <li><b>"Push to Jolli" is now "Share in Jolli"</b> &mdash; the cloud-publish button is
                    relabeled across all surfaces. Behavior is unchanged; only the label was updated</li>
            </ul>

            <h4>UI</h4>
            <ul>
                <li><b>Tool window redesign</b> &mdash; breadcrumb navigation and foreign-mode support</li>
                <li><b>Summary panel redesign</b> &mdash; realigned to match the VS Code layout</li>
                <li><b>LLM provider attribution</b> &mdash; summary footers now show which provider
                    generated the summary</li>
            </ul>

            <h4>Fixes &amp; Improvements</h4>
            <ul>
                <li>Fixed Jolli API key clearing not triggering the status indicator, and not saving
                    as <code>null</code> when cleared</li>
                <li>Fixed SSH/HTTPS remote mismatch that split Memory Banks and created duplicate repo
                    entries; repo identity is now canonicalized on merge</li>
                <li>Fixed Migrate-to-Memory-Bank creating duplicate repo folders; consolidated onto the
                    base folder name</li>
                <li>Auto-clear stale sync-status badges in the status bar</li>
                <li>Windows: mark the <code>.jolli</code> directory as hidden, fix path-separator drift
                    in the storage layer, and fix the build &amp; test suite</li>
                <li>Fixed SQLite JDBC driver loading</li>
                <li>Fixed a stderr deadlock and refined the sync poll interval</li>
                <li>Fixed OnboardingPanel font rendering and added an API key help tooltip</li>
                <li>Added <code>client_version</code> to OAuth login URLs</li>
            </ul>

            <h3>0.99.0</h3>

            <h4>Memory Bank</h4>
            <ul>
                <li><b>Memory Bank</b> &mdash; a new local storage layer that keeps human-readable
                    Markdown summaries, plans, and notes alongside canonical JSON in a user-configurable
                    folder. Summaries are dual-written to both the git orphan branch (system of record)
                    and the Memory Bank folder by default</li>
                <li><b>Memory Bank explorer</b> &mdash; browse your Memory Bank as a tree view in the
                    tool window with commit/plan/note badges, double-click to open the formatted summary
                    viewer. Supports file operations (New Folder, File, Import, Rename, Move, Delete) and
                    drag-and-drop</li>
                <li><b>Auto-migration</b> &mdash; existing orphan branch data is automatically migrated
                    to the Memory Bank folder on plugin startup</li>
            </ul>

            <h4>AI Agent Support</h4>
            <ul>
                <li><b>Claude Code</b> &mdash; StopHook after each response, SessionStartHook briefing at startup</li>
                <li><b>Gemini CLI</b> &mdash; AfterAgent hook after each agent completion</li>
                <li><b>Codex CLI</b> &mdash; automatic filesystem discovery, no hook needed</li>
                <li><b>OpenCode</b> &mdash; session discovery via SQLite database scan</li>
                <li><b>Cursor IDE</b> &mdash; Composer session discovery via SQLite database scan</li>
                <li><b>GitHub Copilot CLI &amp; Copilot Chat</b> &mdash; session discovery via filesystem scan</li>
            </ul>

            <h4>Settings &amp; Setup</h4>
            <ul>
                <li><b>Simplified setup flow</b> &mdash; hooks auto-install on credential save and
                    auto-remove on credential clear; no separate Enable/Disable step</li>
                <li><b>Onboarding screen</b> &mdash; detects existing API keys (config or
                    <code>ANTHROPIC_API_KEY</code> env var) and skips onboarding automatically</li>
                <li><b>Tabbed Settings dialog</b> &mdash; reorganized into five tabs: General,
                    AI Agents, AI Summary, Sync to Jolli, and Memory Bank</li>
                <li><b>AI Summary provider selection</b> &mdash; choose between Anthropic and Jolli
                    as the summarization provider</li>
                <li><b>Pause toggle</b> &mdash; temporarily disable hooks without losing configuration</li>
            </ul>

            <h4>Plugin Distribution</h4>
            <ul>
                <li><b>Reduced plugin size</b> &mdash; stripped unused platform natives from sqlite-jdbc
                    (FreeBSD, Android, ARM32, RISC-V, ppc64) and deduplicated the sqlite-jdbc dependency
                    between the plugin and hooks JAR. Plugin zip reduced from 31 MB to 7 MB</li>
                <li><b>Quality improvements</b> &mdash; resolved JetBrains Marketplace internal API
                    warnings, fixed binary compatibility issues across IntelliJ versions, improved UI
                    layout and panel management, fixed encoding issues, and added Plugin Verifier to CI</li>
            </ul>

            <h3>0.97.9</h3>
            <ul>
                <li><b>Privacy consent notice</b> &mdash; display a privacy notice with link to privacy
                    policy at the top of the Settings page, satisfying JetBrains Marketplace guideline
                    2.2 for explicit user consent before data processing</li>
            </ul>

            <h3>0.97.0</h3>
            <ul>
                <li><b>Initial IntelliJ plugin release</b> &mdash; pure Kotlin port of the VS Code extension</li>
                <li><b>Four-panel tool window</b>: STATUS, PLANS &amp; NOTES, CHANGES, COMMITS in a right
                    sidebar with collapsible panels</li>
                <li><b>AI Commit</b> &mdash; generate commit messages from staged diffs using Anthropic API</li>
                <li><b>Squash</b> &mdash; squash selected commits with LLM-generated combined message and
                    automatic memory merging</li>
                <li><b>Push</b> &mdash; git push with force-push confirmation dialog</li>
                <li><b>View Summary</b> &mdash; JCEF-based HTML viewer for commit summaries with dark/light
                    theme support</li>
                <li><b>Plans &amp; Notes</b> &mdash; auto-detect Claude Code plans, add custom notes
                    (Markdown files or text snippets)</li>
                <li><b>Hook installation</b> &mdash; pure Kotlin file I/O, no Node.js; installs git hooks
                    and Claude Code stop hook</li>
                <li><b>Standalone hooks JAR</b> &mdash; git hooks run as <code>jollimemory-hooks.jar</code>
                    fat JAR outside the IDE</li>
                <li><b>Orphan branch storage</b> &mdash; summaries stored in
                    <code>jollimemory/summaries/v3</code> with tree-hash aliases</li>
                <li><b>Push to Jolli Space</b> &mdash; publish summaries to team knowledge base via API</li>
                <li><b>Create &amp; Update PR</b> &mdash; GitHub PR management via <code>gh</code> CLI
                    with summary markers</li>
                <li><b>Settings page</b> &mdash; Anthropic API key, model selection, Jolli API key at
                    Settings &gt; Tools &gt; Jolli Memory</li>
                <li><b>Compatibility</b>: IntelliJ IDEA 2024.3+ (build 243&ndash;262.*)</li>
            </ul>
        """.trimIndent()
        vendor {
            name = "Jolli"
            url = "https://jolli.ai"
            email = "support@jolli.ai"
        }
        ideaVersion {
            sinceBuild = "243"
            untilBuild = "262.*"
        }
    }

    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3")
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.1.3")
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

// Resolve the sqlite-jdbc JAR filename from the dependency so the Class-Path
// manifest stays correct when the version is bumped.
val sqliteJdbcFileName: String by lazy {
    hooksRuntime.resolvedConfiguration.resolvedArtifacts
        .map { it.file.name }
        .first { it.startsWith("sqlite-jdbc") }
}

// Fat JAR for hooks (standalone executable without IntelliJ dependencies)
tasks.register<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("hookJar") {
    archiveBaseName.set("jollimemory-hooks")
    archiveClassifier.set("")
    manifest {
        attributes["Main-Class"] = "ai.jolli.jollimemory.hooks.HookRunner"
        // JVM resolves Class-Path entries relative to the JAR's own directory.
        // Two entries: (1) when installed to ~/.jolli/bin/ alongside sqlite-jdbc.jar,
        // (2) when running from plugin's bin/ directory, resolve from sibling lib/.
        attributes["Class-Path"] = "sqlite-jdbc.jar ../lib/$sqliteJdbcFileName"
    }
    from(sourceSets.main.get().output)
    // runtimeClasspath no longer includes Gson/kotlin-stdlib (both compileOnly);
    // hooksRuntime bundles them explicitly for standalone execution.
    configurations = listOf(hooksRuntime)
    // Exclude IntelliJ platform classes — hooks don't need them
    exclude("com/intellij/**")
    exclude("org/jetbrains/**")
    // Exclude TypeVariableImpl and TypesJVMKt — TypeVariableImpl doesn't implement
    // TypeVariable.getAnnotatedBounds(), causing binary incompatibility with newer
    // JDKs bundled in IntelliJ 2026.1+. TypesJVMKt.computeJavaType() references
    // TypeVariableImpl, so it must also be excluded to avoid NoSuchClassError.
    // Must NOT exclude the entire kotlin/reflect package — KFunction etc.
    // are needed by kotlin-stdlib's Regex.findAll() at runtime.
    exclude("kotlin/reflect/TypeVariableImpl.class")
    exclude("kotlin/reflect/TypesJVMKt.class")
    exclude("kotlin/reflect/TypesJVMKt\$*.class")
    // Exclude the plugin descriptor so IntelliJ doesn't see two plugin.xml files
    exclude("META-INF/plugin.xml")
    // Exclude sqlite-jdbc entirely — it ships as a separate JAR in bin/ and is loaded
    // via Class-Path manifest at runtime. This avoids duplicating the 3.8 MB library.
    exclude("org/sqlite/**")
    exclude("META-INF/maven/org.xerial/**")
    exclude("META-INF/native-image/org.xerial/**")
    exclude("META-INF/versions/9/org/sqlite/**")
    mergeServiceFiles()
}

// Add hooks JAR to the sandbox BEFORE buildPlugin zips it
tasks.named("prepareSandbox") {
    dependsOn("hookJar")
}

// After prepareSandbox completes, copy hooks JAR and a stripped sqlite-jdbc.jar into bin/.
// Using bin/ instead of lib/ keeps them off the plugin classloader path, so Plugin
// Verifier doesn't flag the bundled dependencies.
tasks.register("copyHookJarToSandbox") {
    dependsOn("prepareSandbox", "hookJar")
    doLast {
        val hookJar = tasks.named("hookJar").get().outputs.files.singleFile
        val pluginBin = layout.buildDirectory.dir("idea-sandbox/plugins/jollimemory-intellij/bin").get().asFile
        pluginBin.mkdirs()
        hookJar.copyTo(File(pluginBin, "jollimemory-hooks.jar"), overwrite = true)
        logger.lifecycle("Copied hooks JAR to: ${pluginBin}/jollimemory-hooks.jar")

        // Produce a platform-stripped sqlite-jdbc.jar for the hooks JAR's Class-Path.
        // The plugin's lib/ has the full upstream JAR; we strip it down to desktop platforms only.
        val keepNativePrefixes = listOf(
            "org/sqlite/native/Mac/",
            "org/sqlite/native/Linux/aarch64/",
            "org/sqlite/native/Linux/x86_64/",
            "org/sqlite/native/Windows/aarch64/",
            "org/sqlite/native/Windows/x86_64/",
        )
        val sqliteSrc = hooksRuntime.resolvedConfiguration.resolvedArtifacts
            .map { it.file }
            .first { it.name.startsWith("sqlite-jdbc") }
        val sqliteDst = File(pluginBin, "sqlite-jdbc.jar")
        val zipIn = ZipFile(sqliteSrc)
        val zipOut = ZipOutputStream(FileOutputStream(sqliteDst))
        try {
            val entries = zipIn.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val name = entry.name
                if (name.startsWith("org/sqlite/native/") &&
                    keepNativePrefixes.none { prefix -> name.startsWith(prefix) }
                ) continue
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
        logger.lifecycle("Stripped sqlite-jdbc.jar to: ${pluginBin}/sqlite-jdbc.jar (${sqliteSrc.length() / 1024}K -> ${sqliteDst.length() / 1024}K)")
    }
}

// buildSearchableOptions reads from sandbox — make sure hooks JAR is there
tasks.named("buildSearchableOptions") {
    dependsOn("copyHookJarToSandbox")
}

// After buildPlugin creates the zip, inject bin/ JARs and strip unused sqlite-jdbc natives from lib/.
tasks.named("buildPlugin") {
    dependsOn("copyHookJarToSandbox")
    doLast {
        val zipFile = layout.buildDirectory.dir("distributions").get().asFile
            .listFiles()?.firstOrNull { it.name.endsWith(".zip") } ?: return@doLast
        val pluginBin = layout.buildDirectory.dir("idea-sandbox/plugins/jollimemory-intellij/bin").get().asFile

        // 1. Add hooks JAR to bin/ (outside lib/ so Plugin Verifier skips it).
        //    sqlite-jdbc.jar is NOT duplicated here — the hooks JAR's Class-Path manifest
        //    references ../lib/sqlite-jdbc-*.jar when running from the plugin directory.
        //    A separate copy is only made to ~/.jolli/bin/ by HookInstaller at install time.
        ant.withGroovyBuilder {
            "zip"("destfile" to zipFile.absolutePath, "update" to true) {
                "zipfileset"("dir" to pluginBin.absolutePath, "prefix" to "jollimemory-intellij/bin") {
                    "include"("name" to "jollimemory-hooks.jar")
                }
            }
        }
        logger.lifecycle("Injected hooks JAR into: ${zipFile.name}")

        // 2. Strip sqlite-jdbc native libraries in lib/ for platforms IntelliJ never runs on.
        //    The lib/ copy is used by the IDE plugin classloader; bin/sqlite-jdbc.jar is for hooks.
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

    test {
        useJUnitPlatform()
        // Run test classes across several JVMs in parallel. The suite is ~1094 plain
        // unit tests in one sequential JVM by default (~20 min); separate forks give
        // full isolation (each fork has its own System.out and mockk global state, so
        // the System.out-swapping and mockkStatic/mockkObject tests can't race), unlike
        // in-JVM JUnit parallelism. Capped to avoid oversubscribing the IDE-sandbox JVMs.
        // Partitioning captured output per fork (vs. one shared buffer) also avoids the
        // Gradle "Could not write XML test results" failure that the serial run hit when a
        // test emitted a NUL byte that is illegal in XML 1.0. Cuts a full run to ~5 min.
        maxParallelForks = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(1, 6)
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
