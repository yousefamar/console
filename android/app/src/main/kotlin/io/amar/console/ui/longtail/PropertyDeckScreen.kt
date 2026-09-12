package io.amar.console.ui.longtail

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Directions
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Flight
import androidx.compose.material.icons.filled.House
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.longtail.PROPERTY_KINDS
import io.amar.console.data.longtail.PropertyCard
import io.amar.console.data.longtail.PropertyDeckRepository
import io.amar.console.data.longtail.Verdict
import io.amar.console.data.longtail.factsLine
import io.amar.console.data.longtail.formatPrice
import io.amar.console.data.longtail.kindLabel
import io.amar.console.data.longtail.listedAgo
import io.amar.console.data.longtail.portalLabel
import io.amar.console.data.longtail.swipeVerdict
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import io.amar.console.ui.theme.accents
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Review deck — the map's unreviewed property pins as a card stack. Swipe
 * right = interested (the pin turns 🏡), left = not interested (the pin
 * goes), tap = the full listing in a sheet. Same verdicts as the Map pin
 * panel and the SPA's LayerFeaturePanel; the hub redraws the layers and the
 * phone's map picks the change up over the sync bus.
 */
@Composable
fun PropertyDeckScreen(repo: PropertyDeckRepository, onBack: () -> Unit) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<PropertyCard?>(null) }
    // A button verdict animates the top card off like a swipe would.
    var programmatic by remember { mutableStateOf<Verdict?>(null) }

    LaunchedEffect(Unit) { if (state.cards.isEmpty()) repo.load() }

    val top = state.cards.firstOrNull()
    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = kindLabel(state.kind),
            subtitle = if (state.total > 0) "${state.total} to review" else null,
            onBack = onBack,
        )
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (k in PROPERTY_KINDS) {
                val n = state.counts[k]
                FilterChip(
                    selected = state.kind == k,
                    onClick = { if (state.kind != k) scope.launch { repo.load(k) } },
                    label = { Text(if (n != null) "${kindLabel(k)} $n" else kindLabel(k)) },
                )
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
            when {
                top == null && state.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                top == null && state.error != null -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(state.error!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.accents.red)
                    TextButton(onClick = { scope.launch { repo.load() } }) { Text("retry") }
                }
                top == null -> EmptyState(Icons.Filled.House, "All reviewed", "New listings land here as the portals list them.")
                else -> BoxWithConstraints(Modifier.fillMaxSize()) {
                    val widthPx = constraints.maxWidth.toFloat()
                    // Two cards peek out behind the top one.
                    for (i in minOf(2, state.cards.size - 1) downTo 1) {
                        val c = state.cards[i]
                        val scale = 1f - 0.04f * i
                        key(c.key) {
                            Box(
                                Modifier.fillMaxSize()
                                    .graphicsLayer { scaleX = scale; scaleY = scale; translationY = 14.dp.toPx() * i },
                            ) { PropertyCardFace(c, onOpen = null) }
                        }
                    }
                    SwipeableCard(
                        card = top,
                        widthPx = widthPx,
                        programmatic = programmatic,
                        onVerdict = { v ->
                            programmatic = null
                            scope.launch { repo.judge(top, v) }
                        },
                        onOpen = { detail = top },
                    )
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(bottom = 14.dp, top = 2.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            VerdictButton(Icons.Filled.Close, "Not interested", MaterialTheme.accents.red, enabled = top != null && programmatic == null) { programmatic = Verdict.Dismissed }
            Spacer(Modifier.size(28.dp))
            IconButton(onClick = { scope.launch { repo.undo() } }, enabled = state.history.isNotEmpty()) {
                Icon(Icons.AutoMirrored.Filled.Undo, "Undo", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.size(28.dp))
            VerdictButton(Icons.Filled.Favorite, "Interested", MaterialTheme.accents.green, enabled = top != null && programmatic == null) { programmatic = Verdict.Interested }
        }
    }

    detail?.let { c ->
        PropertyDetailSheet(
            card = c,
            onDismiss = { detail = null },
            onVerdict = { v ->
                detail = null
                programmatic = v
            },
        )
    }
}

@Composable
private fun VerdictButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: Color, enabled: Boolean, onClick: () -> Unit) {
    val ring = if (enabled) tint else MaterialTheme.colorScheme.outlineVariant
    Box(
        Modifier.size(64.dp).clip(CircleShape)
            .border(2.dp, ring, CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = ring, modifier = Modifier.size(30.dp))
    }
}

