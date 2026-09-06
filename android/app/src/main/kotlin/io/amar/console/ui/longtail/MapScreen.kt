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
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Directions
import androidx.compose.material.icons.filled.DirectionsBike
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.DirectionsTransit
import androidx.compose.material.icons.filled.DirectionsWalk
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.LocationSearching
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Navigation
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import io.amar.console.ui.theme.accents
import io.amar.console.ui.theme.isDark
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.data.longtail.BuiltinLayer
import io.amar.console.data.longtail.GPlace
import io.amar.console.data.longtail.GTravelMode
import io.amar.console.data.longtail.LatLon
import io.amar.console.data.longtail.fmtDistance
import io.amar.console.data.longtail.fmtDuration
import io.amar.console.data.longtail.fmtRating
import io.amar.console.data.longtail.gmapsDirUrl
import io.amar.console.data.longtail.placeTypeLabels
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
    // MapLibre requires the full lifecycle from onCreate — without it the GL
    // surface never initialises and the pane renders as a white rectangle.
    val mapView = remember { MapView(context).apply { onCreate(null) } }
    val renderer = remember { MapRenderer() }
    val scope = rememberCoroutineScope()
    val state by repo.state.collectAsState()

    var styleReady by remember { mutableStateOf(false) }
    val centeredRef = remember { mutableStateOf(false) }
    val fittedSlugs = remember { mutableStateOf(setOf<String>()) }

    var showLayers by remember { mutableStateOf(false) }
    var showCreds by remember { mutableStateOf(false) }
    // Basemap light/dark, persisted — dark tiles are unreadable in sunlight.
    val mapPrefs = remember { context.getSharedPreferences("console.map", android.content.Context.MODE_PRIVATE) }
    // Unset → follow the app theme; the map's own toggle still wins once used.
    val themeDark = MaterialTheme.isDark
    var darkMap by remember { mutableStateOf(mapPrefs.getBoolean("darkMap", themeDark)) }
    // Long-pressed spot pending a "navigate here" confirmation.
    var navSpot by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    // Tapped agent-layer feature (e.g. a where-to-move town) → info panel.
    var featureInfo by remember { mutableStateOf<AgentFeatureInfo?>(null) }
    // Google Maps place search (toolbar 🔍 chip toggles the bar).
    var showSearch by remember { mutableStateOf(false) }
    // The live MapLibreMap once ready — read synchronously for the camera
    // centre (search bias, directions origin fallback).
    var mapObj by remember { mutableStateOf<org.maplibre.android.maps.MapLibreMap?>(null) }
    fun mapCentre(): LatLon? = mapObj?.cameraPosition?.target?.let { LatLon(it.latitude, it.longitude) }

    fun setMapStyle(dark: Boolean) {
        darkMap = dark
        mapPrefs.edit().putBoolean("darkMap", dark).apply()
        styleReady = false
        mapView.getMapAsync { map ->
            map.setStyle(org.maplibre.android.maps.Style.Builder().fromUri(basemapStyleUrl(dark))) { style ->
                // setStyle wipes all sources/layers/images — full re-attach.
                renderer.detach()
                renderer.attach(map, style)
                renderer.apply(repo.state.value)
                styleReady = true
            }
        }
    }

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
            mapObj = map
            map.cameraPosition = CameraPosition.Builder().target(LatLng(54.0, -2.0)).zoom(5.0).build()
            map.uiSettings.isCompassEnabled = false
            map.setStyle(org.maplibre.android.maps.Style.Builder().fromUri(basemapStyleUrl(darkMap))) { style ->
                renderer.attach(map, style)
                renderer.apply(repo.state.value)
                styleReady = true
            }
            // Tap → hit-test the pin/agent layers (topmost wins).
            map.addOnMapClickListener { latLng ->
                val pt: PointF = map.projection.toScreenLocation(latLng)
                val gm = map.queryRenderedFeatures(pt, "gmaps-pins")
                val gc = map.queryRenderedFeatures(pt, "gc-pins")
                val mu = map.queryRenderedFeatures(pt, "meetup-pins")
                val route = if (repo.state.value.gmapsRoutes.size > 1) map.queryRenderedFeatures(pt, "gmaps-routes") else emptyList()
                when {
                    gm.isNotEmpty() -> {
                        gm[0].getStringProperty("id")?.let { repo.selectPlace(it) }
                    }
                    gc.isNotEmpty() -> {
                        val code = gc[0].getStringProperty("code")
                        if (code != null) scope.launch { repo.selectCache(code) }
                    }
                    mu.isNotEmpty() -> {
                        val id = mu[0].getStringProperty("id")
                        if (id != null) scope.launch { repo.selectEvent(id) }
                    }
                    route.isNotEmpty() -> {
                        // Tapping an alternate route selects it (SPA gmaps-routes click).
                        runCatching { route[0].getNumberProperty("idx")?.toInt() }.getOrNull()?.let { repo.selectRoute(it) }
                    }
                    else -> {
                        // Agent layers (towns, airports, flight arcs…): query
                        // the point sublayers of every visible layer; a hit
                        // opens an info panel from the feature's properties
                        // (the SPA popup, driven by the layer's popup[] list).
                        val st = repo.state.value
                        outer@ for (l in st.layers) {
                            if (st.layerVisible[l.slug] == false) continue
                            val ids = listOf("layer:${l.slug}:circle", "layer:${l.slug}:symbol", "layer:${l.slug}:label", "layer:${l.slug}:fill")
                            for (layerId in ids) {
                                val fs = runCatching { map.queryRenderedFeatures(pt, layerId) }.getOrDefault(emptyList())
                                if (fs.isNotEmpty()) {
                                    featureInfo = agentFeatureInfo(l, fs[0], latLng.latitude, latLng.longitude)
                                    break@outer
                                }
                            }
                        }
                    }
                }
                true
            }
            // Long-press ANY spot → hand the coords to Google Maps / whatever
            // handles geo: URIs ("open with" chooser). Navigation escape hatch.
            map.addOnMapLongClickListener { latLng ->
                navSpot = latLng.latitude to latLng.longitude
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

    // Search pick / pin tap → ease onto the place. Keyed on the id so tapping
    // the same pin twice doesn't re-fly.
    LaunchedEffect(state.gmapsSelectedPlaceId, styleReady) {
        if (!styleReady) return@LaunchedEffect
        val p = state.gmapsResults.find { it.id == state.gmapsSelectedPlaceId } ?: return@LaunchedEffect
        renderer.flyTo(p.lat, p.lon, zoom = if (state.gmapsResults.size > 1) 13.0 else 15.0)
    }
    // A fresh set of routes → frame the chosen one (selection changes alone don't re-fit).
    LaunchedEffect(state.gmapsRoutes, styleReady) {
        if (!styleReady) return@LaunchedEffect
        val r = state.gmapsRoutes.getOrNull(state.gmapsSelectedRoute) ?: return@LaunchedEffect
        routeBbox(r)?.let { renderer.fitBounds(it) }
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
            onCustomRange = { from, to -> scope.launch { repo.loadHistory(from, to) } },
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
            darkMap = darkMap,
            onToggleDark = { setMapStyle(!darkMap) },
            searchActive = showSearch,
            onToggleSearch = {
                if (showSearch) repo.clearGmapsSearch()
                showSearch = !showSearch
            },
            searchBar = if (showSearch) ({
                GmapsSearchBar(
                    state = state,
                    onAutocomplete = { q -> scope.launch { repo.autocompleteGmaps(q, mapCentre()) } },
                    onSearch = { q -> scope.launch { repo.searchGmaps(q, mapCentre()) } },
                    onPick = { id -> scope.launch { repo.pickSuggestion(id) } },
                    onSelectResult = { id -> repo.selectPlace(id) },
                    onClear = { repo.clearGmapsSearch() },
                    onDismissSuggestions = { repo.clearGmapsSuggestions() },
                )
            }) else null,
        )

        // Long-press target → confirm chip (bottom-center, above attribution).
        navSpot?.let { (lat, lon) ->
            Surface(
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp),
                shape = RoundedCornerShape(10.dp),
                color = MaterialTheme.colorScheme.inverseSurface,
                tonalElevation = 4.dp,
            ) {
                Row(
                    Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        "%.5f, %.5f".format(lat, lon),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                    )
                    Text(
                        "NAVIGATE", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.inversePrimary,
                        modifier = Modifier.clickable { openInMaps(context, lat, lon); navSpot = null },
                    )
                    Icon(
                        Icons.Filled.Close, "Dismiss", tint = MaterialTheme.colorScheme.inverseOnSurface,
                        modifier = Modifier.size(16.dp).clickable { navSpot = null },
                    )
                }
            }
        }

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
        val selectedPlace = state.gmapsResults.find { it.id == state.gmapsSelectedPlaceId }
        if (selectedPlace != null) {
            PlaceDetailPanel(
                place = selectedPlace,
                state = state,
                onClose = { repo.selectPlace(null) },
                onDirections = { mode ->
                    // Origin = my latest OwnTracks fix (the phone's own report),
                    // else wherever the map is looking.
                    val from = state.current.firstOrNull()?.let { LatLon(it.lat, it.lon) } ?: mapCentre()
                    if (from != null) scope.launch { repo.getDirections(from, selectedPlace, mode) }
                },
                onSelectRoute = { repo.selectRoute(it) },
                onClearDirections = { repo.clearDirections() },
                onClearError = { repo.clearGmapsError() },
                // Bottom card (Google Maps' own shape) — keeps clear of the
                // toolbar + search dropdown at the top.
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        } else if (selectedCache != null) {
            CacheDetailPanel(selectedCache, onClose = { scope.launch { repo.selectCache(null) } }, modifier = Modifier.align(Alignment.TopEnd))
        } else if (selectedEvent != null) {
            MeetupEventPanel(selectedEvent, onClose = { scope.launch { repo.selectEvent(null) } }, modifier = Modifier.align(Alignment.TopEnd))
        } else featureInfo?.let { info ->
            AgentFeaturePanel(
                info,
                onClose = { featureInfo = null },
                onDismiss = { searchId, listingId ->
                    scope.launch {
                        runCatching { repo.dismissListing(searchId, listingId) }
                        featureInfo = null
                    }
                },
                modifier = Modifier.align(Alignment.TopEnd),
            )
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
    onCustomRange: (Long, Long) -> Unit,
    onDevice: (String) -> Unit,
    onFlyToMe: () -> Unit,
    onFetchHere: () -> Unit,
    onFetchMeetupHere: () -> Unit,
    onMeetupDays: (Int) -> Unit,
    darkMap: Boolean,
    onToggleDark: () -> Unit,
    searchActive: Boolean,
    onToggleSearch: () -> Unit,
    /** The Google Maps search bar, rendered under the chip row while open. */
    searchBar: (@Composable () -> Unit)?,
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

            // Google Maps place search (Yousef's mobile ask: find places, hand
            // off to Google Maps for navigation).
            ToolbarChip(onClick = onToggleSearch) {
                Icon(
                    if (searchActive) Icons.Filled.Close else Icons.Filled.Search,
                    if (searchActive) "Close search" else "Search places",
                    modifier = Modifier.size(15.dp),
                    tint = if (searchActive) MaterialTheme.colorScheme.primary else androidx.compose.material3.LocalContentColor.current,
                )
            }

            // Layers button — total count = agent layers + 3 built-ins.
            ToolbarChip(onClick = onToggleLayers) {
                Icon(Icons.Filled.Layers, "Map layers", modifier = Modifier.size(15.dp))
                Text("${state.layers.size + 3}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // Light/dark basemap (sunlight readability).
            ToolbarChip(onClick = onToggleDark) {
                Icon(
                    if (darkMap) Icons.Filled.LightMode else Icons.Filled.DarkMode,
                    if (darkMap) "Switch to light map" else "Switch to dark map",
                    modifier = Modifier.size(15.dp),
                )
            }

            // Location cluster (only while the Location built-in is on).
            if (state.builtinVisible[BuiltinLayer.LOCATION] != false) {
                LocationRangeChip(state, onRangeDays, onCustomRange, onDevice)
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
        searchBar?.invoke()
        state.error?.let { err ->
            Text(
                err,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.15f))
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
private fun LocationRangeChip(state: MapUiState, onRangeDays: (Long) -> Unit, onCustomRange: (Long, Long) -> Unit, onDevice: (String) -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var open by remember { mutableStateOf(false) }
    var devOpen by remember { mutableStateOf(false) }
    var custom by remember { mutableStateOf(false) }
    val ranges = listOf(1L to "Last 24h", 2L to "Last 48h", 7L to "Last 7 days", 30L to "Last 30 days", 90L to "Last 90 days", 365L to "Last year")

    // Custom range: pick from-date, then to-date; each pick reloads history.
    if (custom) {
        custom = false
        pickDate(ctx, state.rangeFrom) { fromMs ->
            pickDate(ctx, state.rangeTo) { toMs -> onCustomRange(fromMs, toMs) }
        }
    }

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
                    DropdownMenuItem(text = { Text("Custom…") }, onClick = { open = false; custom = true })
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
            state.error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 2.dp)) }
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
                if (cache.found) Text("found", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.green)
                if (cache.dnf) Text("DNF", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.red)
                if (cache.pmOnly) Text("premium", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.amber)
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { openUrl(ctx, "https://www.geocaching.com/geocache/${cache.code}") }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Text("open on geocaching.com", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                }
                if (cache.lat != null && cache.lon != null) {
                    TextButton(onClick = { openInMaps(ctx, cache.lat!!, cache.lon!!, cache.name) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Icon(Icons.Filled.Directions, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.accents.blue)
                        Spacer(Modifier.size(4.dp))
                        Text("navigate", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                    }
                }
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
                if (event.eventType == "ONLINE") Text("online", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                if (event.eventType == "HYBRID") Text("hybrid", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.amber)
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (event.eventUrl.isNotBlank()) {
                    TextButton(onClick = { openUrl(ctx, event.eventUrl) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Text("open on meetup.com", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                    }
                }
                if (event.lat != null && event.lon != null) {
                    TextButton(onClick = { openInMaps(ctx, event.lat!!, event.lon!!, event.venueName.ifBlank { event.title }) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Icon(Icons.Filled.Directions, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.accents.blue)
                        Spacer(Modifier.size(4.dp))
                        Text("navigate", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Google Maps search + place detail (SPA GmapsPanel / PlaceDetailPanel parity)

/**
 * Search box under the toolbar: type-ahead via /gmaps/autocomplete (250 ms
 * debounce, ≥2 chars, one billing session per run), IME Search → free-text
 * /gmaps/search. The dropdown shows suggestions while typing, else the multi-
 * result list after a text search. Not configured → a hint, never an error.
 */
@Composable
private fun GmapsSearchBar(
    state: MapUiState,
    onAutocomplete: (String) -> Unit,
    onSearch: (String) -> Unit,
    onPick: (placeId: String) -> Unit,
    onSelectResult: (placeId: String) -> Unit,
    onClear: () -> Unit,
    onDismissSuggestions: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var showResults by remember { mutableStateOf(false) }
    // A query set BY CODE (pick → place name) must not re-trigger type-ahead,
    // or the dropdown reopens with suggestions for the place just picked.
    var programmatic by remember { mutableStateOf<String?>(null) }
    val focusRequester = remember { androidx.compose.ui.focus.FocusRequester() }
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    val configured = state.gmapsConfigured

    LaunchedEffect(Unit) { if (configured != false) runCatching { focusRequester.requestFocus() } }
    // Debounced type-ahead — every keystroke restarts the 250 ms wait.
    LaunchedEffect(query) {
        if (query == programmatic) return@LaunchedEffect
        if (query.trim().length < 2) { onDismissSuggestions(); return@LaunchedEffect }
        kotlinx.coroutines.delay(250)
        onAutocomplete(query)
    }
    // A pick renames the box to the place (SPA gmapsQuery = place.name).
    LaunchedEffect(state.gmapsSelectedPlaceId) {
        if (state.gmapsResults.size == 1) state.gmapsResults.firstOrNull()?.let { if (query != it.name) { programmatic = it.name; query = it.name } }
    }

    Column(Modifier.fillMaxWidth()) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
            tonalElevation = 2.dp,
        ) {
            if (configured == false) {
                Text(
                    "Google Maps search isn't configured on the hub — set a Maps Platform key with `con map gmaps credentials --key …`.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                )
                return@Surface
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.Search, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) {
                        Text("Search Google Maps", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    androidx.compose.foundation.text.BasicTextField(
                        value = query,
                        onValueChange = { programmatic = null; query = it; showResults = false },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = {
                            if (query.isNotBlank()) { onSearch(query); showResults = true; focusManager.clearFocus() }
                        }),
                        modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
                    )
                }
                if (state.gmapsSearching || state.gmapsSuggesting) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                } else if (query.isNotEmpty() || state.gmapsResults.isNotEmpty()) {
                    Icon(
                        Icons.Filled.Close, "Clear search", modifier = Modifier.size(16.dp).clickable { query = ""; showResults = false; onClear() },
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        val suggestions = state.gmapsSuggestions
        val results = if (showResults && state.gmapsResults.size > 1) state.gmapsResults else emptyList()
        if (suggestions.isNotEmpty() || results.isNotEmpty()) {
            Surface(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).heightIn(max = 280.dp),
                shape = RoundedCornerShape(8.dp),
                tonalElevation = 4.dp,
                shadowElevation = 6.dp,
            ) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    for (s in suggestions) {
                        Column(
                            Modifier.fillMaxWidth().clickable {
                                programmatic = s.mainText; query = s.mainText; showResults = false; focusManager.clearFocus(); onPick(s.placeId)
                            }.padding(horizontal = 12.dp, vertical = 8.dp),
                        ) {
                            Text(s.mainText, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            s.secondaryText?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                    for (p in results) {
                        val selected = p.id == state.gmapsSelectedPlaceId
                        Column(
                            Modifier.fillMaxWidth()
                                .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                                .clickable { showResults = false; focusManager.clearFocus(); onSelectResult(p.id) }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        ) {
                            Text(p.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val sub = listOfNotNull(fmtRating(p.rating, p.userRatingCount), p.address).joinToString(" · ")
                            if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
        // Directions errors render inside the place card instead.
        state.gmapsError?.takeIf { state.gmapsRouteTo == null }?.let { err ->
            Text(
                err,
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFFFCA5A5),
                modifier = Modifier.padding(top = 4.dp).clip(RoundedCornerShape(6.dp)).background(Color(0x33EF4444)).padding(horizontal = 8.dp, vertical = 4.dp),
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private val TRAVEL_MODE_ICONS = listOf(
    GTravelMode.DRIVE to Icons.Filled.DirectionsCar,
    GTravelMode.WALK to Icons.Filled.DirectionsWalk,
    GTravelMode.BICYCLE to Icons.Filled.DirectionsBike,
    GTravelMode.TRANSIT to Icons.Filled.DirectionsTransit,
)

/**
 * Bottom card for the selected Google place: name / address / rating / types,
 * then two hand-offs — "navigate" = the geo: "Open with…" chooser (any maps
 * app), "Google Maps" = the place's own deep link — and in-app directions
 * (hub Routes API): travel-mode toggle, selectable alternatives drawn on the
 * map, "open route in Google Maps" carrying origin + mode.
 */
@Composable
private fun PlaceDetailPanel(
    place: GPlace,
    state: MapUiState,
    onClose: () -> Unit,
    onDirections: (GTravelMode) -> Unit,
    onSelectRoute: (Int) -> Unit,
    onClearDirections: () -> Unit,
    onClearError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val routed = state.gmapsRouteTo?.id == place.id
    val routes = if (routed) state.gmapsRoutes else emptyList()
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp).heightIn(max = 420.dp),
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(place.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                    place.address?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            val rating = fmtRating(place.rating, place.userRatingCount)
            val types = placeTypeLabels(place.types)
            if (rating != null || types.isNotEmpty()) {
                Row(
                    Modifier.padding(top = 4.dp).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    rating?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Color(0xFFFBBF24)) }
                    for (t in types) {
                        Surface(shape = RoundedCornerShape(4.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                            Text(t, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                        }
                    }
                }
            }
            // Hand-offs.
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { openInMaps(ctx, place.lat, place.lon, place.name) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Icon(Icons.Filled.Directions, null, modifier = Modifier.size(14.dp), tint = Color(0xFF60A5FA))
                    Spacer(Modifier.size(4.dp))
                    Text("navigate", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
                }
                TextButton(
                    onClick = { openUrl(ctx, place.googleMapsUri ?: gmapsDirUrl(null, place, state.gmapsMode)) },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                ) {
                    Icon(Icons.Filled.OpenInNew, null, modifier = Modifier.size(14.dp), tint = Color(0xFF60A5FA))
                    Spacer(Modifier.size(4.dp))
                    Text("Google Maps", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
                }
                Spacer(Modifier.weight(1f))
                if (!routed) {
                    TextButton(onClick = { onDirections(state.gmapsMode) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Filled.Navigation, null, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("Directions", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            if (routed) {
                HorizontalDivider(Modifier.padding(vertical = 6.dp), thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (state.current.isNotEmpty()) "from my location" else "from map centre",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f),
                    )
                    // Travel mode — switching re-routes immediately.
                    for ((mode, icon) in TRAVEL_MODE_ICONS) {
                        val sel = mode == state.gmapsMode
                        Surface(
                            onClick = { if (!sel) onDirections(mode) },
                            shape = RoundedCornerShape(6.dp),
                            color = if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.padding(start = 4.dp),
                        ) {
                            Icon(
                                icon, mode.label, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp).size(16.dp),
                                tint = if (sel) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    IconButton(onClick = onClearDirections, modifier = Modifier.padding(start = 4.dp).size(24.dp)) {
                        Icon(Icons.Filled.Close, "Clear directions", modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (state.gmapsRouting) {
                    Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                        Text("routing…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                for ((i, r) in routes.withIndex()) {
                    val sel = i == state.gmapsSelectedRoute
                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (sel) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                            .clickable { onSelectRoute(i) }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(width = 3.dp, height = 28.dp).clip(RoundedCornerShape(2.dp)).background(if (sel) Color(0xFF4285F4) else Color(0xFF9CA3AF)))
                        Spacer(Modifier.size(8.dp))
                        Column(Modifier.weight(1f)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(fmtDuration(r.durationSec), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                                Text(fmtDistance(r.distanceMeters), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            r.description?.let { Text("via $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
                state.gmapsRouteFrom?.let { from ->
                    TextButton(
                        onClick = { openUrl(ctx, gmapsDirUrl(from, place, state.gmapsMode)) },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                        modifier = Modifier.padding(top = 4.dp),
                    ) {
                        Icon(Icons.Filled.OpenInNew, null, modifier = Modifier.size(14.dp), tint = Color(0xFF60A5FA))
                        Spacer(Modifier.size(4.dp))
                        Text("open route in Google Maps", style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA))
                    }
                }
                state.gmapsError?.let { err ->
                    Text(
                        err, style = MaterialTheme.typography.labelSmall, color = Color(0xFFFCA5A5),
                        modifier = Modifier.padding(top = 4.dp).clickable { onClearError() }, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Agent-layer feature info (SPA popup parity)

// Keys rendered specially or used as plumbing, not as generic field rows —
// mirrors the SPA's PANEL_SPECIAL in MapTab.tsx's LayerFeaturePanel.
private val FIELD_SPECIAL = setOf("name", "title", "url", "listingId", "searchId")

data class AgentFeatureInfo(
    val layerName: String,
    val title: String,
    /** label → value rows, ordered by the layer's popup[] list (or all
     *  non-underscore properties when the layer defines none). */
    val fields: List<Pair<String, String>>,
    val lat: Double,
    val lon: Double,
    /** External link (e.g. the portal listing page) — rendered as a tappable
     *  "open" row instead of a plain-text field. */
    val url: String? = null,
    /** listingId + searchId, present together only for property pins — drives
     *  the "not interested" dismiss action. */
    val listingId: String? = null,
    val searchId: String? = null,
)

/** Build the info panel model from a tapped feature's properties. Mirrors the
 *  SPA popup: layer meta popup[] picks + orders + labels the fields; without
 *  it, fall back to every property not starting with '_'. */
fun agentFeatureInfo(
    layer: io.amar.console.data.longtail.MapLayerMeta,
    feature: org.maplibre.geojson.Feature,
    tapLat: Double,
    tapLon: Double,
): AgentFeatureInfo {
    val props = feature.properties()
    fun prop(k: String): String? = props?.get(k)?.let { v ->
        if (v.isJsonPrimitive) v.asJsonPrimitive.asString else v.toString()
    }?.takeIf { it.isNotBlank() && it != "null" }

    val fields = if (layer.style.popup.isNotEmpty()) {
        layer.style.popup.mapNotNull { (key, label) -> prop(key)?.let { label.ifBlank { key } to it } }
    } else {
        props?.keySet().orEmpty().filter { !it.startsWith("_") }
            .mapNotNull { k -> prop(k)?.let { k to it } }
    }
    val title = prop("name") ?: prop("title") ?: prop("_label") ?: layer.name
    // Prefer the feature's own point coords (navigate target); fall back to tap.
    val geom = feature.geometry()
    val (lat, lon) = if (geom is org.maplibre.geojson.Point) geom.latitude() to geom.longitude() else tapLat to tapLon
    val listingId = prop("listingId")
    val searchId = prop("searchId")
    return AgentFeatureInfo(
        layerName = layer.name,
        title = title,
        fields = fields.filter { (k, v) -> k !in FIELD_SPECIAL && (k != "name" && k != "title" || v != title) },
        lat = lat,
        lon = lon,
        url = prop("url"),
        listingId = listingId,
        searchId = searchId,
    )
}

@Composable
private fun AgentFeaturePanel(
    info: AgentFeatureInfo,
    onClose: () -> Unit,
    onDismiss: (searchId: String, listingId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var dismissing by remember(info.listingId) { mutableStateOf(false) }
    Surface(
        modifier = modifier.padding(top = 8.dp, end = 8.dp).widthIn(max = 320.dp).heightIn(max = 480.dp),
        shape = RoundedCornerShape(8.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(info.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                    Text(info.layerName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(16.dp)) }
            }
            for ((label, value) in info.fields) {
                Row(Modifier.padding(top = 3.dp)) {
                    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.widthIn(min = 84.dp))
                    Text(value, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { openInMaps(ctx, info.lat, info.lon, info.title) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Icon(Icons.Filled.Directions, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.accents.blue)
                    Spacer(Modifier.size(4.dp))
                    Text("navigate", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                }
                if (!info.url.isNullOrEmpty()) {
                    TextButton(onClick = { openUrl(ctx, info.url) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Icon(Icons.Filled.OpenInNew, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.accents.blue)
                        Spacer(Modifier.size(4.dp))
                        Text("open", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.accents.blue)
                    }
                }
            }
            if (!info.listingId.isNullOrEmpty() && !info.searchId.isNullOrEmpty()) {
                TextButton(
                    onClick = {
                        if (dismissing) return@TextButton
                        dismissing = true
                        onDismiss(info.searchId, info.listingId)
                    },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    Icon(Icons.Filled.Close, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.size(4.dp))
                    Text(
                        if (dismissing) "hiding…" else "not interested",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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

/** Hand coordinates to an external maps app via a geo: URI, always through a
 *  chooser ("Open with…") so Google Maps / Organic Maps / etc. are pickable.
 *  Fallback: no geo: handler at all → Google Maps web URL in the browser. */
fun openInMaps(ctx: android.content.Context, lat: Double, lon: Double, label: String? = null) {
    val q = if (label != null) {
        "$lat,$lon(${android.net.Uri.encode(label)})"
    } else "$lat,$lon"
    val geo = android.content.Intent(
        android.content.Intent.ACTION_VIEW,
        android.net.Uri.parse("geo:$lat,$lon?q=$q"),
    )
    val opened = runCatching {
        ctx.startActivity(android.content.Intent.createChooser(geo, "Open location with"))
    }.isSuccess
    if (!opened) openUrl(ctx, "https://www.google.com/maps/search/?api=1&query=$lat,$lon")
}

/** Native date picker seeded from [initialMs]; calls back with the chosen day's
 *  epoch-ms (local midnight). Used by the custom history range. */
private fun pickDate(ctx: android.content.Context, initialMs: Long, onPicked: (Long) -> Unit) {
    val cal = java.util.Calendar.getInstance().apply { timeInMillis = initialMs }
    android.app.DatePickerDialog(
        ctx,
        { _, year, month, day ->
            val c = java.util.Calendar.getInstance().apply {
                clear(); set(year, month, day, 0, 0, 0)
            }
            onPicked(c.timeInMillis)
        },
        cal.get(java.util.Calendar.YEAR),
        cal.get(java.util.Calendar.MONTH),
        cal.get(java.util.Calendar.DAY_OF_MONTH),
    ).show()
}

/** Colour a log entry by its type (mirrors logColor in MapTab.tsx). */
@Composable
private fun logColor(type: String): Color = when (type) {
    "found_it", "attended", "webcam_photo_taken" -> MaterialTheme.accents.green
    "didnt_find_it" -> MaterialTheme.accents.red
    "needs_maintenance", "needs_archive", "owner_maintenance" -> MaterialTheme.accents.amber
    else -> MaterialTheme.colorScheme.onSurfaceVariant
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

/** OpenFreeMap vector style URL (keyless, no-limits) — mirrors the SPA's
 *  basemapStyleUrl(). CARTO's raster CDN was dropped (^zany-koi): it now
 *  requires an API key. [dark] picks OFM dark vs Positron — outdoors in
 *  sunlight the dark tiles are unreadable, so the toolbar exposes a
 *  persisted light/dark toggle. The style ships its own glyphs (Noto Sans
 *  Regular), so agent-layer text labels keep rendering. */
fun basemapStyleUrl(dark: Boolean): String =
    if (dark) "https://tiles.openfreemap.org/styles/dark"
    else "https://tiles.openfreemap.org/styles/positron"
