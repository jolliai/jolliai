package ai.jolli.jollimemory.toolwindow.sidebar

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.FileChange
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.SummaryVirtualFile
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.BrowserUtil
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.io.File
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * JCEF-based sidebar panel that hosts the unified webview.
 *
 * Replicates the bridge pattern from SummaryPanel.kt:
 *   - JS → Kotlin: JBCefJSQuery with base64-encoded JSON
 *   - Kotlin → JS: executeJavaScript dispatching a CustomEvent
 *
 * The panel assembles HTML from the four builders (HTML, CSS, Script, Messages),
 * injects the JCEF bridge script, and routes messages between the webview and
 * the JolliMemoryService.
 */
class JCEFSidebarPanel(
	private val project: Project,
	private val parentDisposable: Disposable,
) : JPanel(BorderLayout()) {

	private var browser: JBCefBrowser? = null
	private var jsQuery: JBCefJSQuery? = null
	private var bridgeScript: String = ""
	private val gson = Gson()
	private var webviewReady = false
	private var selectedRepoName: String? = null
	private var selectedBranchName: String? = null
	private val selectedFilePaths = mutableSetOf<String>()
	private val selectedCommitHashes = mutableSetOf<String>()
	private var lastPushedBranchName: String? = null
	private val statusListener: () -> Unit = {
		if (webviewReady) {
			ApplicationManager.getApplication().executeOnPooledThread {
				// Detect branch changes and push dedicated branch name update
				val service = getService()
				val currentBranch = service?.currentBranchName
				if (currentBranch != null && currentBranch != lastPushedBranchName) {
					lastPushedBranchName = currentBranch
					pushBranchNameChanged(currentBranch, service.isDetached())
					pushReposAndBranches()
				}
				pushAllSections()
			}
		}
	}

	init {
		add(createContent(), BorderLayout.CENTER)
		subscribeToThemeChanges()
		// Auto-refresh when service status changes (git events, orphan ref updates, etc.)
		val service = project.getService(JolliMemoryService::class.java)
		service?.addStatusListener(statusListener)
		// Expose webview-side file selection so non-sidebar actions (CommitAIAction
		// etc.) can read it. The legacy Swing ChangesPanel used to register itself
		// in panelRegistry; with the JCEF rebuild that registration is gone, so
		// actions falling back to `service.getChangedFiles()` would commit ALL
		// files instead of the user's selection — this hook restores that contract.
		service?.webviewSelectedPaths = { selectedFilePaths.toSet() }
		service?.webviewSelectedCommitHashes = { selectedCommitHashes.toSet() }
		Disposer.register(parentDisposable, Disposable {
			if (service?.webviewSelectedPaths != null) service.webviewSelectedPaths = null
			if (service?.webviewSelectedCommitHashes != null) service.webviewSelectedCommitHashes = null
		})
		// Push auth state changes to webview
		val authDisposable = JolliAuthService.addAuthListener {
			if (webviewReady) {
				pushAuthChanged(JolliAuthService.isSignedIn())
			}
		}
		Disposer.register(parentDisposable, authDisposable)
	}

	val component: JComponent get() = this

	// ── JCEF setup ──────────────────────────────────────────────────────────

	private fun createContent(): JComponent {
		val b = JBCefBrowser()
		browser = b

		val query = JBCefJSQuery.create(b as JBCefBrowserBase)
		jsQuery = query
		Disposer.register(parentDisposable, query)
		Disposer.register(parentDisposable, b)

		query.addHandler { request ->
			try {
				val decoded = String(java.util.Base64.getDecoder().decode(request), Charsets.UTF_8)
				val json = JsonParser.parseString(decoded).asJsonObject
				dispatchWebviewMessage(json)
			} catch (e: Exception) {
				LOG.warn("Failed to parse sidebar message: ${e.message}", e)
			}
			JBCefJSQuery.Response("ok")
		}

		bridgeScript = """
			window.__jbQuery = function(msg) {
				${query.inject("msg")}
			};
		""".trimIndent()

		// Intercept link clicks → open in system browser
		b.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
			override fun onBeforeBrowse(
				browser: CefBrowser?,
				frame: CefFrame?,
				request: CefRequest?,
				userGesture: Boolean,
				isRedirect: Boolean,
			): Boolean {
				val url = request?.url ?: return false
				if (url.startsWith("http://") || url.startsWith("https://")) {
					BrowserUtil.browse(url)
					return true
				}
				return false
			}
		}, b.cefBrowser)

		b.loadHTML(buildFullHtml())
		return b.component
	}

	private fun buildFullHtml(): String {
		val themeVars = SidebarCssBuilder.buildThemeVars()
		val css = SidebarCssBuilder.buildCss()
		val codiconCss = loadCodiconCss()
		val mainScript = SidebarScriptBuilder.buildScript()
		return SidebarHtmlBuilder.buildHtml(themeVars, css, codiconCss, bridgeScript, mainScript)
	}

	/**
	 * Load codicon.css from resources and rewrite the @font-face url to a
	 * data: URI, since JCEF's loadHTML has no base URL for relative paths.
	 */
	private fun loadCodiconCss(): String {
		val cssStream = javaClass.getResourceAsStream("/codicons/codicon.css")
			?: return "/* codicon.css not found */"
		var css = cssStream.bufferedReader().readText()

		val ttfStream = javaClass.getResourceAsStream("/codicons/codicon.ttf")
		if (ttfStream != null) {
			val ttfBytes = ttfStream.readBytes()
			val b64 = java.util.Base64.getEncoder().encodeToString(ttfBytes)
			val dataUri = "data:font/truetype;base64,$b64"
			css = css.replace(Regex("""url\([^)]*codicon\.ttf[^)]*\)"""), "url('$dataUri')")
		}

		return css
	}

	// ── Theme change listener ───────────────────────────────────────────────

	private fun subscribeToThemeChanges() {
		val connection = ApplicationManager.getApplication().messageBus.connect(parentDisposable)
		connection.subscribe(LafManagerListener.TOPIC, LafManagerListener {
			reload()
		})
	}

	/** Rebuild HTML with updated theme vars and reload the webview. */
	fun reload() {
		webviewReady = false
		browser?.loadHTML(buildFullHtml())
	}

	// ── Kotlin → JS (post to webview) ───────────────────────────────────────

	fun postToWebview(command: String, data: Map<String, Any?> = emptyMap()) {
		val payload = gson.toJson(data + ("command" to command))
		val b64 = java.util.Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
		browser?.cefBrowser?.executeJavaScript(
			"window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
			browser?.cefBrowser?.url ?: "",
			0,
		)
	}

	// ── JS → Kotlin (message dispatch) ──────────────────────────────────────

	private fun dispatchWebviewMessage(json: com.google.gson.JsonObject) {
		val type = json.get("type")?.asString ?: return
		LOG.debug("Sidebar message: $type")

		when (type) {
			"ready" -> handleReady()
			"command" -> handleCommand(json)
			"kb:expandFolder" -> handleKbExpandFolder(json)
			"kb:openMemory" -> handleKbOpenMemory(json)
			"kb:openFile" -> handleKbOpenFile(json)
			"kb:setMode" -> {
				val mode = json.get("mode")?.asString ?: return
				if (mode == "memories") {
					ApplicationManager.getApplication().executeOnPooledThread { pushMemoriesData() }
				}
			}
			"kb:search" -> {
				val query = json.get("query")?.asString ?: ""
				ApplicationManager.getApplication().executeOnPooledThread { pushMemoriesData(filter = query) }
			}
			"kb:clearSearch" -> {
				ApplicationManager.getApplication().executeOnPooledThread { pushMemoriesData() }
			}
			"kb:loadMore" -> {
				// Increase limit for pagination
				ApplicationManager.getApplication().executeOnPooledThread { pushMemoriesData(limit = 200) }
			}
			"branch:openCommit" -> handleBranchOpenCommit(json)
			"branch:openChange" -> handleBranchOpenChange(json)
			"branch:openPlan" -> handleBranchOpenPlan(json)
			"branch:openNote" -> handleBranchOpenNote(json)
			"branch:discardFile" -> handleBranchDiscardFile(json)
			"branch:toggleFileSelection" -> handleToggleFileSelection(json)
			// TODO(remove): debug log dispatch paired with jbLog() in SidebarScriptBuilder.kt.
			"debug:log" -> LOG.info("[jbDebug] ${json.get("message")?.asString ?: ""}")
			"branch:toggleCommitSelection" -> handleToggleCommitSelection(json)
			"selection:request" -> handleSelectionRequest(json)
			"selection:requestBranchMemories" -> {
				val repo = json.get("repoName")?.asString ?: return
				val branch = json.get("branchName")?.asString ?: return
				ApplicationManager.getApplication().executeOnPooledThread {
					pushBranchMemoriesForSelection(repo, branch)
				}
			}
			"tab:switched" -> { /* UI-only, no host action needed */ }
			"section:toggle" -> { /* UI-only, no host action needed */ }
			"refresh" -> handleRefresh(json)
			else -> LOG.debug("Unhandled sidebar message type: $type")
		}
	}

	// ── Message handlers ────────────────────────────────────────────────────

	private fun getService(): JolliMemoryService? =
		project.getService(JolliMemoryService::class.java)

	private fun handleReady() {
		webviewReady = true
		LOG.info("Sidebar webview ready")
		pushInit()
		ApplicationManager.getApplication().executeOnPooledThread {
			pushReposAndBranches()
			pushAllSections()
		}
	}

	private fun isViewingForeign(): Boolean {
		val service = getService() ?: return false
		val repoForeign = selectedRepoName != null && selectedRepoName != service.currentRepoName
		val branchForeign = selectedBranchName != null && selectedBranchName != service.currentBranchName
		return repoForeign || branchForeign
	}

	private fun warnForeignReadOnly() {
		ApplicationManager.getApplication().invokeLater {
			com.intellij.openapi.ui.Messages.showWarningDialog(
				project,
				"This view is read-only — switch back to your workspace branch to make changes.",
				"Jolli Memory",
			)
		}
	}

	private fun handleCommand(json: com.google.gson.JsonObject) {
		val command = json.get("command")?.asString ?: return
		LOG.info("Sidebar command: $command")
		if (command in MUTATING_COMMANDS && isViewingForeign()) {
			LOG.warn("Refusing mutating command '$command' in foreign read-only view")
			warnForeignReadOnly()
			return
		}
		val service = getService() ?: return
		val args = json.get("args")?.asJsonArray
		val firstArg = args?.firstOrNull()
		when (command) {
			"jollimemory.enable" -> {
				service.install()
				pushEnabledChanged(service.isEnabled())
			}
			"jollimemory.disable" -> {
				service.uninstall()
				pushEnabledChanged(service.isEnabled())
			}
			"jollimemory.refresh" -> {
				ApplicationManager.getApplication().executeOnPooledThread { pushAllSections() }
			}
			"jollimemory.openSettings" -> {
				ApplicationManager.getApplication().invokeLater {
					ai.jolli.jollimemory.toolwindow.SettingsDialog(project, service).show()
				}
			}
			"jollimemory.commitAI" -> invokeAction("JolliMemory.CommitAI")
			"jollimemory.addPlan" -> invokeAction("JolliMemory.AddPlan")
			"jollimemory.addMarkdownNote" -> ai.jolli.jollimemory.actions.AddNoteAction.openMarkdownPicker(project)
			"jollimemory.addTextSnippet" -> ai.jolli.jollimemory.actions.AddNoteAction.openSnippetEditor(project)
			"jollimemory.editPlan" -> {
				val planId = firstArg?.asString ?: return
				openPlanFile(planId)
			}
			"jollimemory.editNote" -> {
				val noteId = firstArg?.asString ?: return
				openNoteFile(noteId)
			}
			"jollimemory.removePlan" -> {
				val planId = firstArg?.asString ?: return
				ApplicationManager.getApplication().invokeLater {
					val cwd = service.mainRepoRoot ?: project.basePath ?: return@invokeLater
					val registry = SessionTracker.loadPlansRegistry(cwd)
					val entry = registry.plans[planId] ?: return@invokeLater
					val title = entry.title.ifBlank { planId }
					val result = com.intellij.openapi.ui.Messages.showYesNoDialog(
						project,
						"Remove plan \"$title\" from the list?",
						"Remove Plan",
						com.intellij.openapi.ui.Messages.getQuestionIcon(),
					)
					if (result != com.intellij.openapi.ui.Messages.YES) return@invokeLater
					ApplicationManager.getApplication().executeOnPooledThread {
						val updatedPlans = registry.plans.toMutableMap()
						updatedPlans[planId] = entry.copy(ignored = true)
						SessionTracker.savePlansRegistry(registry.copy(plans = updatedPlans), cwd)
						service.refreshStatus()
						pushPlansData()
					}
				}
			}
			"jollimemory.removeNote" -> {
				val noteId = firstArg?.asString ?: return
				ApplicationManager.getApplication().invokeLater {
					val cwd = service.mainRepoRoot ?: project.basePath ?: return@invokeLater
					val registry = SessionTracker.loadPlansRegistry(cwd)
					val notes = (registry.notes ?: emptyMap()).toMutableMap()
					val note = notes[noteId] ?: return@invokeLater
					val result = com.intellij.openapi.ui.Messages.showYesNoDialog(
						project,
						"Remove note \"${note.title}\" from the list?",
						"Remove Note",
						com.intellij.openapi.ui.Messages.getQuestionIcon(),
					)
					if (result != com.intellij.openapi.ui.Messages.YES) return@invokeLater
					ApplicationManager.getApplication().executeOnPooledThread {
						if (note.commitHash == null && note.format == NoteFormat.snippet && note.sourcePath != null) {
							try { File(note.sourcePath).takeIf { it.exists() }?.delete() } catch (_: Exception) {}
						}
						notes.remove(noteId)
						SessionTracker.savePlansRegistry(registry.copy(notes = notes), cwd)
						service.refreshStatus()
						pushPlansData()
					}
				}
			}
			"jollimemory.viewSummary", "jollimemory.viewMemorySummary" -> {
				val hash = firstArg?.asString ?: return
				openSummaryEditor(hash)
			}
			"jollimemory.copyCommitHash" -> {
				val hash = firstArg?.asString ?: return
				val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
				clipboard.setContents(java.awt.datatransfer.StringSelection(hash), null)
			}
			"jollimemory.copyRecallPrompt" -> {
				val hash = firstArg?.asString ?: return
				ApplicationManager.getApplication().executeOnPooledThread {
					val summary = service.getSummary(hash)
					if (summary == null) {
						ApplicationManager.getApplication().invokeLater {
							com.intellij.openapi.ui.Messages.showWarningDialog(
								project,
								"No summary found for this commit.",
								"Copy Recall Prompt",
							)
						}
						return@executeOnPooledThread
					}
					val prompt = "Use the Skill tool to execute the \"jolli-recall\" skill with args \"${summary.branch}\"."
					val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
					clipboard.setContents(java.awt.datatransfer.StringSelection(prompt), null)
				}
			}
			"jollimemory.selectAllFiles" -> {
				// Toggle: if all files are already selected, deselect all; otherwise select all
				val service2 = getService() ?: return
				val paths = service2.getChangedFiles().map { it.relativePath }
				val allSelected = paths.isNotEmpty() && paths.all { selectedFilePaths.contains(it) }
				if (allSelected) selectedFilePaths.removeAll(paths.toSet()) else selectedFilePaths.addAll(paths)
				pushChangesData()
			}
			"jollimemory.discardSelectedChanges" -> handleDiscardSelectedChanges()
			"jollimemory.squash" -> invokeAction("JolliMemory.Squash")
			"jollimemory.pushBranch" -> {
				val cwd = service.mainRepoRoot ?: project.basePath ?: return
				ApplicationManager.getApplication().executeOnPooledThread {
					try {
						ai.jolli.jollimemory.services.PrService.pushBranch(cwd)
						ApplicationManager.getApplication().invokeLater {
							com.intellij.openapi.ui.Messages.showInfoMessage(project, "Branch pushed.", "Jolli Memory")
						}
					} catch (ex: Exception) {
						LOG.warn("Push branch failed", ex)
						ApplicationManager.getApplication().invokeLater {
							com.intellij.openapi.ui.Messages.showErrorDialog(project, "Push failed: ${ex.message ?: ex.javaClass.simpleName}", "Jolli Memory")
						}
					}
				}
			}
			"jollimemory.selectAllCommits" -> {
				// Mirror jollimemory.selectAllFiles: toggle the host-tracked set,
				// then push refreshed data so the JS re-renders with isSelected.
				val service2 = getService() ?: return
				val hashes = service2.getBranchCommits().map { it.hash }
				val allSelected = hashes.isNotEmpty() && hashes.all { selectedCommitHashes.contains(it) }
				if (allSelected) selectedCommitHashes.removeAll(hashes.toSet())
				else selectedCommitHashes.addAll(hashes)
				ApplicationManager.getApplication().executeOnPooledThread { pushCommitsData() }
			}
			"jollimemory.openCommitFileChange" -> {
				val payload = if (firstArg?.isJsonObject == true) firstArg.asJsonObject else return
				val commitHash = payload.get("commitHash")?.asString ?: return
				val relativePath = payload.get("relativePath")?.asString ?: return
				val statusCode = payload.get("statusCode")?.asString ?: "M"
				val oldPath = payload.get("oldPath")?.asString
				openCommitFileDiff(commitHash, relativePath, statusCode, oldPath)
			}
		}
	}

	private fun handleKbExpandFolder(json: com.google.gson.JsonObject) {
		val folderPath = json.get("path")?.asString ?: return
		LOG.debug("KB expand folder: $folderPath")
		ApplicationManager.getApplication().executeOnPooledThread {
			val items = listKbChildren(folderPath)
			pushKbFolders(folderPath, items)
		}
	}

	private fun handleKbOpenMemory(json: com.google.gson.JsonObject) {
		val commitHash = json.get("commitHash")?.asString ?: return
		LOG.debug("KB open memory: $commitHash")
		openSummaryEditor(commitHash)
	}

	private fun handleKbOpenFile(json: com.google.gson.JsonObject) {
		// JS posts the kbRoot-relative path as `fileKey` (see SidebarScriptBuilder.kt
		// click handler); the previous `json.get("path")` was a pre-existing wire
		// mismatch that made every KB folder-tree click a silent no-op.
		val fileKey = json.get("fileKey")?.asString ?: return
		LOG.debug("KB open file: $fileKey")
		val service = getService() ?: return
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)
		// fileKey is kbRoot-relative like "main/some-file.md"
		ApplicationManager.getApplication().executeOnPooledThread {
			for (repo in discovered) {
				val file = repo.kbRoot.resolve(fileKey)
				if (!java.nio.file.Files.exists(file)) continue

				// If this is a memory-summary .md, try to open the rich Summary
				// panel by loading the JSON sidecar from THIS repo's kbRoot
				// (cross-repo support — mirrors VS Code's
				// `getSummaryAnyRepoWithSource`). Fall back to plain-text open
				// when the sidecar is missing or unparseable, matching VS Code's
				// "frontmatter looked like a summary but the bridge couldn't
				// load it" fallback at Extension.ts:1939.
				val commitHash = if (file.toString().endsWith(".md")) parseSummaryFrontmatter(file) else null
				if (commitHash != null) {
					val summary = loadSummaryFromKbRoot(repo.kbRoot, commitHash)
						?: service.getSummary(commitHash) // last-ditch: current-repo orphan branch
					if (summary != null) {
						ApplicationManager.getApplication().invokeLater {
							FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary), true)
						}
						return@executeOnPooledThread
					}
					LOG.warn("KB open: frontmatter referenced commit $commitHash but no summary found; falling back to plain text")
				}

				val vf = LocalFileSystem.getInstance().findFileByPath(file.toString())
				if (vf != null) {
					ApplicationManager.getApplication().invokeLater {
						FileEditorManager.getInstance(project).openFile(vf, true)
					}
				}
				return@executeOnPooledThread
			}
		}
	}

	/**
	 * Returns the commitHash if [file] is a memory-summary markdown (frontmatter
	 * `type: commit` + `commitHash: <hash>`); returns null for plan/note copies,
	 * files without frontmatter, or anything that fails to parse. Caller falls
	 * back to a plain editor open in those cases. Port of VS Code's
	 * `parseSummaryFrontmatter` in cli/src/views/Extension.ts.
	 */
	private fun parseSummaryFrontmatter(file: java.nio.file.Path): String? {
		val raw = try {
			java.nio.file.Files.readString(file)
		} catch (_: Exception) {
			return null
		}
		if (!raw.startsWith("---\n")) return null
		val closing = raw.indexOf("\n---", 4)
		if (closing == -1) return null
		val block = raw.substring(4, closing)
		var type: String? = null
		var commitHash: String? = null
		for (line in block.lines()) {
			val idx = line.indexOf(':')
			if (idx == -1) continue
			val key = line.substring(0, idx).trim()
			val value = line.substring(idx + 1).trim()
			if (key == "type") type = value
			else if (key == "commitHash") commitHash = value
		}
		return if (type == "commit" && !commitHash.isNullOrBlank()) commitHash else null
	}

	/**
	 * Loads a CommitSummary directly from a Memory Bank kbRoot's JSON sidecar
	 * (`<kbRoot>/.jolli/summaries/<hash>.json`). Used for cross-repo summary
	 * lookups in the KB folder view — bypasses the current-repo-only
	 * `service.getSummary()` path so memories from sibling repos open properly.
	 */
	private fun loadSummaryFromKbRoot(kbRoot: java.nio.file.Path, commitHash: String): ai.jolli.jollimemory.core.CommitSummary? {
		val jsonFile = kbRoot.resolve(".jolli/summaries/$commitHash.json")
		if (!java.nio.file.Files.exists(jsonFile)) return null
		return try {
			val raw = java.nio.file.Files.readString(jsonFile)
			Gson().fromJson(raw, ai.jolli.jollimemory.core.CommitSummary::class.java)
		} catch (e: Exception) {
			LOG.warn("Failed to load summary $commitHash from $kbRoot: ${e.message}")
			null
		}
	}

	private fun handleBranchOpenCommit(json: com.google.gson.JsonObject) {
		val hash = json.get("hash")?.asString ?: return
		LOG.debug("Branch open commit: $hash")
		openSummaryEditor(hash)
	}

	private fun handleBranchOpenChange(json: com.google.gson.JsonObject) {
		val filePath = json.get("filePath")?.asString ?: return
		LOG.debug("Branch open change: $filePath")
		openFileDiff(filePath)
	}

	private fun handleBranchOpenPlan(json: com.google.gson.JsonObject) {
		val planId = json.get("planId")?.asString ?: return
		LOG.debug("Branch open plan: $planId")
		openPlanFile(planId)
	}

	private fun handleBranchOpenNote(json: com.google.gson.JsonObject) {
		val noteId = json.get("noteId")?.asString ?: return
		LOG.debug("Branch open note: $noteId")
		openNoteFile(noteId)
	}

	private fun handleBranchDiscardFile(json: com.google.gson.JsonObject) {
		if (isViewingForeign()) {
			LOG.warn("Refusing branch:discardFile in foreign read-only view")
			warnForeignReadOnly()
			return
		}
		val filePath = json.get("filePath")?.asString ?: return
		val indexStatus = json.get("indexStatus")?.asString ?: ""
		val worktreeStatus = json.get("worktreeStatus")?.asString ?: ""
		val originalPath = json.get("originalPath")?.asString?.takeIf { it.isNotBlank() }
		LOG.debug("Branch discard file: $filePath (index=$indexStatus, worktree=$worktreeStatus, orig=$originalPath)")
		val service = getService() ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			val gitOps = service.getGitOps() ?: return@executeOnPooledThread
			val repoRoot = service.mainRepoRoot ?: project.basePath
			discardSingleFile(gitOps, repoRoot, filePath, indexStatus, worktreeStatus, originalPath)
			pushChangesData()
		}
	}

	/**
	 * Dispatch table matching VS Code's `JolliMemoryBridge.discardFiles`. The
	 * indexStatus column drives the choice; A/C (added) and R (renamed) are
	 * special-cased because they require disk deletion in addition to unstaging.
	 */
	private fun discardSingleFile(
		gitOps: ai.jolli.jollimemory.bridge.GitOps,
		repoRoot: String?,
		filePath: String,
		indexStatus: String,
		worktreeStatus: String,
		originalPath: String?,
	) {
		when {
			// Untracked — delete from disk; git doesn't track it.
			indexStatus == "?" && worktreeStatus == "?" -> {
				if (repoRoot != null) {
					try { File("$repoRoot/$filePath").delete() } catch (_: Exception) {}
				}
			}
			// Newly added / copied — unstage, then delete from disk.
			indexStatus == "A" || indexStatus == "C" -> {
				gitOps.exec("restore", "--staged", "--", filePath)
				if (repoRoot != null) {
					try { File("$repoRoot/$filePath").delete() } catch (_: Exception) {}
				}
			}
			// Renamed — unstage both sides, restore the old path, remove the new.
			indexStatus == "R" -> {
				val restorePaths = if (originalPath != null) arrayOf("restore", "--staged", "--", filePath, originalPath)
				else arrayOf("restore", "--staged", "--", filePath)
				gitOps.exec(*restorePaths)
				if (originalPath != null) {
					gitOps.exec("restore", "--", originalPath)
				}
				if (repoRoot != null) {
					try { File("$repoRoot/$filePath").delete() } catch (_: Exception) {}
				}
			}
			// Staged + worktree modify — restore both.
			indexStatus.isNotBlank() && indexStatus != " " && worktreeStatus.isNotBlank() && worktreeStatus != " " -> {
				gitOps.exec("restore", "--staged", "--worktree", "--", filePath)
			}
			// Staged-only modify — unstage.
			indexStatus.isNotBlank() && indexStatus != " " -> {
				gitOps.exec("restore", "--staged", "--", filePath)
			}
			// Worktree-only modify — discard working-tree changes.
			else -> {
				gitOps.exec("restore", "--", filePath)
			}
		}
	}

	private fun handleDiscardSelectedChanges() {
		val service = getService() ?: return
		val changes = service.getChangedFiles()
		val selected = changes.filter { selectedFilePaths.contains(it.relativePath) }
		if (selected.isEmpty()) {
			ApplicationManager.getApplication().invokeLater {
				com.intellij.openapi.ui.Messages.showInfoMessage(
					project,
					"No files selected to discard.",
					"Jolli Memory",
				)
			}
			return
		}
		ApplicationManager.getApplication().invokeLater {
			val count = selected.size
			val deletedCount = selected.count {
				val idx = it.statusCode.firstOrNull()
				idx == '?' || idx == 'A' || idx == 'R'
			}
			val maxPreview = 10
			val preview = selected.take(maxPreview).joinToString("\n") { it.relativePath }
			val overflow = if (count > maxPreview) "\n…and ${count - maxPreview} more" else ""
			val deleteWarning = if (deletedCount > 0)
				"\n\n⚠ $deletedCount file${if (deletedCount != 1) "s" else ""} will be permanently deleted from disk (new/untracked/renamed)."
			else ""
			val message = "$preview$overflow$deleteWarning\n\nThis cannot be undone."
			val title = "Discard changes to $count selected file${if (count != 1) "s" else ""}?"
			val choice = com.intellij.openapi.ui.Messages.showOkCancelDialog(
				project,
				message,
				title,
				"Discard All",
				com.intellij.openapi.ui.Messages.getCancelButton(),
				com.intellij.openapi.ui.Messages.getWarningIcon(),
			)
			if (choice != com.intellij.openapi.ui.Messages.OK) return@invokeLater
			ApplicationManager.getApplication().executeOnPooledThread {
				val gitOps = service.getGitOps() ?: return@executeOnPooledThread
				val repoRoot = service.mainRepoRoot ?: project.basePath
				for (change in selected) {
					val statusCode = change.statusCode
					val indexStatus = if (statusCode.length >= 1) statusCode.substring(0, 1) else " "
					val worktreeStatus = if (statusCode.length >= 2) statusCode.substring(1, 2) else " "
					discardSingleFile(gitOps, repoRoot, change.relativePath, indexStatus, worktreeStatus, change.oldPath)
				}
				selectedFilePaths.removeAll(selected.map { it.relativePath }.toSet())
				pushChangesData()
			}
		}
	}

	private fun handleToggleFileSelection(json: com.google.gson.JsonObject) {
		val filePath = json.get("filePath")?.asString ?: return
		val selected = json.get("selected")?.asBoolean ?: return
		LOG.debug("Toggle file selection: $filePath = $selected")
		if (selected) selectedFilePaths.add(filePath) else selectedFilePaths.remove(filePath)
		pushChangesData()
	}

	private fun handleToggleCommitSelection(json: com.google.gson.JsonObject) {
		val hash = json.get("hash")?.asString ?: return
		val selected = json.get("selected")?.asBoolean ?: return
		LOG.debug("Toggle commit selection: $hash = $selected")
		if (selected) selectedCommitHashes.add(hash) else selectedCommitHashes.remove(hash)
		ApplicationManager.getApplication().executeOnPooledThread { pushCommitsData() }
	}

	private fun handleSelectionRequest(json: com.google.gson.JsonObject) {
		val repoName = json.get("repoName")?.asString
		val branchName = json.get("branchName")?.asString
		LOG.debug("Selection request: repo=$repoName branch=$branchName")

		if (repoName != null) {
			selectedRepoName = repoName
			selectedBranchName = null
			// Push branches for the newly selected repo
			val service = getService() ?: return
			ApplicationManager.getApplication().executeOnPooledThread {
				val branches = listBranchesForRepo(repoName)
				selectedBranchName = branches.firstOrNull()
				pushBranches(branches, repoName)
				postToWebview("selection:set", mapOf(
					"repoName" to selectedRepoName,
					"branchName" to selectedBranchName,
				))
				// If foreign repo, push branch memories
				if (repoName != service.currentRepoName && selectedBranchName != null) {
					pushBranchMemoriesForSelection(repoName, selectedBranchName!!)
				}
			}
		} else if (branchName != null) {
			selectedBranchName = branchName
			postToWebview("selection:set", mapOf(
				"repoName" to selectedRepoName,
				"branchName" to branchName,
			))
			val service = getService() ?: return
			val repo = selectedRepoName ?: service.currentRepoName ?: return
			// Push branch memories for any non-current branch (foreign repo or different branch)
			val isForeign = repo != service.currentRepoName || branchName != service.currentBranchName
			if (isForeign) {
				ApplicationManager.getApplication().executeOnPooledThread {
					pushBranchMemoriesForSelection(repo, branchName)
				}
			}
		}
	}

	private fun handleRefresh(json: com.google.gson.JsonObject? = null) {
		val scope = json?.get("scope")?.asString ?: "all"
		LOG.debug("Refresh requested (scope=$scope)")
		val service = getService() ?: return
		service.refreshStatus()
		ApplicationManager.getApplication().executeOnPooledThread {
			if (scope == "kb" || scope == "all") {
				pushKbRootFolders()
				pushMemoriesData()
			}
			if (scope == "branch" || scope == "all") {
				pushPlansData()
				pushChangesData()
				pushCommitsData()
				postToWebview("selection:invalidateBranchMemories", emptyMap())
			}
			if (scope == "status" || scope == "all") {
				pushStatusData()
			}
		}
	}

	private fun invokeAction(actionId: String) {
		ApplicationManager.getApplication().invokeLater {
			val action = com.intellij.openapi.actionSystem.ActionManager.getInstance()
				.getAction(actionId) ?: return@invokeLater
			val dataContext = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
				.add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
				.build()
			val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(
				action,
				null,
				com.intellij.openapi.actionSystem.ActionPlaces.UNKNOWN,
				dataContext,
			)
			action.actionPerformed(event)
		}
	}

	// ── Actions (open editors, diffs) ───────────────────────────────────────

	private fun openSummaryEditor(commitHash: String) {
		val service = getService() ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			val summary = service.getSummary(commitHash) ?: return@executeOnPooledThread
			ApplicationManager.getApplication().invokeLater {
				FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary), true)
			}
		}
	}

	private fun openFileDiff(filePath: String) {
		val service = getService() ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			val repoRoot = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
			val change = service.getChangedFiles().find { it.relativePath == filePath }
				?: return@executeOnPooledThread

			when (change.statusCode) {
				"A", "??" -> {
					val file = LocalFileSystem.getInstance()
						.findFileByPath("$repoRoot/${change.relativePath}")
						?: return@executeOnPooledThread
					ApplicationManager.getApplication().invokeLater {
						FileEditorManager.getInstance(project).openFile(file, true)
					}
				}
				"D" -> {
					val gitOps = service.getGitOps() ?: return@executeOnPooledThread
					val headContent = gitOps.exec("show", "HEAD:${change.relativePath}") ?: ""
					val fileType = FileTypeManager.getInstance()
						.getFileTypeByFileName(change.relativePath)
					val left = LightVirtualFile("${change.relativePath} (HEAD)", fileType, headContent)
					val right = LightVirtualFile("${change.relativePath} (Deleted)", fileType, "")
					right.isWritable = false
					val request = SimpleDiffRequest(
						"${change.relativePath} (Deleted)",
						DiffContentFactory.getInstance().create(project, left),
						DiffContentFactory.getInstance().create(project, right),
						"HEAD", "Deleted",
					)
					ApplicationManager.getApplication().invokeLater {
						DiffManager.getInstance().showDiff(project, request)
					}
				}
				else -> {
					val gitOps = service.getGitOps() ?: return@executeOnPooledThread
					val headContent = gitOps.exec("show", "HEAD:${change.relativePath}") ?: ""
					val diskFile = File("$repoRoot/${change.relativePath}")
					val diskContent = if (diskFile.exists()) diskFile.readText() else ""
					val fileType = FileTypeManager.getInstance()
						.getFileTypeByFileName(change.relativePath)
					val left = LightVirtualFile("${change.relativePath} (HEAD)", fileType, headContent)
					val right = LightVirtualFile("${change.relativePath} (Working Tree)", fileType, diskContent)
					val request = SimpleDiffRequest(
						"${change.relativePath} (HEAD \u2194 Working Tree)",
						DiffContentFactory.getInstance().create(project, left),
						DiffContentFactory.getInstance().create(project, right),
						"HEAD", "Working Tree",
					)
					ApplicationManager.getApplication().invokeLater {
						DiffManager.getInstance().showDiff(project, request)
					}
				}
			}
		}
	}

	private fun openPlanFile(planId: String) {
		val service = getService() ?: return
		val repoRoot = service.mainRepoRoot ?: project.basePath ?: return
		val registry = SessionTracker.loadPlansRegistry(repoRoot)
		val plan = registry.plans[planId] ?: return
		val file = LocalFileSystem.getInstance().findFileByPath(plan.sourcePath) ?: return
		ApplicationManager.getApplication().invokeLater {
			FileEditorManager.getInstance(project).openFile(file, true)
		}
	}

	private fun openNoteFile(noteId: String) {
		val service = getService() ?: return
		val repoRoot = service.mainRepoRoot ?: project.basePath ?: return
		val registry = SessionTracker.loadPlansRegistry(repoRoot)
		val note = registry.notes?.get(noteId) ?: return
		val notePath = note.sourcePath
			?: "$repoRoot/.jolli/jollimemory/notes/$noteId.md"
		val file = LocalFileSystem.getInstance().findFileByPath(notePath) ?: return
		ApplicationManager.getApplication().invokeLater {
			FileEditorManager.getInstance(project).openFile(file, true)
		}
	}

	private fun openCommitFileDiff(commitHash: String, relativePath: String, statusCode: String, oldPath: String?) {
		val service = getService() ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			val gitOps = service.getGitOps() ?: return@executeOnPooledThread
			val beforePath = oldPath ?: relativePath
			val beforeContent = when (statusCode) {
				"A" -> ""
				else -> gitOps.exec("show", "$commitHash~1:$beforePath") ?: ""
			}
			val afterContent = when (statusCode) {
				"D" -> ""
				else -> gitOps.exec("show", "$commitHash:$relativePath") ?: ""
			}
			val fileName = File(relativePath).name
			val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)
			val shortHash = commitHash.take(8)
			ApplicationManager.getApplication().invokeLater {
				val left = DiffContentFactory.getInstance().create(project, beforeContent, fileType)
				val right = DiffContentFactory.getInstance().create(project, afterContent, fileType)
				val request = SimpleDiffRequest(
					"$relativePath ($shortHash)",
					left, right,
					"$shortHash~1", shortHash,
				)
				DiffManager.getInstance().showDiff(project, request)
			}
		}
	}

	// ── Serializers (Kotlin data → Map for JSON) ────────────────────────────

	private fun serializeCommit(c: CommitSummaryBrief): Map<String, Any?> {
		val service = getService()
		val children = service?.listCommitFiles(c.hash)?.map { f ->
			mapOf(
				"id" to "${c.hash}:${f.relativePath}",
				"label" to f.relativePath.substringAfterLast('/'),
				"description" to f.relativePath.substringBeforeLast('/', ""),
				"gitStatus" to f.statusCode,
				"originalPath" to f.oldPath,
				"commitFile" to mapOf(
					"commitHash" to c.hash,
					"relativePath" to f.relativePath,
					"statusCode" to f.statusCode,
					"oldPath" to f.oldPath,
				),
			)
		} ?: emptyList()

		val statsLine = buildString {
			if (c.topicCount > 0) append("${c.topicCount} topic${if (c.topicCount != 1) "s" else ""}")
			if (c.filesChanged > 0) {
				if (isNotEmpty()) append(", ")
				append("${c.filesChanged} file${if (c.filesChanged != 1) "s" else ""} changed")
			}
			if (c.insertions > 0) { append(", ${c.insertions} insertion${if (c.insertions != 1) "s" else ""}(+)") }
			if (c.deletions > 0) { append(", ${c.deletions} deletion${if (c.deletions != 1) "s" else ""}(-)") }
		}

		return mapOf(
			"id" to c.hash,
			"label" to c.message.ifBlank { c.shortHash },
			"description" to c.shortDate,
			"iconKey" to "git-commit",
			"collapsibleState" to "collapsed",
			"isSelected" to selectedCommitHashes.contains(c.hash),
			"hasMemory" to c.hasSummary,
			"contextValue" to if (c.hasSummary) "commitWithMemory" else "commit",
			"children" to children,
			"hover" to mapOf(
				"message" to c.message,
				"relativeDate" to c.shortDate,
				"commitType" to c.commitType,
				"branch" to (service?.currentBranchName ?: ""),
				"statsLine" to statsLine,
				"shortHash" to c.shortHash,
			),
		)
	}

	private fun serializeFileChange(change: FileChange, isSelected: Boolean = true): Map<String, Any?> {
		// statusCode is the raw 2-char porcelain XY. For the visible status letter,
		// collapse to a single representative char (the non-space one); for the
		// split indexStatus/worktreeStatus we keep the raw chars so the discard
		// dispatch can tell staged-only vs worktree-only apart.
		val displayStatus = if (change.statusCode == "??") "U" else change.statusCode.trim()
		val fileName = change.relativePath.substringAfterLast('/')
		val parentDir = change.relativePath.substringBeforeLast('/', "")
		return mapOf(
			"id" to change.relativePath,
			"label" to fileName,
			"description" to parentDir,
			"gitStatus" to displayStatus,
			"isSelected" to isSelected,
			"contextValue" to "fileChange",
			"indexStatus" to (if (change.statusCode.length >= 1) change.statusCode.substring(0, 1) else " "),
			"worktreeStatus" to (if (change.statusCode.length >= 2) change.statusCode.substring(1, 2) else " "),
			"originalPath" to change.oldPath,
		)
	}

	private fun serializePlan(slug: String, plan: PlanEntry): Map<String, Any?> {
		val iconKey = if (plan.commitHash != null) "lock" else "file-text"
		return mapOf(
			"id" to slug,
			"label" to plan.title.ifBlank { slug },
			"description" to "${plan.editCount} edit${if (plan.editCount != 1) "s" else ""}",
			"iconKey" to iconKey,
			"tooltip" to "${slug}.md\nBranch: ${plan.branch}\nUpdated: ${plan.updatedAt}",
			"contextValue" to "plan",
		)
	}

	private fun serializeNote(note: NoteEntry): Map<String, Any?> {
		val iconKey = when {
			note.commitHash != null -> "lock"
			note.format == NoteFormat.snippet -> "comment"
			else -> "note"
		}
		val formatStr = if (note.format == NoteFormat.snippet) "snippet" else "markdown"
		return mapOf(
			"id" to note.id,
			"label" to note.title,
			"description" to formatStr,
			"iconKey" to iconKey,
			"tooltip" to "${note.id}\nFormat: $formatStr\nBranch: ${note.branch}\nUpdated: ${note.updatedAt}",
			"contextValue" to "note",
		)
	}

	private fun serializeStatusEntries(): List<Map<String, Any?>> {
		val service = getService() ?: return emptyList()
		val status = service.getStatus() ?: return emptyList()
		val entries = mutableListOf<Map<String, Any?>>()

		// Hooks row
		val hookParts = mutableListOf<String>()
		if (status.gitHookInstalled) hookParts.add("3 Git")
		if (status.claudeHookInstalled) hookParts.add("2 Claude")
		if (status.geminiHookInstalled) hookParts.add("1 Gemini CLI")
		entries.add(mapOf(
			"id" to "hooks",
			"label" to "Hooks",
			"description" to if (hookParts.isNotEmpty()) hookParts.joinToString(" + ") else "none installed",
			"iconKey" to if (status.gitHookInstalled) "check" else "x",
		))

		// AI Summary Provider row — mirrors VS Code's pushProviderItem.
		entries.add(serializeProviderEntry())

		// Per-agent integration rows — mirrors VS Code's pushIntegrationItem.
		// Cursor / Copilot / scan-error rows aren't surfaced here because the
		// Kotlin status fetcher doesn't track those fields yet; they can be
		// added when JolliMemoryService grows detection for them.
		val config = ai.jolli.jollimemory.core.SessionTracker.loadConfig()
		integrationEntry(
			id = "integration-claude",
			detected = status.claudeDetected,
			enabled = config.claudeEnabled != false,
			hookInstalled = status.claudeHookInstalled,
			label = "Claude Integration",
			enabledTooltip = "Claude Code hooks installed (Stop, SessionStart) — session tracking is enabled",
			disabledTooltip = "Claude Code detected but session tracking is disabled in config",
			hookMissingTooltip = "Claude Code detected but hooks are not installed",
		)?.let(entries::add)
		integrationEntry(
			id = "integration-codex",
			detected = status.codexDetected,
			enabled = config.codexEnabled != false,
			hookInstalled = null,
			label = "Codex Integration",
			enabledTooltip = "Codex CLI sessions directory found — session discovery is enabled",
			disabledTooltip = "Codex CLI detected but session discovery is disabled in config",
			hookMissingTooltip = null,
		)?.let(entries::add)
		integrationEntry(
			id = "integration-gemini",
			detected = status.geminiDetected,
			enabled = config.geminiEnabled != false,
			hookInstalled = status.geminiHookInstalled,
			label = "Gemini Integration",
			enabledTooltip = "Gemini CLI AfterAgent hook installed — session tracking is enabled",
			disabledTooltip = "Gemini CLI detected but session tracking is disabled in config",
			hookMissingTooltip = "Gemini CLI detected but AfterAgent hook is not installed",
		)?.let(entries::add)
		integrationEntry(
			id = "integration-opencode",
			detected = status.openCodeDetected,
			enabled = config.openCodeEnabled != false,
			hookInstalled = null,
			label = "OpenCode Integration",
			enabledTooltip = "OpenCode sessions database found — session discovery is enabled",
			disabledTooltip = "OpenCode detected but session discovery is disabled in config",
			hookMissingTooltip = null,
		)?.let(entries::add)

		// Summaries row
		entries.add(mapOf(
			"id" to "summaries",
			"label" to "Stored Memories",
			"description" to "${status.summaryCount}",
			"iconKey" to "book",
		))

		// Sessions row
		entries.add(mapOf(
			"id" to "sessions",
			"label" to "Sessions",
			"description" to "${status.activeSessions}",
			"iconKey" to "pulse",
		))

		return entries
	}

	/**
	 * Port of VS Code's `pushIntegrationItem`: emits a row describing a per-
	 * agent integration's state. Returns null when the agent isn't detected
	 * (matches VS Code's "skip the row entirely" behavior for undetected
	 * agents, so the panel doesn't list every possible integration).
	 *
	 * Four states:
	 *   - detected but disabled in config       → warning
	 *   - detected, enabled, no hook concept    → ok (e.g. Codex / OpenCode)
	 *   - detected, enabled, hook missing       → warning (Claude / Gemini)
	 *   - detected, enabled, hook installed     → ok
	 */
	private fun integrationEntry(
		id: String,
		detected: Boolean?,
		enabled: Boolean,
		hookInstalled: Boolean?,
		label: String,
		enabledTooltip: String,
		disabledTooltip: String,
		hookMissingTooltip: String?,
	): Map<String, Any?>? {
		if (detected != true) return null
		return when {
			!enabled -> mapOf(
				"id" to id,
				"label" to label,
				"description" to "detected but disabled",
				"iconKey" to "warning",
				"tooltip" to disabledTooltip,
			)
			hookInstalled == null && hookMissingTooltip == null -> mapOf(
				"id" to id,
				"label" to label,
				"description" to "detected & enabled",
				"iconKey" to "check",
				"tooltip" to enabledTooltip,
			)
			hookInstalled == false && hookMissingTooltip != null -> mapOf(
				"id" to id,
				"label" to label,
				"description" to "hook not installed",
				"iconKey" to "warning",
				"tooltip" to hookMissingTooltip,
			)
			else -> mapOf(
				"id" to id,
				"label" to label,
				"description" to "hook installed",
				"iconKey" to "check",
				"tooltip" to enabledTooltip,
			)
		}
	}

	/**
	 * Port of VS Code's `resolveLlmCredentialSource` from cli/src/core/LlmClient.ts.
	 * Returns one of "anthropic-config" | "anthropic-env" | "jolli-proxy" | null.
	 * Keep this in lockstep with the TS reference — silent drift will misreport
	 * which provider actually generated past summaries.
	 */
	private fun resolveLlmCredentialSource(config: ai.jolli.jollimemory.core.JolliMemoryConfig): String? {
		val anthropicEnv = System.getenv("ANTHROPIC_API_KEY")?.takeIf { it.isNotBlank() }
		when (config.aiProvider) {
			"jolli" -> return if (!config.jolliApiKey.isNullOrBlank()) "jolli-proxy" else null
			"anthropic" -> {
				if (!config.apiKey.isNullOrBlank()) return "anthropic-config"
				if (anthropicEnv != null) return "anthropic-env"
				return null
			}
		}
		// Legacy precedence (aiProvider unset): apiKey > env > jolliApiKey
		if (!config.apiKey.isNullOrBlank()) return "anthropic-config"
		if (anthropicEnv != null) return "anthropic-env"
		if (!config.jolliApiKey.isNullOrBlank()) return "jolli-proxy"
		return null
	}

	private fun serializeProviderEntry(): Map<String, Any?> {
		val config = ai.jolli.jollimemory.core.SessionTracker.loadConfig()
		val source = resolveLlmCredentialSource(config)
		val description: String
		val iconKey: String
		val tooltip: String
		when (source) {
			"anthropic-config" -> {
				description = "Anthropic"
				iconKey = "check"
				tooltip = "AI summaries are generated via the Anthropic API key from your config."
			}
			"anthropic-env" -> {
				description = "Anthropic (env)"
				iconKey = "check"
				tooltip = "AI summaries are generated via the ANTHROPIC_API_KEY environment variable."
			}
			"jolli-proxy" -> {
				description = "Jolli"
				iconKey = "check"
				tooltip = "AI summaries are routed through the Jolli backend proxy."
			}
			else -> {
				description = "not configured — click to set"
				iconKey = "warning"
				tooltip = when (config.aiProvider) {
					"jolli" -> "Provider is set to Jolli but no Jolli API key is on file. Sign in again or set a key in Settings."
					"anthropic" -> "Provider is set to Anthropic but no API key is configured. Open Settings to add one."
					else -> "No AI provider is configured. Pick one (Anthropic or Jolli) in Settings."
				}
			}
		}
		return mapOf(
			"id" to "ai-provider",
			"label" to "AI Summary Provider",
			"description" to description,
			"iconKey" to iconKey,
			"tooltip" to tooltip,
		)
	}

	// ── Breadcrumb helpers ──────────────────────────────────────────────────

	private fun pushReposAndBranches() {
		val service = getService() ?: return
		val repoName = service.currentRepoName
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(repoName, remoteUrl)
		val repos = discovered.map { repo ->
			mapOf(
				"repoName" to repo.repoName,
				"remoteUrl" to repo.remoteUrl,
				"isCurrent" to repo.isCurrentRepo,
			)
		}
		pushRepos(repos)

		// Push branches for the current repo
		if (repoName != null) {
			val branches = listBranchesForRepo(repoName)
			pushBranches(branches, repoName)
		}
	}

	private fun listBranchesForRepo(repoName: String): List<String> {
		val service = getService() ?: return emptyList()
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)
		val repo = discovered.find { it.repoName == repoName } ?: return emptyList()
		val mm = MetadataManager(repo.kbRoot.resolve(".jolli"))
		val names = mm.listBranchMappings().map { it.branch }.toMutableSet()
		// Ensure the current branch is included even if no summary exists yet
		if (repoName == service.currentRepoName) {
			service.currentBranchName?.let { names.add(it) }
		}
		return names.sorted()
	}

	private fun pushBranchMemoriesForSelection(repoName: String, branchName: String) {
		val service = getService() ?: return
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)
		val repo = discovered.find { it.repoName == repoName } ?: return
		val mm = MetadataManager(repo.kbRoot.resolve(".jolli"))
		val index = mm.readIndex()
		val items = (index?.entries ?: emptyList())
			.filter { it.branch == branchName }
			.map { entry ->
				mapOf(
					"commitHash" to entry.commitHash,
					"title" to (entry.commitMessage ?: entry.commitHash.take(8)),
					"branch" to (entry.branch ?: branchName),
					"repoName" to repoName,
					"timestamp" to (entry.commitDate?.let {
						try { java.time.Instant.parse(it).toEpochMilli() } catch (_: Exception) { 0L }
					} ?: 0L),
				)
			}
		pushBranchMemories(repoName, branchName, items)
	}

	// ── KB folder helpers ───────────────────────────────────────────────────

	/**
	 * Lists children of a KB folder path for the webview tree.
	 * [folderPath] is a relative path like "myrepo" or "myrepo/main".
	 * Returns serialized node maps matching the JS renderFolderNode shape.
	 */
	private fun listKbChildren(folderPath: String): List<Map<String, Any?>> {
		val service = getService() ?: return emptyList()
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)

		// folderPath could be a repo root like "myrepo" or a subfolder like "myrepo/main/..."
		val repoName = folderPath.substringBefore('/')
		val repo = discovered.find { it.repoName == repoName }
			?: discovered.find { it.kbRoot.fileName.toString() == repoName }
			?: return emptyList()

		val targetDir = if (folderPath.contains('/')) {
			repo.kbRoot.resolve(folderPath.substringAfter('/'))
		} else {
			repo.kbRoot
		}

		if (!java.nio.file.Files.isDirectory(targetDir)) return emptyList()

		val mm = MetadataManager(repo.kbRoot.resolve(".jolli"))
		val manifest = mm.readManifest()
		val titleMap = manifest.files.associate { it.path to (it.title ?: it.path) }
		val typeMap = manifest.files.associate { it.path to it.type }

		return try {
			java.nio.file.Files.list(targetDir).use { stream ->
				stream.filter { !it.fileName.toString().startsWith(".") }
					.sorted(compareByDescending<java.nio.file.Path> { java.nio.file.Files.isDirectory(it) }
						.thenBy { it.fileName.toString() })
					.map { child ->
						val isDir = java.nio.file.Files.isDirectory(child)
						val name = child.fileName.toString()
						val relPath = "$folderPath/$name"
						val kbRelPath = repo.kbRoot.relativize(child).toString().replace('\\', '/')
						// Manifest stores summaries as type="commit"; the JS folder
						// renderer recognizes "memory" instead. Translate here so
						// the blue markdown icon (kb-icon-memory) is applied.
						val rawType = typeMap[kbRelPath]
						val fileKind = when (rawType) {
							"commit" -> "memory"
							null -> if (!isDir) "memory" else null
							else -> rawType
						}
						val fileTitle = titleMap[kbRelPath]
						mapOf(
							"name" to name,
							"relPath" to relPath,
							"isDirectory" to isDir,
							"isRepoRoot" to false,
							"isCurrentRepo" to repo.isCurrentRepo,
							"fileKind" to fileKind,
							"fileTitle" to fileTitle,
							"fileBranch" to null,
							"fileKey" to if (!isDir) kbRelPath else null,
						)
					}.toList()
			}
		} catch (e: Exception) {
			LOG.warn("Failed to list KB children: $folderPath", e)
			emptyList()
		}
	}

	/** Pushes root-level KB folder nodes (the repo list). */
	private fun pushKbRootFolders() {
		val service = getService() ?: return
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)
		val items = discovered.map { repo ->
			mapOf(
				"name" to repo.repoName,
				"relPath" to repo.repoName,
				"isDirectory" to true,
				"isRepoRoot" to true,
				"isCurrentRepo" to repo.isCurrentRepo,
				"fileKind" to null,
				"fileTitle" to null,
				"fileBranch" to null,
				"fileKey" to null,
			)
		}
		pushKbFolders("__root__", items)
	}

	// ── Push helpers (fetch + serialize + push) ─────────────────────────────

	private fun pushAllSections() {
		pushChangesData()
		pushCommitsData()
		pushPlansData()
		pushStatusData()
		pushMemoriesData()
		pushKbRootFolders()
	}

	private fun pushChangesData() {
		val service = getService() ?: return
		val changes = service.getChangedFiles()
		// Prune stale selections (files no longer in git status)
		val currentPaths = changes.map { it.relativePath }.toSet()
		selectedFilePaths.retainAll(currentPaths)
		pushChanges(changes.map { serializeFileChange(it, selectedFilePaths.contains(it.relativePath)) })
	}

	private fun pushCommitsData() {
		val service = getService() ?: return
		val commits = service.getBranchCommits()
		// Prune stale selections — commits may have been amended/squashed/dropped
		// out of the branch range since the user last clicked a checkbox.
		val currentHashes = commits.map { it.hash }.toSet()
		selectedCommitHashes.retainAll(currentHashes)
		// Match VS Code's four-mode signal so the JS can decide whether to show
		// the Squash / Push Branch / checkbox controls. The JS only renders
		// section-toolbar actions when mode is "multi" or "single".
		val mode = when {
			commits.isEmpty() -> "empty"
			service.isBranchMerged() -> "merged"
			commits.size == 1 -> "single"
			else -> "multi"
		}
		pushCommits(commits.map { serializeCommit(it) }, mode)
	}

	private fun pushPlansData() {
		val service = getService() ?: return
		val repoRoot = service.mainRepoRoot ?: return
		val currentBranch = service.currentBranchName ?: return
		val registry = SessionTracker.loadPlansRegistry(repoRoot)

		val items = mutableListOf<Map<String, Any?>>()
		// Plans on current branch, not ignored
		registry.plans.filter { (_, p) -> p.branch == currentBranch && p.ignored != true }
			.forEach { (slug, plan) -> items.add(serializePlan(slug, plan)) }
		// Notes on current branch, not ignored
		registry.notes?.filter { (_, n) -> n.branch == currentBranch && n.ignored != true }
			?.forEach { (_, note) -> items.add(serializeNote(note)) }

		pushPlans(items)
	}

	private fun pushStatusData() {
		pushStatus(serializeStatusEntries())
		val service = getService() ?: return
		val repoRoot = service.mainRepoRoot ?: project.basePath
		val lockFile = repoRoot?.let { java.nio.file.Path.of(it, ".jolli", "jollimemory", "lock") }
		pushWorkerBusy(lockFile != null && java.nio.file.Files.exists(lockFile))
	}

	private fun pushMemoriesData(limit: Int = 50, filter: String? = null) {
		val service = getService() ?: return
		val (entries, totalCount) = loadCrossRepoMemories(service, limit, filter)
		val hasMore = entries.size < totalCount
		val items = entries.map { (repoName, entry) ->
			mapOf(
				"id" to entry.commitHash,
				"title" to entry.commitMessage,
				"commitHash" to entry.commitHash,
				"branch" to entry.branch,
				"repoName" to repoName,
				"timestamp" to (entry.commitDate?.let {
					try { java.time.Instant.parse(it).toEpochMilli() } catch (_: Exception) { 0L }
				} ?: 0L),
			)
		}
		pushKbMemories(items, hasMore)
	}

	/**
	 * Aggregates memory index entries across every discovered Memory Bank
	 * repo, matching VS Code's KB Memories tab (cross-repo view). Filters to
	 * v4 Hoist heads (parent==null), de-duplicates by commitHash (current-repo
	 * wins when the same hash appears twice — typical when a sibling KB folder
	 * shadows the project itself), applies optional search filter, sorts
	 * newest-first, paginates. Returns each entry paired with the repoName it
	 * came from so the row can be labelled correctly in the webview.
	 */
	private fun loadCrossRepoMemories(
		service: JolliMemoryService,
		limit: Int,
		filter: String?,
	): Pair<List<Pair<String, ai.jolli.jollimemory.core.SummaryIndexEntry>>, Int> {
		val remoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }
		val discovered = KBRepoDiscoverer.discover(service.currentRepoName, remoteUrl)

		// Discovered repos are returned with the current repo first; iterate in
		// that order so the current-repo entry wins when we dedupe.
		val byHash = linkedMapOf<String, Pair<String, ai.jolli.jollimemory.core.SummaryIndexEntry>>()
		for (repo in discovered) {
			val idx = try {
				MetadataManager(repo.kbRoot.resolve(".jolli")).readIndex()
			} catch (e: Exception) {
				LOG.warn("Failed to read index from ${repo.kbRoot}: ${e.message}")
				null
			} ?: continue
			for (entry in idx.entries) {
				if (entry.parentCommitHash != null) continue // heads only
				if (!byHash.containsKey(entry.commitHash)) {
					byHash[entry.commitHash] = repo.repoName to entry
				}
			}
		}

		var entries: List<Pair<String, ai.jolli.jollimemory.core.SummaryIndexEntry>> = byHash.values
			.toList()
			.sortedByDescending { (_, e) -> e.commitDate ?: "" }

		if (!filter.isNullOrBlank()) {
			val lowerFilter = filter.lowercase()
			entries = entries.filter { (_, e) ->
				(e.commitMessage?.lowercase()?.contains(lowerFilter) == true) ||
					(e.branch?.lowercase()?.contains(lowerFilter) == true)
			}
		}

		return entries.take(limit) to entries.size
	}

	// ── Push methods (called by host when data changes) ─────────────────────

	fun pushInit() {
		val service = project.getService(JolliMemoryService::class.java) ?: return
		postToWebview("init", mapOf(
			"enabled" to service.isEnabled(),
			"authenticated" to service.isAuthenticated(),
			"configured" to service.isConfigured(),
			"branchName" to (service.currentBranchName ?: ""),
			"detached" to service.isDetached(),
			"currentRepoName" to (service.currentRepoName ?: ""),
			"activeTab" to "branch",
			"kbMode" to "folders",
			"selectedRepoName" to (selectedRepoName ?: service.currentRepoName ?: ""),
			"selectedBranchName" to (selectedBranchName ?: service.currentBranchName ?: ""),
		))
	}

	fun pushStatus(entries: List<Map<String, Any?>>) {
		postToWebview("status:data", mapOf("entries" to entries))
	}

	fun pushPlans(items: List<Any>) {
		postToWebview("branch:plansData", mapOf("items" to items))
	}

	fun pushChanges(items: List<Any>) {
		postToWebview("branch:changesData", mapOf("items" to items))
	}

	fun pushCommits(items: List<Any>, mode: String = "merged") {
		postToWebview("branch:commitsData", mapOf("items" to items, "mode" to mode))
	}

	fun pushKbFolders(parentPath: String, items: List<Any>) {
		postToWebview("kb:foldersData", mapOf("parentPath" to parentPath, "items" to items))
	}

	fun pushKbMemories(items: List<Any>, hasMore: Boolean = false) {
		postToWebview("kb:memoriesData", mapOf("items" to items, "hasMore" to hasMore))
	}

	fun pushRepos(repos: List<Any>) {
		postToWebview("selection:repos", mapOf("repos" to repos))
	}

	fun pushBranches(branches: List<String>, repoName: String? = null) {
		postToWebview("selection:branches", mapOf("branches" to branches, "repoName" to repoName))
	}

	fun pushBranchMemories(repoName: String, branchName: String, items: List<Any>) {
		postToWebview("selection:branchMemories", mapOf(
			"repoName" to repoName,
			"branchName" to branchName,
			"items" to items,
		))
	}

	fun pushWorkerBusy(busy: Boolean) {
		postToWebview("worker:busy", mapOf("busy" to busy))
	}

	fun pushAuthChanged(signedIn: Boolean) {
		postToWebview("auth:changed", mapOf("signedIn" to signedIn))
	}

	fun pushEnabledChanged(enabled: Boolean) {
		postToWebview("enabled:changed", mapOf("enabled" to enabled))
	}

	fun pushConfiguredChanged(configured: Boolean) {
		postToWebview("configured:changed", mapOf("configured" to configured))
	}

	fun pushBranchNameChanged(branchName: String, detached: Boolean = false) {
		postToWebview("branch:branchName", mapOf("name" to branchName, "detached" to detached))
	}

	companion object {
		private val LOG = Logger.getInstance(JCEFSidebarPanel::class.java)

		// Commands that mutate workspace state — blocked when viewing a foreign repo/branch.
		private val MUTATING_COMMANDS = setOf(
			"jollimemory.commitAI",
			"jollimemory.addPlan",
			"jollimemory.addMarkdownNote",
			"jollimemory.addTextSnippet",
			"jollimemory.editPlan",
			"jollimemory.editNote",
			"jollimemory.removePlan",
			"jollimemory.removeNote",
			"jollimemory.discardSelectedChanges",
			"jollimemory.squash",
			"jollimemory.pushBranch",
		)
	}
}
