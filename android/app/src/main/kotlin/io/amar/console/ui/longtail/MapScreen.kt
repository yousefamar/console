package io.amar.console.ui.longtail

import android.graphics.PointF
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.LocationSearching
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.data.longtail.BuiltinLayer
import io.amar.console.data.longtail.MapCache
import io.amar.console.data.longtail.MapRepository
import io.amar.console.data.longtail.MapUiState
import io.amar.console.data.longtail.MeetupEvent
import kotlinx.coroutines.launch
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapView

/**
 * Map pane: CARTO dark raster basemap + OwnTracks history, geocache/meetup
 * pins with lazy detail, and agent-authored GeoJSON layers. Rendering is
 * imperative (MapRenderer); this composable owns the toolbar, layers panel,
 * and detail sheets. Offline = pins/track without basemap tiles (data is
 * Room/meta-KV-hydrated; only the CARTO tiles need the network).
 */
@Composable
fun MapScreen(repo: MapRepository, onGrid: () -> Unit = {}) {
    val context = androidx.compose.ui.platform.LocalContext.current
    remember { MapLibre.getInstance(context) }
    val mapView = remember { MapView(context) }
    val renderer = remember { MapRenderer() }
    val scope = rememberCoroutineScope()
    val state by repo.state.collectAsState()

    var styleReady by remember { mutableStateOf(false) }
    val centeredRef = remember { mutableStateOf(false) }
    val fittedSlugs = remember { mutableStateOf(setOf<String>()) }

    var showLayers by remember { mutableStateOf(false) }
    var showCreds by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        mapView.onStart()
        mapView.onResume()
        onDispose {
            renderer.detach()
            mapView.onPause()
            mapView.onStop()
            mapView.onDestroy()
        }
    }

    // Build the map once; wire click handlers + renderer on style load.
    LaunchedEffect(Unit) {
        repo.hydrate()
        mapView.getMapAsync { map ->
            map.cameraPosition = CameraPosition.Builder().target(LatLng(54.0, -2.0)).zoom(5.0).build()
            map.uiSettings.isCompassEnabled = false
            map.setStyle(cartoDarkStyleJson()) { style ->
                renderer.attach(map, style)
                renderer.apply(repo.state.value)
                styleReady = true
            }
            // Tap → hit-test the pin/agent layers (topmost wins).
            map.addOnMapClickListener { latLng ->
                val pt: PointF = map.projection.toScreenLocation(latLng)
                val gc = map.queryRenderedFeatures(pt, "gc-pins")
                val mu = map.queryRenderedFeatures(pt, "meetup-pins")
                when {
                    gc.isNotEmpty() -> {
                        val code = gc[0].getStringProperty("code")
                        if (code != null) scope.launch { repo.selectCache(code) }
                    }
                    mu.isNotEmpty() -> {
                        val id = mu[0].getStringProperty("id")
                        if (id != null) scope.launch { repo.selectEvent(id) }
                    }
                }
                true
            }
        }
        // Initial data load: refresh (status + pins + events + layers) then history.
        repo.reconcile()
        repo.loadHistory()
    }

    // push state → renderer
    LaunchedEffect(state, styleReady) {
        if (styleReady) renderer.apply(state)
    }

    // auto-center once on first current fix
    LaunchedEffect(state.current, styleReady) {
        if (styleReady && !centeredRef.value) {
            state.current.firstOrNull()?.let { fix ->
                centeredRef.value = true
                mapView.getMapAsync { it.easeCamera(CameraUpdateFactory.newLatLngZoom(LatLng(fix.lat, fix.lon), 11.0), 600) }
            }
        }
    }

    // fit agent layers with fit:true once, when first visible with data
    LaunchedEffect(state.layers, state.layerData, state.layerVisible, styleReady) {
        if (!styleReady) return@LaunchedEffect
        for (l in state.layers) {
            if (l.fit && l.bbox != null && state.layerData[l.slug] != null &&
                state.layerVisible[l.slug] != false && l.slug !in fittedSlugs.value
            ) {
                fittedSlugs.value = fittedSlugs.value + l.slug
                renderer.fitBounds(l.bbox!!)
            }
        }
    }

    // marching-ants dash loop for animated agent lines (paused off-screen is
    // handled by composition death — the loop only runs while this is composed)
    LaunchedEffect(styleReady) {
        if (!styleReady) return@LaunchedEffect
        var step = 0
        while (true) {
            if (renderer.hasAnimatedLines()) {
                renderer.stepDash(DASH_SEQUENCE[step % DASH_SEQUENCE.size])
                step++
            }
            kotlinx.coroutines.delay(130)
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = { mapView })

        MapToolbar(
            state = state,
            onGrid = onGrid,
            onToggleLayers = { showLayers = !showLayers },
            onToggleCreds = { showCreds = !showCreds },
            onRangeDays = { days -> scope.launch { repo.loadHistory(System.currentTimeMillis() - days * MapUiState.DAY_MS, System.currentTimeMillis()) } },
            onDevice = { dev -> scope.launch { repo.loadHistory(device = dev) } },
            onFlyToMe = {
                state.current.firstOrNull()?.let { fix ->
                    mapView.getMapAsync { it.easeCamera(CameraUpdateFactory.newLatLngZoom(LatLng(fix.lat, fix.lon), 14.0), 600) }
                }
            },
            onFetchHere = {
                mapView.getMapAsync { map ->
                    val b = map.projection.visibleRegion.latLngBounds
                    scope.launch { repo.fetchArea(listOf(b.getLatSouth(), b.getLonWest(), b.getLatNorth(), b.getLonEast())) }
                }
            },
            onFetchMeetupHere = {
                mapView.getMapAsync { map ->
                    val b = map.projection.visibleRegion.latLngBounds
                    scope.launch { repo.fetchMeetupArea(listOf(b.getLatSouth(), b.getLonWest(), b.getLatNorth(), b.getLonEast())) }
                }
            },
            onMeetupDays = { repo.setMeetupDays(it) },
        )

        if (showLayers) {
            LayersPanel(
                state = state,
                onClose = { showLayers = false },
                onToggleBuiltin = { scope.launch { repo.toggleBuiltin(it) } },
                onToggleLayer = { scope.launch { repo.toggleLayer(it) } },
                onToggleGroup = { g, v -> scope.launch { repo.setGroupVisible(g, v) } },
                modifier = Modifier.align(Alignment.TopStart),
            )
        }
        if (showCreds) {
            CredentialsPanel(
                state = state,
                onClose = { showCreds = false },
                onSubmit = { u, p, c -> repo.setCredentials(u, p, c) },
                modifier = Modifier.align(Alignment.TopStart),
            )
        }

        val selectedCache = state.pins.find { it.code == state.selectedCode }
        val selectedEvent = state.events.find { it.id == state.selectedEventId }
        if (selectedCache != null) {
            CacheDetailPanel(selectedCache, onClose = { scope.launch { repo.selectCache(null) } }, modifier = Modifier.align(Alignment.TopEnd))
        } else if (selectedEvent != null) {
            MeetupEventPanel(selectedEvent, onClose = { scope.launch { repo.selectEvent(null) } }, modifier = Modifier.align(Alignment.TopEnd))
        }
    }
}

