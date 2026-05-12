package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.sqlite.SQLiteErrorCode
import org.sqlite.SQLiteException
import java.nio.file.AccessDeniedException

class SqliteHelpersTest {

    @Nested
    inner class ClassifyScanError {

        @Test
        fun `SQLITE_CORRUPT maps to corrupt`() {
            val e = SQLiteException("database disk image is malformed", SQLiteErrorCode.SQLITE_CORRUPT)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.corrupt
        }

        @Test
        fun `SQLITE_NOTADB maps to corrupt`() {
            val e = SQLiteException("file is not a database", SQLiteErrorCode.SQLITE_NOTADB)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.corrupt
        }

        @Test
        fun `SQLITE_BUSY maps to locked`() {
            val e = SQLiteException("database is locked", SQLiteErrorCode.SQLITE_BUSY)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.locked
        }

        @Test
        fun `SQLITE_LOCKED maps to locked`() {
            val e = SQLiteException("database table is locked", SQLiteErrorCode.SQLITE_LOCKED)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.locked
        }

        @Test
        fun `SQLITE_PERM maps to permission`() {
            val e = SQLiteException("access permission denied", SQLiteErrorCode.SQLITE_PERM)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.permission
        }

        @Test
        fun `SQLITE_CANTOPEN maps to permission`() {
            val e = SQLiteException("unable to open database file", SQLiteErrorCode.SQLITE_CANTOPEN)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.permission
        }

        @Test
        fun `SQLITE_ERROR with 'no such table' maps to schema`() {
            val e = SQLiteException("no such table: cursorDiskKV", SQLiteErrorCode.SQLITE_ERROR)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.schema
        }

        @Test
        fun `SQLITE_ERROR with 'no such column' maps to schema`() {
            val e = SQLiteException("no such column: lastUpdatedAt", SQLiteErrorCode.SQLITE_ERROR)
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.schema
        }

        @Test
        fun `AccessDeniedException maps to permission`() {
            val e = AccessDeniedException("/some/locked/path")
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.permission
        }

        @Test
        fun `non-SQLite exception with corrupt message falls back to corrupt via message regex`() {
            val e = RuntimeException("wrapped: SQLITE_CORRUPT: bad file")
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.corrupt
        }

        @Test
        fun `non-SQLite exception with locked message falls back to locked via message regex`() {
            val e = RuntimeException("wrapped: database is locked elsewhere")
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.locked
        }

        @Test
        fun `non-SQLite exception with schema message falls back to schema via message regex`() {
            val e = RuntimeException("upstream: no such table foo")
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.schema
        }

        @Test
        fun `unrecognized error maps to unknown`() {
            val e = RuntimeException("totally unrelated boom")
            classifyScanError(e).kind shouldBe SqliteScanErrorKind.unknown
        }

        @Test
        fun `message is preserved in returned error`() {
            val e = RuntimeException("specific failure detail")
            classifyScanError(e).message shouldBe "specific failure detail"
        }
    }

    @Nested
    inner class ParseSyntheticPath {

        @Test
        fun `splits valid path on last hash`() {
            val (db, id) = parseSyntheticPath("/path/to/state.vscdb#composer-abc")
            db shouldBe "/path/to/state.vscdb"
            id shouldBe "composer-abc"
        }

        @Test
        fun `lastIndexOf preserves hash in db path`() {
            val (db, id) = parseSyntheticPath("/path/with #symbol/state.vscdb#composer-xyz")
            db shouldBe "/path/with #symbol/state.vscdb"
            id shouldBe "composer-xyz"
        }

        @Test
        fun `missing hash throws`() {
            try {
                parseSyntheticPath("/no/hash/here")
                throw AssertionError("expected IllegalArgumentException")
            } catch (_: IllegalArgumentException) {
                // ok
            }
        }

        @Test
        fun `leading hash throws`() {
            try {
                parseSyntheticPath("#only-id")
                throw AssertionError("expected IllegalArgumentException")
            } catch (_: IllegalArgumentException) {
                // ok
            }
        }

        @Test
        fun `trailing hash throws`() {
            try {
                parseSyntheticPath("/path/db#")
                throw AssertionError("expected IllegalArgumentException")
            } catch (_: IllegalArgumentException) {
                // ok
            }
        }
    }
}
