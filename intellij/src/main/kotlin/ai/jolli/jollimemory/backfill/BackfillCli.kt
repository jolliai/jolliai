package ai.jolli.jollimemory.backfill

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * BackfillCli — out-of-process bridge to the `jolli backfill` engine.
 *
 * The VS Code extension bundles the CLI and calls `runBackfill` / `listMissingCommits`
 * in-process. The IntelliJ plugin generates memory with native Java hooks and has no
 * in-process JS runtime, so it drives the SAME engine over the CLI's subprocess
 * surface (see cli/src/commands/BackfillCommand.ts):
 *
 *   - [listCandidates] → `jolli backfill --list-candidates` (cold-start signals, no LLM)
 *   - [preview]        → `jolli backfill --hashes … --dry-run` (per-commit session/turn
 *                        counts for the selectable list, no LLM)
 *   - [run]            → `jolli backfill --hashes … --stream` (real generation, one NDJSON
 *                        progress line per commit)
 *
 * Node + the bundled `Cli.js` are resolved via [CliIntegrations] (the same resolution
 * the MCP/skills enable path uses), so a machine without Node degrades to
 * [Outcome.NodeMissing] rather than crashing — memory generation itself never needs it.
 */
object BackfillCli {

	private val log = JmLogger.create("BackfillCli")

	/** A commit that lacks a summary — mirrors the CLI's `MissingCommitInfo`. */
	data class Candidate(
		val commitHash: String,
		val subject: String,
		val ts: Long,
		/** Attributed AI conversations (0 = diff-only). Populated by [preview], else 0. */
		val sessions: Int = 0,
		/** User-initiated turns across those conversations. Populated by [preview], else 0. */
		val conversationTurns: Int = 0,
	)

	/** Cold-start signals from `--list-candidates` (the offer card's inputs). */
	data class ColdStartSignals(
		val hasAnyMemory: Boolean,
		val total: Int,
		val missing: Int,
		val candidates: List<Candidate>,
	)

	/** One per-commit progress event from `--stream`. */
	data class Progress(
		val done: Int,
		val total: Int,
		val commitHash: String,
		val subject: String,
		val status: String,
		val sessions: Int,
		val topics: Int,
	)

	/** Final tally from a `--stream` run (or a `--dry-run` report). */
	data class Report(
		val total: Int,
		val generated: Int,
		val skipped: Int,
		val errors: Int,
		/** Only the acted-on rows (generated / error), for the card's done view. */
		val rows: List<Progress>,
	)

	/** Result of a subprocess call: success, or a reason the engine could not run. */
	sealed class Outcome<out T> {
		data class Ok<T>(val value: T) : Outcome<T>()

		/** Node is not on PATH — back-fill is unavailable (memory generation still works). */
		object NodeMissing : Outcome<Nothing>()

		/** The bundled `Cli.js` could not be located (packaging problem). */
		object BundleMissing : Outcome<Nothing>()

		/** The CLI ran but failed (non-zero exit, timeout, or malformed output). */
		data class Failed(val message: String) : Outcome<Nothing>()
	}

	/**
	 * Resolves a runnable `Cli.js`, preferring the plugin's OWN bundled copy
	 * (`<plugin>/cli-dist/Cli.js`) because it always matches the running plugin's code —
	 * it therefore always understands the CLI flags this class emits (`--list-candidates`,
	 * `--stream`, …).
	 *
	 * We deliberately do NOT prefer the extracted `~/.jolli/jollimemory/dist-intellij/Cli.js`:
	 * that copy is refreshed only on a plugin **version change** (via `enableIntegrations`),
	 * so a same-version rebuild — or an upgrade whose bundled CLI gained new flags without a
	 * matching re-extract — leaves it stale. A stale copy silently rejects the new flags
	 * (exit 1), which manifests as "the cold-start card never appears." The extracted dist
	 * exists for the hook/MCP dispatch indirection, not for the plugin's own subprocess
	 * calls; it is only a fallback here for the rare layout where the bundle can't be found.
	 */
	private fun resolveCliJs(): File? {
		CliIntegrations.resolveBundledCliJs()?.let { return it }
		val installed = File(CliIntegrations.distIntellijDir(), "Cli.js")
		if (installed.exists()) return installed
		return CliIntegrations.extractCliDist()?.let { File(it, "Cli.js").takeIf(File::exists) }
	}

