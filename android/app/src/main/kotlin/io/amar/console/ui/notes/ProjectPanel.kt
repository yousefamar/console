package io.amar.console.ui.notes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.BlogHelpers
import io.amar.console.data.notes.BlogRepository
import io.amar.console.data.notes.FrontmatterParser
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.launch

/**
 * Project pill in the editor status bar — shown for files under
 * `projects/<slug>/`. Tapping toggles the ProjectPanel. Shows folder icon,
 * project title, and post count (or '· untracked'). (src/components/notes/
 * ProjectPill.tsx + ProjectPanel.tsx)
 *
 * NOTE: the SPA panel also lists live agent sessions whose cwd is under the
 * project and offers "Start agent in project". That needs the agents
 * repository, which isn't reachable through NoteEditorScreen's current
 * signature (owned by ui/shell). Recorded as a sharedFileNeed; the panel here
 * covers title / status / posts / new-post.
 */
@Composable
fun ProjectPill(
    repo: NotesRepository,
    slug: String,
    open: Boolean,
    onToggle: () -> Unit,
) {
    val projects by repo.blog.projects.collectAsState()
    val postsByProject by repo.blog.postsByProject.collectAsState()
    val tracked = projects.firstOrNull { it.slug == slug }
    val postCount = postsByProject[slug]?.size ?: 0
    LaunchedEffect(slug) { repo.blog.refreshProjectPosts(slug); repo.blog.refreshProjects() }

    Row(
        Modifier
            .background(if (open) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent, RoundedCornerShape(6.dp))
            .clickable { onToggle() }
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(Icons.Filled.Folder, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(tracked?.title ?: BlogHelpers.humaniseSlug(slug), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (tracked != null) {
            Text("· $postCount post${if (postCount == 1) "" else "s"}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val statusColor = when (tracked.status) {
                "active" -> Color(0xFF4ADE80); "dormant" -> Color(0xFFFBBF24); else -> MaterialTheme.colorScheme.onSurfaceVariant
            }
            Icon(Icons.Filled.Circle, null, Modifier.size(6.dp), tint = statusColor)
        } else {
            Text("· untracked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)
        }
    }
}

/** Full project panel as a dialog (mobile) — title, status dropdown, posts, new post. */
@Composable
fun ProjectPanelDialog(
    repo: NotesRepository,
    slug: String,
    onDismiss: () -> Unit,
    onOpenFile: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val projects by repo.blog.projects.collectAsState()
    val postsByProject by repo.blog.postsByProject.collectAsState()
    val tracked = projects.firstOrNull { it.slug == slug }
    val posts = postsByProject[slug]
    var statusMenu by remember { mutableStateOf(false) }
    var newPost by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }

    LaunchedEffect(slug) { repo.blog.refreshProjectPosts(slug) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(tracked?.title ?: BlogHelpers.humaniseSlug(slug), style = MaterialTheme.typography.titleMedium)
                    Text(slug + if (tracked == null) " · untracked" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { scope.launch { refreshing = true; repo.blog.refreshProjectPosts(slug); refreshing = false } }) {
                    Icon(Icons.Filled.Refresh, "Refresh posts", tint = if (refreshing) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
        },
        text = {
            Column {
                if (tracked != null) {
                    // Status dropdown.
                    Box {
                        Row(
                            Modifier.clickable { statusMenu = true }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text("Status: ${tracked.status}", style = MaterialTheme.typography.bodySmall)
                        }
                        DropdownMenu(expanded = statusMenu, onDismissRequest = { statusMenu = false }) {
                            for (s in listOf("active", "dormant", "complete")) {
                                DropdownMenuItem(
                                    text = { Text(s) },
                                    leadingIcon = { if (s == tracked.status) Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) },
                                    onClick = {
                                        statusMenu = false
                                        scope.launch { repo.blog.setProjectStatus(slug, s) }
                                    },
                                )
                            }
                        }
                    }
                } else {
                    Text("Untracked. Add an index.md with `log: true` frontmatter to track this project.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text("Posts", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                when {
                    posts == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall)
                    posts.isEmpty() -> Text("No posts yet — write one ↓", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> LazyColumn(Modifier.fillMaxWidth()) {
                        items(posts, key = { it.path }) { p ->
                            Text(
                                p.title.ifBlank { p.path.substringAfterLast('/') },
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.fillMaxWidth().clickable { onOpenFile(p.path); onDismiss() }.padding(vertical = 6.dp),
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (tracked != null) TextButton(onClick = { newPost = true }) { Text("New post") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )

    if (newPost) {
        TitlePromptDialog(
            title = "New post about ${tracked?.title ?: slug}",
            inheritProject = slug,
            onDismiss = { newPost = false },
            onConfirm = { t ->
                newPost = false; onDismiss()
                scope.launch {
                    val r = repo.blog.createDraft(t, slug)
                    if (r.ok && r.path != null) { repo.reconcile(); onOpenFile(r.path); repo.blog.refreshProjectPosts(slug) }
                }
            },
        )
    }
}
