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
// Feeds

@Entity(tableName = "feed_list")
data class FeedRow(
    @PrimaryKey val id: String,
    val title: String,
    val folder: String?,
)

@Entity(
    tableName = "feed_items",
    indices = [Index("feedId", "publishedAt"), Index("publishedAt")],
)
data class FeedItemRow(
    @PrimaryKey val id: String,
    val feedId: String,
    val title: String,
    val link: String?,
    val content: String?,       // full HTML when the hub extracted it
    val snippet: String?,
    val publishedAt: Long,
    val imageUrl: String?,
)

/** Read markers: additive set, pendingSync=true rows await the hub PUT. */
@Entity(tableName = "feed_read")
data class FeedReadRow(
    @PrimaryKey val itemId: String,
    val pendingSync: Boolean,
)

@Dao
interface FeedsDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertFeeds(rows: List<FeedRow>)

    @Query("SELECT * FROM feed_list")
    fun observeFeeds(): Flow<List<FeedRow>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertItems(rows: List<FeedItemRow>)

    @Query("SELECT * FROM feed_items ORDER BY publishedAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<FeedItemRow>>

    @Query("SELECT * FROM feed_items WHERE id = :id")
    suspend fun itemById(id: String): FeedItemRow?

    @Query("DELETE FROM feed_items WHERE id IN (:ids)")
    suspend fun deleteItems(ids: List<String>)

    @Query("SELECT id FROM feed_items")
    suspend fun allItemIds(): List<String>

    /** Per-feed cap: keep the newest [keep] items of a feed. */
    @Query(
        """DELETE FROM feed_items WHERE feedId = :feedId AND id NOT IN (
             SELECT id FROM feed_items WHERE feedId = :feedId ORDER BY publishedAt DESC LIMIT :keep
           )"""
    )
    suspend fun pruneFeed(feedId: String, keep: Int)

    @Query("SELECT DISTINCT feedId FROM feed_items")
    suspend fun feedsWithItems(): List<String>

    // Read markers
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertRead(rows: List<FeedReadRow>)

    @Query("SELECT itemId FROM feed_read")
    fun observeReadIds(): Flow<List<String>>

    @Query("SELECT itemId FROM feed_read WHERE pendingSync = 1")
    suspend fun pendingReadIds(): List<String>

    @Query("UPDATE feed_read SET pendingSync = 0 WHERE itemId IN (:ids)")
    suspend fun markSynced(ids: List<String>)

    @Query("DELETE FROM feed_read WHERE itemId = :id")
    suspend fun deleteRead(id: String)
}

// ---------------------------------------------------------------------- //
// Agents

@Entity(tableName = "agent_sessions")
data class AgentSessionRow(
    @PrimaryKey val id: String,
    val name: String,
    val status: String,          // running | idle | ended
    val hasUnread: Boolean,
    val needsAttention: Boolean,
    val attentionSnippet: String?,
    val agentKey: String?,
    val modelLabel: String?,
    val hibernated: Boolean,
    val cwd: String?,
    /** Absolute index high-water of locally-cached messages. */
    val lastCachedIndex: Long,
    val messageLogLength: Long,
)

@Entity(
    tableName = "agent_messages",
    indices = [Index("sessionId", "absIndex", unique = true)],
)
data class AgentMessageRow(
    @PrimaryKey(autoGenerate = true) val pk: Long = 0,
    val sessionId: String,
    val absIndex: Long,
    val kind: String,            // text | user_prompt | tool_use | tool_result | ...
    val payloadJson: String,
)

@Dao
interface AgentsDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSessions(rows: List<AgentSessionRow>)

    @Query("SELECT * FROM agent_sessions WHERE status != 'ended' ORDER BY name ASC")
    fun observeSessions(): Flow<List<AgentSessionRow>>

    @Query("SELECT * FROM agent_sessions WHERE id = :id")
    suspend fun byId(id: String): AgentSessionRow?

    @Query("DELETE FROM agent_sessions WHERE id NOT IN (:ids)")
    suspend fun deleteAbsent(ids: List<String>)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessages(rows: List<AgentMessageRow>)

    @Query("SELECT * FROM agent_messages WHERE sessionId = :sessionId ORDER BY absIndex DESC LIMIT :limit")
    fun observeRecent(sessionId: String, limit: Int): Flow<List<AgentMessageRow>>

    @Query("SELECT MAX(absIndex) FROM agent_messages WHERE sessionId = :sessionId")
    suspend fun maxIndex(sessionId: String): Long?

    @Query(
        """DELETE FROM agent_messages WHERE sessionId = :sessionId AND absIndex NOT IN (
             SELECT absIndex FROM agent_messages WHERE sessionId = :sessionId ORDER BY absIndex DESC LIMIT :keep
           )"""
    )
    suspend fun pruneSession(sessionId: String, keep: Int)

    @Query("SELECT DISTINCT sessionId FROM agent_messages")
    suspend fun sessionsWithMessages(): List<String>
}
