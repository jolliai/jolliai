package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

class JmLoggerTest {

    @Test
    fun `create returns a ModuleLogger`() {
        val logger = JmLogger.create("TestModule")
        // Should not throw — just verify it can be created
        logger::class.simpleName shouldBe "ModuleLogger"
    }

    @Test
    fun `getJolliMemoryDir constructs correct path`() {
        val dir = JmLogger.getJolliMemoryDir("/fake/project")
        dir shouldBe "/fake/project/.jolli/jollimemory"
    }

    @Test
    fun `getJolliMemoryDir uses logDirCwd when set`() {
        JmLogger.setLogDir("/custom/dir")
        val dir = JmLogger.getJolliMemoryDir()
        dir shouldContain "/custom/dir/.jolli/jollimemory"
        // Reset
        JmLogger.setLogDir(System.getProperty("user.dir"))
    }

    @Test
    fun `setLogLevel does not throw`() {
        JmLogger.setLogLevel(LogLevel.debug)
        JmLogger.setLogLevel(LogLevel.info, mapOf("TestModule" to LogLevel.debug))
        // Reset to default
        JmLogger.setLogLevel(LogLevel.info)
    }

    @Test
    fun `ORPHAN_BRANCH constant is correct`() {
        JmLogger.ORPHAN_BRANCH shouldBe "jollimemory/summaries/v3"
    }

    @Test
    fun `LogLevel enum has correct priorities`() {
        LogLevel.debug.priority shouldBe 0
        LogLevel.info.priority shouldBe 1
        LogLevel.warn.priority shouldBe 2
        LogLevel.error.priority shouldBe 3
    }
}
