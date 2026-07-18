package io.amar.console.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface MailThreadDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<MailThreadRow>)

    @Query("SELECT * FROM mail_threads WHERE isInbox = 1 AND (snoozedUntil IS NULL OR snoozedUntil < :now) ORDER BY date DESC")
    fun observeInbox(now: Long): Flow<List<MailThreadRow>>

    @Query("SELECT * FROM mail_threads WHERE id = :id")
    fun observeThread(id: String): Flow<MailThreadRow?>

    @Query("SELECT * FROM mail_threads WHERE id = :id")
    suspend fun byId(id: String): MailThreadRow?

    @Query("SELECT id FROM mail_threads WHERE isInbox = 1")
    suspend fun inboxIds(): List<String>

    @Query("DELETE FROM mail_threads WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("UPDATE mail_threads SET isInbox = :inbox WHERE id = :id")
    suspend fun setInbox(id: String, inbox: Boolean)

    @Query("UPDATE mail_threads SET isUnread = :unread WHERE id = :id")
    suspend fun setUnread(id: String, unread: Boolean)

    @Query("UPDATE mail_threads SET snoozedUntil = :until WHERE id = :id")
    suspend fun setSnoozed(id: String, until: Long?)

    @Query("SELECT COUNT(*) FROM mail_threads WHERE isInbox = 1 AND isUnread = 1")
    fun observeUnreadCount(): Flow<Int>

    /** Snoozed threads whose timer expired (re-inbox check). */
    @Query("SELECT * FROM mail_threads WHERE snoozedUntil IS NOT NULL AND snoozedUntil < :now")
    suspend fun expiredSnoozes(now: Long): List<MailThreadRow>
}

@Dao
interface MailMessageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<MailMessageRow>)

    @Query("SELECT * FROM mail_messages WHERE threadId = :threadId ORDER BY date ASC")
    fun observeForThread(threadId: String): Flow<List<MailMessageRow>>

    @Query("SELECT * FROM mail_messages WHERE threadId = :threadId ORDER BY date ASC")
    suspend fun forThread(threadId: String): List<MailMessageRow>

    @Query("DELETE FROM mail_messages WHERE threadId IN (:threadIds)")
    suspend fun deleteForThreads(threadIds: List<String>)

    /** Body eviction: null-out bodies outside the newest [keep] threads. */
    @Query(
        """UPDATE mail_messages SET bodyHtml = NULL WHERE threadId NOT IN (
             SELECT id FROM mail_threads WHERE isInbox = 1 ORDER BY date DESC LIMIT :keep
           )"""
    )
    suspend fun evictBodiesOutsideNewest(keep: Int)
}
