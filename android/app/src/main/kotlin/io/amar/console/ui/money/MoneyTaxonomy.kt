package io.amar.console.ui.money

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.money.MoneyCategories
import io.amar.console.data.money.MoneyCategory
import io.amar.console.data.money.MoneyRepository
import io.amar.console.data.money.MoneyRule
import io.amar.console.data.money.RuleMatch
import io.amar.console.ui.theme.accents

private val RED: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.red

// ---------------------------------------------------------------------- //
// Categories

/** Header row that folds the section: the taxonomy is edited rarely, so it opens collapsed. */
@Composable
internal fun FoldableTitle(title: String, trailing: String?, expanded: Boolean, onToggle: () -> Unit, onAdd: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 12.dp).padding(top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                if (expanded) "Collapse" else "Expand",
                Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onClick = onAdd, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Filled.Add, "Add", Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/** Chips grouped income → expense → transfer (SPA CategoriesPanel); archived ones behind a switch. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CategoriesSection(
    categories: List<MoneyCategory>,
    showArchived: Boolean,
    onToggleArchived: (Boolean) -> Unit,
    onEdit: (MoneyCategory) -> Unit,
) {
    val groups = remember(categories, showArchived) { MoneyCategories.grouped(categories, showArchived) }
    val archivedCount = remember(categories) { categories.count { it.archived } }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (groups.isEmpty()) Hint("No categories yet — add one.", padded = false)
        for ((kind, cats) in groups) {
            Text(kind.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (c in cats) CategoryChip(c, onClick = { onEdit(c) })
            }
        }
        if (archivedCount > 0) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Show archived ($archivedCount)",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Switch(checked = showArchived, onCheckedChange = onToggleArchived)
            }
        }
    }
}

@Composable
private fun CategoryChip(c: MoneyCategory, onClick: () -> Unit) {
    val dot = parseCatColor(c.color) ?: MaterialTheme.colorScheme.onSurfaceVariant
    val alpha = if (c.archived) 0.5f else 1f
    Row(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(dot.copy(alpha = alpha)))
        Text(c.emoji, style = MaterialTheme.typography.bodySmall)
        Text(c.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (c.isSystem) Text("SYS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (c.archived) Text("archived", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** New / edit category (SPA CategoryEditor): name, emoji, colour, kind, variable, archived, delete. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CategoryEditorSheet(
    category: MoneyCategory?,
    onSave: (MoneyCategory) -> Unit,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
) {
    val key = category?.id
    var name by remember(key) { mutableStateOf(category?.name.orEmpty()) }
    var emoji by remember(key) { mutableStateOf(category?.emoji ?: MoneyCategories.DEFAULT_EMOJI) }
    var color by remember(key) { mutableStateOf(category?.color ?: MoneyCategories.DEFAULT_COLOR) }
    var kind by remember(key) { mutableStateOf(category?.kind ?: MoneyCategories.KIND_EXPENSE) }
    var variable by remember(key) { mutableStateOf(category?.variable ?: true) }
    var archived by remember(key) { mutableStateOf(category?.archived ?: false) }
    val hex = MoneyCategories.normaliseHex(color)
    val canSave = name.isNotBlank() && hex != null

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(if (category == null) "New category" else "Edit category", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (onDelete != null) IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Delete, "Delete", Modifier.size(16.dp), tint = RED)
            }
        }
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(emoji, { emoji = it }, label = { Text("Emoji") }, singleLine = true, modifier = Modifier.width(88.dp))
            OutlinedTextField(
                color, { color = it }, label = { Text("Colour") }, singleLine = true,
                isError = hex == null,
                leadingIcon = { Box(Modifier.size(14.dp).clip(CircleShape).background(parseCatColor(hex) ?: MaterialTheme.colorScheme.outlineVariant)) },
                modifier = Modifier.weight(1f),
            )
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (s in MoneyCategories.SWATCHES) {
                val picked = s == hex
                Box(
                    Modifier
                        .size(26.dp)
                        .clip(CircleShape)
                        .background(parseCatColor(s) ?: Color.Gray)
                        .then(if (picked) Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier)
                        .clickable { color = s },
                    contentAlignment = Alignment.Center,
                ) {
                    if (picked) Icon(Icons.Filled.Check, null, Modifier.size(14.dp), tint = Color.Black)
                }
            }
        }
        Text("KIND", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (k in MoneyCategories.KINDS) FilterChip(
                selected = k == kind,
                onClick = { kind = k },
                enabled = category?.isSystem != true,
                label = { Text(k.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelSmall) },
            )
        }
        ToggleRow("Variable spend", "Projected from the trailing 3-month average; off for stream-funded categories (rent, salary)", variable) { variable = it }
        if (category != null && !category.isSystem) {
            ToggleRow("Archived", "Hidden from pickers; past transactions keep it", archived) { archived = it }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    onSave(
                        MoneyCategory(
                            id = category?.id ?: MoneyCategories.mintCategoryId(),
                            name = name.trim(),
                            emoji = emoji.trim().ifEmpty { MoneyCategories.DEFAULT_EMOJI },
                            color = hex ?: MoneyCategories.DEFAULT_COLOR,
                            kind = kind,
                            isSystem = category?.isSystem ?: false,
                            variable = variable,
                            archived = archived,
                        ),
                    )
                },
                enabled = canSave,
            ) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

// ---------------------------------------------------------------------- //
// Rules

/** Priority-ordered list (SPA RulesPanel): `50  merchant ~ "tesco"  →  🛒 Groceries`. */
@Composable
internal fun RulesSection(rules: List<MoneyRule>, categoriesById: Map<String, MoneyCategory>, onEdit: (MoneyRule) -> Unit) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Hint("Rules run in priority order (lower first); the first match wins.", padded = false)
        if (rules.isEmpty()) Hint("No rules yet — add one.", padded = false)
        for (r in rules) {
            val cat = categoriesById[r.categoryId]
            Row(
                Modifier.fillMaxWidth().clickable { onEdit(r) }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(r.priority.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(28.dp))
                Column(Modifier.weight(1f)) {
                    Text(MoneyCategories.ruleTitle(r), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val extras = buildList {
                        if (r.ignore) add("ignored")
                        if (r.asTransfer) add("transfer")
                        r.sharedFraction?.let { add("share ${(it * 100).toInt()}%" + (r.sharedWithCounterparty?.let { c -> " with $c" } ?: "")) }
                    }
                    if (extras.isNotEmpty()) Text(extras.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Filled.ArrowForward, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    cat?.label ?: r.categoryId,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp),
                )
            }
        }
    }
}

