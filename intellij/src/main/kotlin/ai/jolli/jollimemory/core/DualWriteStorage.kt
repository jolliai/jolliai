package ai.jolli.jollimemory.core

/**
 * DualWriteStorage — StorageProvider that writes to both orphan branch and folder.
 *
 * Primary (OrphanBranchStorage) is the source of truth for reads.
 * Shadow (FolderStorage) receives a copy of every write. Shadow failures
 * are logged as warnings but never block the primary write path.
 *
 * Part of JOLLI-1309 / Phase 2, Step 2.1.
 */
class DualWriteStorage(
    private val primary: OrphanBranchStorage,
    private val shadow: FolderStorage,
) : StorageProvider {

    private val log = JmLogger.create("DualWriteStorage")

    override fun readFile(path: String): String? {
        return primary.readFile(path)
    }

    override fun writeFiles(files: List<FileWrite>, message: String) {
        primary.writeFiles(files, message)
        try {
            shadow.writeFiles(files, message)
        } catch (e: Exception) {
            log.warn("Shadow write failed (folder storage): %s", e.message)
        }
    }

    override fun listFiles(prefix: String): List<String> {
        return primary.listFiles(prefix)
    }

    override fun exists(): Boolean {
        return primary.exists()
    }

    override fun ensure() {
        primary.ensure()
        try {
            shadow.ensure()
        } catch (e: Exception) {
            log.warn("Shadow ensure failed (folder storage): %s", e.message)
        }
    }
}