/** The draggable top card: follows the finger with a tilt, stamps LIKE/NOPE as it nears the commit line, flies off or springs back. */
@Composable
private fun SwipeableCard(
    card: PropertyCard,
    widthPx: Float,
    programmatic: Verdict?,
    onVerdict: (Verdict) -> Unit,
    onOpen: () -> Unit,
) {
    val offsetX = remember(card.key) { Animatable(0f) }
    val offsetY = remember(card.key) { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val commitPx = widthPx * io.amar.console.data.longtail.SWIPE_COMMIT_FRACTION

    suspend fun flyOff(v: Verdict) {
        val dir = if (v == Verdict.Interested) 1f else -1f
        offsetX.animateTo(dir * widthPx * 1.4f, tween(220))
        onVerdict(v)
    }

    LaunchedEffect(programmatic, card.key) {
        if (programmatic != null) flyOff(programmatic)
    }

    val progress = (offsetX.value / commitPx).coerceIn(-1f, 1f)
    Box(
        Modifier.fillMaxSize()
            .offset { IntOffset(offsetX.value.roundToInt(), offsetY.value.roundToInt()) }
            .graphicsLayer { rotationZ = (offsetX.value / widthPx) * 12f }
            .pointerInput(card.key) {
                val tracker = VelocityTracker()
                detectDragGestures(
                    onDragStart = { tracker.resetTracking() },
                    onDrag = { change, drag ->
                        change.consume()
                        tracker.addPosition(change.uptimeMillis, change.position)
                        scope.launch {
                            offsetX.snapTo(offsetX.value + drag.x)
                            offsetY.snapTo(offsetY.value + drag.y * 0.4f)
                        }
                    },
                    onDragEnd = {
                        val v = swipeVerdict(offsetX.value, tracker.calculateVelocity().x, widthPx)
                        scope.launch {
                            if (v == null) {
                                launch { offsetX.animateTo(0f, spring(stiffness = 600f)) }
                                launch { offsetY.animateTo(0f, spring(stiffness = 600f)) }
                            } else {
                                launch { offsetY.animateTo(0f, tween(220)) }
                                flyOff(v)
                            }
                        }
                    },
                    onDragCancel = {
                        scope.launch {
                            launch { offsetX.animateTo(0f, spring()) }
                            launch { offsetY.animateTo(0f, spring()) }
                        }
                    },
                )
            },
    ) {
        PropertyCardFace(card, onOpen = onOpen)
        if (progress > 0.05f) Stamp("LIKE", MaterialTheme.accents.green, progress, Modifier.align(Alignment.TopStart).padding(22.dp).graphicsLayer { rotationZ = -14f })
        if (progress < -0.05f) Stamp("NOPE", MaterialTheme.accents.red, -progress, Modifier.align(Alignment.TopEnd).padding(22.dp).graphicsLayer { rotationZ = 14f })
    }
}

@Composable
private fun Stamp(text: String, color: Color, alpha: Float, modifier: Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Black,
        color = color.copy(alpha = alpha.coerceIn(0f, 1f)),
        modifier = modifier.border(3.dp, color.copy(alpha = alpha.coerceIn(0f, 1f)), RoundedCornerShape(6.dp)).padding(horizontal = 10.dp, vertical = 2.dp),
    )
}

