package io.amar.console.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(row: OutboxRow): Long

    @Query("SELECT * FROM outbox WHERE status = 'pending' ORDER BY createdAt ASC")
    suspend fun pending(): List<OutboxRow>

    @Query("SELECT * FROM outbox WHERE status IN ('pending','processing','failed','conflict') ORDER BY createdAt ASC")
    fun observeAll(): Flow<List<OutboxRow>>

    @Query("SELECT COUNT(*) FROM outbox WHERE status IN ('pending','failed','conflict')")
    fun observeBacklogCount(): Flow<Int>

    @Query("UPDATE outbox SET status = :status, error = :error WHERE id = :id")
    suspend fun setStatus(id: Long, status: String, error: String? = null)

    @Query("UPDATE outbox SET status = 'pending', retryCount = retryCount + 1, error = :error WHERE id = :id")
    suspend fun markRetry(id: Long, error: String?)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: Long)

    /** Cancel queued actions for an entity (undo path — SPA removeByThread). */
    @Query("DELETE FROM outbox WHERE entityId = :entityId AND type = :type AND status = 'pending'")
    suspend fun removeByEntity(entityId: String, type: String)

    /** Crash recovery: un-wedge rows stuck in `processing` (SPA resetStuckProcessing). */
    @Query("UPDATE outbox SET status = 'pending' WHERE status = 'processing'")
    suspend fun resetStuckProcessing()

    @Query("SELECT * FROM outbox WHERE id = :id")
    suspend fun byId(id: Long): OutboxRow?

    /** Conflict banner: watch a path's parked noteSave row (etc.) live. */
    @Query("SELECT * FROM outbox WHERE type = :type AND entityId = :entityId AND status = :status")
    fun observeByEntityStatus(type: String, entityId: String, status: String): Flow<List<OutboxRow>>

    /** Conflict resolution: clear an entity's rows in ANY non-terminal state. */
    @Query("DELETE FROM outbox WHERE entityId = :entityId AND type = :type")
    suspend fun removeByEntityAllStatuses(entityId: String, type: String)
}

@Dao
interface MetaDao {
    @Query("SELECT value FROM meta WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: MetaRow)

    @Query("DELETE FROM meta WHERE `key` = :key")
    suspend fun delete(key: String)
}

@Dao
interface ChatRoomDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<ChatRoomRow>)

    @Query("DELETE FROM chat_rooms WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("SELECT * FROM chat_rooms ORDER BY lastMessageTime DESC")
    fun observeAll(): Flow<List<ChatRoomRow>>

    @Query("SELECT * FROM chat_rooms WHERE id = :id")
    fun observeRoom(id: String): Flow<ChatRoomRow?>

    @Query("SELECT * FROM chat_rooms WHERE id = :id")
    suspend fun byId(id: String): ChatRoomRow?

    @Query("SELECT id FROM chat_rooms")
    suspend fun allIds(): List<String>

    @Query("SELECT * FROM chat_rooms")
    suspend fun allRooms(): List<ChatRoomRow>

    @Query("SELECT COUNT(*) FROM chat_rooms WHERE isUnread = 1 AND isMuted = 0 AND (snoozedUntil IS NULL OR snoozedUntil < :now)")
    fun observeUnreadCount(now: Long): Flow<Int>
}

@Dao
interface ChatMessageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<ChatMessageRow>)

    @Query("SELECT * FROM chat_messages WHERE roomId = :roomId ORDER BY timestamp DESC LIMIT :limit")
    fun observeRecent(roomId: String, limit: Int): Flow<List<ChatMessageRow>>

    @Query("SELECT * FROM chat_messages WHERE roomId = :roomId ORDER BY timestamp DESC LIMIT :limit")
    suspend fun recent(roomId: String, limit: Int): List<ChatMessageRow>

    @Query("SELECT * FROM chat_messages WHERE id = :id")
    suspend fun byId(id: String): ChatMessageRow?

    @Query("DELETE FROM chat_messages WHERE id = :id")
    suspend fun delete(id: String)

    /** Swap a local echo for the real event row in one transaction. */
    @Transaction
    suspend fun replaceEcho(echoId: String, real: ChatMessageRow) {
        delete(echoId)
        upsertAll(listOf(real))
    }

    @Query("UPDATE chat_messages SET sendFailed = :failed WHERE id = :id")
    suspend fun setSendFailed(id: String, failed: Boolean)

    /** Bridge send-failure with the human-readable reason (bubble title). */
    @Query("UPDATE chat_messages SET sendFailed = :failed, sendFailedReason = :reason WHERE id = :id")
    suspend fun setSendFailedReason(id: String, failed: Boolean, reason: String?)

    /** One-shot guard for the rotate-key-and-resend auto-recovery. */
    @Query("UPDATE chat_messages SET autoRotateRetried = 1 WHERE id = :id")
    suspend fun markAutoRotateRetried(id: String)

    /** Soft-delete a row while preserving its body (diff/archive fallback). */
    @Query("UPDATE chat_messages SET isDeleted = 1, deletedBy = :by WHERE id = :id")
    suspend fun setDeleted(id: String, by: String?)

    @Query("SELECT COUNT(*) FROM chat_messages WHERE roomId = :roomId")
    suspend fun countForRoom(roomId: String): Int

    /** Prune a room's timeline to the newest [keep] rows (LRU bound). */
    @Query(
        """DELETE FROM chat_messages WHERE roomId = :roomId AND id NOT IN (
             SELECT id FROM chat_messages WHERE roomId = :roomId ORDER BY timestamp DESC LIMIT :keep
           )"""
    )
    suspend fun pruneRoom(roomId: String, keep: Int)

    @Query("SELECT DISTINCT roomId FROM chat_messages")
    suspend fun roomsWithMessages(): List<String>

    /** Reload-room wipe: drop cached messages EXCEPT deleted rows still
     *  carrying a body — re-pagination returns empty tombstones, which would
     *  lose the recovered text forever (SPA reloadRoom). */
    @Query(
        """DELETE FROM chat_messages WHERE roomId = :roomId AND NOT
             (isDeleted = 1 AND body IS NOT NULL AND body != '')"""
    )
    suspend fun deleteRoomExceptRecoverableDeleted(roomId: String)
}
