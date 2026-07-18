package io.amar.console.data.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Reproduces the EXACT v55 startup crash and proves the self-heal:
 * a phone that installed v44–v50 has the ORIGINAL version-5 schema on disk
 * (checked into this test's resources from the v44 commit); schema version 5
 * was later accidentally REDEFINED, so the shipped auto-migration chain
 * doesn't match that database. Opening it must not crash the app —
 * ConsoleDb.build() probes at startup and resets the cache DB on mismatch.
 */
@RunWith(RobolectricTestRunner::class)
class SelfHealTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `stranded v44-era v5 database self-heals instead of crashing`() {
        // Recreate the phone's on-disk DB from the TRUE v44-era schema JSON.
        val dbFile = context.getDatabasePath("console.db")
        dbFile.parentFile?.mkdirs()
        dbFile.delete()
        val schema = JSONObject(
            javaClass.classLoader!!.getResource("schema-v5-as-shipped-in-v44.json")!!.readText()
        )
        val raw = SQLiteDatabase.openOrCreateDatabase(dbFile, null)
        val database = schema.getJSONObject("database")
        val entities = database.getJSONArray("entities")
        for (i in 0 until entities.length()) {
            val entity = entities.getJSONObject(i)
            val tableName = entity.getString("tableName")
            raw.execSQL(entity.getString("createSql").replace("\${TABLE_NAME}", tableName))
            entity.optJSONArray("indices")?.let { indices ->
                for (j in 0 until indices.length()) {
                    raw.execSQL(indices.getJSONObject(j).getString("createSql").replace("\${TABLE_NAME}", tableName))
                }
            }
        }
        raw.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
        raw.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '${database.getString("identityHash")}')")
        raw.version = 5
        raw.close()

        // v55 crashed HERE. The fix must return a usable database.
        val db = ConsoleDb.build(context)
        try {
            runBlocking {
                assertEquals(0, db.outbox().pending().size)
                db.chatMessages().recent("!r", 5) // exercises the worst table
            }
        } finally {
            db.close()
            dbFile.delete()
        }
    }
}