// 14-step constant-period dash sequence — marching ants (mirrors DASH_SEQUENCE
// in MapTab.tsx). Each entry restarts the dash so the march reads as continuous.
private val DASH_SEQUENCE: List<Array<Float>> = listOf(
    arrayOf(0f, 4f, 3f), arrayOf(0.5f, 4f, 2.5f), arrayOf(1f, 4f, 2f), arrayOf(1.5f, 4f, 1.5f),
    arrayOf(2f, 4f, 1f), arrayOf(2.5f, 4f, 0.5f), arrayOf(3f, 4f, 0f),
    arrayOf(0f, 0.5f, 3f, 3.5f), arrayOf(0f, 1f, 3f, 3f), arrayOf(0f, 1.5f, 3f, 2.5f),
    arrayOf(0f, 2f, 3f, 2f), arrayOf(0f, 2.5f, 3f, 1.5f), arrayOf(0f, 3f, 3f, 1f), arrayOf(0f, 3.5f, 3f, 0.5f),
)

// ---------------------------------------------------------------------- //
// Toolbar

@Composable
private fun MapToolbar(
    state: MapUiState,
    onGrid: () -> Unit,
    onToggleLayers: () -> Unit,
    onToggleCreds: () -> Unit,
    onRangeDays: (Long) -> Unit,
    onDevice: (String) -> Unit,
    onFlyToMe: () -> Unit,
    onFetchHere: () -> Unit,
    onFetchMeetupHere: () -> Unit,
    onMeetupDays: (Int) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // App-grid button (this pane is full-screen — no PaneTopBar).
            ToolbarChip(onClick = onGrid) {
                Icon(Icons.Filled.Apps, "App grid", modifier = Modifier.size(15.dp))
            }

            // Layers button — total count = agent layers + 3 built-ins.
            ToolbarChip(onClick = onToggleLayers) {
                Icon(Icons.Filled.Layers, "Map layers", modifier = Modifier.size(15.dp))
                Text("${state.layers.size + 3}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // Location cluster (only while the Location built-in is on).
            if (state.builtinVisible[BuiltinLayer.LOCATION] != false) {
                LocationRangeChip(state, onRangeDays, onDevice)
                ToolbarChip(onClick = onFlyToMe) {
                    Icon(Icons.Filled.MyLocation, "Centre on my location", modifier = Modifier.size(15.dp))
                }
            }

            // Geocaching cluster (only while Geocaches built-in is on).
            if (state.builtinVisible[BuiltinLayer.GEOCACHES] != false) {
                GeocacheChip(state, onToggleCreds, onFetchHere)
            }

            // Meetup cluster (only while Meetup built-in is on).
            if (state.builtinVisible[BuiltinLayer.MEETUP] != false) {
                MeetupChip(state, onMeetupDays, onFetchMeetupHere)
            }
        }
        state.error?.let { err ->
            Text(
                err,
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFFFCA5A5),
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0x33EF4444))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ToolbarChip(onClick: () -> Unit, content: @Composable () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        tonalElevation = 2.dp,
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}

@Composable
private fun LocationRangeChip(state: MapUiState, onRangeDays: (Long) -> Unit, onDevice: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var devOpen by remember { mutableStateOf(false) }
    val ranges = listOf(1L to "Last 24h", 2L to "Last 48h", 7L to "Last 7 days", 30L to "Last 30 days", 90L to "Last 90 days", 365L to "Last year")
    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), tonalElevation = 2.dp) {
        Row(Modifier.padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            if (state.loadingHistory) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Icon(Icons.Filled.LocationSearching, "History range", modifier = Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box {
                TextButton(onClick = { open = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 0.dp)) {
                    val days = ((state.rangeTo - state.rangeFrom) / MapUiState.DAY_MS).coerceAtLeast(1)
                    Text(rangeLabel(days), style = MaterialTheme.typography.labelSmall)
                    Icon(Icons.Filled.KeyboardArrowDown, null, modifier = Modifier.size(14.dp))
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    for ((d, label) in ranges) {
                        DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onRangeDays(d) })
                    }
                }
            }
            if (state.devices.size > 1) {
                Box {
                    TextButton(onClick = { devOpen = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 0.dp)) {
                        Text(state.device ?: "device", style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                    DropdownMenu(expanded = devOpen, onDismissRequest = { devOpen = false }) {
                        for (d in state.devices) {
                            DropdownMenuItem(text = { Text(d) }, onClick = { devOpen = false; onDevice(d) })
                        }
                    }
                }
            }
        }
    }
}

