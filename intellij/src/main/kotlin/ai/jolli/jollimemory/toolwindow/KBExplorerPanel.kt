package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.KBDataCache
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.core.IngestPipeline
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.MultiRepoCompile
import ai.jolli.jollimemory.core.MigrationEngine
import ai.jolli.jollimemory.core.MigrationState
import ai.jolli.jollimemory.core.FolderStorage
import ai.jolli.jollimemory.core.OrphanBranchStorage
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.sync.SyncActivation
import ai.jolli.jollimemory.sync.SyncErrorCode
import ai.jolli.jollimemory.sync.SyncState
import ai.jolli.jollimemory.sync.SyncStatusDetail
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.icons.AllIcons
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.messages.MessageBusConnection
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.dnd.*
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JToggleButton
import javax.swing.JTree
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import java.awt.CardLayout
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile
import kotlin.io.path.name

/**
 * KBExplorerPanel — Memory Bank folder browser with context menu, drag-and-drop,
 * selection highlighting, and metadata sync.
 */
class KBExplorerPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    private enum class ViewMode { TREE, TIMELINE }

    private var tree: Tree? = null
    private var treeModel: DefaultTreeModel? = null
    private var kbRoot: Path? = null
    private var metadataManager: MetadataManager? = null
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    /** Relativize and normalize to forward slashes so lookups match manifest paths on Windows. */
    private fun relPath(root: Path, child: Path): String =
        root.relativize(child).toString().replace('\\', '/')

    private var currentView = ViewMode.TREE
    private val contentPanel = JPanel(CardLayout())
    private val treePanel = JPanel(BorderLayout())
    private val timelinePanel = JPanel(BorderLayout())
    private var cachedRepos: List<KBRepoDiscoverer.DiscoveredRepo> = emptyList()
    private var searchQuery: String = ""

    private val statusListener: () -> Unit
    private val syncStateListener: (SyncState, SyncStatusDetail?) -> Unit
    private val busConnection: MessageBusConnection

    /** Inline sync progress/result indicator, shown in the toolbar row next to the
     *  view-toggle buttons. Mirrors the IDE status-bar widget so the user gets
     *  immediate feedback after clicking "Sync to Personal Space". */
    private val syncStatusLabel = JLabel().apply { isVisible = false }
    /** Auto-clears the transient "Synced" message after a short delay. */
    private var syncClearTimer: Timer? = null

    data class KBNodeData(
        val path: Path,
        val name: String,
        val displayName: String? = null,
        val isDirectory: Boolean,
        val isRepoRoot: Boolean = false,
        val isCurrentRepo: Boolean = false,
        val badge: String? = null,
        /** Branch the entry came from — used to build the recall prompt. Null for non-memory nodes. */
        val branch: String? = null,
        /** The repo-specific KB root this entry belongs to. Distinct from the panel's current kbRoot
         *  for cross-repo views (Timeline); needed to find the right `.jolli/` for summaries. */
        val entryKbRoot: Path? = null,
    )

    init {
        border = JBUI.Borders.empty()

        // Toolbar with view toggle buttons
        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 2, 0)).apply {
            border = JBUI.Borders.empty(2)
        }
        val btnTree = JToggleButton("Tree").apply { toolTipText = "Tree view"; putClientProperty("JButton.buttonType", "segmented"); putClientProperty("JButton.segmentPosition", "first") }
        val btnTimeline = JToggleButton("Timeline").apply { toolTipText = "Timeline view"; putClientProperty("JButton.buttonType", "segmented"); putClientProperty("JButton.segmentPosition", "last") }
        val viewButtons = listOf(btnTree, btnTimeline)
        // Search field — only visible in Timeline view
        val searchField = com.intellij.ui.SearchTextField(false).apply {
            toolTipText = "Search across all repos"
            textEditor.columns = 12
            isVisible = false
        }
        searchField.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
            override fun removeUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
            override fun changedUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
        })
        fun selectView(mode: ViewMode) {
            currentView = mode
            viewButtons.forEach { it.isSelected = false }
            when (mode) { ViewMode.TREE -> btnTree; ViewMode.TIMELINE -> btnTimeline }.isSelected = true
            searchField.isVisible = mode == ViewMode.TIMELINE
            (contentPanel.layout as CardLayout).show(contentPanel, mode.name)
            ApplicationManager.getApplication().executeOnPooledThread { rebuildCurrentView() }
        }
        btnTree.addActionListener { selectView(ViewMode.TREE) }
        btnTimeline.addActionListener { selectView(ViewMode.TIMELINE) }
        toolbar.add(btnTree)
        toolbar.add(btnTimeline)
        toolbar.add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))

        // Reset (re-migrate) button
        val btnReset = JButton(AllIcons.Actions.Refresh).apply {
            toolTipText = "Reset — re-migrate from orphan branch"
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            preferredSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            maximumSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            margin = JBUI.emptyInsets()
            addActionListener {
                ApplicationManager.getApplication().executeOnPooledThread { resetMigration() }
            }
        }
        toolbar.add(btnReset)
        toolbar.add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))

        // Build Knowledge Wiki — mirrors VS Code's "Build Knowledge Wiki" toolbar
        // button (command jollimemory.compileNow): ingests pending sources into
        // topic pages and regenerates the visible _wiki/ for every Memory Bank repo.
        val btnBuildWiki = JButton(AllIcons.Actions.Compile).apply {
            toolTipText = "Build Knowledge Wiki"
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            preferredSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            maximumSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            margin = JBUI.emptyInsets()
            addActionListener { buildKnowledgeWiki() }
        }
        toolbar.add(btnBuildWiki)
        toolbar.add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))

        // Sync to Personal Space — mirrors the cloud-upload button on VS Code's
        // Memory Bank toolbar (vscode/src/views/SidebarScriptBuilder.ts), which
        // fires the same `jollimemory.syncNow` flow. The button is deliberately
        // independent of the auto-sync toggle: it is always shown, and the
        // handler only points the user to sign-in when sync is dormant.
        val btnSync = JButton(JolliMemoryIcons.CloudUpload).apply {
            toolTipText = "Sync to Personal Space"
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            preferredSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            maximumSize = Dimension(JBUI.scale(22), JBUI.scale(22))
            margin = JBUI.emptyInsets()
            addActionListener {
                ApplicationManager.getApplication().executeOnPooledThread { syncToPersonalSpace() }
            }
        }
        toolbar.add(btnSync)
        toolbar.add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
        // Inline sync status — same row as the Tree/Timeline toggle and the sync
        // button. Hidden until the first sync state arrives.
        toolbar.add(syncStatusLabel)
        toolbar.add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
        toolbar.add(searchField)

        contentPanel.add(treePanel, ViewMode.TREE.name)
        contentPanel.add(timelinePanel, ViewMode.TIMELINE.name)

        add(toolbar, BorderLayout.NORTH)
        add(contentPanel, BorderLayout.CENTER)

        showMessage("Loading...")

        statusListener = { ApplicationManager.getApplication().executeOnPooledThread { refresh() } }
        service.addStatusListener(statusListener)

        // Mirror sync state into the toolbar indicator (progress + result).
        syncStateListener = { state, detail ->
            SwingUtilities.invokeLater { updateSyncStatus(state, detail) }
        }
        service.addSyncStateListener(syncStateListener)

        // Watch KB parent directory for file changes across all repos
        busConnection = ApplicationManager.getApplication().messageBus.connect()
        busConnection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                val parentStr = KBPathResolver.KB_PARENT.toString()
                val hasRelevantChange = events.any { e ->
                    (e is VFileCreateEvent || e is VFileDeleteEvent || e is VFileMoveEvent) &&
                        (e.path ?: "").startsWith(parentStr)
                }
                if (hasRelevantChange) {
                    ApplicationManager.getApplication().executeOnPooledThread { refresh() }
                }
            }
        })

        // Also refresh after git operations (commits, amends) — hooks write to KB folder
        // via an external process, so VFS_CHANGES may not fire until a VFS refresh occurs.
        project.messageBus.connect(this as Disposable).subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener {
                // asyncRefresh triggers a VFS scan on the write thread, then calls our
                // VFS_CHANGES listener which refreshes the tree on a pooled thread.
                VirtualFileManager.getInstance().asyncRefresh { refresh() }
            },
        )
    }

    fun load() {
        try {
            resolveKBRoot()
            reconcile()
            reloadCache()
            buildTree()
        } catch (e: Exception) {
            showMessage("Error: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    fun refresh() {
        try {
            resolveKBRoot()
            reconcile()
            reloadCache()
            rebuildCurrentView()
        } catch (e: Exception) {
            showMessage("Refresh error: ${e.message}")
        }
    }

    private fun reloadCache() {
        val config = SessionTracker.loadConfig()
        val projectPath = service.mainRepoRoot ?: project.basePath
        val currentRepoName = projectPath?.let { KBPathResolver.extractRepoName(it) }
        val currentRemoteUrl = projectPath?.let { KBPathResolver.getRemoteUrl(it) }
        cachedRepos = KBRepoDiscoverer.discover(currentRepoName, currentRemoteUrl, config.knowledgeBasePath)
        KBDataCache.reload(cachedRepos)
    }

    private fun rebuildCurrentView() {
        when (currentView) {
            ViewMode.TREE -> buildTree()
            ViewMode.TIMELINE -> buildTimeline()
        }
    }

    private fun resolveKBRoot() {
        val projectPath = service.mainRepoRoot ?: project.basePath
            ?: throw IllegalStateException("No project path")
        val config = SessionTracker.loadConfig()
        val repoName = KBPathResolver.extractRepoName(projectPath)
        val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
        val resolved = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
        KBPathResolver.initializeKBFolder(resolved, repoName, remoteUrl)
        kbRoot = resolved
        metadataManager = MetadataManager(resolved.resolve(".jolli"))
    }

    private fun reconcile() {
        val root = kbRoot ?: return
        metadataManager?.reconcile(root)
    }

    // ── Tree building ──────────────────────────────────────────────────────

    private fun buildTree() {
        val repos = cachedRepos
        if (repos.isEmpty()) {
            showMessageIn(treePanel, "No memories yet — commit with an AI coding tool to get started")
            return
        }

        val rootNode = DefaultMutableTreeNode("KB")

        for (repo in repos) {
            val repoMM = MetadataManager(repo.kbRoot.resolve(".jolli"))
            val badgeMap = mutableMapOf<String, String>()
            val titleMap = mutableMapOf<String, String>()
            val branchMap = mutableMapOf<String, String>()

            // Build set of paths to hide (child entries after squash/consolidation)
            val index = repoMM.readIndex()
            val childHashes = index?.entries
                ?.filter { it.parentCommitHash != null }
                ?.map { it.commitHash }
                ?.toSet()
                ?: emptySet()
            val hiddenPaths = mutableSetOf<String>()

            repoMM.readManifest().files.forEach { entry ->
                badgeMap[entry.path] = when (entry.type) {
                    "commit" -> "C"; "plan" -> "P"; "note" -> "N"; else -> ""
                }
                if (entry.title != null) titleMap[entry.path] = entry.title
                entry.source.branch?.let { branchMap[entry.path] = it }
                // Track paths of child entries to hide from tree
                if (entry.type == "commit" && entry.fileId in childHashes) {
                    hiddenPaths.add(entry.path)
                }
            }

            val repoNode = DefaultMutableTreeNode(KBNodeData(
                repo.kbRoot, repo.repoName, isDirectory = true,
                isRepoRoot = true, isCurrentRepo = repo.isCurrentRepo,
            ))

            // Add branch folders
            val dirs = Files.list(repo.kbRoot).use { s ->
                s.filter { it.isDirectory() }
                    .filter { !isHiddenOrInternal(it.name) }
                    .sorted(compareBy { it.name })
                    .toList()
            }
            for (dir in dirs) {
                val branchNode = DefaultMutableTreeNode(KBNodeData(dir, dir.name, isDirectory = true))
                addChildren(branchNode, dir, repo.kbRoot, badgeMap, titleMap, branchMap, hiddenPaths)
                repoNode.add(branchNode)
            }

            // Add root-level files
            Files.list(repo.kbRoot).use { s ->
                s.filter { it.isRegularFile() }
                    .filter { !it.name.startsWith(".") && it.name != "index.json" }
                    .sorted(compareBy { it.name })
                    .forEach { file ->
                        val relPath = relPath(repo.kbRoot, file)
                        if (relPath in hiddenPaths) return@forEach
                        repoNode.add(DefaultMutableTreeNode(
                            KBNodeData(
                                file, file.name,
                                displayName = titleMap[relPath],
                                isDirectory = false,
                                badge = badgeMap[relPath],
                                branch = branchMap[relPath],
                                entryKbRoot = repo.kbRoot,
                            )
                        ))
                    }
            }

            rootNode.add(repoNode)
        }

        SwingUtilities.invokeLater {
            val model = DefaultTreeModel(rootNode)
            if (tree == null) {
                val t = Tree(model).apply {
                    isRootVisible = false
                    showsRootHandles = true
                    cellRenderer = KBTreeCellRenderer()
                    selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
                }

                // Double-click and right-click handlers
                t.addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        if (e.clickCount == 2) {
                            val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
                            val data = node.userObject as? KBNodeData ?: return
                            if (!data.isDirectory) {
                                if (data.badge == "C") openCommitSummary(data) else openFile(data.path)
                            }
                        }
                    }
                    override fun mousePressed(e: MouseEvent) {
                        if (e.isPopupTrigger) showPopup(e, t)
                    }
                    override fun mouseReleased(e: MouseEvent) {
                        if (e.isPopupTrigger) showPopup(e, t)
                    }
                })

                setupDragAndDrop(t)
                tree = t
                treeModel = model
            } else {
                // Preserve selection across refresh by matching the selected node's file path
                val selectedNode = tree!!.lastSelectedPathComponent as? DefaultMutableTreeNode
                val selectedData = selectedNode?.userObject as? KBNodeData
                val selectedFilePath = selectedData?.path

                treeModel = model
                tree!!.model = model

                if (selectedFilePath != null) {
                    findNodeByPath(rootNode, selectedFilePath)?.let { matchedNode ->
                        val tp = TreePath(model.getPathToRoot(matchedNode))
                        tree!!.selectionPath = tp
                    }
                }
            }

            treePanel.removeAll()
            treePanel.add(JBScrollPane(tree!!), BorderLayout.CENTER)
            // Expand current repo and its branch folders; collapse other repos
            for (i in 0 until rootNode.childCount) {
                val repoNode = rootNode.getChildAt(i) as? DefaultMutableTreeNode ?: continue
                val repoData = repoNode.userObject as? KBNodeData
                val repoPath = TreePath(arrayOf(rootNode, repoNode))
                if (repoData?.isCurrentRepo == true) {
                    tree!!.expandPath(repoPath)
                    for (j in 0 until repoNode.childCount) {
                        tree!!.expandPath(TreePath(arrayOf(rootNode, repoNode, repoNode.getChildAt(j))))
                    }
                } else {
                    tree!!.collapsePath(repoPath)
                }
            }
            treePanel.revalidate()
            treePanel.repaint()
        }
    }

    private fun showPopup(e: MouseEvent, t: Tree) {
        val row = t.getRowForLocation(e.x, e.y)  // returns -1 if not exactly on a row
        if (row >= 0) {
            t.setSelectionRow(row)
            val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode
            val data = node?.userObject as? KBNodeData
            showContextMenu(e, data)
        } else {
            // Clicked on empty area — clear selection, context menu targets root
            t.clearSelection()
            showContextMenu(e, null)
        }
    }

    /** Memory-only popup for the Timeline view — no file-ops items there. */
    private fun showMemoryPopup(e: MouseEvent, t: Tree) {
        val row = t.getRowForLocation(e.x, e.y)
        if (row < 0) return
        t.setSelectionRow(row)
        val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
        val data = node.userObject as? KBNodeData ?: return
        if (data.isDirectory || data.badge != "C") return

        val group = DefaultActionGroup().apply {
            data.branch?.let { branch ->
                add(object : AnAction("Copy Recall Prompt") {
                    override fun actionPerformed(ev: AnActionEvent) = copyRecallPromptForBranch(branch)
                })
            }
            add(object : AnAction("View Commit Memory") {
                override fun actionPerformed(ev: AnActionEvent) = openCommitSummary(data)
            })
        }
        val menu = ActionManager.getInstance().createActionPopupMenu("JolliMemory.KBMemoryMenu", group)
        menu.component.show(e.component, e.x, e.y)
    }

    private fun addChildren(
        parentNode: DefaultMutableTreeNode, dir: Path, kbRoot: Path,
        badgeMap: Map<String, String>, titleMap: Map<String, String>,
        branchMap: Map<String, String>, hiddenPaths: Set<String>,
    ) {
        try {
            Files.list(dir).use { s ->
                s.filter { !it.name.startsWith(".") }
                    .sorted(compareByDescending<Path> { it.isDirectory() }.thenBy { it.name })
                    .forEach { child ->
                        val relPath = relPath(kbRoot, child)
                        if (child.isDirectory()) {
                            val n = DefaultMutableTreeNode(KBNodeData(child, child.name, isDirectory = true))
                            addChildren(n, child, kbRoot, badgeMap, titleMap, branchMap, hiddenPaths)
                            parentNode.add(n)
                        } else {
                            if (relPath in hiddenPaths) return@forEach
                            parentNode.add(DefaultMutableTreeNode(
                                KBNodeData(
                                    child, child.name,
                                    displayName = titleMap[relPath],
                                    isDirectory = false,
                                    badge = badgeMap[relPath],
                                    branch = branchMap[relPath],
                                    entryKbRoot = kbRoot,
                                )
                            ))
                        }
                    }
            }
        } catch (e: Exception) {
            LOG.warn("Failed to list children of $dir", e)
        }
    }

    // ── Drag and drop (unified via DragSource + DropTarget) ────────────────

    private var draggedPath: Path? = null

    private fun setupDragAndDrop(t: Tree) {
        // Drag source — initiates drag from tree nodes
        val dragSource = DragSource.getDefaultDragSource()
        dragSource.createDefaultDragGestureRecognizer(t, DnDConstants.ACTION_MOVE,
            DragGestureListener { dge ->
                if (t.selectionRows == null || t.selectionRows.isEmpty()) return@DragGestureListener
                val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return@DragGestureListener
                val data = node.userObject as? KBNodeData ?: return@DragGestureListener
                draggedPath = data.path
                dge.startDrag(DragSource.DefaultMoveDrop, StringSelection(data.path.toString()))
            })

        // Drop target — accepts drops onto tree nodes
        t.dropTarget = DropTarget(t, DnDConstants.ACTION_COPY_OR_MOVE,
            object : DropTargetListener {
                override fun dragEnter(dtde: DropTargetDragEvent) { dtde.acceptDrag(DnDConstants.ACTION_COPY_OR_MOVE) }
                override fun dragOver(dtde: DropTargetDragEvent) {
                    dtde.acceptDrag(DnDConstants.ACTION_COPY_OR_MOVE)
                    // Highlight drop target
                    val row = t.getClosestRowForLocation(dtde.location.x, dtde.location.y)
                    if (row >= 0) t.setSelectionRow(row)
                }
                override fun dropActionChanged(dtde: DropTargetDragEvent) {}
                override fun dragExit(dte: DropTargetEvent) {}

                override fun drop(dtde: DropTargetDropEvent) {
                    dtde.acceptDrop(DnDConstants.ACTION_COPY_OR_MOVE)
                    val root = kbRoot ?: run { dtde.dropComplete(false); return }
                    val mm = metadataManager ?: run { dtde.dropComplete(false); return }

                    // Determine target folder
                    val row = t.getClosestRowForLocation(dtde.location.x, dtde.location.y)
                    val targetNode = if (row >= 0) {
                        val path = t.getPathForRow(row)
                        path?.lastPathComponent as? DefaultMutableTreeNode
                    } else null
                    val targetData = targetNode?.userObject as? KBNodeData
                    val targetDir = when {
                        targetData == null -> root
                        targetData.isDirectory -> targetData.path
                        else -> targetData.path.parent ?: root
                    }

                    try {
                        val transferable = dtde.transferable

                        // Check for internal drag first (from our tree)
                        val internalSource = draggedPath
                        if (internalSource != null && transferable.isDataFlavorSupported(DataFlavor.stringFlavor)) {
                            draggedPath = null
                            val dest = targetDir.resolve(internalSource.fileName)
                            if (internalSource == dest) { dtde.dropComplete(false); return }

                            if (Files.exists(dest)) {
                                val confirm = Messages.showYesNoDialog(
                                    project,
                                    "\"${dest.fileName}\" already exists in the destination. Overwrite?",
                                    "Confirm Overwrite",
                                    Messages.getWarningIcon(),
                                )
                                if (confirm != Messages.YES) { dtde.dropComplete(false); return }
                            }

                            Files.move(internalSource, dest, StandardCopyOption.REPLACE_EXISTING)
                            val oldRel = relPath(root, internalSource)
                            val newRel = relPath(root, dest)
                            if (Files.isDirectory(dest)) {
                                mm.renameBranchFolder(oldRel, newRel)
                            } else {
                                val entry = mm.findByPath(oldRel)
                                if (entry != null) mm.updatePath(entry.fileId, newRel)
                            }
                            backgroundRefresh()
                            dtde.dropComplete(true)
                            return
                        }

                        // External drop (from Finder)
                        if (transferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                            @Suppress("UNCHECKED_CAST")
                            val files = transferable.getTransferData(DataFlavor.javaFileListFlavor) as List<File>
                            for (file in files) {
                                val source = file.toPath()
                                val dest = targetDir.resolve(source.fileName)

                                if (Files.exists(dest)) {
                                    val confirm = Messages.showYesNoDialog(
                                        project,
                                        "\"${dest.fileName}\" already exists in the destination. Overwrite?",
                                        "Confirm Overwrite",
                                        Messages.getWarningIcon(),
                                    )
                                    if (confirm != Messages.YES) continue
                                }

                                if (source.startsWith(root)) {
                                    Files.move(source, dest, StandardCopyOption.REPLACE_EXISTING)
                                    val oldRel = relPath(root, source)
                                    val newRel = relPath(root, dest)
                                    val entry = mm.findByPath(oldRel)
                                    if (entry != null) mm.updatePath(entry.fileId, newRel)
                                } else {
                                    Files.copy(source, dest, StandardCopyOption.REPLACE_EXISTING)
                                }
                            }
                            backgroundRefresh()
                            dtde.dropComplete(true)
                            return
                        }

                        dtde.dropComplete(false)
                    } catch (e: Exception) {
                        LOG.warn("Drag-and-drop failed", e)
                        dtde.dropComplete(false)
                    }
                }
            })
    }

    // ── Context menu ───────────────────────────────────────────────────────

    private fun showContextMenu(e: MouseEvent, data: KBNodeData?) {
        val root = data?.entryKbRoot ?: kbRoot ?: return
        val mm = if (data?.entryKbRoot != null) MetadataManager(root.resolve(".jolli")) else metadataManager ?: return

        val targetDir = when {
            data == null -> root
            data.isDirectory -> data.path
            else -> data.path.parent ?: root
        }

        val group = DefaultActionGroup()

        // Memory-entry actions appear first when the node is a commit memory file
        if (data != null && !data.isDirectory && data.badge == "C") {
            data.branch?.let { branch ->
                group.add(object : AnAction("Copy Recall Prompt") {
                    override fun actionPerformed(ev: AnActionEvent) = copyRecallPromptForBranch(branch)
                })
            }
            group.add(object : AnAction("View Commit Memory") {
                override fun actionPerformed(ev: AnActionEvent) = openCommitSummary(data)
            })
            group.addSeparator()
        }

        group.add(object : AnAction("New Folder") {
            override fun actionPerformed(ev: AnActionEvent) = doNewFolder(targetDir)
        })
        group.add(object : AnAction("New Markdown File") {
            override fun actionPerformed(ev: AnActionEvent) = doNewFile(targetDir)
        })
        group.add(object : AnAction("Import File(s)...") {
            override fun actionPerformed(ev: AnActionEvent) = doImportFiles(targetDir)
        })

        if (data != null) {
            group.addSeparator()
            group.add(object : AnAction("Rename") {
                override fun actionPerformed(ev: AnActionEvent) = doRename(data, root, mm)
            })
            if (!data.isDirectory) {
                group.add(object : AnAction("Move to...") {
                    override fun actionPerformed(ev: AnActionEvent) = doMove(data, root, mm)
                })
            }
            group.addSeparator()
            group.add(object : AnAction("Delete") {
                override fun actionPerformed(ev: AnActionEvent) = doDelete(data, root, mm)
            })
        }

        group.addSeparator()
        group.add(object : AnAction(RevealFileAction.getActionName()) {
            override fun actionPerformed(ev: AnActionEvent) {
                val target = data?.path ?: root
                RevealFileAction.openFile(target.toFile())
            }
        })

        val menu = ActionManager.getInstance().createActionPopupMenu("JolliMemory.KBTreeMenu", group)
        menu.component.show(e.component, e.x, e.y)
    }

    // ── File operations ────────────────────────────────────────────────────

    private fun doNewFolder(parentDir: Path) {
        val name = Messages.showInputDialog(project, "Folder name:", "New Folder", null)
        if (name.isNullOrBlank()) return
        try {
            Files.createDirectories(parentDir.resolve(name))
            backgroundRefresh()
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to create folder: ${e.message}", "Error")
        }
    }

    private fun doNewFile(parentDir: Path) {
        val name = Messages.showInputDialog(project, "File name:", "New Markdown File", null)
        if (name.isNullOrBlank()) return
        val fileName = if (name.endsWith(".md")) name else "$name.md"
        try {
            val filePath = parentDir.resolve(fileName)
            Files.writeString(filePath, "# $name\n\n")
            backgroundRefresh()
            // Open in editor with write access enabled
            SwingUtilities.invokeLater {
                val vFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(filePath)
                if (vFile != null) {
                    vFile.isWritable  // trigger VFS refresh
                    val descriptor = OpenFileDescriptor(project, vFile)
                    FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
                }
            }
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to create file: ${e.message}", "Error")
        }
    }

    private fun doImportFiles(targetDir: Path) {
        val descriptor = FileChooserDescriptorFactory.createAllButJarContentsDescriptor()
        val files = FileChooser.chooseFiles(descriptor, project, null)
        if (files.isEmpty()) return
        try {
            for (vf in files) {
                val source = Path.of(vf.path)
                val dest = targetDir.resolve(source.name)
                Files.copy(source, dest, StandardCopyOption.REPLACE_EXISTING)
            }
            backgroundRefresh()
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to import: ${e.message}", "Error")
        }
    }

    private fun doRename(data: KBNodeData, root: Path, mm: MetadataManager) {
        val oldName = data.name
        val newName = Messages.showInputDialog(project, "New name:", "Rename", null, oldName, null)
        if (newName.isNullOrBlank() || newName == oldName) return

        try {
            val newPath = data.path.parent.resolve(newName)
            Files.move(data.path, newPath)

            if (data.isDirectory) {
                mm.renameBranchFolder(oldName, newName)
            } else {
                val oldRelPath = relPath(root, data.path)
                val newRelPath = relPath(root, newPath)
                val entry = mm.findByPath(oldRelPath)
                if (entry != null) {
                    mm.updatePath(entry.fileId, newRelPath)
                }
            }
            backgroundRefresh()
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to rename: ${e.message}", "Error")
        }
    }

    private fun doMove(data: KBNodeData, root: Path, mm: MetadataManager) {
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        val kbVFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)
        val chosen = FileChooser.chooseFiles(descriptor, project, kbVFile)
        if (chosen.isEmpty()) return

        val destDir = Path.of(chosen[0].path)
        if (!destDir.startsWith(root)) {
            Messages.showWarningDialog(project, "Destination must be inside the Memory Bank folder.", "Move")
            return
        }

        try {
            val destPath = destDir.resolve(data.name)
            Files.move(data.path, destPath)

            val oldRelPath = relPath(root, data.path)
            val newRelPath = relPath(root, destPath)
            val entry = mm.findByPath(oldRelPath)
            if (entry != null) {
                mm.updatePath(entry.fileId, newRelPath)
            }
            backgroundRefresh()
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to move: ${e.message}", "Error")
        }
    }

    private fun doDelete(data: KBNodeData, root: Path, mm: MetadataManager) {
        val displayName = data.displayName ?: data.name
        val confirm = Messages.showYesNoDialog(
            project, "Delete \"$displayName\"?", "Delete",
            Messages.getQuestionIcon(),
        )
        if (confirm != Messages.YES) return

        try {
            if (data.isDirectory) {
                Files.walk(data.path)
                    .sorted(Comparator.reverseOrder())
                    .forEach { Files.deleteIfExists(it) }
                mm.removeBranchFolder(data.name)
            } else {
                Files.deleteIfExists(data.path)
                val relPath = relPath(root, data.path)
                val entry = mm.findByPath(relPath)
                if (entry != null) {
                    mm.removeFromManifest(entry.fileId)
                }
            }
            backgroundRefresh()
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to delete: ${e.message}", "Error")
        }
    }

    // ── File open helpers ──────────────────────────────────────────────────

    private fun openFile(path: Path) {
        val vFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path) ?: return
        val descriptor = OpenFileDescriptor(project, vFile)
        FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
    }

    private fun openCommitSummary(data: KBNodeData) {
        // Use the node's own repo root when present so Timeline / A-Z entries from
        // discovered foreign repos resolve their manifest correctly. Falls back to
        // the panel's current-repo kbRoot for legacy Tree-only callers.
        val root = data.entryKbRoot ?: kbRoot ?: return
        val mm = if (data.entryKbRoot != null) MetadataManager(root.resolve(".jolli")) else metadataManager ?: return
        val relativePath = relPath(root, data.path)
        val entry = mm.findByPath(relativePath) ?: run { openFile(data.path); return }
        val summaryPath = root.resolve(".jolli/summaries/${entry.fileId}.json")
        if (!Files.exists(summaryPath)) { openFile(data.path); return }

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val json = Files.readString(summaryPath, java.nio.charset.StandardCharsets.UTF_8)
                val summary = gson.fromJson(json, CommitSummary::class.java)
                if (summary != null) {
                    val isForeign = data.entryKbRoot != null && data.entryKbRoot != kbRoot
                    SwingUtilities.invokeLater {
                        FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary, readOnly = isForeign), true)
                    }
                } else {
                    SwingUtilities.invokeLater { openFile(data.path) }
                }
            } catch (e: Exception) {
                LOG.warn("Failed to open commit summary for ${data.path}", e)
                SwingUtilities.invokeLater { openFile(data.path) }
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun copyRecallPromptForBranch(branch: String) {
        val prompt = "Invoke the \"jolli-recall\" skill with args \"$branch\"."
        val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(prompt), null)
        Messages.showInfoMessage(
            project,
            "Recall prompt copied — paste it into Claude Code.",
            "Copy Recall Prompt",
        )
    }

    private fun backgroundRefresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refresh() }
    }

    // ── Search ─────────────────────────────────────────────────────────────

    private fun onSearchChanged(query: String) {
        searchQuery = query.trim().lowercase()
        ApplicationManager.getApplication().executeOnPooledThread { rebuildCurrentView() }
    }

    private fun matchesSearch(vararg fields: String?): Boolean {
        if (searchQuery.isEmpty()) return true
        return fields.any { it?.lowercase()?.contains(searchQuery) == true }
    }

    // ── Reset migration ───────────────────────────────────────────────────

    private fun resetMigration() {
        try {
            val root = kbRoot ?: return
            val mm = MetadataManager(root.resolve(".jolli"))
            mm.saveMigrationState(MigrationState(status = "pending"))

            val projectPath = service.mainRepoRoot ?: project.basePath ?: return
            val orphan = OrphanBranchStorage(GitOps(projectPath))
            val folder = FolderStorage(root, mm)
            val engine = MigrationEngine(orphan, folder, mm)
            val result = engine.runMigration()

            LOG.info("Reset migration: ${result.status} (${result.migratedEntries}/${result.totalEntries})")
            refresh()
        } catch (e: Exception) {
            LOG.warn("Reset migration failed", e)
        }
    }

    /**
     * Manual "Sync to Personal Space" — IntelliJ port of the
     * `jollimemory.syncNow` command (vscode/src/sync/SyncCommands.ts).
     *
     * Parity with VS Code's `runtime.ensureBuilt()` gate:
     *   - Not signed in → the orchestrator can never be built, so point the
     *     user at sign-in instead of silently doing nothing.
     *   - Signed in but orchestrator not yet built (e.g. enabled after the
     *     last reconcile) → lazy-build it via [SyncActivation.reconcileSync].
     *   - Then route through [JolliMemoryService.requestManualSync], which
     *     coalesces with any in-flight round.
     */
    private fun syncToPersonalSpace() {
        JM.info("syncToPersonalSpace: button clicked")
        if (!JolliAuthService.isSignedIn()) {
            JM.info("syncToPersonalSpace: not signed in — prompting sign-in, aborting")
            com.intellij.notification.Notifications.Bus.notify(
                com.intellij.notification.Notification(
                    "JolliMemory",
                    "Sync to Personal Space",
                    "Memory Bank sync needs a Jolli sign-in. Open Settings → Memory Bank and sign in to Jolli, then try again.",
                    com.intellij.notification.NotificationType.INFORMATION,
                ),
                project,
            )
            return
        }
        JM.info("syncToPersonalSpace: signed in; isSyncBuilt=${service.isSyncBuilt()}")
        if (!service.isSyncBuilt()) {
            JM.info("syncToPersonalSpace: orchestrator not built — running reconcileSync to lazy-build")
            SyncActivation.reconcileSync(project, service)
            JM.info("syncToPersonalSpace: after reconcileSync, isSyncBuilt=${service.isSyncBuilt()}")
        }
        JM.info("syncToPersonalSpace: calling requestManualSync (orchestrator built=${service.isSyncBuilt()})")
        service.requestManualSync()
        JM.info("syncToPersonalSpace: requestManualSync returned")
    }

    /**
     * Manual "Build Knowledge Wiki" — IntelliJ port of the VS Code
     * `jollimemory.compileNow` command (vscode/src/CompileCommand.ts). Ingests
     * pending sources into topic pages and regenerates the visible `_wiki/` for
     * every Memory Bank repo, with a background progress task and a result toast.
     */
    private fun buildKnowledgeWiki() {
        JM.info("buildKnowledgeWiki: button clicked")
        val config = SessionTracker.loadConfig()
        // Either a Jolli sign-in (proxy mode) or an Anthropic key (direct mode, local
        // prompt templates) can drive the wiki build.
        val hasCredentials = !config.apiKey.isNullOrBlank() ||
            !config.jolliApiKey.isNullOrBlank() ||
            !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()
        if (!hasCredentials) {
            notifyWiki(
                "Building the knowledge wiki needs an API key. Open Settings → Memory Bank to sign in or configure a key, then try again.",
                NotificationType.INFORMATION,
            )
            return
        }
        if (wikiBuildInFlight) {
            notifyWiki("Knowledge wiki build is already in progress.", NotificationType.INFORMATION)
            return
        }
        wikiBuildInFlight = true

        val parent = config.knowledgeBasePath?.let { Path.of(it) } ?: KBPathResolver.KB_PARENT
        val llmConfig = IngestPipeline.LlmConfig(
            apiKey = config.apiKey,
            jolliApiKey = config.jolliApiKey,
            model = config.model,
            aiProvider = config.aiProvider,
        )

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Building knowledge wiki…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val result = MultiRepoCompile.compileAllRepos(
                        parent, llmConfig,
                        excludeFolders = config.compileExcludeFolders ?: emptyList(),
                        onProgress = { folder -> indicator.text = "Compiling $folder…" },
                    )
                    if (result.skipped) {
                        notifyWiki(
                            "Another knowledge wiki build is already running for this Memory Bank folder — skipped.",
                            NotificationType.INFORMATION,
                        )
                    } else {
                        val failedNote = if (result.failed > 0) " (${result.failed} failed)" else ""
                        notifyWiki(
                            "Knowledge wiki updated: ${result.totalIngested} source(s) across ${result.repos.size} repo(s)$failedNote.",
                            NotificationType.INFORMATION,
                        )
                    }
                    // External nio writes — refresh the VFS subtree so the KB tree picks up _wiki/.
                    ApplicationManager.getApplication().invokeLater {
                        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(parent)?.refresh(true, true)
                    }
                } catch (e: Exception) {
                    JM.warn("buildKnowledgeWiki failed: ${e.message}")
                    notifyWiki("Knowledge wiki build failed: ${e.message}", NotificationType.ERROR)
                } finally {
                    wikiBuildInFlight = false
                }
            }
        })
    }

    private fun notifyWiki(message: String, type: NotificationType) {
        com.intellij.notification.Notifications.Bus.notify(
            com.intellij.notification.Notification("JolliMemory", "Build Knowledge Wiki", message, type),
            project,
        )
    }

    /**
     * Reflects a sync state change in the toolbar indicator. Runs on the EDT.
     *
     * Mirrors the IDE status-bar widget ([ai.jolli.jollimemory.sync.SyncStatusBarWidget]),
     * which remains the canonical place for terminal errors. This inline copy gives
     * immediate, in-panel feedback so the user does not have to hunt for the status bar:
     * - SYNCING  → "⟳ Syncing…"
     * - SYNCED   → "✓ Synced" (auto-clears after a few seconds)
     * - CONFLICTS→ "⚠ N conflicts"
     * - OFFLINE  → "✗ Sync failed" when a terminal error is present, otherwise hidden
     */
    private fun updateSyncStatus(state: SyncState, detail: SyncStatusDetail?) {
        syncClearTimer?.stop()
        syncClearTimer = null

        when (state) {
            SyncState.SYNCING -> {
                syncStatusLabel.text = "⟳ Syncing…"
                syncStatusLabel.foreground = JBColor.foreground()
                syncStatusLabel.toolTipText = "Memory Bank sync in progress"
                syncStatusLabel.isVisible = true
            }
            SyncState.SYNCED -> {
                syncStatusLabel.text = "✓ Synced"
                syncStatusLabel.foreground = JBColor(Color(0x59, 0xA8, 0x69), Color(0x5F, 0xB8, 0x65))
                syncStatusLabel.toolTipText = "Memory Bank in sync"
                syncStatusLabel.isVisible = true
                // Transient success — fade out so the toolbar returns to its resting state.
                syncClearTimer = Timer(4000) {
                    syncStatusLabel.isVisible = false
                    syncStatusLabel.text = ""
                }.apply { isRepeats = false; start() }
            }
            SyncState.CONFLICTS -> {
                val count = detail?.conflictCount
                syncStatusLabel.text = if (count != null) "⚠ $count conflicts" else "⚠ Conflicts"
                syncStatusLabel.foreground = JBColor(Color(0xC2, 0x8A, 0x00), Color(0xD6, 0xA0, 0x2E))
                syncStatusLabel.toolTipText =
                    if (count != null) "$count items need your attention" else "Conflicts need your attention"
                syncStatusLabel.isVisible = true
            }
            SyncState.OFFLINE -> {
                if (detail?.failed == true && detail.failedCode != null) {
                    syncStatusLabel.text = failedText(detail.failedCode)
                    syncStatusLabel.foreground = JBColor(Color(0xC7, 0x42, 0x2E), Color(0xD9, 0x5A, 0x4A))
                    // The full error lives in the IDE status bar; tooltip carries the detail here too.
                    syncStatusLabel.toolTipText = detail.lastError ?: "Memory Bank sync failed"
                    syncStatusLabel.isVisible = true
                } else {
                    syncStatusLabel.isVisible = false
                    syncStatusLabel.text = ""
                }
            }
        }
        syncStatusLabel.parent?.revalidate()
        syncStatusLabel.parent?.repaint()
    }

    /** Short toolbar label for a terminal sync error; mirrors the status-bar widget. */
    private fun failedText(code: SyncErrorCode): String = when (code) {
        SyncErrorCode.VAULT_LOCKED -> "⚠ Personal Space busy"
        SyncErrorCode.LOCALFOLDER_INVALID -> "✗ Folder invalid"
        SyncErrorCode.PUSH_REJECTED -> "✗ Push rejected"
        else -> "✗ Sync failed"
    }

    // ── Timeline view ──────────────────────────────────────────────────────

    private fun buildTimeline() {
        val groups = KBDataCache.byTimeline()
        if (groups.isEmpty()) {
            showMessageIn(timelinePanel, "No memories yet")
            return
        }

        val rootNode = DefaultMutableTreeNode("Timeline")
        for ((dateLabel, entries) in groups) {
            val filtered = entries.filter { matchesSearch(it.repo, it.branch, it.title, it.path) }
            if (filtered.isEmpty()) continue
            val dateNode = DefaultMutableTreeNode(dateLabel)
            for (entry in filtered) {
                val display = entry.title ?: entry.path
                dateNode.add(DefaultMutableTreeNode(KBNodeData(
                    entry.fullPath, entry.path, displayName = display,
                    isDirectory = false, badge = "C",
                    branch = entry.branch, entryKbRoot = entry.kbRoot,
                )))
            }
            rootNode.add(dateNode)
        }

        if (rootNode.childCount == 0) {
            showMessageIn(timelinePanel, "No results for \"$searchQuery\"")
            return
        }

        SwingUtilities.invokeLater {
            val t = Tree(DefaultTreeModel(rootNode)).apply {
                isRootVisible = false
                showsRootHandles = true
                cellRenderer = TimelineCellRenderer()
            }
            t.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) {
                        val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
                        val data = node.userObject as? KBNodeData ?: return
                        if (!data.isDirectory) openCommitSummary(data)
                    }
                }
                override fun mousePressed(e: MouseEvent) { if (e.isPopupTrigger) showMemoryPopup(e, t) }
                override fun mouseReleased(e: MouseEvent) { if (e.isPopupTrigger) showMemoryPopup(e, t) }
            })
            // Expand all date groups
            for (i in 0 until rootNode.childCount) {
                t.expandPath(TreePath(arrayOf(rootNode, rootNode.getChildAt(i))))
            }
            timelinePanel.removeAll()
            timelinePanel.add(JBScrollPane(t), BorderLayout.CENTER)
            timelinePanel.revalidate()
            timelinePanel.repaint()
        }
    }

    // ── View helpers ──────────────────────────────────────────────────────

    private fun showMessageIn(panel: JPanel, text: String) {
        SwingUtilities.invokeLater {
            panel.removeAll()
            val escaped = StringUtil.escapeXmlEntities(text)
            panel.add(JLabel("<html><center>$escaped</center></html>", SwingConstants.CENTER).apply {
                border = JBUI.Borders.empty(20)
            }, BorderLayout.CENTER)
            panel.revalidate()
            panel.repaint()
        }
    }

    private fun showMessage(text: String) {
        showMessageIn(treePanel, text)
        showMessageIn(timelinePanel, text)
    }

    private fun findNodeByPath(node: DefaultMutableTreeNode, targetPath: Path): DefaultMutableTreeNode? {
        val data = node.userObject as? KBNodeData
        if (data?.path == targetPath) return node
        for (i in 0 until node.childCount) {
            val child = node.getChildAt(i) as? DefaultMutableTreeNode ?: continue
            val found = findNodeByPath(child, targetPath)
            if (found != null) return found
        }
        return null
    }

    private fun isHiddenOrInternal(name: String): Boolean {
        return name.startsWith(".") || name == "summaries" || name == "transcripts" || name == "plan-progress"
    }

    override fun dispose() {
        busConnection.disconnect()
        service.removeStatusListener(statusListener)
        service.removeSyncStateListener(syncStateListener)
        syncClearTimer?.stop()
        syncClearTimer = null
    }

    companion object {
        private val LOG = Logger.getInstance(KBExplorerPanel::class.java)
        // Lands in the shared <projectDir>/.jolli/jollimemory/debug.log so the
        // manual-sync click path is observable alongside the sync-layer logs.
        private val JM = ai.jolli.jollimemory.core.JmLogger.create("KBExplorerPanel")

        /** Process-wide guard: at most one knowledge-wiki build runs at a time. */
        @Volatile
        private var wikiBuildInFlight = false
    }

    // ── Tree cell renderer ─────────────────────────────────────────────────

    private class KBTreeCellRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean,
            expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = value as? DefaultMutableTreeNode ?: return
            val data = node.userObject as? KBNodeData ?: return
            if (data.isRepoRoot) {
                icon = AllIcons.Nodes.Module
                val attrs = if (data.isCurrentRepo) SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES
                    else SimpleTextAttributes.REGULAR_ATTRIBUTES
                append(data.name, attrs)
            } else if (data.isDirectory) {
                icon = AllIcons.Nodes.Folder
                append(data.name)
            } else {
                icon = FileTypeManager.getInstance().getFileTypeByFileName(data.name).icon
                append(data.displayName ?: data.name)
                when (data.badge) {
                    "C" -> append("  C", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, Color(0x9C, 0x27, 0xB0)))
                    "P" -> append("  P", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, Color(0x21, 0x96, 0xF3)))
                    "N" -> append("  N", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, Color(0x4C, 0xAF, 0x50)))
                }
            }
        }
    }

    private class TimelineCellRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean,
            expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = value as? DefaultMutableTreeNode ?: return
            val data = node.userObject
            if (data is String) {
                // Date group header
                icon = AllIcons.Actions.GroupByPrefix
                append(data, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            } else if (data is KBNodeData) {
                icon = AllIcons.Vcs.CommitNode
                append(data.displayName ?: data.name)
            }
        }
    }

}
