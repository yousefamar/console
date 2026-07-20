package io.amar.console.data.db

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * The offline-first local database. Schema versions are additive (new tables
 * per milestone → Room AutoMigration); milestones: v1 chat, v2 mail.
 */
@Database(
    entities = [
        OutboxRow::class,
        MetaRow::class,
        ChatRoomRow::class,
        ChatMessageRow::class,
        MailThreadRow::class,
        MailMessageRow::class,
        CalendarRow::class,
        CalEventRow::class,
        NoteFileRow::class,
        FeedRow::class,
        FeedItemRow::class,
        FeedReadRow::class,
        AgentSessionRow::class,
        AgentMessageRow::class,
        BookmarkRow::class,
        GeocacheRow::class,
        MeetupEventRow::class,
    ],
    version = 10,
    exportSchema = true,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3),
        AutoMigration(from = 3, to = 4),
        AutoMigration(from = 4, to = 5),
        AutoMigration(from = 5, to = 6),
        AutoMigration(from = 6, to = 7),
        AutoMigration(from = 7, to = 8),
        AutoMigration(from = 8, to = 9),
        AutoMigration(from = 9, to = 10),
    ],
)
abstract class ConsoleDb : RoomDatabase() {
    abstract fun outbox(): OutboxDao
    abstract fun meta(): MetaDao
    abstract fun chatRooms(): ChatRoomDao
    abstract fun chatMessages(): ChatMessageDao
    abstract fun mailThreads(): MailThreadDao
    abstract fun mailMessages(): MailMessageDao
    abstract fun calendar(): CalendarDao
    abstract fun notes(): NotesDao
    abstract fun feeds(): FeedsDao
    abstract fun agents(): AgentsDao
    abstract fun bookmarks(): BookmarksDao
    abstract fun map(): MapDao

    companion object {
        /**
         * Build + PROBE the database synchronously, self-healing on failure.
         *
         * Room validates the schema lazily at first open; a migration that
         * produced a mismatched table throws IllegalStateException from
         * whatever DAO call happens to run first — in v55 that was a
         * background coroutine, which crash-looped the app at startup.
         *
         * The local DB is strictly a CACHE of hub state (chat/mail/cal all
         * re-sync via cursors; the outbox is the only loss, and a corrupted
         * DB can't flush anyway) — so on ANY open failure we delete the file
         * and start fresh rather than ever refusing to launch.
         */
        fun build(context: Context): ConsoleDb {
            val appCtx = context.applicationContext
            var db = builder(appCtx).build()
            try {
                // Force open + migration + validation NOW, on this thread.
                db.openHelper.writableDatabase
            } catch (e: Exception) {
                android.util.Log.e("ConsoleDb", "schema open failed — resetting cache DB", e)
                runCatching { io.amar.console.core.DebugAgent.log("error", message = "DB self-heal: ${e.message?.take(200)}") }
                runCatching { db.close() }
                appCtx.deleteDatabase("console.db")
                db = builder(appCtx).build()
                db.openHelper.writableDatabase // fresh create — must succeed
            }
            return db
        }

        private fun builder(appCtx: Context) =
            Room.databaseBuilder(appCtx, ConsoleDb::class.java, "console.db")
                .fallbackToDestructiveMigrationOnDowngrade()
    }
}
