package io.amar.console.ui.mail

import io.amar.console.data.mail.GmailParse
import io.amar.console.data.mail.MailFormat

/** The message a reply/forward is based on (last message of the thread, or a
 *  specific one from the per-message ⋯ menu). */
data class ReplyContext(
    val messageId: String,
    val fromName: String,
    val fromEmail: String,
    val toHeader: String,
    val ccHeader: String?,
    val subject: String,
    val date: Long,
    val bodyHtml: String?,
    val bodyText: String?,
)

/** Prefilled compose fields. */
data class ComposePrefill(
    val from: String,
    val to: String,
    val cc: String,
    val subject: String,
    val quotedHtml: String?,
)

/**
 * Pure prefill logic ported from ComposeEditor.tsx: smart from-address pick,
 * reply / reply-all To+Cc, Re:/Fwd: subject, and the Gmail-style quoted
 * original block. Kept pure so it's unit-testable.
 */
fun prefill(
    mode: ComposeMode,
    ctx: ReplyContext?,
    aliases: List<MailFormat.Alias>,
    userEmail: String,
): ComposePrefill {
    if (ctx == null || mode == ComposeMode.COMPOSE) {
        val from = if (aliases.isEmpty()) userEmail else (aliases.firstOrNull { it.isDefault } ?: aliases.first()).email
        return ComposePrefill(from = from, to = "", cc = "", subject = "", quotedHtml = null)
    }

    val from = MailFormat.pickFromAddress(aliases, ctx.toHeader, ctx.ccHeader, userEmail)
    val aliasEmails = aliases.map { it.email.lowercase() }
    val originalHtml = ctx.bodyHtml ?: ctx.bodyText?.let { "<pre>${escape(it)}</pre>" } ?: ""

    return when (mode) {
        ComposeMode.REPLY -> {
            // To = original sender, unless I sent it (then original To).
            val to = if (ctx.fromEmail.equals(userEmail, true)) ctx.toHeader
            else "${ctx.fromName} <${ctx.fromEmail}>"
            ComposePrefill(
                from = from, to = to, cc = "",
                subject = MailFormat.rePrefix(ctx.subject),
                quotedHtml = MailFormat.replyQuote(ctx.fromName, ctx.fromEmail, ctx.date, originalHtml),
            )
        }
        ComposeMode.REPLY_ALL -> {
            val to = "${ctx.fromName} <${ctx.fromEmail}>"
            val cc = MailFormat.replyAllCc(ctx.toHeader, ctx.ccHeader, from, aliasEmails)
            ComposePrefill(
                from = from, to = to, cc = cc,
                subject = MailFormat.rePrefix(ctx.subject),
                quotedHtml = MailFormat.replyQuote(ctx.fromName, ctx.fromEmail, ctx.date, originalHtml),
            )
        }
        ComposeMode.FORWARD -> ComposePrefill(
            from = from, to = "", cc = "",
            subject = MailFormat.fwdPrefix(ctx.subject),
            quotedHtml = MailFormat.forwardQuote(ctx.fromName, ctx.fromEmail, ctx.date, ctx.subject, ctx.toHeader, originalHtml),
        )
        ComposeMode.COMPOSE -> ComposePrefill(from, "", "", "", null)
    }
}

/** Build a [ReplyContext] from a stored message row (from header parsed). */
fun replyContextFromMessage(
    messageId: String,
    fromHeader: String,
    toHeader: String,
    ccHeader: String?,
    subject: String,
    date: Long,
    bodyHtml: String?,
    bodyText: String?,
): ReplyContext {
    val (name, email) = GmailParse.parseAddress(fromHeader)
    return ReplyContext(messageId, name, email, toHeader, ccHeader, subject, date, bodyHtml, bodyText)
}

private fun escape(t: String): String = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
