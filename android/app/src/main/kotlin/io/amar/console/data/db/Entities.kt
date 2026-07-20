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
    @androidx.room.ColumnInfo(defaultValue = "0")
    val isPinned: Boolean = false,  // m.favourite tag — always-visible section
    /** Timestamp of the latest message when the room was last marked read —
     *  drives the "— New —" unread divider (SPA: DbChatRoom.lastReadTs). */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val lastReadTs: Long? = null,
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
    /** Matrix org.matrix.custom.html formatted_body (sanitized at render). */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val formattedBody: String? = null,
    val msgtype: String,            // m.text | m.image | m.file | ...
    val mediaMxc: String?,
    val mediaMime: String?,
    /** Audio/video duration from content.info (ms) — audio bubble label. */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val mediaDurationMs: Long? = null,
    val encryptedFileJson: String?, // EncryptedFile info for E2EE media download
    val replyToJson: String?,
    val isEdited: Boolean = false,
    val isDeleted: Boolean = false,
    val reactionsJson: String? = null,
    val localEcho: Boolean = false,
    val sendFailed: Boolean = false,
    val txnId: String? = null,      // outbox dedupe token that produced this echo
    /** Spooled outgoing media (echo renders this before upload completes). */
    val localMediaPath: String? = null,
    /** Redactor MXID when this row is a soft-delete (SPA: DbChatMessage.deletedBy). */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val deletedBy: String? = null,
    /** First-edit original body — preserved for the inline word-diff view. */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val originalBody: String? = null,
    /** Bridge/send failure text (com.beeper.message_send_status) — bubble title. */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val sendFailedReason: String? = null,
    /** MSC1767 waveform amplitudes JSON array (voice-note bar rendering). */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val waveformJson: String? = null,
    /** MSC3245 voice-message flag (distinguishes voice notes from audio files). */
    @androidx.room.ColumnInfo(defaultValue = "0")
    val isVoiceNote: Boolean = false,
    /** One-shot guard: rotate-key-and-resend already attempted for this echo. */
    @androidx.room.ColumnInfo(defaultValue = "0")
    val autoRotateRetried: Boolean = false,
    /** content.info image/video dimensions (aspect-ratio-preserving thumbnails). */
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val mediaWidth: Int? = null,
    @androidx.room.ColumnInfo(defaultValue = "NULL")
    val mediaHeight: Int? = null,
)
