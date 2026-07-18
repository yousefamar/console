package io.amar.console

import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Launch smoke tests — boot the REAL Application + MainActivity, the exact
 * path that crash-looped v55. Robolectric executes Application.onCreate
 * (AppGraph → ConsoleDb.build → sync engine) and the Activity through
 * onCreate/onStart/onResume including Compose setContent.
 *
 * Every release MUST keep these green: they are the "does it open" gate.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = ConsoleApp::class)
class AppLaunchTest {

    @Test
    fun `app launches to first screen on a clean install`() {
        val app = ApplicationProvider.getApplicationContext<ConsoleApp>()
        assertNotNull(app.graph) // Application.onCreate ran, graph built
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        controller.setup() // create → start → resume — crashes here fail the test
        controller.pause().stop().destroy()
    }

    @Test
    fun `app launches with a stranded v44-era database on disk`() {
        // Seed the same mismatched-schema DB that crashed v55 BEFORE the
        // Activity spins up (the Application graph already self-healed the
        // main handle in onCreate; this exercises a second open).
        val app = ApplicationProvider.getApplicationContext<ConsoleApp>()
        val dbFile = app.getDatabasePath("console.db")
        // Corrupt scenario: replace with a schema Room can't reconcile.
        app.graph.db.close()
        dbFile.delete()
        SQLiteDatabase.openOrCreateDatabase(dbFile, null).apply {
            execSQL("CREATE TABLE chat_messages (id TEXT NOT NULL PRIMARY KEY, wrong INTEGER)")
            execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
            execSQL("INSERT INTO room_master_table VALUES (42, 'bogus-hash')")
            version = 5
            close()
        }
        // Rebuilding must self-heal, not throw.
        val healed = io.amar.console.data.db.ConsoleDb.build(app)
        kotlinx.coroutines.runBlocking { healed.outbox().pending() }
        healed.close()
    }
}
