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
    ],
    version = 3,
    exportSchema = true,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3),
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

    companion object {
        fun build(context: Context): ConsoleDb =
            Room.databaseBuilder(context.applicationContext, ConsoleDb::class.java, "console.db")
                .fallbackToDestructiveMigrationOnDowngrade()
                .build()
    }
}