/** What a card shows at rest: hero photo with the price over it, then the facts. [onOpen] null = a peeking card, not tappable. */
@Composable
private fun PropertyCardFace(card: PropertyCard, onOpen: (() -> Unit)?) {
    val ctx = LocalContext.current
    Surface(
        modifier = Modifier.fillMaxSize().then(if (onOpen != null) Modifier.clickable(onClick = onOpen) else Modifier),
        shape = RoundedCornerShape(18.dp),
        tonalElevation = 2.dp,
        shadowElevation = 6.dp,
    ) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().weight(0.58f)) {
                if (card.image != null) {
                    AsyncImage(model = card.image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.House, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(64.dp))
                    }
                }
                // Price + address legible over any photo.
                Box(
                    Modifier.fillMaxWidth().align(Alignment.BottomStart)
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f))))
                        .padding(start = 14.dp, end = 14.dp, top = 40.dp, bottom = 10.dp),
                ) {
                    Column {
                        Text(
                            formatPrice(card.price, card.currency) ?: "Price on request",
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                        )
                        (card.address ?: card.title)?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.92f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                Row(Modifier.align(Alignment.TopEnd).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    // Gold = the tiered (lifted-ceiling) searches' layer colour on the map.
                    if (card.tier != null) Badge(card.tier, Color(0xFFEAB308), fg = Color.Black)
                    if (card.fixer) Badge("needs work", MaterialTheme.accents.amber, fg = Color.Black)
                    Badge(card.country, Color.Black.copy(alpha = 0.55f))
                }
            }
            Column(Modifier.fillMaxWidth().weight(0.42f).padding(horizontal = 14.dp, vertical = 10.dp)) {
                val facts = factsLine(card)
                if (facts.isNotEmpty()) Text(facts, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                card.highStreet?.let { FactRow(Icons.Filled.Storefront, it) }
                card.airport?.let { FactRow(Icons.Filled.Flight, it) }
                // Takes whatever height is left and ellipsizes to it, so the footer never gets pushed off the card.
                Text(
                    card.summary ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 6, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp).weight(1f),
                )
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    val meta = listOfNotNull(portalLabel(card.portal), listedAgo(card.listedAt), card.alsoOn.takeIf { it.isNotEmpty() }?.let { "also on ${it.joinToString { p -> portalLabel(p) }}" })
                    Text(meta.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (onOpen != null && card.url.isNotEmpty()) {
                        IconButton(onClick = { openUrl(ctx, card.url) }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.OpenInNew, "Open listing", tint = MaterialTheme.accents.blue, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Badge(text: String, bg: Color, fg: Color = Color.White) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = fg,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(bg).padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

@Composable
private fun FactRow(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        Spacer(Modifier.size(6.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Everything the card carries, plus the verdict buttons so a read-through ends in a decision. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PropertyDetailSheet(card: PropertyCard, onDismiss: () -> Unit, onVerdict: (Verdict) -> Unit) {
    val ctx = LocalContext.current
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp).verticalScroll(rememberScrollState()).padding(bottom = 28.dp)) {
            if (card.image != null) {
                AsyncImage(model = card.image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(200.dp).clip(RoundedCornerShape(12.dp)))
                Spacer(Modifier.height(12.dp))
            }
            Text(formatPrice(card.price, card.currency) ?: "Price on request", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            card.title?.takeIf { it != card.address }?.let { Text(it, style = MaterialTheme.typography.titleSmall) }
            card.address?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            val facts = factsLine(card)
            if (facts.isNotEmpty()) Text(facts, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 8.dp))
            card.highStreet?.let { FactRow(Icons.Filled.Storefront, it) }
            card.airport?.let { FactRow(Icons.Filled.Flight, it) }
            if (card.keyFeatures.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                for (f in card.keyFeatures) Text("• $f", style = MaterialTheme.typography.bodySmall)
            }
            (card.description ?: card.summary)?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(10.dp))
            val meta = listOfNotNull(portalLabel(card.portal), card.agent, listedAgo(card.listedAt)?.let { "listed $it" })
            Text(meta.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { openInMaps(ctx, card.lat, card.lon, card.address ?: card.title) }) {
                    Icon(Icons.Filled.Directions, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.size(4.dp)); Text("navigate")
                }
                if (card.url.isNotEmpty()) TextButton(onClick = { openUrl(ctx, card.url) }) {
                    Icon(Icons.Filled.OpenInNew, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.size(4.dp)); Text("open on ${portalLabel(card.portal)}")
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                VerdictButton(Icons.Filled.Close, "Not interested", MaterialTheme.accents.red, enabled = true) { onVerdict(Verdict.Dismissed) }
                Spacer(Modifier.size(40.dp))
                VerdictButton(Icons.Filled.Favorite, "Interested", MaterialTheme.accents.green, enabled = true) { onVerdict(Verdict.Interested) }
            }
        }
    }
}

private fun openUrl(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
}
