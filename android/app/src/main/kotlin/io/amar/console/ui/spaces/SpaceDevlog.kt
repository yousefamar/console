package io.amar.console.ui.spaces

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.BlogRepository
import io.amar.console.data.notes.NotesRepository
import io.amar.console.ui.notes.TitlePromptDialog
import kotlinx.coroutines.launch

/**
 * Devlog surfaces for a space — SPA `AreaDevlog` / `ProjectDevlog`
 * (SpacesTab.tsx, ^loud-colt / ^prim-moth). Drafts first (unsaved → amber,
 * else blue "draft"), then published posts newest-first with their date; area
 * views also chip the owning project. "New post" seeds the draft with the
 * space (project → `project:`, area → `tags: [<area>]`) and opens it.
 */

/** Pure selection/formatting for the devlog rows — unit-tested. */
object DevlogLogic {
    /** Drafts homed in a space: a project's by `project` (path- or
     *  frontmatter-claimed, the repo resolves both); an area's by tag,
     *  excluding a project draft whose project slug merely equals the area. */
    fun draftsFor(drafts: List<BlogRepository.Draft>, slug: String, kind: String): List<BlogRepository.Draft> =
        if (kind == "project") drafts.filter { it.project == slug }
        else drafts.filter { slug in it.tags && it.project != slug }

    /** `2026-09-05 10:00:00` / ISO → `2026-09-05`; blank → null. */
    fun shortDate(date: String?): String? = date?.trim()?.takeIf { it.length >= 10 }?.substring(0, 10)

    /** Header count: drafts + posts, or null when nothing is known yet. */
    fun count(drafts: List<BlogRepository.Draft>, posts: List<BlogRepository.Post>?): Int? =
        if (posts == null && drafts.isEmpty()) null else drafts.size + (posts?.size ?: 0)
}

private val DRAFT_BLUE = Color(0xFF3B82F6)
private val UNSAVED_AMBER = Color(0xFFF59E0B)

/** Area detail: the writing IS the content — full-height, always expanded. */
@Composable
fun AreaDevlog(notes: NotesRepository, slug: String, onOpenNote: (String) -> Unit) {
    val drafts by notes.blog.drafts.collectAsState()
    val postsByArea by notes.blog.postsByArea.collectAsState()
    val posts = postsByArea[slug]
    val mine = remember(drafts, slug) { DevlogLogic.draftsFor(drafts, slug, "area") }
    val dirty = dirtyPaths(notes)
    var newPost by remember { mutableStateOf(false) }
    LaunchedEffect(slug) { notes.blog.refreshAreaPosts(slug); notes.blog.refreshDrafts() }

    LazyColumn(Modifier.fillMaxSize()) {
        devlogHeader(
            label = "Posts", count = DevlogLogic.count(mine, posts),
            expanded = null, onToggle = null, onNew = { newPost = true },
        )
        devlogRows(mine, posts, dirty, showProject = true, emptyText = "No posts tagged $slug yet", onOpenNote)
    }
    if (newPost) NewPostDialog(notes, title = "New $slug post", area = slug, onDismiss = { newPost = false }, onOpenNote = onOpenNote)
}

/** Project Docs: a collapsed-by-default strip above the file tree. */
fun LazyListScope.projectDevlogStrip(
    slug: String,
    drafts: List<BlogRepository.Draft>,
    posts: List<BlogRepository.Post>?,
    dirty: Set<String>,
    expanded: Boolean,
    onToggle: () -> Unit,
    onNew: () -> Unit,
    onOpenNote: (String) -> Unit,
) {
    devlogHeader(label = "Devlog", count = DevlogLogic.count(drafts, posts), expanded = expanded, onToggle = onToggle, onNew = onNew)
    if (expanded) devlogRows(drafts, posts, dirty, showProject = false, emptyText = "No posts or drafts for $slug", onOpenNote)
}

@Composable
fun NewPostDialog(
    notes: NotesRepository,
    title: String,
    project: String? = null,
    area: String? = null,
    onDismiss: () -> Unit,
    onOpenNote: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    TitlePromptDialog(
        title = title,
        inheritProject = project,
        onDismiss = onDismiss,
        onConfirm = { t ->
            onDismiss()
            scope.launch {
                val r = notes.blog.createDraft(t, project = project, area = area)
                if (r.ok && r.path != null) {
                    notes.reconcile()
                    notes.blog.refreshDrafts()
                    onOpenNote(r.path)
                }
            }
        },
    )
}

/** Paths with unsaved edits: offline-dirty rows + dirty open tabs. */
@Composable
private fun dirtyPaths(notes: NotesRepository): Set<String> {
    val files by notes.observeFiles().collectAsState(initial = emptyList())
    val tabs by notes.tabs.state.collectAsState()
    return remember(files, tabs) {
        (files.filter { it.dirty }.map { it.path } + tabs.open.filter { it.dirty }.map { it.path }).toHashSet()
    }
}

private fun LazyListScope.devlogHeader(
    label: String,
    count: Int?,
    expanded: Boolean?,
    onToggle: (() -> Unit)?,
    onNew: () -> Unit,
) {
    item(key = "devlog-header-$label") {
        Row(
            Modifier.fillMaxWidth()
                .let { if (onToggle != null) it.clickable(onClick = onToggle) else it }
                .padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label + (count?.let { " ($it)" } ?: ""),
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (expanded != null) Icon(
                if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse devlog" else "Expand devlog",
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp),
            )
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            TextButton(onClick = onNew, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("+ New post", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

private fun LazyListScope.devlogRows(
    drafts: List<BlogRepository.Draft>,
    posts: List<BlogRepository.Post>?,
    dirty: Set<String>,
    showProject: Boolean,
    emptyText: String,
    onOpenNote: (String) -> Unit,
) {
    items(drafts, key = { "draft:" + it.path }) { d ->
        DevlogRow(
            title = d.title.ifBlank { d.path.substringAfterLast('/') },
            trailing = if (d.path in dirty) Pair<String, Color?>("unsaved", UNSAVED_AMBER) else Pair<String, Color?>("draft", DRAFT_BLUE),
            chip = null,
            onClick = { onOpenNote(d.path) },
        )
    }
    items(posts ?: emptyList(), key = { "post:" + it.path }) { p ->
        DevlogRow(
            title = p.title.ifBlank { p.path.substringAfterLast('/') },
            trailing = DevlogLogic.shortDate(p.date)?.let { Pair<String, Color?>(it, null) },
            chip = if (showProject) p.project else null,
            onClick = { onOpenNote(p.path) },
        )
    }
    if (posts == null && drafts.isEmpty()) {
        item(key = "devlog-loading") {
            Text("Loading…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
    } else if (posts?.isEmpty() == true && drafts.isEmpty()) {
        item(key = "devlog-empty") {
            Text(emptyText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
    }
}

@Composable
private fun DevlogRow(title: String, trailing: Pair<String, Color?>?, chip: String?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp),
        )
        Text(
            title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (chip != null) Text(
            chip, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 4.dp, vertical = 1.dp),
        )
        if (trailing != null) Text(
            trailing.first, style = MaterialTheme.typography.labelSmall,
            color = trailing.second ?: MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
