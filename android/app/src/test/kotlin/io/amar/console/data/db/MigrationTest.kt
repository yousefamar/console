package io.amar.console.data.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * Replays the exact upgrade path a phone takes: create the database at an
 * OLD schema version straight from the exported schema JSON (createSql +
 * user_version), then open it with the CURRENT ConsoleDb. Room runs the
 * auto-migrations and validates the resulting schema at open — precisely
 * what happens at app boot. This is the guard that would have caught the
 * v55 startup crash (migration column mismatch on chat_messages).
 *
 * No MigrationTestHelper: its asset plumbing is unreliable under
 * Robolectric; the schema JSONs are read from the repo path directly.
 */
@RunWith(RobolectricTestRunner::class)
class MigrationTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val schemasDir = File(System.getProperty("user.dir"), "schemas/io.amar.console.data.db.ConsoleDb")

    private fun createAtVersion(version: Int, dbFile: File) {
        val schema = JSONObject(File(schemasDir, "$version.json").readText())
        val db = SQLiteDatabase.openOrCreateDatabase(dbFile, null)
        val database = schema.getJSONObject("database")
        val entities = database.getJSONArray("entities")
        for (i in 0 until entities.length()) {
            val entity = entities.getJSONObject(i)
            val tableName = entity.getString("tableName")
            db.execSQL(entity.getString("createSql").replace("\${TABLE_NAME}", tableName))
            val indices = entity.optJSONArray("indices")
            if (indices != null) {
                for (j in 0 until indices.length()) {
                    val idx = indices.getJSONObject(j)
                    db.execSQL(idx.getString("createSql").replace("\${TABLE_NAME}", tableName))
                }
            }
        }
        // Room's identity hash table + user_version — exactly what Room writes.
        db.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
        db.execSQL(
            "INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '${database.getString("identityHash")}')"
        )
        db.version = version
        db.close()
    }

    private fun openAndUse(dbFile: File) {
        val room = Room.databaseBuilder(context, ConsoleDb::class.java, dbFile.absolutePath).build()
        try {
            // A real query forces open + migration + schema validation.
            runBlocking { room.chatMessages().recent("!r", 5) }
            runBlocking { room.outbox().pending() }
        } finally {
            room.close()
        }
    }

    private fun migrateFrom(version: Int, seed: ((SQLiteDatabase) -> Unit)? = null) {
        val dbFile = File(context.cacheDir, "migration-$version.db")
        dbFile.delete()
        createAtVersion(version, dbFile)
        if (seed != null) {
            val db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            seed(db)
            db.close()
        }
        openAndUse(dbFile)
    }

    @Test
    fun `migrate 4 to latest with data`() = migrateFrom(4) { db ->
        db.execSQL(
            """INSERT INTO chat_messages
               (id, roomId, timestamp, senderId, senderName, body, msgtype,
                mediaMxc, mediaMime, encryptedFileJson, replyToJson,
                isEdited, isDeleted, reactionsJson, localEcho, sendFailed, txnId)
               VALUES ('e1', '!r', 1, '@a:x', 'A', 'hi', 'm.text',
                       NULL, NULL, NULL, NULL, 0, 0, NULL, 0, 0, NULL)"""
        )
    }

    @Test
    fun `migrate 5 to latest`() = migrateFrom(5)

    @Test
    fun `migrate 6 to latest`() = migrateFrom(6)

    @Test
    fun `migrate 1 to latest`() = migrateFrom(1)

    @Test
    fun `seeded row survives 4 to latest`() {
        val dbFile = File(context.cacheDir, "migration-keep.db")
        dbFile.delete()
        createAtVersion(4, dbFile)
        SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL(
                """INSERT INTO chat_messages
                   (id, roomId, timestamp, senderId, senderName, body, msgtype,
                    mediaMxc, mediaMime, encryptedFileJson, replyToJson,
                    isEdited, isDeleted, reactionsJson, localEcho, sendFailed, txnId)
                   VALUES ('keep', '!r', 9, '@a:x', 'A', 'survives', 'm.text',
                           NULL, NULL, NULL, NULL, 0, 0, NULL, 0, 0, NULL)"""
            )
        }
        val room = Room.databaseBuilder(context, ConsoleDb::class.java, dbFile.absolutePath).build()
        try {
            val row = runBlocking { room.chatMessages().byId("keep") }
            assertEquals("survives", row?.body)
        } finally {
            room.close()
        }
    }
}