	/** Common prefix `[node, Cli.js, "backfill"]`, or an Outcome explaining why it can't run. */
	private fun baseCommand(): Pair<List<String>, Outcome<Nothing>?> {
		val node = CliIntegrations.resolveNode() ?: return emptyList<String>() to Outcome.NodeMissing
		val cliJs = resolveCliJs() ?: return emptyList<String>() to Outcome.BundleMissing
		return listOf(node, cliJs.absolutePath, "backfill") to null
	}

	/**
	 * `jolli backfill --list-candidates` — cold-start signals only (no attribution, no LLM).
	 * [sinceDays]/[limit] bound + cap the candidate rows (the offer card uses 30 / 10).
	 */
	fun listCandidates(projectDir: String, sinceDays: Int? = null, limit: Int? = null): Outcome<ColdStartSignals> {
		val (base, err) = baseCommand()
		if (err != null) return err
		val args = base.toMutableList()
		args.add("--list-candidates")
		args.add("--cwd"); args.add(projectDir)
		if (sinceDays != null) { args.add("--since-days"); args.add(sinceDays.toString()) }
		if (limit != null) { args.add("--limit"); args.add(limit.toString()) }
		return capture(args, projectDir, timeoutSeconds = 30) { out ->
			val obj = JsonParser.parseString(out.trim()).asJsonObject
			ColdStartSignals(
				hasAnyMemory = obj.bool("hasAnyMemory"),
				total = obj.int("total"),
				missing = obj.int("missing"),
				candidates = obj.getAsJsonArray("candidates")?.map { parseCandidate(it.asJsonObject) } ?: emptyList(),
			)
		}
	}

	/**
	 * `jolli backfill --hashes … --dry-run` — enriches the selectable list with per-commit
	 * session/turn counts without an LLM call. Returns candidates in the SAME order as
	 * [hashes], each carrying its dry-run `sessions` / `conversationTurns` (0 when the
	 * dry-run could not attribute a commit, so the list never contradicts the offer count).
	 */
	fun preview(projectDir: String, candidates: List<Candidate>): Outcome<List<Candidate>> {
		if (candidates.isEmpty()) return Outcome.Ok(emptyList())
		val (base, err) = baseCommand()
		if (err != null) return err
		val args = base.toMutableList()
		args.add("--hashes"); args.add(candidates.joinToString(",") { it.commitHash })
		args.add("--dry-run")
		args.add("--format"); args.add("json")
		args.add("--cwd"); args.add(projectDir)
		return capture(args, projectDir, timeoutSeconds = 120) { out ->
			val report = JsonParser.parseString(out.trim()).asJsonObject
			val byHash = HashMap<String, JsonObject>()
			report.getAsJsonArray("outcomes")?.forEach { el ->
				val o = el.asJsonObject
				byHash[o.str("commitHash")] = o
			}
			candidates.map { c ->
				val o = byHash[c.commitHash]
				c.copy(
					sessions = o?.int("sessions") ?: 0,
					conversationTurns = o?.int("conversationTurns") ?: 0,
				)
			}
		}
	}

