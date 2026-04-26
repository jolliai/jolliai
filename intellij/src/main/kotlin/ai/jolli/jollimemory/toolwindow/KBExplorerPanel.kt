package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
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
import javax.swing.JLabel
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JTree
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
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

    private var tree: Tree? = null
    private var treeModel: DefaultTreeModel? = null
    private var kbRoot: Path? = null
    private var metadataManager: MetadataManager? = null
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private val refreshTimer: javax.swing.Timer
    private val statusListener: () -> Unit

    data class KBNodeData(
        val path: Path,
        val name: String,
        val displayName: String? = null,
        val isDirectory: Boolean,
        val badge: String? = null,
    )

    init {
        border = JBUI.Borders.empty()
        showMessage("Loading...")

        statusListener = { ApplicationManager.getApplication().executeOnPooledThread { refresh() } }
        service.addStatusListener(statusListener)

        refreshTimer = javax.swing.Timer(3000) {
            ApplicationManager.getApplication().executeOnPooledThread { refresh() }
        }.apply {
            isRepeats = true
            start()
        }
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
            buildTree()
        } catch (e: Exception) {
            showMessage("Refresh error: ${e.message}")
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
        val root = kbRoot ?: throw IllegalStateException("KB root not resolved")
        if (!Files.isDirectory(root)) {
            showMessage("KB folder not found: $root")
            return
        }

        val badgeMap = mutableMapOf<String, String>()
        val titleMap = mutableMapOf<String, String>()
        metadataManager?.readManifest()?.files?.forEach { entry ->
            badgeMap[entry.path] = when (entry.type) {
                "commit" -> "C"; "plan" -> "P"; "note" -> "N"; else -> ""
            }
            if (entry.title != null) titleMap[entry.path] = entry.title
        }

        val rootNode = DefaultMutableTreeNode("KB")
        val dirs = Files.list(root).use { s ->
            s.filter { it.isDirectory() }
                .filter { !isHiddenOrInternal(it.name) }
                .sorted(compareBy { it.name })
                .toList()
        }

        for (dir in dirs) {
            val branchNode = DefaultMutableTreeNode(KBNodeData(dir, dir.name, isDirectory = true))
            addChildren(branchNode, dir, root, badgeMap, titleMap)
            rootNode.add(branchNode)  // Show all folders including empty ones
        }

        Files.list(root).use { s ->
            s.filter { it.isRegularFile() }
                .filter { !it.name.startsWith(".") && it.name != "index.json" }
                .sorted(compareBy { it.name })
                .forEach { file ->
                    val relPath = root.relativize(file).toString()
                    rootNode.add(DefaultMutableTreeNode(
                        KBNodeData(file, file.name, displayName = titleMap[relPath], isDirectory = false, badge = badgeMap[relPath])
                    ))
                }
        }

        if (rootNode.childCount == 0) {
            showMessage("No memories yet — commit with an AI coding tool to get started")
            return
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
                // Preserve selection across refresh
                val selectedPath = tree!!.selectionPath
                treeModel = model
                tree!!.model = model
                if (selectedPath != null) {
                    tree!!.selectionPath = selectedPath
                }
            }

            removeAll()
            add(JBScrollPane(tree!!), BorderLayout.CENTER)
            for (i in 0 until rootNode.childCount) {
                tree!!.expandPath(TreePath(arrayOf(rootNode, rootNode.getChildAt(i))))
            }
            revalidate()
            repaint()
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
        } catch (_: Exception) {}
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
                    } catch (_: Exception) {
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
        popup.add(JMenuItem("Reveal in Finder").apply {
            addActionListener {
                val target = data?.path ?: root
                try {
                    // Use 'open -R' to reveal and select the file/folder in Finder
                    Runtime.getRuntime().exec(arrayOf("open", "-R", target.toString()))
                } catch (_: Exception) {}
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
            } catch (_: Exception) {
                SwingUtilities.invokeLater { openFile(data.path) }
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun backgroundRefresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refresh() }
    }

    private fun showMessage(text: String) {
        SwingUtilities.invokeLater {
            removeAll()
            add(JLabel("<html><center>$text</center></html>", SwingConstants.CENTER).apply {
                border = JBUI.Borders.empty(20)
            }, BorderLayout.CENTER)
            revalidate()
            repaint()
        }
    }

    private fun isHiddenOrInternal(name: String): Boolean {
        return name.startsWith(".") || name == "summaries" || name == "transcripts" || name == "plan-progress"
    }

    override fun dispose() {
        refreshTimer.stop()
        service.removeStatusListener(statusListener)
    }

    // ── Tree cell renderer ─────────────────────────────────────────────────

    private class KBTreeCellRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean,
            expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = value as? DefaultMutableTreeNode ?: return
            val data = node.userObject as? KBNodeData ?: return
            if (data.isDirectory) {
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
}
