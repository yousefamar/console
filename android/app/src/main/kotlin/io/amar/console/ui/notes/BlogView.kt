package io.amar.console.ui.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.BlogHelpers
import io.amar.console.data.notes.BlogRepository
import io.amar.console.data.notes.FrontmatterParser
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.launch

/**
 * Blog writing-mode sidebar: a prominent New-post button, drafts (age-coloured),
 * projects (expandable devlogs, status dots, per-project new-post), and recent
 * published posts (with live-permalink open). Auto-refreshes on mount.
 * (src/components/notes/BlogView.tsx)
 */
@Composable
fun BlogView(
    repo: NotesRepository,
    onOpenFile: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val drafts by repo.blog.drafts.collectAsState()
    val projects by repo.blog.projects.collectAsState()
    val recent by repo.blog.recentPosts.collectAsState()
    val postsByProject by repo.blog.postsByProject.collectAsState()
    val refreshing by repo.blog.refreshing.collectAsState()
    var newPost by remember { mutableStateOf(false) }
    var expandedProject by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { repo.blog.refreshAll() }

    fun openBlogFile(path: String) {
        scope.launch { repo.tabs.open(path, repo.openFile(path) ?: ""); onOpenFile(path) }
    }

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Blog", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = { scope.launch { repo.blog.refreshAll() } }) {
                Icon(Icons.Filled.Refresh, "Refresh", tint = if (refreshing) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            }
        }
        // New post button.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
                .clickable { newPost = true }
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Filled.Add, null, tint = MaterialTheme.colorScheme.primary)
            Text("New post", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        }

        LazyColumn(Modifier.fillMaxSize()) {
            item { SectionHeader("Drafts", drafts.size) }
            if (drafts.isEmpty()) item { EmptyRow("No drafts. Write something.") }
            items(drafts, key = { it.path }) { d ->
                val age = System.currentTimeMillis() - d.mtime
                val color = when (BlogHelpers.ageSeverity(age)) {
                    BlogHelpers.AgeSeverity.STALE -> Color(0xFFF87171)
                    BlogHelpers.AgeSeverity.WARN -> Color(0xFFFBBF24)
                    BlogHelpers.AgeSeverity.FRESH -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Row(
                    Modifier.fillMaxWidth().clickable { openBlogFile(d.path) }.padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Filled.Description, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f)) {
                        Text(d.title.ifBlank { d.path.substringAfterLast('/') }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(BlogHelpers.formatAge(age), style = MaterialTheme.typography.labelSmall, color = color)
                    }
                }
            }

            item { SectionHeader("Projects", projects.size) }
            items(BlogHelpers.sortProjects(projects), key = { it.slug }) { p ->
                ProjectRow(
                    project = p,
                    expanded = expandedProject == p.slug,
                    posts = postsByProject[p.slug],
                    onToggle = {
                        if (expandedProject == p.slug) expandedProject = null
                        else { expandedProject = p.slug; scope.launch { repo.blog.refreshProjectPosts(p.slug) } }
                    },
                    onNewPost = { newPostForProject(scope, repo, p.slug, ::openBlogFile) },
                    onOpen = { openBlogFile(it) },
                )
            }

            item { SectionHeader("Recent", recent.size) }
            items(recent, key = { it.path }) { post ->
                PostRow(post, onOpen = { openBlogFile(it) }, onLive = { url ->
                    runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
                })
            }
        }
    }

    if (newPost) {
        TitlePromptDialog(
            title = "New post",
            inheritProject = null,
            onDismiss = { newPost = false },
            onConfirm = { t ->
                newPost = false
                scope.launch {
                    val r = repo.blog.createDraft(t)
                    if (r.ok && r.path != null) {
                        repo.reconcile(); repo.blog.refreshDrafts(); openBlogFile(r.path)
                    }
                }
            },
        )
    }
}

private fun newPostForProject(
    scope: kotlinx.coroutines.CoroutineScope,
    repo: NotesRepository,
    slug: String,
    open: (String) -> Unit,
) {
    // Fire a draft creation inheriting the project (title defaults to a stub;
    // the meta bar lets the user rename). Kept minimal — the per-project '+'.
    scope.launch {
        val r = repo.blog.createDraft("Untitled", slug)
        if (r.ok && r.path != null) { repo.reconcile(); repo.blog.refreshDrafts(); open(r.path) }
    }
}

@Composable
private fun SectionHeader(title: String, count: Int) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("$count", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyRow(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
}

@Composable
private fun ProjectRow(
    project: BlogRepository.Project,
    expanded: Boolean,
    posts: List<BlogRepository.Post>?,
    onToggle: () -> Unit,
    onNewPost: () -> Unit,
    onOpen: (String) -> Unit,
) {
    val statusColor = when (project.status) {
        "active" -> Color(0xFF4ADE80)
        "dormant" -> Color(0xFFFBBF24)
        else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
    }
    Column {
        Row(
            Modifier.fillMaxWidth().clickable { onToggle() }.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.ChevronRight, null, Modifier.size(16.dp))
            Icon(Icons.Filled.Folder, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(project.title, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            IconButton(onClick = onNewPost, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Add, "New post", Modifier.size(14.dp)) }
            Box(Modifier.size(8.dp).padding(1.dp)) { Icon(Icons.Filled.Circle, null, tint = statusColor, modifier = Modifier.size(6.dp)) }
        }
        if (expanded) {
            when {
                posts == null -> EmptyRow("Loading…")
                posts.isEmpty() -> EmptyRow("No posts yet")
                else -> for (p in posts) PostRow(p, indent = true, onOpen = onOpen, onLive = null)
            }
        }
    }
}

@Composable
private fun PostRow(
    post: BlogRepository.Post,
    indent: Boolean = false,
    onOpen: (String) -> Unit,
    onLive: ((String) -> Unit)?,
) {
    Row(
        Modifier.fillMaxWidth().clickable { onOpen(post.path) }
            .padding(start = if (indent) 28.dp else 12.dp, end = 8.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(post.title.ifBlank { post.path.substringAfterLast('/') }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                BlogHelpers.postDateLabel(post.date) + (post.project?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val url = FrontmatterParser.permalinkForLogPath(post.path)
        if (onLive != null && url != null) {
            IconButton(onClick = { onLive(url) }, modifier = Modifier.size(28.dp)) {
                Icon(Icons.AutoMirrored.Filled.OpenInNew, "View live", Modifier.size(14.dp))
            }
        }
    }
}
