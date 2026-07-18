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
// Bookmarks — cached listing for offline browse (bodies stay hub-side).

@Entity(tableName = "bookmarks")
data class BookmarkRow(
    @PrimaryKey val file: String,       // <name>.md in the vault bookmarks dir
    val title: String,
    val url: String?,
    val tagsJson: String?,              // ["tag", ...]
    val addedAt: Long,
)

@Dao
interface BookmarksDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<BookmarkRow>)

    @Query("SELECT * FROM bookmarks ORDER BY addedAt DESC")
    fun observeAll(): Flow<List<BookmarkRow>>

    @Query("DELETE FROM bookmarks WHERE file NOT IN (:files)")
    suspend fun deleteAbsent(files: List<String>)
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
