package io.amar.console.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * The offline-first local database. Schema versions are additive; milestone
 * M2+ adds mail/cal/notes/feeds/agents tables with migrations.
 */
@Database(
    entities = [
        OutboxRow::class,
        MetaRow::class,
        ChatRoomRow::class,
        ChatMessageRow::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class ConsoleDb : RoomDatabase() {
    abstract fun outbox(): OutboxDao
    abstract fun meta(): MetaDao
    abstract fun chatRooms(): ChatRoomDao
    abstract fun chatMessages(): ChatMessageDao

    companion object {
        fun build(context: Context): ConsoleDb =
            Room.databaseBuilder(context.applicationContext, ConsoleDb::class.java, "console.db")
                .fallbackToDestructiveMigrationOnDowngrade()
                .build()
    }
}
