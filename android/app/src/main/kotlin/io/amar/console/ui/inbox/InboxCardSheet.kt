package io.amar.console.ui.inbox

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.spaces.SpacesRepository
import io.amar.console.ui.spaces.CardSheet

/**
 * The card editing sheet hosted OUTSIDE Spaces — from the Inbox's agent
 * detail, for a review / blocked card (SPA `InboxCardModal`, ^glad-bee:
 * Yousef wants no jump to Spaces mid-triage). Owns its OWN board read for
 * that project (`fetchBoard`, never the open-board state — Spaces may be
 * showing another project) and resolves the card by `^id`, else exact text,
 * the same address the hub's board routes take. Mutations go through the shared
 * [CardSheet] → hub BoardOps; the sheet closes after each, and the caller
 * refreshes the spaces list on dismiss.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxCardSheet(
    spaces: SpacesRepository,
    project: String,
    /** `^id` when stamped, else the card text. */
    query: String,
    allSessions: List<AgentSessionRow>,
    onDismiss: () -> Unit,
    onOpenSession: (String) -> Unit = {},
) {
    var board by remember(project) { mutableStateOf<SpacesRepository.BoardView?>(null) }
    var error by remember(project) { mutableStateOf<String?>(null) }
    LaunchedEffect(project, query) {
        runCatching { spaces.fetchBoard(project) }
            .onSuccess { board = it }
            .onFailure { error = it.message ?: "Couldn't load the board" }
    }
    val b = board
    val card = remember(b, query) { b?.let { findCard(it, query) } }
    when {
        b == null -> LoadingSheet(onDismiss, error)
        card == null -> LoadingSheet(onDismiss, "Card not found on the $project board — it may have moved.")
        else -> CardSheet(
            spacesRepo = spaces,
            card = card,
            allSessions = allSessions,
            bound = allSessions.filter { it.project == project },
            kind = "project",
            slug = project,
            columns = b.columns.map { it.title },
            onOpenSession = onOpenSession,
            onDismiss = onDismiss,
        )
    }
}

/** `^id` first (the stable address), else the exact card text — the resolution
 *  order BoardOps uses (SPA `findCardByQuery`). */
internal fun findCard(board: SpacesRepository.BoardView, query: String): SpacesRepository.CardView? {
    val cards = board.columns.flatMap { it.cards }
    if (query.startsWith("^")) {
        val id = query.drop(1)
        return cards.firstOrNull { it.blockId == id }
    }
    return cards.firstOrNull { it.text == query } ?: cards.firstOrNull { it.blockId != null && "^${it.blockId}" == query }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LoadingSheet(onDismiss: () -> Unit, error: String?) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
            if (error != null) {
                Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            } else {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}
