package io.amar.console.ui.components

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns

/**
 * Attachment display metadata for the composer chips (FEATURES chat #7):
 * filename + human-readable size + whether it's an image (image chips show a
 * thumbnail, everything else shows a paperclip + filename + size).
 */
data class AttachmentMeta(
    val uri: Uri,
    val name: String,
    val sizeBytes: Long,
    val mime: String?,
) {
    val isImage: Boolean get() = mime?.startsWith("image/") == true
}

/** Human file size: B / KB / MB (1 dp above KB). Pure — unit-tested. */
fun formatBytes(bytes: Long): String = when {
    bytes < 0 -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format(java.util.Locale.UK, "%.1f MB", bytes / (1024.0 * 1024.0))
}

/** Resolve display name / size / mime for a content Uri (best-effort). */
fun queryAttachmentMeta(context: Context, uri: Uri): AttachmentMeta {
    var name = uri.lastPathSegment ?: "file"
    var size = -1L
    val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
    runCatching {
        context.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
            if (c.moveToFirst()) {
                if (nameIdx >= 0 && !c.isNull(nameIdx)) name = c.getString(nameIdx)
                if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
            }
        }
    }
    return AttachmentMeta(uri, name, size, mime)
}
