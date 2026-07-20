package io.amar.console.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// ---------------------------------------------------------------------- //
// Bookmarks — cached listing for offline browse (bodies stay hub-side).

@Entity(tableName = "bookmarks")
data class BookmarkRow(
    @PrimaryKey val file: String,       // <name>.md in the vault bookmarks dir
    val title: String,
    val url: String?,
    val tagsJson: String?,              // ["tag", ...]
    val addedAt: Long,
    // v11: the /bookmarks list endpoint already carries these — cache them so
    // the detail sheet (archive link + Added date) and search work offline and
    // don't blank while the lazy body fetch is in flight.
    @ColumnInfo(defaultValue = "NULL") val description: String? = null,
    @ColumnInfo(defaultValue = "NULL") val archive: String? = null,
    /** Raw `added` string (ISO or date) for en-GB display; addedAt is the sort key. */
    @ColumnInfo(defaultValue = "NULL") val addedRaw: String? = null,
)

@Dao
interface BookmarksDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<BookmarkRow>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: BookmarkRow)

    @Query("SELECT * FROM bookmarks ORDER BY addedAt DESC")
    fun observeAll(): Flow<List<BookmarkRow>>

    @Query("SELECT * FROM bookmarks WHERE file = :file")
    suspend fun byFile(file: String): BookmarkRow?

    @Query("UPDATE bookmarks SET tagsJson = :tagsJson WHERE file = :file")
    suspend fun updateTags(file: String, tagsJson: String)

    @Query("DELETE FROM bookmarks WHERE file NOT IN (:files)")
    suspend fun deleteAbsent(files: List<String>)

    @Query("DELETE FROM bookmarks WHERE file = :file")
    suspend fun deleteByFile(file: String)
}

// ---------------------------------------------------------------------- //
// Map mirrors — geocache + meetup summaries (ports of Dexie v8/v11).

@Entity(tableName = "geocaches", indices = [Index("lat", "lon")])
data class GeocacheRow(
    @PrimaryKey val code: String,
    val name: String,
    val type: String,
    val lat: Double?,
    val lon: Double?,
    val difficulty: Double?,
    val terrain: Double?,
    val found: Boolean,
)

@Entity(tableName = "meetup_events", indices = [Index("lat", "lon"), Index("dateTime")])
data class MeetupEventRow(
    @PrimaryKey val id: String,
    val title: String,
    val groupName: String?,
    val lat: Double?,
    val lon: Double?,
    val dateTime: Long,
    val eventUrl: String?,
)

@Dao
interface MapDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertGeocaches(rows: List<GeocacheRow>)

    @Query("SELECT * FROM geocaches WHERE lat IS NOT NULL")
    suspend fun geocaches(): List<GeocacheRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMeetup(rows: List<MeetupEventRow>)

    @Query("SELECT * FROM meetup_events WHERE lat IS NOT NULL AND dateTime > :now")
    suspend fun upcomingMeetup(now: Long): List<MeetupEventRow>

    @Query("DELETE FROM meetup_events WHERE id NOT IN (:ids)")
    suspend fun deleteAbsentMeetup(ids: List<String>)
}
