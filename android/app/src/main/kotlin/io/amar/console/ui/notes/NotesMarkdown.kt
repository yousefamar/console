package io.amar.console.ui.notes

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.notes.NotesRepository

/**
 * Notes-specific markdown view renderer. Unlike the shared agents MarkdownLite,
 * this one resolves the notes-editor extras the SPA live-preview renders in
 * view mode: dimmed YAML frontmatter, clickable `[[wiki-links]]` (opening the
 * target note) + `[text](url)` links, inline images (`![]()` and `![[embed]]`
 * resolved to bytes via the hub asset dir), task-list checkboxes, headings,
 * bold/italic/strike/inline-code, blockquotes and list hanging indent.
 *
 * (src/notes/live-preview.ts — but as a plain top-to-bottom render, not a
 * cursor-reveals-syntax live editor, since Compose has no CM6 equivalent.)
 */
@Composable
fun NotesMarkdownView(
    content: String,
    repo: NotesRepository,
    filePath: String,
    onOpenNote: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    allPaths: List<String>,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val fmRange = remember(content) { io.amar.console.data.notes.FrontmatterParser.range(content) }
        val fm = if (fmRange != null) content.substring(fmRange.first, fmRange.last + 1) else null
        val body = if (fmRange != null) content.substring(fmRange.last + 1) else content

        if (fm != null) {
            // Frontmatter dimmed italic, never collapsed (avoids layout shift).
            Text(
                fm.trimEnd(),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                fontStyle = FontStyle.Italic,
            )
        }

        val lines = remember(body) { body.lines() }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trimStart()
            when {
                trimmed.startsWith("![[") || imageMd(trimmed) != null -> {
                    val ref = if (trimmed.startsWith("![[")) trimmed.removePrefix("![[").substringBefore("]]")
                    else imageMd(trimmed)!!
                    InlineImage(ref, repo, filePath)
                }
                taskItem(trimmed) != null -> {
                    val (checked, label) = taskItem(trimmed)!!
                    TaskCheckboxRow(checked, label, allPaths, onOpenNote, onOpenUrl)
                }
                else -> RenderNoteLine(line, allPaths, onOpenNote, onOpenUrl)
            }
            i++
        }
    }
}

private fun imageMd(line: String): String? =
    Regex("""^!\[[^\]]*]\(([^)]+)\)""").find(line.trim())?.groupValues?.get(1)

/** "- [ ] text" / "- [x] text" → (checked, text), else null. */
private fun taskItem(line: String): Pair<Boolean, String>? {
    val m = Regex("""^[-*+]\s+\[([ xX])]\s+(.*)$""").find(line.trim()) ?: return null
    return (m.groupValues[1].lowercase() == "x") to m.groupValues[2]
}

@Composable
private fun TaskCheckboxRow(
    checked: Boolean,
    label: String,
    allPaths: List<String>,
    onOpenNote: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(
            if (checked) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = if (checked) "done" else "todo",
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(16.dp).padding(top = 2.dp),
        )
        ClickableInline(label, allPaths, onOpenNote, onOpenUrl)
    }
}

@Composable
private fun RenderNoteLine(
    line: String,
    allPaths: List<String>,
    onOpenNote: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val t = line.trimStart()
    when {
        t.isBlank() -> {}
        t.startsWith("###### ") -> Heading(t.removePrefix("###### "), MaterialTheme.typography.titleSmall.fontSize)
        t.startsWith("##### ") -> Heading(t.removePrefix("##### "), MaterialTheme.typography.titleSmall.fontSize)
        t.startsWith("#### ") -> Heading(t.removePrefix("#### "), MaterialTheme.typography.titleMedium.fontSize)
        t.startsWith("### ") -> Text(annotate(t.removePrefix("### "), allPaths), style = MaterialTheme.typography.titleSmall)
        t.startsWith("## ") -> Text(annotate(t.removePrefix("## "), allPaths), style = MaterialTheme.typography.titleMedium)
        t.startsWith("# ") -> Text(annotate(t.removePrefix("# "), allPaths), style = MaterialTheme.typography.titleLarge)
        t == "---" || t == "***" -> Box(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Box(Modifier.fillMaxWidth().size(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
        }
        t.startsWith("> ") -> Row {
            Box(Modifier.size(width = 3.dp, height = 18.dp).background(MaterialTheme.colorScheme.outline))
            ClickableInline(t.removePrefix("> "), allPaths, onOpenNote, onOpenUrl, italic = true, modifier = Modifier.padding(start = 8.dp))
        }
        t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ ") ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", style = MaterialTheme.typography.bodyMedium)
                ClickableInline(t.drop(2), allPaths, onOpenNote, onOpenUrl)
            }
        Regex("""^\d+\.\s""").containsMatchIn(t) ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(t.substringBefore(' ') + " ", style = MaterialTheme.typography.bodyMedium)
                ClickableInline(t.substringAfter(' '), allPaths, onOpenNote, onOpenUrl)
            }
        else -> ClickableInline(line, allPaths, onOpenNote, onOpenUrl)
    }
}

