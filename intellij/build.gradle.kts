import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.5.0"
    id("com.gradleup.shadow") version "9.0.0-beta12"
    id("org.jetbrains.kotlinx.kover") version "0.9.1"
}

group = "ai.jolli"
version = "0.98.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
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
    }
    // Gson and kotlin-stdlib are compileOnly — IntelliJ bundles both at runtime.
    // The standalone hooks JAR bundles its own copies via the hooksRuntime configuration.
    compileOnly("com.google.code.gson:gson:2.12.1")
    compileOnly("org.jetbrains.kotlin:kotlin-stdlib")
    hooksRuntime("com.google.code.gson:gson:2.12.1")
    hooksRuntime("org.jetbrains.kotlin:kotlin-stdlib:2.1.20")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("io.mockk:mockk:1.13.16")
    testImplementation("io.kotest:kotest-assertions-core:5.9.1")
}

intellijPlatform {
    pluginConfiguration {
        id = "ai.jolli.jollimemory"
        name = "JolliMemory"
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
            <h3>0.98.0</h3>
            <ul>
                <li><b>Knowledge Base explorer</b> &mdash; browse your local Knowledge Base folder
                    as a tree view in the JOLLI tool window, with C/P/N badges and readable titles.
                    Double-click commit files to open the formatted summary viewer</li>
                <li><b>Folder-based storage</b> &mdash; new dual-write mode stores summaries as
                    human-readable Markdown files alongside hidden JSON data in a local folder
                    (<code>~/Documents/jolli/{project}/</code>)</li>
                <li><b>Auto-migration</b> &mdash; existing orphan branch data is automatically
                    migrated to the Knowledge Base folder on plugin startup. Manual migration
                    available via Settings</li>
                <li><b>File operations</b> &mdash; right-click context menu for New Folder,
                    New File, Import, Rename, Move, Delete. Drag and drop support for
                    files and folders with metadata sync</li>
                <li><b>Create &amp; Update PR</b> &mdash; automatically detects existing PRs
                    and updates them instead of failing</li>
                <li><b>Fix CommitsPanel after Enable</b> &mdash; resolve race condition where
                    CommitsPanel showed &ldquo;disabled&rdquo; on empty branches after Enable</li>
                <li><b>Fix panel refresh on branch switch</b> &mdash; add VCS listener and
                    periodic polling for reliable branch detection</li>
            </ul>

            <h3>0.97.9</h3>
            <ul>
                <li><b>Privacy consent notice</b> &mdash; display a privacy notice with link to
                    privacy policy at the top of the Settings page, satisfying JetBrains Marketplace
                    guideline 2.2 for explicit user consent before data processing</li>
            </ul>

            <h3>0.97.8</h3>
            <ul>
                <li><b>Fix scheduled-for-removal API</b> &mdash; replace <code>PluginId.findId()</code>
                    with <code>PluginId.getId()</code> to resolve Plugin Verifier warnings</li>
                <li><b>Add Plugin Verifier to CI</b> &mdash; verify binary compatibility against
                    IntelliJ 2024.3, 2025.1, and 2026.1 on every build</li>
            </ul>

            <h3>0.97.7</h3>
            <ul>
                <li><b>Bump version</b> &mdash; version bump for standalone repository migration</li>
            </ul>

            <h3>0.97.6</h3>
            <ul>
                <li><b>Marketplace readiness</b> &mdash; add plugin icons (<code>pluginIcon.svg</code>
                    with dark variant), configure Gradle plugin signing and publishing,
                    add Apache 2.0 LICENSE</li>
            </ul>

            <h3>0.97.5</h3>
            <ul>
                <li><b>Install Gemini CLI hooks</b> &mdash; the Enable button now writes the AfterAgent hook
                    to <code>.gemini/settings.json</code>, matching the VS Code extension</li>
                <li><b>Auto-refresh panels after commit</b> &mdash; COMMITS and CHANGES panels now subscribe
                    to <code>GIT_REPO_CHANGE</code> events directly, so they update automatically after
                    IntelliJ UI commits instead of requiring manual refresh</li>
                <li><b>Fix stale &ldquo;disabled&rdquo; state after enable</b> &mdash; prevent a slow initial
                    background refresh from overwriting the correct UI state</li>
                <li><b>Fix VFS listener bus scope</b> &mdash; CHANGES panel now subscribes to
                    <code>VFS_CHANGES</code> on the application-level message bus</li>
                <li><b>Fix TypesJVMKt binary incompatibility</b> &mdash; exclude <code>TypesJVMKt</code>
                    from hooks fat JAR in addition to <code>TypeVariableImpl</code> to resolve
                    Plugin Verifier <code>NoSuchClassError</code> on IntelliJ 2026.1+</li>
                <li><b>Fix tool window icon</b> &mdash; correct SVG icon rendering in the sidebar</li>
                <li><b>Refactor panel layout</b> &mdash; panels now use JPanel rows for better alignment and consistency</li>
                <li><b>Harden hook installation</b> &mdash; fix CLI file permissions and scope the package name</li>
                <li><b>Update export path</b> &mdash; SummaryExporter now writes to <code>~/Documents/jollimemory/</code></li>
            </ul>

            <h3>0.97.4</h3>
            <ul>
                <li><b>Fix TypeVariable binary incompatibility</b> &mdash; exclude <code>TypeVariableImpl</code> from hooks fat JAR
                    to resolve IntelliJ 2026.1+ (build 261) compatibility where <code>getAnnotatedBounds()</code> was missing</li>
                <li><b>kotlin-stdlib as compileOnly</b> &mdash; the plugin no longer bundles kotlin-stdlib (IntelliJ provides
                    it at runtime); only the standalone hooks JAR bundles its own copy via a separate <code>hooksRuntime</code>
                    Gradle configuration</li>
            </ul>

            <h3>0.97.3</h3>
            <ul>
                <li>Bump plugin version for distribution</li>
            </ul>

            <h3>0.97.2</h3>
            <ul>
                <li><b>Fix UTF-8 bridge corruption</b> &mdash; resolve encoding issues in git command output parsing
                    that could corrupt non-ASCII characters (emojis, CJK) in commit messages and file paths.
                    Webview messages now use Base64 encoding for safe IPC</li>
                <li><b>Improved UI layout</b> &mdash; collapsible panels with AccordionLayout, ResizeDivider for
                    manual panel resizing, and inline action toolbars per panel</li>
                <li><b>Panel management</b> &mdash; configurable panel visibility via gear menu, PanelRegistry
                    for state persistence across IDE sessions</li>
            </ul>

            <h3>0.97.1</h3>
            <ul>
                <li><b>Refined panel headers</b> &mdash; improved collapsible panel headers, expand/collapse
                    animations, and panel toolbar layout</li>
            </ul>

            <h3>0.97.0 &mdash; Initial Release</h3>
            <ul>
                <li><b>Pure Kotlin port</b> of the VS Code extension &mdash; no Node.js dependency</li>
                <li><b>Tool window</b> with STATUS, PLANS &amp; NOTES, CHANGES, and COMMITS panels</li>
                <li><b>AI Commit</b> &mdash; generate commit messages from staged diffs using Anthropic API</li>
                <li><b>Squash</b> &mdash; squash selected commits with LLM-generated combined message and
                    automatic memory merging</li>
                <li><b>Summary Viewer</b> &mdash; JCEF-based HTML viewer with dark/light theme support</li>
                <li><b>Plans &amp; Notes</b> &mdash; auto-detect Claude Code plans, add Markdown files and text snippets</li>
                <li><b>Hook installation</b> &mdash; pure Kotlin file I/O for git hooks and Claude Code stop hook</li>
                <li><b>Standalone hooks JAR</b> &mdash; git hooks run as <code>jollimemory-hooks.jar</code> fat JAR
                    outside the IDE</li>
                <li><b>Multi-agent support</b> &mdash; session tracking for Claude Code (StopHook), Gemini CLI
                    (AfterAgent hook), and Codex CLI (filesystem discovery)</li>
                <li><b>Orphan branch storage</b> &mdash; summaries stored in <code>jollimemory/summaries/v3</code>
                    with tree-hash aliases for cross-branch matching</li>
                <li><b>Push to Jolli Space</b> &mdash; publish summaries to team knowledge base via API</li>
                <li><b>Create &amp; Update PR</b> &mdash; GitHub PR management via <code>gh</code> CLI with summary markers</li>
                <li><b>E2E Test Generation</b> &mdash; AI-generated test scenarios editable inline</li>
                <li><b>Session Context Recall</b> &mdash; automatic briefing at session start and full
                    <code>/jolli-recall</code> command for branch history</li>
                <li><b>Settings page</b> &mdash; Anthropic API key, model selection, and Jolli API key
                    at Settings &gt; Tools &gt; Jolli Memory</li>
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

// Fat JAR for hooks (standalone executable without IntelliJ dependencies)
tasks.register<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("hookJar") {
    archiveBaseName.set("jollimemory-hooks")
    archiveClassifier.set("")
    manifest {
        attributes["Main-Class"] = "ai.jolli.jollimemory.hooks.HookRunner"
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
    mergeServiceFiles()
}

// Add hooks JAR to the sandbox BEFORE buildPlugin zips it
tasks.named("prepareSandbox") {
    dependsOn("hookJar")
}

// After prepareSandbox completes, copy hooks JAR into the sandbox bin dir.
// Using bin/ instead of lib/ keeps the standalone hooks JAR off the plugin
// classloader path, so Plugin Verifier doesn't flag its bundled dependencies.
tasks.register("copyHookJarToSandbox") {
    dependsOn("prepareSandbox", "hookJar")
    doLast {
        val hookJar = tasks.named("hookJar").get().outputs.files.singleFile
        val pluginBin = layout.buildDirectory.dir("idea-sandbox/plugins/jollimemory-intellij/bin").get().asFile
        pluginBin.mkdirs()
        hookJar.copyTo(File(pluginBin, "jollimemory-hooks.jar"), overwrite = true)
        logger.lifecycle("Copied hooks JAR to: ${pluginBin}/jollimemory-hooks.jar")
    }
}

// buildSearchableOptions reads from sandbox — make sure hooks JAR is there
tasks.named("buildSearchableOptions") {
    dependsOn("copyHookJarToSandbox")
}

// After buildPlugin creates the zip, inject the hooks JAR into bin/ (not lib/)
tasks.named("buildPlugin") {
    dependsOn("copyHookJarToSandbox")
    doLast {
        val hookJar = layout.buildDirectory.file("idea-sandbox/plugins/jollimemory-intellij/bin/jollimemory-hooks.jar").get().asFile
        val zipFile = layout.buildDirectory.dir("distributions").get().asFile
            .listFiles()?.firstOrNull { it.name.endsWith(".zip") } ?: return@doLast

        // Add hooks JAR to bin/ in the existing zip (outside lib/ so Plugin Verifier skips it)
        ant.withGroovyBuilder {
            "zip"("destfile" to zipFile.absolutePath, "update" to true) {
                "zipfileset"("dir" to hookJar.parentFile.absolutePath, "prefix" to "jollimemory-intellij/bin") {
                    "include"("name" to "jollimemory-hooks.jar")
                }
            }
        }
        logger.lifecycle("Injected hooks JAR into: ${zipFile.name}")
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
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        }
    }

    // Workaround: IntelliJ Platform Gradle Plugin 2.5.0 fails to parse the Java
    // version from the downloaded IDE runtime, producing "JavaLanguageVersion must
    // be a positive integer, not ''". Explicitly set the JVM launcher for affected tasks.
    withType<JavaExec> {
        javaLauncher.set(
            project.the<JavaToolchainService>().launcherFor {
                languageVersion.set(JavaLanguageVersion.of(21))
            }
        )
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
        javaLauncher.set(
            project.the<JavaToolchainService>().launcherFor {
                languageVersion.set(JavaLanguageVersion.of(21))
            }
        )
    }
}
