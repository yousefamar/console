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

    /** Search over cached items (title/snippet), newest first. */
    @Query(
        """SELECT * FROM feed_items WHERE title LIKE '%' || :q || '%'
             OR snippet LIKE '%' || :q || '%'
           ORDER BY publishedAt DESC LIMIT :limit"""
    )
    suspend fun searchItems(q: String, limit: Int = 100): List<FeedItemRow>

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
    // --- v9: full session metadata for the parity sweep ---
    @ColumnInfo(defaultValue = "0") val lastReadIndex: Long = 0,
    /** claudeSessionId of the parent, when this session is a fork (lineage nesting). */
    @ColumnInfo(defaultValue = "NULL") val parentClaudeSessionId: String? = null,
    /** The session's own claudeSessionId (needed for cron/resume keying). */
    @ColumnInfo(defaultValue = "NULL") val claudeSessionId: String? = null,
    /** Per-session model pin (null → follows the hub-wide model). */
    @ColumnInfo(defaultValue = "NULL") val modelOverride: String? = null,
    /** Current permission mode ('default' | 'plan' | 'acceptEdits' …). */
    @ColumnInfo(defaultValue = "NULL") val permissionMode: String? = null,
    @ColumnInfo(defaultValue = "NULL") val gitBranch: String? = null,
    @ColumnInfo(defaultValue = "0") val gitDirty: Boolean = false,
    @ColumnInfo(defaultValue = "-1") val gitAdded: Int = -1,
    @ColumnInfo(defaultValue = "-1") val gitDeleted: Int = -1,
    /** Live child-process count on the claude PID (background bashes). */
    @ColumnInfo(defaultValue = "0") val backgroundProcessCount: Int = 0,
    @ColumnInfo(defaultValue = "0") val createdAt: Long = 0,
    @ColumnInfo(defaultValue = "0") val isAl: Boolean = false,
    @ColumnInfo(defaultValue = "0") val totalCostMicros: Long = 0,
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

    /** Ended sessions stay visible while unread (a killed fork survives for audit
     *  until acknowledged) — mirrors AgentTab's `status!=='ended' || hasUnread`. */
    @Query("SELECT * FROM agent_sessions WHERE status != 'ended' OR hasUnread = 1 ORDER BY name ASC")
    fun observeSessions(): Flow<List<AgentSessionRow>>

    @Query("SELECT * FROM agent_sessions WHERE id = :id")
    suspend fun byId(id: String): AgentSessionRow?

    @Query("SELECT * FROM agent_sessions")
    suspend fun allSessions(): List<AgentSessionRow>

    @Query("DELETE FROM agent_sessions WHERE id NOT IN (:ids)")
    suspend fun deleteAbsent(ids: List<String>)

    @Query("DELETE FROM agent_sessions WHERE id = :id")
    suspend fun deleteSession(id: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessages(rows: List<AgentMessageRow>)

    /** REPLACE variant for the live-streaming rolling text row (updated in
     *  place at a fixed absIndex while deltas accumulate). */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun replaceMessage(row: AgentMessageRow)

    @Query("SELECT * FROM agent_messages WHERE sessionId = :sessionId ORDER BY absIndex DESC LIMIT :limit")
    fun observeRecent(sessionId: String, limit: Int): Flow<List<AgentMessageRow>>

    @Query("SELECT * FROM agent_messages WHERE sessionId = :sessionId ORDER BY absIndex DESC LIMIT :limit")
    suspend fun recent(sessionId: String, limit: Int): List<AgentMessageRow>

    @Query("SELECT MAX(absIndex) FROM agent_messages WHERE sessionId = :sessionId")
    suspend fun maxIndex(sessionId: String): Long?

    @Query("SELECT MIN(absIndex) FROM agent_messages WHERE sessionId = :sessionId")
    suspend fun minIndex(sessionId: String): Long?

    @Query("DELETE FROM agent_messages WHERE sessionId = :sessionId")
    suspend fun clearMessages(sessionId: String)

    /** Hub restart mints a new hub id for the same claudeSessionId — carry the
     *  cached transcript over so it doesn't look like a brand-new session. */
    @Query("UPDATE OR REPLACE agent_messages SET sessionId = :newId WHERE sessionId = :oldId")
    suspend fun remapMessages(oldId: String, newId: String)

    @Query(
        """DELETE FROM agent_messages WHERE sessionId = :sessionId AND absIndex NOT IN (
             SELECT absIndex FROM agent_messages WHERE sessionId = :sessionId ORDER BY absIndex DESC LIMIT :keep
           )"""
    )
    suspend fun pruneSession(sessionId: String, keep: Int)

    @Query("SELECT DISTINCT sessionId FROM agent_messages")
    suspend fun sessionsWithMessages(): List<String>

    /** Latest text / user_prompt payload per session — the sidebar subtitle
     *  snippet source. One row per session (the highest absIndex of a snippet
     *  kind). */
    @Query(
        """SELECT m.sessionId AS sessionId, m.payloadJson AS payloadJson FROM agent_messages m
           JOIN (SELECT sessionId, MAX(absIndex) AS mx FROM agent_messages
                 WHERE kind IN ('text','user_prompt') GROUP BY sessionId) t
           ON m.sessionId = t.sessionId AND m.absIndex = t.mx"""
    )
    fun observeLastSnippets(): Flow<List<SessionSnippet>>
}

/** Projection for observeLastSnippets. */
data class SessionSnippet(val sessionId: String, val payloadJson: String)
