package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.KBDataCache
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.MigrationEngine
import ai.jolli.jollimemory.core.MigrationState
import ai.jolli.jollimemory.core.FolderStorage
import ai.jolli.jollimemory.core.OrphanBranchStorage
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.services.JolliMemoryService
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.icons.AllIcons
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
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
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JToggleButton
import javax.swing.JTree
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
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
 * KBExplorerPanel — Knowledge Base folder browser with context menu, drag-and-drop,
 * selection highlighting, and metadata sync.
 */
class KBExplorerPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    private enum class ViewMode { TREE, TIMELINE, AZ }

    private var tree: Tree? = null
    private var treeModel: DefaultTreeModel? = null
    private var kbRoot: Path? = null
    private var metadataManager: MetadataManager? = null
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private var currentView = ViewMode.TREE
    private val contentPanel = JPanel(CardLayout())
    private val treePanel = JPanel(BorderLayout())
    private val timelinePanel = JPanel(BorderLayout())
    private val azPanel = JPanel(BorderLayout())
    private var cachedRepos: List<KBRepoDiscoverer.DiscoveredRepo> = emptyList()
    private var searchQuery: String = ""

    private val statusListener: () -> Unit
    private val busConnection: MessageBusConnection

    data class KBNodeData(
        val path: Path,
        val name: String,
        val displayName: String? = null,
        val isDirectory: Boolean,
        val isRepoRoot: Boolean = false,
        val isCurrentRepo: Boolean = false,
        val badge: String? = null,
    )

    init {
        border = JBUI.Borders.empty()

        // Toolbar with view toggle buttons
        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 2, 0)).apply {
            border = JBUI.Borders.empty(2)
        }
        val btnTree = JToggleButton("Tree", true).apply { toolTipText = "Tree view"; putClientProperty("JButton.buttonType", "segmented"); putClientProperty("JButton.segmentPosition", "first") }
        val btnTimeline = JToggleButton("Timeline").apply { toolTipText = "Timeline view"; putClientProperty("JButton.buttonType", "segmented"); putClientProperty("JButton.segmentPosition", "middle") }
        val btnAZ = JToggleButton("A-Z").apply { toolTipText = "Alphabetical view"; putClientProperty("JButton.buttonType", "segmented"); putClientProperty("JButton.segmentPosition", "last") }
        val viewButtons = listOf(btnTree, btnTimeline, btnAZ)
        fun selectView(mode: ViewMode) {
            currentView = mode
            viewButtons.forEach { it.isSelected = false }
            when (mode) { ViewMode.TREE -> btnTree; ViewMode.TIMELINE -> btnTimeline; ViewMode.AZ -> btnAZ }.isSelected = true
            (contentPanel.layout as CardLayout).show(contentPanel, mode.name)
            ApplicationManager.getApplication().executeOnPooledThread { rebuildCurrentView() }
        }
        btnTree.addActionListener { selectView(ViewMode.TREE) }
        btnTimeline.addActionListener { selectView(ViewMode.TIMELINE) }
        btnAZ.addActionListener { selectView(ViewMode.AZ) }
        toolbar.add(btnTree)
        toolbar.add(btnTimeline)
        toolbar.add(btnAZ)
        toolbar.add(javax.swing.Box.createHorizontalStrut(8))

        // Search field
        val searchField = com.intellij.ui.SearchTextField(false).apply {
            toolTipText = "Search across all repos"
            textEditor.columns = 12
        }
        searchField.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
            override fun removeUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
            override fun changedUpdate(e: DocumentEvent?) = onSearchChanged(searchField.text)
        })
        toolbar.add(searchField)
        toolbar.add(javax.swing.Box.createHorizontalStrut(4))

        // Reset button
        val btnReset = JButton(AllIcons.Actions.Refresh).apply {
            toolTipText = "Reset — re-migrate from orphan branch"
            isBorderPainted = false
            isContentAreaFilled = false
            addActionListener {
                ApplicationManager.getApplication().executeOnPooledThread { resetMigration() }
            }
        }
        toolbar.add(btnReset)

        contentPanel.add(treePanel, ViewMode.TREE.name)
        contentPanel.add(timelinePanel, ViewMode.TIMELINE.name)
        contentPanel.add(azPanel, ViewMode.AZ.name)

        add(toolbar, BorderLayout.NORTH)
        add(contentPanel, BorderLayout.CENTER)

        showMessage("Loading...")

        statusListener = { ApplicationManager.getApplication().executeOnPooledThread { refresh() } }
        service.addStatusListener(statusListener)

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
            ViewMode.AZ -> buildAZ()
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
            repoMM.readManifest().files.forEach { entry ->
                badgeMap[entry.path] = when (entry.type) {
                    "commit" -> "C"; "plan" -> "P"; "note" -> "N"; else -> ""
                }
                if (entry.title != null) titleMap[entry.path] = entry.title
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
                addChildren(branchNode, dir, repo.kbRoot, badgeMap, titleMap)
                repoNode.add(branchNode)
            }

            // Add root-level files
            Files.list(repo.kbRoot).use { s ->
                s.filter { it.isRegularFile() }
                    .filter { !it.name.startsWith(".") && it.name != "index.json" }
                    .sorted(compareBy { it.name })
                    .forEach { file ->
                        val relPath = repo.kbRoot.relativize(file).toString()
                        repoNode.add(DefaultMutableTreeNode(
                            KBNodeData(file, file.name, displayName = titleMap[relPath], isDirectory = false, badge = badgeMap[relPath])
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

    private fun addChildren(
        parentNode: DefaultMutableTreeNode, dir: Path, kbRoot: Path,
        badgeMap: Map<String, String>, titleMap: Map<String, String>,
    ) {
        try {
            Files.list(dir).use { s ->
                s.filter { !it.name.startsWith(".") }
                    .sorted(compareByDescending<Path> { it.isDirectory() }.thenBy { it.name })
                    .forEach { child ->
                        val relPath = kbRoot.relativize(child).toString()
                        if (child.isDirectory()) {
                            val n = DefaultMutableTreeNode(KBNodeData(child, child.name, isDirectory = true))
                            addChildren(n, child, kbRoot, badgeMap, titleMap)
                            parentNode.add(n)
                        } else {
                            parentNode.add(DefaultMutableTreeNode(
                                KBNodeData(child, child.name, displayName = titleMap[relPath], isDirectory = false, badge = badgeMap[relPath])
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
                            val oldRel = root.relativize(internalSource).toString()
                            val newRel = root.relativize(dest).toString()
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
                                    val oldRel = root.relativize(source).toString()
                                    val newRel = root.relativize(dest).toString()
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
        val root = kbRoot ?: return
        val mm = metadataManager ?: return
        val popup = JPopupMenu()

        val targetDir = when {
            data == null -> root
            data.isDirectory -> data.path
            else -> data.path.parent ?: root
        }

        popup.add(JMenuItem("New Folder").apply {
            addActionListener { doNewFolder(targetDir) }
        })
        popup.add(JMenuItem("New Markdown File").apply {
            addActionListener { doNewFile(targetDir) }
        })
        popup.add(JMenuItem("Import File(s)...").apply {
            addActionListener { doImportFiles(targetDir) }
        })

        if (data != null) {
            popup.addSeparator()
            popup.add(JMenuItem("Rename").apply {
                addActionListener { doRename(data, root, mm) }
            })
            if (!data.isDirectory) {
                popup.add(JMenuItem("Move to...").apply {
                    addActionListener { doMove(data, root, mm) }
                })
            }
            popup.addSeparator()
            popup.add(JMenuItem("Delete").apply {
                addActionListener { doDelete(data, root, mm) }
            })
        }

        popup.addSeparator()
        popup.add(JMenuItem(RevealFileAction.getActionName()).apply {
            addActionListener {
                val target = data?.path ?: root
                RevealFileAction.openFile(target.toFile())
            }
        })

        popup.show(e.component, e.x, e.y)
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
                val oldRelPath = root.relativize(data.path).toString()
                val newRelPath = root.relativize(newPath).toString()
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
            Messages.showWarningDialog(project, "Destination must be inside the Knowledge Base folder.", "Move")
            return
        }

        try {
            val destPath = destDir.resolve(data.name)
            Files.move(data.path, destPath)

            val oldRelPath = root.relativize(data.path).toString()
            val newRelPath = root.relativize(destPath).toString()
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
                val relPath = root.relativize(data.path).toString()
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
        val root = kbRoot ?: return
        val mm = metadataManager ?: return
        val relativePath = root.relativize(data.path).toString()
        val entry = mm.findByPath(relativePath) ?: run { openFile(data.path); return }
        val summaryPath = root.resolve(".jolli/summaries/${entry.fileId}.json")
        if (!Files.exists(summaryPath)) { openFile(data.path); return }

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val json = Files.readString(summaryPath, java.nio.charset.StandardCharsets.UTF_8)
                val summary = gson.fromJson(json, CommitSummary::class.java)
                if (summary != null) {
                    SwingUtilities.invokeLater {
                        FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary), true)
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

    // ── A-Z view ──────────────────────────────────────────────────────────

    private fun buildAZ() {
        val entries = KBDataCache.byAlpha()
            .filter { matchesSearch(it.repo, it.branch, it.title, it.path) }
        if (entries.isEmpty()) {
            showMessageIn(azPanel, if (searchQuery.isEmpty()) "No memories yet" else "No results for \"$searchQuery\"")
            return
        }

        val rootNode = DefaultMutableTreeNode("A-Z")
        for (entry in entries) {
            val label = "${entry.repo} :: ${entry.branch ?: "?"} :: ${entry.title ?: entry.path}"
            rootNode.add(DefaultMutableTreeNode(KBNodeData(
                entry.fullPath, label, isDirectory = false, badge = "C",
            )))
        }

        SwingUtilities.invokeLater {
            val t = Tree(DefaultTreeModel(rootNode)).apply {
                isRootVisible = false
                showsRootHandles = false
                cellRenderer = AZCellRenderer()
            }
            t.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) {
                        val node = t.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
                        val data = node.userObject as? KBNodeData ?: return
                        if (!data.isDirectory) openCommitSummary(data)
                    }
                }
            })
            azPanel.removeAll()
            azPanel.add(JBScrollPane(t), BorderLayout.CENTER)
            azPanel.revalidate()
            azPanel.repaint()
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
        showMessageIn(azPanel, text)
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
    }

    companion object {
        private val LOG = Logger.getInstance(KBExplorerPanel::class.java)
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

    private class AZCellRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean,
            expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = value as? DefaultMutableTreeNode ?: return
            val data = node.userObject as? KBNodeData ?: return
            icon = AllIcons.Vcs.CommitNode
            // name is already "repo :: branch :: title"
            val parts = data.name.split(" :: ", limit = 3)
            if (parts.size == 3) {
                append(parts[0], SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append(" :: ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append(parts[1], SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append(" :: ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append(parts[2])
            } else {
                append(data.name)
            }
        }
    }
}
