package io.amar.console.ui.money

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.amar.console.data.money.Account
import io.amar.console.data.money.MoneyAccounts
import io.amar.console.data.money.MoneyRepository
import io.amar.console.ui.theme.accents

private val RED: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.red

/** Which account editor is up (the SPA's one modal for both). */
internal sealed interface AccountSheet {
    object New : AccountSheet

    /** Keyed by id, not a snapshot, so a reconcile landing under it re-renders from state. */
    data class Edit(val id: String) : AccountSheet
}

internal fun MoneyRepository.State.accountFor(sheet: AccountSheet.Edit): Account? =
    accounts.firstOrNull { it.id == sheet.id }

/**
 * The phone's twin of the SPA's `AccountEditor` (`NetWorthView.tsx`): name,
 * liquidity, emoji, held-externally, growth assumption, notes — plus Archive on
 * an existing one and Delete for a manual account.
 *
 * Two fields are deliberately absent. `type` is fixed (a new account is always
 * `manual`; converting one would strand the Monzo mirror) and `monzoAccountId`
 * is the desktop's to link. [MoneyAccounts.toAccount] carries both through
 * untouched, along with the ledger — the readings belong to `money:balance`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AccountEditorSheet(
    account: Account?,
    onSave: (Account) -> Unit,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
) {
    val key = account?.id
    var draft by remember(key) { mutableStateOf(MoneyAccounts.draftOf(account)) }
    var archived by remember(key) { mutableStateOf(account?.archived ?: false) }
    val problem = MoneyAccounts.validate(draft)

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (account == null) "New account" else "Edit account",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            if (onDelete != null) IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Delete, "Delete", Modifier.size(16.dp), tint = RED)
            }
        }
        if (account?.type == MoneyAccounts.TYPE_MONZO) {
            Hint("Monzo-linked — its balance syncs itself, and the link is managed in the web app.", padded = false)
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                draft.emoji, { draft = draft.copy(emoji = it) },
                label = { Text("Emoji") }, singleLine = true, modifier = Modifier.width(88.dp),
            )
            OutlinedTextField(
                draft.name, { draft = draft.copy(name = it) },
                label = { Text("Name") }, singleLine = true, modifier = Modifier.weight(1f),
            )
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (e in MoneyAccounts.EMOJI_CHOICES) {
                val picked = e == draft.emoji
                Box(
                    Modifier
                        .size(32.dp)
                        .then(
                            if (picked) Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface, RoundedCornerShape(6.dp))
                            else Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))
                        )
                        .clickable { draft = draft.copy(emoji = if (picked) "" else e) },
                    contentAlignment = Alignment.Center,
                ) { Text(e, style = MaterialTheme.typography.bodyMedium) }
            }
        }

        Text("LIQUIDITY", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((keyL, label) in MoneyAccounts.LIQUIDITY_LABELS) FilterChip(
                selected = keyL == draft.liquidity,
                onClick = { draft = draft.copy(liquidity = keyL) },
                label = { Text(label, style = MaterialTheme.typography.labelSmall) },
            )
        }
        MoneyAccounts.LIQUIDITY_HINTS[draft.liquidity]?.let { Hint(it, padded = false) }

        OutlinedTextField(
            draft.growth, { draft = draft.copy(growth = it) },
            label = { Text("Growth % a year") },
            placeholder = { Text(if (draft.liquidity == MoneyAccounts.INVESTMENT) "blank = the global investment rate" else "blank = no growth") },
            isError = !MoneyAccounts.growthValid(draft.growth),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Hint("Compounded monthly in the projection — e.g. 3.25 for a savings account, 6.5 for an equity fund.", padded = false)

        OutlinedTextField(
            draft.notes, { draft = draft.copy(notes = it) },
            label = { Text("Notes") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        )

        AccountToggleRow(
            "Held externally",
            "Someone else holds it for him: counts toward net worth, not drawable",
            draft.isExternal,
        ) { draft = draft.copy(isExternal = it) }
        if (account != null) {
            AccountToggleRow("Archived", "Hidden from the net-worth list; its readings are kept", archived) { archived = it }
        }

        problem?.let { Hint(it, padded = false) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = { onSave(MoneyAccounts.toAccount(draft, account).copy(archived = archived)) },
                enabled = problem == null,
            ) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

/** Local twin of the taxonomy sheet's toggle row (that one is private to its file). */
@Composable
private fun AccountToggleRow(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        androidx.compose.material3.Switch(checked = checked, onCheckedChange = onChange)
    }
}