@Composable
private fun Heading(text: String, size: androidx.compose.ui.unit.TextUnit) {
    Text(text, style = MaterialTheme.typography.titleSmall.copy(fontSize = size, fontWeight = FontWeight.SemiBold))
}

/**
 * Render inline markdown with clickable [[wiki]] + [text](url) links. Uses a
 * ClickableText-like model: builds an AnnotatedString and detects taps on
 * link annotations. For simplicity taps anywhere on a line with exactly one
 * link open that link; multi-link lines fall back to opening the first.
 */
@Composable
private fun ClickableInline(
    raw: String,
    allPaths: List<String>,
    onOpenNote: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    italic: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val wiki = Regex("""\[\[([^\]]+)]]""").find(raw)
    val url = Regex("""\[([^\]]+)]\((https?://[^)]+)\)""").find(raw)
    val clickTarget: (() -> Unit)? = if (wiki != null) {
        val target = wiki.groupValues[1].substringBefore('|')
        fun() { resolveAndOpen(target, allPaths, onOpenNote) }
    } else if (url != null) {
        val u = url.groupValues[2]
        fun() { onOpenUrl(u) }
    } else null
    val ann = annotate(raw, allPaths)
    Text(
        ann,
        style = MaterialTheme.typography.bodyMedium.copy(fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal),
        modifier = if (clickTarget != null) modifier.clickable { clickTarget() } else modifier,
    )
}

private fun resolveAndOpen(target: String, allPaths: List<String>, onOpenNote: (String) -> Unit) {
    val cleaned = target.removeSuffix(".md")
    // Match by basename or full path (+.md), like the SPA resolver.
    val match = allPaths.firstOrNull { it == "$cleaned.md" || it == cleaned }
        ?: allPaths.firstOrNull { it.substringAfterLast('/').removeSuffix(".md") == cleaned.substringAfterLast('/') }
    if (match != null) onOpenNote(match)
}

/** Inline markdown → styled AnnotatedString: bold/italic/strike/code + link pills. */
internal fun annotate(text: String, allPaths: List<String>): androidx.compose.ui.text.AnnotatedString = buildAnnotatedString {
    var i = 0
    val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x33808080))
    val linkStyle = SpanStyle(color = Color(0xFF6AA0FF), textDecoration = TextDecoration.Underline)
    while (i < text.length) {
        // Wiki link [[target|alias]]
        val wiki = Regex("""\[\[([^\]]+)]]""").matchAt(text, i)
        if (wiki != null) {
            val inner = wiki.groupValues[1]
            val display = if (inner.contains('|')) inner.substringAfter('|') else inner
            withStyle(linkStyle) { append(display) }
            i = wiki.range.last + 1
            continue
        }
        val link = Regex("""\[([^\]]+)]\(([^)]+)\)""").matchAt(text, i)
        if (link != null) {
            withStyle(linkStyle) { append(link.groupValues[1]) }
            i = link.range.last + 1
            continue
        }
        if (text.startsWith("**", i)) {
            val end = text.indexOf("**", i + 2)
            if (end > i) { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(i + 2, end)) }; i = end + 2; continue }
        }
        if (text.startsWith("~~", i)) {
            val end = text.indexOf("~~", i + 2)
            if (end > i) { withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(text.substring(i + 2, end)) }; i = end + 2; continue }
        }
        if (text[i] == '*' && !text.startsWith("**", i)) {
            val end = text.indexOf('*', i + 1)
            if (end > i) { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(text.substring(i + 1, end)) }; i = end + 1; continue }
        }
        if (text[i] == '`') {
            val end = text.indexOf('`', i + 1)
            if (end > i) { withStyle(codeStyle) { append(text.substring(i + 1, end)) }; i = end + 1; continue }
        }
        append(text[i]); i++
    }
}

/**
 * Inline image (max ~300dp tall / full width). Resolves the ref to bytes via
 * the hub asset dir; shows a placeholder while loading and a "not found" note
 * on failure (20s negative-cache is implicit — a re-render retries).
 */
@Composable
private fun InlineImage(ref: String, repo: NotesRepository, filePath: String) {
    var bitmap by remember(ref, filePath) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(ref, filePath) { mutableStateOf(false) }
    LaunchedEffect(ref, filePath) {
        failed = false
        val resolved = if (ref.startsWith("http") || ref.startsWith("data:")) null else repo.resolveImage(ref, filePath)
        if (resolved != null) {
            bitmap = runCatching {
                android.graphics.BitmapFactory.decodeByteArray(resolved.first, 0, resolved.first.size)?.asImageBitmap()
            }.getOrNull()
            if (bitmap == null) failed = true
        } else if (!ref.startsWith("http") && !ref.startsWith("data:")) {
            failed = true
        }
    }
    when {
        bitmap != null -> Image(
            bitmap = bitmap!!,
            contentDescription = ref,
            modifier = Modifier.fillMaxWidth().heightIn(max = 300.dp).clip(RoundedCornerShape(6.dp)),
        )
        failed -> Text(
            "Image not found: $ref",
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
            color = MaterialTheme.colorScheme.error,
        )
        else -> Text(
            "Loading: $ref",
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