/** New / edit rule (SPA RuleEditor). Save needs a category; everything else is optional. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RuleEditorSheet(
    rule: MoneyRule?,
    categories: List<MoneyCategory>,
    onSave: (MoneyRule) -> Unit,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
) {
    val key = rule?.id
    var priority by remember(key) { mutableStateOf((rule?.priority ?: MoneyCategories.DEFAULT_PRIORITY).toString()) }
    var label by remember(key) { mutableStateOf(rule?.label.orEmpty()) }
    var merchant by remember(key) { mutableStateOf(rule?.match?.merchantContains.orEmpty()) }
    var description by remember(key) { mutableStateOf(rule?.match?.descriptionContains.orEmpty()) }
    var counterparty by remember(key) { mutableStateOf(rule?.match?.counterpartyContains.orEmpty()) }
    var sign by remember(key) { mutableStateOf(rule?.match?.amountSign) }
    var monzoCat by remember(key) { mutableStateOf(rule?.match?.monzoCategoryEquals.orEmpty()) }
    var categoryId by remember(key) { mutableStateOf(rule?.categoryId) }
    var ignore by remember(key) { mutableStateOf(rule?.ignore ?: false) }
    var asTransfer by remember(key) { mutableStateOf(rule?.asTransfer ?: false) }
    var share by remember(key) { mutableStateOf(rule?.sharedFraction?.let { MoneyCategories.formatShare(it) }.orEmpty()) }
    var sharedWith by remember(key) { mutableStateOf(rule?.sharedWithCounterparty.orEmpty()) }
    val shareValue = MoneyCategories.parseShare(share)
    val shareBad = share.isNotBlank() && shareValue == null

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(if (rule == null) "New rule" else "Edit rule", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (onDelete != null) IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Delete, "Delete", Modifier.size(16.dp), tint = RED)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(label, { label = it }, label = { Text("Label") }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(
                priority, { priority = it }, label = { Text("Priority") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(96.dp),
            )
        }
        Text("MATCH (all conditions present must apply)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(merchant, { merchant = it }, label = { Text("Merchant contains") }, placeholder = { Text("e.g. tesco") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(description, { description = it }, label = { Text("Description contains") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(counterparty, { counterparty = it }, label = { Text("Counterparty contains") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Amount", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(60.dp))
            for ((value, text) in listOf(null to "Either", "in" to "In (+)", "out" to "Out (−)")) FilterChip(
                selected = sign == value,
                onClick = { sign = value },
                label = { Text(text, style = MaterialTheme.typography.labelSmall) },
            )
        }
        OutlinedTextField(monzoCat, { monzoCat = it }, label = { Text("Monzo category equals") }, placeholder = { Text("e.g. groceries") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("APPLY CATEGORY", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (c in categories) FilterChip(
                selected = c.id == categoryId,
                onClick = { categoryId = c.id },
                label = { Text(c.label, style = MaterialTheme.typography.labelSmall) },
            )
        }
        ToggleRow("Mark as ignored", "Excluded from spend and projections", ignore) { ignore = it }
        ToggleRow("Treat as transfer", "Between my own accounts", asTransfer) { asTransfer = it }
        Text("SHARED EXPENSE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                share, { share = it }, label = { Text("Your share (0–1)") }, placeholder = { Text("0.5") }, singleLine = true,
                isError = shareBad,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.width(130.dp),
            )
            OutlinedTextField(sharedWith, { sharedWith = it }, label = { Text("Counterparty") }, singleLine = true, modifier = Modifier.weight(1f))
        }
        Hint("0.5 = 50/50 split; inbound transfers from the counterparty net off the shared tab.", padded = false)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    val cat = categoryId ?: return@Button
                    onSave(
                        MoneyRule(
                            id = rule?.id ?: MoneyCategories.mintRuleId(),
                            priority = priority.trim().toIntOrNull() ?: MoneyCategories.DEFAULT_PRIORITY,
                            label = label.trim().ifEmpty { null },
                            match = RuleMatch(
                                merchantContains = merchant.trim().ifEmpty { null },
                                descriptionContains = description.trim().ifEmpty { null },
                                counterpartyContains = counterparty.trim().ifEmpty { null },
                                amountSign = sign,
                                monzoCategoryEquals = monzoCat.trim().ifEmpty { null },
                            ),
                            categoryId = cat,
                            ignore = ignore,
                            asTransfer = asTransfer,
                            sharedFraction = shareValue,
                            sharedWithCounterparty = sharedWith.trim().ifEmpty { null },
                        ),
                    )
                },
                enabled = categoryId != null && !shareBad,
            ) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun ToggleRow(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall)
            Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** Which taxonomy sheet is up. The editors key on the id so a landed write re-renders in place. */
internal sealed interface TaxonomySheet {
    data object NewCategory : TaxonomySheet
    data class EditCategory(val id: String) : TaxonomySheet
    data object NewRule : TaxonomySheet
    data class EditRule(val id: String) : TaxonomySheet
}

internal fun MoneyRepository.State.categoryFor(sheet: TaxonomySheet.EditCategory): MoneyCategory? = categories.firstOrNull { it.id == sheet.id }
internal fun MoneyRepository.State.ruleFor(sheet: TaxonomySheet.EditRule): MoneyRule? = rules.firstOrNull { it.id == sheet.id }
