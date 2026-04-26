package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitOps
import java.nio.file.Path

/**
 * StorageFactory — creates the appropriate StorageProvider based on config.
 *
 * Storage modes:
 * - "orphan" (default): OrphanBranchStorage only — current behavior
 * - "dual-write": writes to both orphan branch and folder, reads from orphan
 * - "folder": FolderStorage only — final target state
 *
 * Part of JOLLI-1309 / Phase 2, Step 2.1.
 */
object StorageFactory {

    private val log = JmLogger.create("StorageFactory")

    /**
     * Creates a StorageProvider based on the configured storage mode.
     *
     * @param git GitOps instance for OrphanBranchStorage
     * @param projectPath The resolved repo root path (for resolving KB folder)
     * @param config The user's JolliMemoryConfig (contains storageMode, knowledgeBasePath)
     */
    fun create(git: GitOps, projectPath: String, config: JolliMemoryConfig = SessionTracker.loadConfig()): StorageProvider {
        val mode = config.storageMode ?: "dual-write"
        log.info("StorageFactory.create: storageMode=%s, projectPath=%s", mode, projectPath)

        return when (mode) {
            "dual-write" -> {
                val orphan = OrphanBranchStorage(git)
                val folder = createFolderStorage(projectPath, config)
                log.info("Storage mode: dual-write (primary=orphan, shadow=folder)")
                DualWriteStorage(orphan, folder)
            }
            "folder" -> {
                log.info("Storage mode: folder")
                createFolderStorage(projectPath, config)
            }
            else -> {
                log.info("Storage mode: orphan (default)")
                OrphanBranchStorage(git)
            }
        }
    }

    private fun createFolderStorage(projectPath: String, config: JolliMemoryConfig): FolderStorage {
        val repoName = KBPathResolver.extractRepoName(projectPath)
        val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
        val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
        val metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        return FolderStorage(kbRoot, metadataManager)
    }
}
