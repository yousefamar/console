package io.amar.console.data.mail

import java.util.Calendar
import java.util.Locale

/**
 * Pure mail helpers ported from the SPA (src/utils/date.ts, src/utils/email.ts,
 * src/components/ComposeEditor.tsx). Kept free of Android/Compose deps so the
 * whole file is unit-testable on the JVM.
 */
object MailFormat {

    // ------------------------------------------------------------------ //
    // Snooze times (src/utils/date.ts getSnoozeTime)

    /** Later today = 3h from now, or 18:00 today, whichever is later. */
    fun laterToday(now: Long = System.currentTimeMillis()): Long {
        val threeHours = now + 3 * 3600_000L
        val sixPm = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 18); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        return maxOf(threeHours, sixPm)
    }

    /** Tomorrow 08:00. */
    fun tomorrow(now: Long = System.currentTimeMillis()): Long =
        Calendar.getInstance().apply {
            timeInMillis = now
            add(Calendar.DAY_OF_YEAR, 1)
            set(Calendar.HOUR_OF_DAY, 8); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    /** Next Monday 08:00 (always ≥1 day ahead). Mirrors the SPA's `(8 - day) % 7 || 7`. */
    fun nextWeek(now: Long = System.currentTimeMillis()): Long =
        Calendar.getInstance().apply {
            timeInMillis = now
            // Java DAY_OF_WEEK is Sun=1..Sat=7; JS getDay() is Sun=0..Sat=6.
            val jsDow = get(Calendar.DAY_OF_WEEK) - 1
            val add = (8 - jsDow) % 7
            add(Calendar.DAY_OF_YEAR, if (add == 0) 7 else add)
            set(Calendar.HOUR_OF_DAY, 8); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    // ------------------------------------------------------------------ //
    // File size (src/utils/attachment-cache.ts formatFileSize)

    fun formatFileSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format(Locale.UK, "%.1f KB", bytes / 1024.0)
        else -> String.format(Locale.UK, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    // ------------------------------------------------------------------ //
    // Send-as alias smart pick (ComposeEditor.pickFromAddress)

    data class Alias(val email: String, val name: String = "", val isDefault: Boolean = false)

    /**
     * Best from-address for a reply context:
     * 1. exact alias present in original To/Cc, 2. same-domain alias,
     * 3. default alias, else first / userEmail.
     */
    fun pickFromAddress(aliases: List<Alias>, toHeader: String?, ccHeader: String?, userEmail: String): String {
        if (aliases.isEmpty()) return userEmail
        val recipients = parseAddressEmails(listOfNotNull(toHeader, ccHeader).joinToString(", "))
        val aliasEmails = aliases.map { it.email.lowercase() }

        aliasEmails.firstOrNull { it in recipients }?.let { return it }

        val recipientDomains = recipients.mapNotNull { it.substringAfter('@', "").ifEmpty { null } }
        aliases.firstOrNull { it.email.lowercase().substringAfter('@', "") in recipientDomains }
            ?.let { return it.email }

        return (aliases.firstOrNull { it.isDefault } ?: aliases.first()).email
    }

    /**
     * Reply-all Cc = original To+Cc minus the from-address and every alias email.
     * Mirrors the SPA's substring-contains filter so "Name <x@y>" tokens survive.
     */
    fun replyAllCc(toHeader: String?, ccHeader: String?, fromEmail: String, aliasEmails: List<String>): String {
        val all = listOfNotNull(toHeader, ccHeader).filter { it.isNotBlank() }.joinToString(", ")
        val fromLower = fromEmail.lowercase()
        val aliasLower = aliasEmails.map { it.lowercase() }
        return all.split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .filter { tok ->
                val lower = tok.lowercase()
                !lower.contains(fromLower) && aliasLower.none { lower.contains(it) }
            }
            .joinToString(", ")
    }

    /** Bare lowercase emails from a comma address list (respecting `Name <email>`). */
    fun parseAddressEmails(raw: String): List<String> =
        splitAddresses(raw).map { addr ->
            val m = Regex("<([^>]+)>").find(addr)
            (m?.groupValues?.get(1) ?: addr).trim().lowercase()
        }.filter { it.contains('@') }

    /** Split a comma list but keep quoted display names intact. */
    fun splitAddresses(raw: String): List<String> {
        val out = mutableListOf<String>()
        val sb = StringBuilder()
        var inQuote = false
        for (c in raw) {
            when {
                c == '"' -> { inQuote = !inQuote; sb.append(c) }
                c == ',' && !inQuote -> { out.add(sb.toString().trim()); sb.clear() }
                else -> sb.append(c)
            }
        }
        if (sb.isNotBlank()) out.add(sb.toString().trim())
        return out.filter { it.isNotEmpty() }
    }

    // ------------------------------------------------------------------ //
    // Gmail-style quoted original (ComposeEditor onCreate)

    private fun esc(t: String): String =
        t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** "Wed, Jan 15, 2024 at 9:00 AM" style date. */
    fun quoteDate(ts: Long): String {
        val datePart = java.text.SimpleDateFormat("EEE, MMM d, yyyy", Locale.UK).format(java.util.Date(ts))
        val timePart = java.text.SimpleDateFormat("h:mm a", Locale.UK).format(java.util.Date(ts))
        return "$datePart at $timePart"
    }

    /** Reply blockquote appended below the user's text (Gmail collapses it). */
    fun replyQuote(fromName: String, fromEmail: String, dateMs: Long, originalHtml: String): String {
        val d = quoteDate(dateMs)
        return "<br><div class=\"gmail_quote\"><div dir=\"ltr\" class=\"gmail_attr\">On $d ${esc(fromName)} &lt;${esc(fromEmail)}&gt; wrote:<br></div>" +
            "<blockquote class=\"gmail_quote\" style=\"margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex\">" +
            originalHtml +
            "</blockquote></div>"
    }

    /** Forward header block + original body. */
    fun forwardQuote(fromName: String, fromEmail: String, dateMs: Long, subject: String, to: String, originalHtml: String): String {
        val d = quoteDate(dateMs)
        return "<br><div class=\"gmail_quote\">" +
            "<div dir=\"ltr\" style=\"font-size:small;color:#222\">---------- Forwarded message ---------<br>" +
            "<b>From:</b> ${esc(fromName)} &lt;${esc(fromEmail)}&gt;<br>" +
            "<b>Date:</b> $d<br>" +
            "<b>Subject:</b> ${esc(subject)}<br>" +
            "<b>To:</b> ${esc(to)}<br></div><br>" +
            originalHtml +
            "</div>"
    }

    /** Wrap the user's editor content above the quote so Gmail nests the quote under ⋯. */
    fun assembleSendHtml(userHtml: String, quotedHtml: String?): String =
        if (!quotedHtml.isNullOrEmpty()) "<div dir=\"ltr\">$userHtml</div>$quotedHtml" else userHtml

    /** Re:/Fwd: subject prefixing (case-insensitive, not duplicated). */
    fun rePrefix(subject: String): String =
        if (subject.trimStart().lowercase().startsWith("re:")) subject else "Re: $subject"

    fun fwdPrefix(subject: String): String =
        if (subject.trimStart().lowercase().startsWith("fwd:")) subject else "Fwd: $subject"

    // ------------------------------------------------------------------ //
    // Body HTML sanitize (src/utils/email.ts sanitizeHtml — DOMPurify equiv)

    /**
     * Strip dangerous tags from email HTML before it hits the (JS-disabled)
     * WebView: script/iframe/object/embed/form/input. JS is already off, but
     * iframes/forms still render + can auto-load remote content, so we mirror
     * the SPA's DOMPurify forbid-list. Regex is coarse but the render surface
     * is inert (no JS, links intercepted), so this is defence-in-depth.
     */
    fun sanitizeHtml(html: String): String {
        var out = html
        // Paired tags with content.
        for (tag in listOf("script", "iframe", "object", "embed", "form")) {
            out = out.replace(Regex("(?is)<$tag\\b[^>]*>.*?</$tag>"), "")
            // Unclosed opener.
            out = out.replace(Regex("(?is)<$tag\\b[^>]*/?>"), "")
        }
        // Void/self-closing inputs.
        out = out.replace(Regex("(?is)<input\\b[^>]*/?>"), "")
        return out
    }

    // ------------------------------------------------------------------ //
    // Dark-mode email CSS (src/utils/email.ts buildDarkModeEmailCss) — invert
    // + hue-rotate so inline-white-background marketing mail goes dark, with
    // media re-inverted to stay natural.

    fun darkModeCss(): String = """
        :root { color-scheme: only light; }
        html { filter: invert(1) hue-rotate(180deg); background: #fff !important; }
        img, video, [style*="background-image"], svg { filter: invert(1) hue-rotate(180deg); }
    """.trimIndent()

    // Force fixed-width marketing tables to linearize to the viewport.
    fun linearizeCss(): String = """
        table, tbody, tr, td, th { display: block !important; width: 100% !important; box-sizing: border-box; }
        td, th { word-break: break-word; }
        img { max-width: 100% !important; height: auto !important; }
        pre { white-space: pre-wrap !important; word-break: break-word; }
    """.trimIndent()
}
