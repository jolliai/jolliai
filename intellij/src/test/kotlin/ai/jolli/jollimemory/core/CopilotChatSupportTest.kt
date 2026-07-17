package ai.jolli.jollimemory.core

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class CopilotChatSupportTest {

	/**
	 * Env pinned to macOS so the fixture layout below is deterministic on any
	 * host. Scan A reads `<home>/.copilot/session-state`; Scan B reads the
	 * macOS user-data dir created by [codeUserDataDir].
	 */
	private fun macEnv(home: File): HookEnv = fakeHookEnv(userHome = home, osName = "Mac OS X")

	/**
	 * Builds a `file:///...` URI matching what VS Code actually writes in workspace.json.
	 * [File.toURI] returns `file:/path` (no authority) which fails the `file://` prefix check.
	 */
	private fun fileUri(f: File): String {
		val abs = f.absolutePath.replace('\\', '/')
		return if (abs.startsWith("/")) "file://$abs" else "file:///$abs"
	}

	/** Returns the macOS VS Code user-data dir under the given home (matches [macEnv]). */
	private fun codeUserDataDir(home: File): File = File(home, "Library/Application Support/Code")

	/** Creates ~/.copilot/session-state/<sid>/ with vscode.metadata.json and events.jsonl. */
	private fun setupSessionState(
		home: File,
		sid: String,
		folderPath: String,
		events: List<String>,
	): File {
		val sessionDir = File(home, ".copilot/session-state/$sid").also { it.mkdirs() }
		File(sessionDir, "vscode.metadata.json").writeText(
			"""{"workspaceFolder": {"folderPath": "${folderPath.replace("\\", "\\\\")}"}}"""
		)
		val eventsFile = File(sessionDir, "events.jsonl")
		eventsFile.writeText(events.joinToString("\n"))
		return eventsFile
	}

	/** Creates VS Code's workspaceStorage/<hash>/chatSessions/<sid>.jsonl with patch-log content. */
	private fun setupChatSessions(
		home: File,
		projectDir: File,
		hash: String,
		sid: String,
		patchLines: List<String>,
	): File {
		val ws = File(codeUserDataDir(home), "User/workspaceStorage/$hash").also { it.mkdirs() }
		File(ws, "workspace.json").writeText("""{"folder": "${fileUri(projectDir)}"}""")
		val chatDir = File(ws, "chatSessions").also { it.mkdirs() }
		val file = File(chatDir, "$sid.jsonl")
		file.writeText(patchLines.joinToString("\n"))
		return file
	}

	@Nested
	inner class Detection {

		@Test
		fun `false when neither root exists`(@TempDir home: File) {
			CopilotChatSupport.isCopilotChatInstalled(macEnv(home)) shouldBe false
		}

		@Test
		fun `true when session-state dir exists`(@TempDir home: File) {
			File(home, ".copilot/session-state").mkdirs()
			CopilotChatSupport.isCopilotChatInstalled(macEnv(home)) shouldBe true
		}

		@Test
		fun `true when github_copilot-chat globalStorage exists`(@TempDir home: File) {
			File(codeUserDataDir(home), "User/globalStorage/github.copilot-chat").mkdirs()
			CopilotChatSupport.isCopilotChatInstalled(macEnv(home)) shouldBe true
		}
	}

	@Nested
	inner class ScanSessionState {

		@Test
		fun `picks events_jsonl whose metadata folderPath matches`(@TempDir home: File, @TempDir projectDir: File) {
			val events = listOf(
				"""{"type":"user.message","timestamp":"2026-05-01T00:00:00Z","data":{"content":"hi"}}""",
			)
			setupSessionState(home, "sid-1", projectDir.absolutePath, events)
			val sessions = CopilotChatSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions
			sessions.shouldHaveSize(1)
			sessions[0].sessionId shouldBe "sid-1"
			sessions[0].source shouldBe TranscriptSource.`copilot-chat`
		}

		@Test
		fun `skips events_jsonl whose folderPath does not match`(@TempDir home: File, @TempDir projectDir: File, @TempDir otherDir: File) {
			setupSessionState(home, "wrong", otherDir.absolutePath, listOf("""{"type":"x"}"""))
			CopilotChatSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions.shouldBeEmpty()
		}

		@Test
		fun `skips sessions with malformed metadata`(@TempDir home: File, @TempDir projectDir: File) {
			val sessionDir = File(home, ".copilot/session-state/bad").also { it.mkdirs() }
			File(sessionDir, "vscode.metadata.json").writeText("not json")
			File(sessionDir, "events.jsonl").writeText("")
			CopilotChatSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions.shouldBeEmpty()
		}
	}

	@Nested
	inner class ScanChatSessions {

		@Test
		fun `picks chatSessions_jsonl under matched workspace hash`(@TempDir home: File, @TempDir projectDir: File) {
			setupChatSessions(home, projectDir, "hash-A", "sid-2", listOf("""{"kind":0,"v":{}}"""))
			val sessions = CopilotChatSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions
			sessions.shouldHaveSize(1)
			sessions[0].sessionId shouldBe "sid-2"
		}

		@Test
		fun `skips _json snapshot files`(@TempDir home: File, @TempDir projectDir: File) {
			val ws = File(codeUserDataDir(home), "User/workspaceStorage/h").also { it.mkdirs() }
			File(ws, "workspace.json").writeText("""{"folder": "${fileUri(projectDir)}"}""")
			val chatDir = File(ws, "chatSessions").also { it.mkdirs() }
			File(chatDir, "snap.json").writeText("{}") // deprecated snapshot — must be ignored
			CopilotChatSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions.shouldBeEmpty()
		}
	}

	// readTranscript takes an absolute file path and never consults the env,
	// so the reader suites below need no HookEnv at all.
	@Nested
	inner class ReadEventsJsonl {

		@Test
		fun `picks user_message and assistant_message, skips other types`(@TempDir home: File, @TempDir projectDir: File) {
			val events = listOf(
				"""{"type":"user.message","timestamp":"2026-05-01T00:00:00Z","data":{"content":"q"}}""",
				"""{"type":"tool.call","timestamp":"2026-05-01T00:00:01Z","data":{"content":"ignored"}}""",
				"""{"type":"assistant.message","timestamp":"2026-05-01T00:00:02Z","data":{"content":"a"}}""",
			)
			val eventsFile = setupSessionState(home, "sid", projectDir.absolutePath, events)
			val result = CopilotChatSupport.readTranscript(eventsFile.absolutePath, null)
			result.entries.shouldHaveSize(2)
			result.entries[0].role shouldBe "human"
			result.entries[0].content shouldBe "q"
			result.entries[1].role shouldBe "assistant"
			result.entries[1].content shouldBe "a"
		}

		@Test
		fun `malformed line skipped but cursor advances`(@TempDir home: File, @TempDir projectDir: File) {
			val events = listOf(
				"not json",
				"""{"type":"user.message","timestamp":"2026-05-01T00:00:00Z","data":{"content":"q"}}""",
			)
			val eventsFile = setupSessionState(home, "sid", projectDir.absolutePath, events)
			val result = CopilotChatSupport.readTranscript(eventsFile.absolutePath, null)
			result.entries.shouldHaveSize(1)
			result.newCursor.lineNumber shouldBe 2
		}

		@Test
		fun `beforeTimestamp gate defers events past cutoff`(@TempDir home: File, @TempDir projectDir: File) {
			val events = listOf(
				"""{"type":"user.message","timestamp":"2026-05-01T00:00:00Z","data":{"content":"before"}}""",
				"""{"type":"assistant.message","timestamp":"2026-05-01T01:00:00Z","data":{"content":"after"}}""",
			)
			val eventsFile = setupSessionState(home, "sid", projectDir.absolutePath, events)
			val result = CopilotChatSupport.readTranscript(
				eventsFile.absolutePath,
				null,
				beforeTimestamp = "2026-05-01T00:30:00Z",
			)
			result.entries.shouldHaveSize(1)
			result.entries[0].content shouldBe "before"
			result.newCursor.lineNumber shouldBe 1
		}
	}

	@Nested
	inner class ReadPatchLog {

		@Test
		fun `replays requests array into entries`(@TempDir home: File, @TempDir projectDir: File) {
			val patch = listOf(
				"""{"kind":0,"v":{"requests":[{"message":{"text":"q1"},"response":[{"value":"a1"}],"timestamp":1700000000000}]}}""",
				"""{"kind":1,"k":["requests",1],"v":{"message":{"text":"q2"},"response":[{"value":"a2"}],"timestamp":1700000060000}}""",
			)
			val file = setupChatSessions(home, projectDir, "h", "sid", patch)
			val result = CopilotChatSupport.readTranscript(file.absolutePath, null)
			result.entries.shouldHaveSize(4)
			result.entries[0].content shouldBe "q1"
			result.entries[1].content shouldBe "a1"
			result.entries[2].content shouldBe "q2"
			result.entries[3].content shouldBe "a2"
		}

		@Test
		fun `cursor resumption skips already-consumed requests`(@TempDir home: File, @TempDir projectDir: File) {
			val patch = listOf(
				"""{"kind":0,"v":{"requests":[{"message":{"text":"q1"},"response":[{"value":"a1"}]},{"message":{"text":"q2"},"response":[{"value":"a2"}]}]}}""",
			)
			val file = setupChatSessions(home, projectDir, "h", "sid", patch)
			val cursor = TranscriptCursor(file.absolutePath, 1, "")
			val result = CopilotChatSupport.readTranscript(file.absolutePath, cursor)
			result.entries.shouldHaveSize(2)
			result.entries[0].content shouldBe "q2"
		}
	}

	@Nested
	inner class PatchReplayPrimitives {

		private fun arr(vararg segs: Any): JsonArray = JsonArray().apply {
			for (s in segs) when (s) {
				is String -> add(s)
				is Int -> add(s)
				else -> error("bad segment type")
			}
		}

		@Test
		fun `kind 0 replaces root`() {
			val lines = listOf("""{"kind":0,"v":{"requests":[]}}""")
			val doc = CopilotChatSupport.replayPatches(lines) as JsonObject
			doc.getAsJsonArray("requests").size() shouldBe 0
		}

		@Test
		fun `kind 1 sets value at nested path, creating intermediates`() {
			val doc = JsonObject()
			val v = JsonParser.parseString(""""hello"""")
			CopilotChatSupport.setAtPath(doc, arr("a", "b", "c"), v)
			(doc.getAsJsonObject("a").getAsJsonObject("b").get("c").asString) shouldBe "hello"
		}

		@Test
		fun `kind 1 creates array when next segment is numeric`() {
			val doc = JsonObject()
			val v = JsonParser.parseString("""{"x":1}""")
			CopilotChatSupport.setAtPath(doc, arr("items", 0, "x"), JsonParser.parseString("42"))
			doc.getAsJsonArray("items")[0].asJsonObject.get("x").asInt shouldBe 42
		}

		@Test
		fun `kind 2 removes object key`() {
			val doc = JsonParser.parseString("""{"a":{"b":1,"c":2}}""").asJsonObject
			CopilotChatSupport.deleteAtPath(doc, arr("a", "b"))
			doc.getAsJsonObject("a").has("b") shouldBe false
			doc.getAsJsonObject("a").has("c") shouldBe true
		}

		@Test
		fun `kind 2 splices array elements`() {
			val doc = JsonParser.parseString("""{"items":["a","b","c"]}""").asJsonObject
			CopilotChatSupport.deleteAtPath(doc, arr("items", 1))
			val items = doc.getAsJsonArray("items")
			items.size() shouldBe 2
			items[0].asString shouldBe "a"
			items[1].asString shouldBe "c"
		}

		@Test
		fun `kind 2 is no-op for non-existent path`() {
			val doc = JsonParser.parseString("""{"a":1}""").asJsonObject
			CopilotChatSupport.deleteAtPath(doc, arr("missing", "nested"))
			doc.get("a").asInt shouldBe 1
		}
	}

	@Nested
	inner class Dispatch {

		@Test
		fun `unrecognized path throws`() {
			val ex = try {
				CopilotChatSupport.readTranscript("/random/path.txt", null)
				null
			} catch (e: Exception) {
				e
			}
			ex.shouldNotBeNull()
		}
	}
}
