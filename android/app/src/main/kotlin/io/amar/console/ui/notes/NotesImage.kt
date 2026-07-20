package io.amar.console.ui.notes

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import io.amar.console.data.notes.EditorActions
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Read an image from a picker/camera Uri, downscale to a 2000px long edge as
 * JPEG q0.85 (GIFs + small images pass through), upload to the blog-assets dir
 * via [NotesRepository.pasteImage], and insert the resulting embed at the
 * caret. Mirrors WriteActionBar's insert pipeline (src/components/notes/
 * WriteActionBar.tsx) + pasteImage in src/store/notes.ts.
 */
suspend fun insertImageFromUri(
    context: Context,
    repo: NotesRepository,
    uri: Uri,
    tfv: TextFieldValue,
    onEdit: (EditorActions.Edit) -> Unit,
) {
    val prepared = withContext(Dispatchers.IO) { prepareImage(context, uri) } ?: return
    val ts = isoStamp()
    val filename = "photo-$ts.${prepared.ext}"
    val result = repo.pasteImage(prepared.bytes, filename, prepared.contentType) ?: run {
        // Upload failed — surface nothing here; caller may toast. Insert a
        // markdown embed pointing at the intended asset path so content isn't
        // silently dropped.
        val embed = "![](assets/images/$filename)"
        onEdit(EditorActions.insert(tfv.text, tfv.selection.end, embed))
        return
    }
    val embed = if (result.wikiEmbed) "![[${result.ref}]]" else "![](${result.ref})"
    onEdit(EditorActions.insert(tfv.text, tfv.selection.end, embed))
}

private data class PreparedImage(val bytes: ByteArray, val ext: String, val contentType: String)

private fun prepareImage(context: Context, uri: Uri): PreparedImage? {
    val raw = runCatching {
        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }.getOrNull() ?: return null
    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
    // GIFs pass through untouched (downscaling would kill animation).
    if (mime.contains("gif")) return PreparedImage(raw, "gif", mime)

    val opts = BitmapFactory.Options()
    val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size, opts) ?: return PreparedImage(raw, extFor(mime), mime)
    val maxEdge = 2000
    val longEdge = maxOf(decoded.width, decoded.height)
    if (longEdge <= maxEdge) {
        // Small enough — re-encode as JPEG q85 for consistency (unless PNG w/ alpha).
        return encode(decoded, mime)
    }
    val scale = maxEdge.toFloat() / longEdge
    val scaled = Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true)
    return encode(scaled, mime)
}

private fun encode(bmp: Bitmap, mime: String): PreparedImage {
    val out = ByteArrayOutputStream()
    // Always JPEG q85 (matches the SPA); transparency is rare for photos.
    bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
    return PreparedImage(out.toByteArray(), "jpg", "image/jpeg")
}

private fun extFor(mime: String): String = when {
    mime.contains("png") -> "png"
    mime.contains("webp") -> "webp"
    mime.contains("gif") -> "gif"
    else -> "jpg"
}

/** ISO-ish timestamp safe for filenames (no ':'). Date.now unavailable → use millis. */
private fun isoStamp(): String {
    val fmt = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.UK)
    return fmt.format(java.util.Date(System.currentTimeMillis()))
}
