package io.amar.console.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Mail — inbox threads (Gmail thread stubs + our derived flags). */
@Entity(
    tableName = "mail_threads",
    indices = [Index("date")],
)
data class MailThreadRow(
    @PrimaryKey val id: String,
    val subject: String,
    val fromName: String,
    val fromEmail: String,
    val snippet: String,
    val date: Long,
    val isUnread: Boolean,
    val isInbox: Boolean,
    val hasAttachments: Boolean,
    val messageCount: Int,
    val snoozedUntil: Long?,
    val account: String,
)

/** Mail — message bodies. bodyHtml nullable: only the newest N keep bodies. */
@Entity(
    tableName = "mail_messages",
    indices = [Index("threadId"), Index("date")],
)
data class MailMessageRow(
    @PrimaryKey val id: String,
    val threadId: String,
    val date: Long,
    val fromHeader: String,
    val toHeader: String,
    val ccHeader: String?,
    val subject: String,
    val bodyHtml: String?,
    val bodyText: String?,
    val isUnread: Boolean,
    val attachmentsJson: String?, // [{messageId, attachmentId, filename, mimeType, size}]
)
