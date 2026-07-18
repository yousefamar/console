package io.amar.console.ui.longtail

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.data.longtail.MapRepository
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapView
import org.maplibre.android.annotations.MarkerOptions

/**
 * Map pane: CARTO dark raster basemap (same keyless CDN the SPA uses) +
 * cached geocache/meetup pins from Room. Offline = pins without basemap,
 * matching the SPA's behaviour. v1 uses simple markers; the SPA's layer
 * system (agent layers, OwnTracks history) stays desktop.
 */
@Composable
fun MapScreen(repo: MapRepository) {
    val context = LocalContext.current
    remember { MapLibre.getInstance(context) }

    val mapView = remember { MapView(context) }

    DisposableEffect(Unit) {
        mapView.onStart()
        mapView.onResume()
        onDispose {
            mapView.onPause()
            mapView.onStop()
            mapView.onDestroy()
        }
    }

    LaunchedEffect(Unit) {
        repo.reconcile()
        val caches = repo.geocaches()
        val meetup = repo.upcomingMeetup()
        mapView.getMapAsync { map ->
            map.setStyle(cartoDarkStyleJson()) {
                // Reading-ish default; pins override attention anyway.
                map.cameraPosition = CameraPosition.Builder()
                    .target(LatLng(51.455, -0.97))
                    .zoom(10.0)
                    .build()
                for (c in caches) {
                    val lat = c.lat ?: continue
                    val lon = c.lon ?: continue
                    map.addMarker(MarkerOptions().position(LatLng(lat, lon)).title(c.name).snippet("${c.type} D${c.difficulty ?: "?"}/T${c.terrain ?: "?"}"))
                }
                for (e in meetup) {
                    val lat = e.lat ?: continue
                    val lon = e.lon ?: continue
                    map.addMarker(MarkerOptions().position(LatLng(lat, lon)).title("📅 ${e.title}").snippet(e.groupName ?: ""))
                }
            }
        }
    }

    AndroidView(modifier = Modifier.fillMaxSize(), factory = { mapView })
}

/** Minimal MapLibre style JSON over CARTO's free dark raster tiles —
 *  mirrors src/map/basemap-style.ts darkRasterStyle(). */
private fun cartoDarkStyleJson(): String = """
{
  "version": 8,
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