	/**
	 * `jolli backfill --hashes … --stream` — real generation. Emits one [Progress] per commit
	 * (via [onProgress]) as the engine drains, then returns the final [Report]. [shouldCancel]
	 * is polled after each event; when it flips true the subprocess is killed and the call
	 * returns [Outcome.Failed] ("cancelled").
	 *
	 * An empty [hashes] means FULL SCOPE (`--all`): every own commit reachable from HEAD that
	 * lacks a summary — the Settings "Generate Missing Summaries" path. A non-empty list backs
	 * the cold-start card's selection.
	 */
	fun run(
		projectDir: String,
		hashes: List<String>,
		onProgress: (Progress) -> Unit,
		shouldCancel: () -> Boolean = { false },
	): Outcome<Report> {
		val (base, err) = baseCommand()
		if (err != null) return err
		val args = base.toMutableList()
		if (hashes.isEmpty()) {
			args.add("--all")
		} else {
			args.add("--hashes"); args.add(hashes.joinToString(","))
		}
		args.add("--stream")
		args.add("--cwd"); args.add(projectDir)
		return try {
			// Merge stderr into stdout: the CLI routes its logs to a file (setLogDir), so
			// stdout is the NDJSON stream; any stray stderr line simply fails to parse and
			// is skipped. Merging also removes the two-pipe deadlock risk (no unread pipe).
			val proc = ProcessBuilder(args)
				.directory(File(projectDir))
				.redirectErrorStream(true)
				.start()
			var report: Report? = null
			val acted = ArrayList<Progress>()
			var cancelled = false
			// Keep the last few non-JSON lines (stderr merged in) so a genuine failure surfaces
			// the real reason instead of a bare exit code.
			val diagnostics = ArrayDeque<String>()
			proc.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
				for (line in lines) {
					val trimmed = line.trim()
					if (trimmed.isEmpty()) continue
					if (!trimmed.startsWith("{")) {
						diagnostics.addLast(trimmed)
						while (diagnostics.size > 5) diagnostics.removeFirst()
						continue
					}
					val obj = try {
						JsonParser.parseString(trimmed).asJsonObject
					} catch (_: Exception) {
						continue
					}
					when (obj.str("type")) {
						"progress" -> {
							val p = parseProgress(obj)
							if (p.status == "generated" || p.status == "error") acted.add(p)
							onProgress(p)
						}
						"report" -> report = parseReport(obj, acted)
					}
					if (shouldCancel()) {
						cancelled = true
						proc.destroyForcibly()
						break
					}
				}
			}
			if (cancelled) return Outcome.Failed("cancelled")
			if (!proc.waitFor(30, TimeUnit.MINUTES)) {
				proc.destroyForcibly()
				return Outcome.Failed("back-fill timed out")
			}
			report?.let { Outcome.Ok(it) } ?: run {
				val detail = diagnostics.lastOrNull()?.let { ": $it" } ?: ""
				log.warn("backfill emitted no report (exit %d)%s", proc.exitValue(), detail)
				Outcome.Failed("back-fill did not complete (exit ${proc.exitValue()})$detail")
			}
		} catch (e: Exception) {
			log.warn("backfill run failed: %s", e.message)
			Outcome.Failed(e.message ?: "unknown error")
		}
	}

	/** Runs [args], captures full stdout, and maps a zero-exit result through [parse]. */
	private fun <T> capture(
		args: List<String>,
		projectDir: String,
		timeoutSeconds: Long,
		parse: (String) -> T,
	): Outcome<T> {
		return try {
			val proc = ProcessBuilder(args)
				.directory(File(projectDir))
				.redirectErrorStream(false)
				.start()
			val out = proc.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
			if (!proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
				proc.destroyForcibly()
				return Outcome.Failed("command timed out")
			}
			if (proc.exitValue() != 0) {
				val stderr = proc.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
				log.warn("backfill exit=%d: %s", proc.exitValue(), stderr.take(200))
				return Outcome.Failed(if (stderr.isNotBlank()) stderr.take(200) else "exit ${proc.exitValue()}")
			}
			Outcome.Ok(parse(out))
		} catch (e: Exception) {
			log.warn("backfill command failed: %s", e.message)
			Outcome.Failed(e.message ?: "unknown error")
		}
	}

	private fun parseCandidate(o: JsonObject): Candidate =
		Candidate(commitHash = o.str("commitHash"), subject = o.str("subject"), ts = o.long("ts"))

	private fun parseProgress(o: JsonObject): Progress {
		val outcome = o.getAsJsonObject("outcome") ?: JsonObject()
		val hash = outcome.str("commitHash")
		val subject = outcome.strOrNull("commitSubject")?.takeIf { it.isNotBlank() } ?: hash.take(8)
		return Progress(
			done = o.int("done"),
			total = o.int("total"),
			commitHash = hash,
			subject = subject,
			status = outcome.str("status"),
			sessions = outcome.int("sessions"),
			topics = outcome.int("topics"),
		)
	}

	private fun parseReport(o: JsonObject, rows: List<Progress>): Report =
		Report(
			total = o.int("total"),
			generated = o.int("generated"),
			skipped = o.int("skipped"),
			errors = o.int("errors"),
			rows = rows,
		)

	// --- Gson null-safe accessors (the engine omits absent optional fields) ---
	private fun JsonObject.str(key: String): String = strOrNull(key) ?: ""
	private fun JsonObject.strOrNull(key: String): String? =
		get(key)?.takeIf { !it.isJsonNull }?.asString
	private fun JsonObject.int(key: String): Int =
		get(key)?.takeIf { !it.isJsonNull }?.asInt ?: 0
	private fun JsonObject.long(key: String): Long =
		get(key)?.takeIf { !it.isJsonNull }?.asLong ?: 0L
	private fun JsonObject.bool(key: String): Boolean =
		get(key)?.takeIf { !it.isJsonNull }?.asBoolean ?: false
}
