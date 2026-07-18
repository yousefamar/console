package io.amar.console.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// ---------------------------------------------------------------------- //
// Calendar

@Entity(tableName = "cal_list")
data class CalendarRow(
    @PrimaryKey val id: String,          // accountEmail:calendarId
    val accountEmail: String,
    val calendarId: String,
    val name: String,
    val color: String?,
    val accessRole: String,
    val visible: Boolean,
)

@Entity(
    tableName = "cal_events",
    indices = [Index("startTime"), Index("calendarId")],
)
data class CalEventRow(
    @PrimaryKey val compoundKey: String, // accountEmail:calendarId:eventId (~temp for queued creates)
    val accountEmail: String,
    val calendarId: String,
    val eventId: String,
    val summary: String,
    val location: String?,
    val startTime: Long,
    val endTime: Long,
    val isAllDay: Boolean,
    val status: String,                  // confirmed | tentative | cancelled
    val rawJson: String,                 // full Google event (attendees, reminders…)
)

@Dao
interface CalendarDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCalendars(rows: List<CalendarRow>)

    @Query("SELECT * FROM cal_list")
    fun observeCalendars(): Flow<List<CalendarRow>>

    @Query("SELECT * FROM cal_list")
    suspend fun calendars(): List<CalendarRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertEvents(rows: List<CalEventRow>)

    @Query("SELECT * FROM cal_events WHERE startTime < :endMs AND endTime > :startMs ORDER BY startTime ASC")
    fun observeEventsInRange(startMs: Long, endMs: Long): Flow<List<CalEventRow>>

    @Query("SELECT * FROM cal_events WHERE compoundKey = :key")
    suspend fun byKey(key: String): CalEventRow?

    @Query("DELETE FROM cal_events WHERE compoundKey = :key")
    suspend fun deleteByKey(key: String)

    @Query("SELECT compoundKey FROM cal_events WHERE startTime < :endMs AND endTime > :startMs")
    suspend fun keysInRange(startMs: Long, endMs: Long): List<String>

    @Query("DELETE FROM cal_events WHERE compoundKey IN (:keys)")
    suspend fun deleteByKeys(keys: List<String>)

    @Query("DELETE FROM cal_events WHERE endTime < :cutoffMs OR startTime > :horizonMs")
    suspend fun pruneOutsideWindow(cutoffMs: Long, horizonMs: Long)
}

// ---------------------------------------------------------------------- //
// Notes

@Entity(tableName = "notes_files")
data class NoteFileRow(
    @PrimaryKey val path: String,
    val name: String,
    val dir: String,
    val mtime: Long,
    val size: Long,
    /** Cached body + the server mtime it was read at (conditional-PUT base). */
    val cachedContent: String?,
    val contentMtime: Long?,
    /** True while a local edit is queued (renders a pending marker). */
    val dirty: Boolean = false,
)

@Dao
interface NotesDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<NoteFileRow>)

    @Query("SELECT * FROM notes_files ORDER BY path ASC")
    fun observeAll(): Flow<List<NoteFileRow>>

    @Query("SELECT * FROM notes_files WHERE path = :path")
    fun observeFile(path: String): Flow<NoteFileRow?>

    @Query("SELECT * FROM notes_files WHERE path = :path")
    suspend fun byPath(path: String): NoteFileRow?

    @Query("DELETE FROM notes_files WHERE path IN (:paths)")
    suspend fun deleteByPaths(paths: List<String>)

    @Query("SELECT path FROM notes_files")
    suspend fun allPaths(): List<String>

    @Query("UPDATE notes_files SET cachedContent = :content, contentMtime = :mtime, dirty = :dirty WHERE path = :path")
    suspend fun setContent(path: String, content: String?, mtime: Long?, dirty: Boolean)

    /** Listing metadata upsert that PRESERVES cached content columns. */
    @Query("UPDATE notes_files SET mtime = :mtime, size = :size WHERE path = :path")
    suspend fun updateMeta(path: String, mtime: Long, size: Long)
}