private fun rangeLabel(days: Long): String = when (days) {
    1L -> "Last 24h"; 2L -> "Last 48h"; 7L -> "Last 7 days"
    30L -> "Last 30 days"; 90L -> "Last 90 days"; 365L -> "Last year"
    else -> "${days}d"
}

@Composable
private fun GeocacheChip(state: MapUiState, onToggleCreds: () -> Unit, onFetchHere: () -> Unit) {
    val gc = state.gcStatus
    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), tonalElevation = 2.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onToggleCreds, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                Icon(Icons.Filled.VpnKey, "geocaching.com account", modifier = Modifier.size(14.dp))
                Spacer(Modifier.size(4.dp))
                Text(if (gc?.loggedIn == true) (gc.username ?: "account") else "Sign in", style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
            if (gc?.loggedIn == true) {
                TextButton(onClick = onFetchHere, enabled = !state.fetching, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                    if (state.fetching) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                    } else {
                        Icon(Icons.Filled.Download, "Fetch geocaches in view", modifier = Modifier.size(14.dp))
                    }
                    gc.budget?.let { Spacer(Modifier.size(4.dp)); Text("${it.remaining}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    }
}

@Composable
private fun MeetupChip(state: MapUiState, onMeetupDays: (Int) -> Unit, onFetchHere: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    val windows = listOf(0 to "Upcoming", 7 to "7 days", 30 to "30 days", 90 to "90 days")
    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), tonalElevation = 2.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📅", modifier = Modifier.padding(start = 8.dp))
            Box {
                TextButton(onClick = { open = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 4.dp)) {
                    Text(windows.find { it.first == state.meetupDays }?.second ?: "Upcoming", style = MaterialTheme.typography.labelSmall)
                    Icon(Icons.Filled.KeyboardArrowDown, null, modifier = Modifier.size(14.dp))
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    for ((d, label) in windows) {
                        DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onMeetupDays(d) })
                    }
                }
            }
            TextButton(onClick = onFetchHere, enabled = !state.fetchingMeetup, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                if (state.fetchingMeetup) {
                    CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                } else {
                    Icon(Icons.Filled.Download, "Fetch Meetup events in view", modifier = Modifier.size(14.dp))
                }
                state.meetupStatus?.budget?.let { Spacer(Modifier.size(4.dp)); Text("${it.remaining}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Layers panel

@Composable
private fun LayersPanel(
    state: MapUiState,
    onClose: () -> Unit,
    onToggleBuiltin: (BuiltinLayer) -> Unit,
    onToggleLayer: (String) -> Unit,
    onToggleGroup: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val geocacheCount = state.pins.count { it.lat != null && it.lon != null }
    val meetupCount = state.events.count { it.lat != null && it.lon != null }
    Surface(
        modifier = modifier.padding(top = 56.dp, start = 8.dp).widthIn(max = 300.dp).heightIn(max = 460.dp),
        shape = RoundedCornerShape(8.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Layers", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            Spacer(Modifier.size(4.dp))
            // built-ins
            BuiltinRow("🔵 Location history", state.builtinVisible[BuiltinLayer.LOCATION] != false, null) { onToggleBuiltin(BuiltinLayer.LOCATION) }
            BuiltinRow("📦 Geocaches", state.builtinVisible[BuiltinLayer.GEOCACHES] != false, geocacheCount) { onToggleBuiltin(BuiltinLayer.GEOCACHES) }
            BuiltinRow("📅 Meetup events", state.builtinVisible[BuiltinLayer.MEETUP] != false, meetupCount) { onToggleBuiltin(BuiltinLayer.MEETUP) }

            if (state.layers.isNotEmpty()) {
                Spacer(Modifier.size(6.dp))
                Text("AGENT LAYERS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
                val groups = state.layers.groupBy { it.group }
                for ((g, ls) in groups) {
                    if (g.isNotEmpty()) {
                        val allOn = ls.all { state.layerVisible[it.slug] != false }
                        Row(Modifier.fillMaxWidth().clickable { onToggleGroup(g, !allOn) }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = allOn, onCheckedChange = { onToggleGroup(g, it) }, modifier = Modifier.size(28.dp))
                            Text(g, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 4.dp))
                        }
                    }
                    for (l in ls) {
                        Row(
                            Modifier.fillMaxWidth().clickable { onToggleLayer(l.slug) }.padding(start = if (g.isNotEmpty()) 16.dp else 0.dp, top = 1.dp, bottom = 1.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = state.layerVisible[l.slug] != false, onCheckedChange = { onToggleLayer(l.slug) }, modifier = Modifier.size(28.dp))
                            Text(l.name, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f).padding(start = 4.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${l.featureCount}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BuiltinRow(label: String, checked: Boolean, count: Int?, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onToggle() }.padding(vertical = 1.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = { onToggle() }, modifier = Modifier.size(28.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f).padding(start = 4.dp))
        if (count != null) Text("$count", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ---------------------------------------------------------------------- //
// geocaching.com credentials

@Composable
private fun CredentialsPanel(
    state: MapUiState,
    onClose: () -> Unit,
    onSubmit: suspend (username: String?, password: String?, cookie: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf("password") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var cookie by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    Surface(
        modifier = modifier.padding(top = 56.dp, start = 8.dp).widthIn(max = 320.dp),
        shape = RoundedCornerShape(8.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("geocaching.com", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            if (state.gcStatus?.loggedIn == true) {
                Text("Signed in as ${state.gcStatus.username}. Re-enter to switch.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                ModeTab("Password", mode == "password") { mode = "password" }
                ModeTab("Cookie", mode == "cookie") { mode = "cookie" }
            }
            if (mode == "password") {
                OutlinedTextField(value = username, onValueChange = { username = it }, placeholder = { Text("username or email") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp))
                OutlinedTextField(value = password, onValueChange = { password = it }, placeholder = { Text("password") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp))
                Text("If a CAPTCHA blocks login, switch to the Cookie tab and paste your gspkauth cookie from a logged-in browser.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
            } else {
                OutlinedTextField(value = cookie, onValueChange = { cookie = it }, placeholder = { Text("paste your gspkauth cookie value") }, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(vertical = 2.dp))
            }
            state.error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Color(0xFFFCA5A5), modifier = Modifier.padding(vertical = 2.dp)) }
            TextButton(
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            onSubmit(username.ifBlank { null }, password.ifBlank { null }, cookie.ifBlank { null })
                            onClose()
                        } catch (_: Exception) { /* error surfaces via state */ } finally { busy = false }
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Signing in…" else "Sign in") }
        }
    }
}

@Composable
private fun ModeTab(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(6.dp),
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}

// ---------------------------------------------------------------------- //
// Detail panels

@Composable
private fun CacheDetailPanel(cache: MapCache, onClose: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.padding(top = 8.dp, end = 8.dp).widthIn(max = 320.dp).heightIn(max = 520.dp),
        shape = RoundedCornerShape(8.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(cache.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                    Text("${cache.code} · ${cache.type}${if (cache.size.isNotBlank()) " · ${cache.size}" else ""}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                Text("D ${cache.difficulty}", style = MaterialTheme.typography.labelSmall)
                Text("T ${cache.terrain}", style = MaterialTheme.typography.labelSmall)
                Text("★ ${cache.favorites}", style = MaterialTheme.typography.labelSmall)
                if (cache.found) Text("found", style = MaterialTheme.typography.labelSmall, color = Color(0xFF4ADE80))
                if (cache.dnf) Text("DNF", style = MaterialTheme.typography.labelSmall, color = Color(0xFFF87171))
                if (cache.pmOnly) Text("premium", style = MaterialTheme.typography.labelSmall, color = Color(0xFFFBBF24))
            }
            if (cache.owner.isNotBlank()) {
                Text("by ${cache.owner}${if (cache.hidden.isNotBlank()) " · ${cache.hidden}" else ""}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
            }
            val d = cache.detail
            if (d == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                    Text("loading detail…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                if (d.hint.isNotBlank()) {
                    Text("Hint", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(d.hint, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 4.dp))
                }
                val enabledAttrs = d.attributes.filter { it.enabled }
                if (enabledAttrs.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (a in enabledAttrs) {
                            Surface(shape = RoundedCornerShape(4.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                                Text(a.label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                            }
                        }
                    }
                }
                if (d.logs.isNotEmpty()) {
                    Text("Recent logs", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    for (l in d.logs.take(8)) {
                        Column(Modifier.padding(top = 4.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(l.date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(l.type.replace("_", " "), style = MaterialTheme.typography.labelSmall, color = logColor(l.type))
                                Text("· ${l.author}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (l.text.isNotBlank()) {
                                Text(stripHtml(l.text), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
            val ctx = androidx.compose.ui.platform.LocalContext.current
            TextButton(onClick = { openUrl(ctx, "https://www.geocaching.com/geocache/${cache.code}") }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                Text("open on geocaching.com", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
            }
        }
    }
}

@Composable
private fun MeetupEventPanel(event: MeetupEvent, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val venueLine = listOf(event.venueName, event.venueCity).filter { it.isNotBlank() }.joinToString(", ")
    Surface(
        modifier = modifier.padding(top = 8.dp, end = 8.dp).widthIn(max = 320.dp).heightIn(max = 520.dp),
        shape = RoundedCornerShape(8.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(event.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                    if (event.groupName.isNotBlank()) Text(event.groupName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            Text(formatEventTime(event.dateTime), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (event.going > 0) Text("${event.going} going", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (event.eventType == "ONLINE") Text("online", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
                if (event.eventType == "HYBRID") Text("hybrid", style = MaterialTheme.typography.labelSmall, color = Color(0xFFFBBF24))
            }
            if (venueLine.isNotBlank()) {
                Text("$venueLine${if (event.venueAddress.isNotBlank()) " · ${event.venueAddress}" else ""}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
            }
            event.detail?.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 12, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = 4.dp))
            } ?: run {
                if (event.eventUrl.isNotBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                        Text("loading detail…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            val ctx = androidx.compose.ui.platform.LocalContext.current
            if (event.eventUrl.isNotBlank()) {
                TextButton(onClick = { openUrl(ctx, event.eventUrl) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Text("open on meetup.com", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// helpers

private fun openUrl(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
}

/** Colour a log entry by its type (mirrors logColor in MapTab.tsx). */
private fun logColor(type: String): Color = when (type) {
    "found_it", "attended", "webcam_photo_taken" -> Color(0xFF22C55E)
    "didnt_find_it" -> Color(0xFFEF4444)
    "needs_maintenance", "needs_archive", "owner_maintenance" -> Color(0xFFF59E0B)
    else -> Color(0xFF94A3B8)
}

/** Strip HTML tags from gc.com log fragments (`<p>…</p>`). */
fun stripHtml(s: String): String {
    if (s.isEmpty()) return ""
    return s
        .replace(Regex("</(p|div)>", RegexOption.IGNORE_CASE), "\n")
        .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
        .replace(Regex("<[^>]+>"), "")
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
}

/** ISO 8601 (with offset) → "Ddd Mmm D, HH:MM" in local time. */
fun formatEventTime(iso: String): String {
    if (iso.isBlank()) return ""
    return runCatching {
        val dt = java.time.OffsetDateTime.parse(iso)
        val local = dt.atZoneSameInstant(java.time.ZoneId.systemDefault())
        val fmt = java.time.format.DateTimeFormatter.ofPattern("EEE MMM d, HH:mm", java.util.Locale.getDefault())
        local.format(fmt)
    }.getOrDefault(iso)
}

/** Minimal MapLibre style JSON over CARTO's free dark raster tiles + demotiles
 *  glyphs (so agent-layer text labels render). Mirrors darkRasterStyle(). */
fun cartoDarkStyleJson(): String = """
{
  "version": 8,
  "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  "sources": {
    "carto": {
      "type": "raster",
      "tiles": [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"
      ],
      "tileSize": 256,
      "attribution": "© OpenStreetMap contributors © CARTO"
    }
  },
  "layers": [
    { "id": "bg", "type": "background", "paint": { "background-color": "#0a0a0a" } },
    { "id": "carto", "type": "raster", "source": "carto" }
  ]
}
""".trimIndent()
