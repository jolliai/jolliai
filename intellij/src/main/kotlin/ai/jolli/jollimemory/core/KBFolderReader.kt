package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import com.intellij.openapi.diagnostic.Logger
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path

/**
 * KBFolderReader — native, bridge-free reads of the hidden `.jolli/` metadata
 * layer for hot UI paths.
 *
 * Rationale: the VS Code sidebar's Memory Bank tab reads `.jolli/manifest.json`
 * directly via `fs.readFile` in [KbFoldersService.buildManifestLookup] rather
 * than going through the CLI's `MetadataManager.readManifest()` even though it
 * has the CLI code in-process. The bypass saves the JSON round-trip through
 * the class boundary and keeps the folder-tree render at microsecond latency.
 *
 * IntelliJ's equivalent hot path (KBExplorerPanel.buildTree per-repo loop)
 * previously routed every manifest / index read through `MetadataManager`, i.e.
 * one ide-bridge daemon call per repo per refresh. On a Memory Bank with 10+
 * repos this added 50–200 ms of pure IPC to every tree rebuild. This reader
 * mirrors VS Code's bypass — same disk read, same Gson parse, no daemon hop.
 *
 * LOCKSTEP CONTRACT: the JSON schemas parsed here MUST stay in step with
 * `cli/src/core/MetadataManager.ts` (manifest, index) and with [Manifest],
 * [SummaryIndex] in this repo. A schema-touching change to either side must
 * update the other in the same PR.
 *
 * SCOPE: read-only. Writes still go through [MetadataManager] over the ide
 * bridge so dual-write consistency, RMW guards, and atomicWrite semantics stay
 * owned by the CLI. Never add a write here.
 *
 * NO DIRTY-GATE (unlike [FolderStorageReader]): manifest.json and index.json
 * are written via `MetadataManager.atomicWrite` (write-to-tmp + rename), so a
 * read always sees either the old or the new complete file — never a partial
 * write. A slightly stale manifest during a shadow-write transaction is
 * acceptable here because the tree render is eventually consistent (the next
 * refresh picks up the new data). The dirty-gate in FolderStorageReader exists
 * to protect summary JSON reads that participate in the multi-file transaction;
 * the tree-level manifest/index reads do not need that protection.
 *
 * ERROR POLICY: fail soft. Missing file returns an empty payload silently
 * (expected on a fresh repo). Malformed JSON returns the same empty payload
 * but logs at WARN — a corrupt manifest indistinguishably reading as "no
 * memories yet" is exactly the class of failure worth a diagnostic breadcrumb.
 */
object KBFolderReader {
    private val LOG = Logger.getInstance(KBFolderReader::class.java)
    private val gson = Gson()

    /**
     * Reads `<kbRoot>/.jolli/manifest.json`. Returns an empty [Manifest] when
     * the file is missing or unparseable — the calling tree code renders "no
     * memories yet" in that case, same as when the CLI class returns an empty
     * manifest.
     */
    fun readManifest(kbRoot: Path): Manifest {
        val path = kbRoot.resolve(".jolli").resolve("manifest.json")
        return try {
            val raw = Files.readString(path, StandardCharsets.UTF_8)
            gson.fromJson(raw, Manifest::class.java) ?: Manifest()
        } catch (_: NoSuchFileException) {
            Manifest()
        } catch (e: JsonSyntaxException) {
            LOG.warn("readManifest: malformed JSON at $path — treating as empty (${e.message})")
            Manifest()
        } catch (e: Exception) {
            LOG.warn("readManifest: read failed at $path — treating as empty", e)
            Manifest()
        }
    }

    /**
     * Reads `<kbRoot>/.jolli/index.json`. Returns null when the file is
     * missing or unparseable — the tree code treats null as "no index yet"
     * (no squash-child hiding possible), which is the same behavior as
     * `MetadataManager.readIndex()` returning `JsonNull`.
     */
    fun readIndex(kbRoot: Path): SummaryIndex? {
        val path = kbRoot.resolve(".jolli").resolve("index.json")
        return try {
            val raw = Files.readString(path, StandardCharsets.UTF_8)
            gson.fromJson(raw, SummaryIndex::class.java)
        } catch (_: NoSuchFileException) {
            null
        } catch (e: JsonSyntaxException) {
            LOG.warn("readIndex: malformed JSON at $path — treating as absent (${e.message})")
            null
        } catch (e: Exception) {
            LOG.warn("readIndex: read failed at $path — treating as absent", e)
            null
        }
    }
}
