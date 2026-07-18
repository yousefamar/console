package io.amar.console.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Room schema v1 — the offline-first mirror. Direct adaptation of the SPA's
 * Dexie schema (src/db/index.ts); see the plan's B2 section for bounds.
 */

/** Shared offline mutation queue (SPA: src/db/sync-queue.ts). */
@Entity(
    tableName = "outbox",
    indices = [Index("status"), Index("type"), Index("createdAt")],
)
data class OutboxRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,               // chatSend | chatMarkRead | mailArchive | ...
    val payloadJson: String,        // per-type args
    val dedupeToken: String,        // idempotency key sent to the hub (txnId/clientToken)
    val entityId: String?,          // roomId / threadId / eventKey / path — for cancellation
    val createdAt: Long,
    val status: String,             // pending | processing | failed | conflict
    val retryCount: Int = 0,
    val error: String? = null,
)

/** KV store for cursors: matrix:lastBatch, mail:historyId:<acct>, chatRooms:seq, notes:lastSync. */
@Entity(tableName = "meta")
data class MetaRow(
    @PrimaryKey val key: String,
    val value: String,
)

/** Hub-authoritative room snapshot mirror (server RoomState rows, verbatim JSON). */
@Entity(
    tableName = "chat_rooms",
    indices = [Index("lastMessageTime")],
)
data class ChatRoomRow(
    @PrimaryKey val id: String,
    val name: String,
    val avatarMxc: String?,
    val isDirect: Boolean,
    val isUnread: Boolean,
    val unreadCount: Int,
    val manualUnread: Boolean,
    val lastMessageBody: String?,
    val lastMessageSender: String?,
    val lastMessageTime: Long,
    val lastReadEventId: String?,
    val isMuted: Boolean,
    val isLowPriority: Boolean,
    val isEncrypted: Boolean,
    val memberCount: Int,
    val networkIcon: String?,       // bridge glyph (whatsapp/linkedin/...)
    val snoozedUntil: Long?,
    val prevBatch: String?,         // pagination cursor for loadOlder
    val rawJson: String,            // full RoomState — fields we don't model survive round-trips
)

/** Chat message timeline (bounded window per room, pruned by SyncPruneWorker). */
@Entity(
    tableName = "chat_messages",
    indices = [Index("roomId", "timestamp")],
)
data class ChatMessageRow(
    @PrimaryKey val id: String,     // event_id, or ~ts.rand for local echo
    val roomId: String,
    val timestamp: Long,
    val senderId: String,
    val senderName: String?,
    val body: String?,
    val msgtype: String,            // m.text | m.image | m.file | ...
    val mediaMxc: String?,
    val mediaMime: String?,
    val encryptedFileJson: String?, // EncryptedFile info for E2EE media download
    val replyToJson: String?,
    val isEdited: Boolean = false,
    val isDeleted: Boolean = false,
    val reactionsJson: String? = null,
    val localEcho: Boolean = false,
    val sendFailed: Boolean = false,
    val txnId: String? = null,      // outbox dedupe token that produced this echo
)
