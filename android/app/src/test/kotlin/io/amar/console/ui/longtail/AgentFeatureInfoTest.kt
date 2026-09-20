package io.amar.console.ui.longtail

import io.amar.console.data.longtail.MapLayerMeta
import io.amar.console.data.longtail.MapLayerStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.maplibre.geojson.Feature

class AgentFeatureInfoTest {

    // The property layer's meta as the hub writes it (server/src/property/sync.ts updateKindLayer).
    private val propertyLayer = MapLayerMeta(
        slug = "property/house", group = "property", name = "house", geometryTypes = listOf("Point"), featureCount = 2, bbox = null,
        style = MapLayerStyle(
            color = "#f97316", size = 5.0,
            popup = listOf("price", "address", "beds", "area", "plot", "condition", "access", "listed", "country", "portal", "alsoOn", "airport", "highStreet", "url").map { it to "" },
        ),
        fit = false, updatedAt = 0L, updatedBy = "property",
    )

    private fun pin(props: String) = Feature.fromJson("""{"type":"Feature","geometry":{"type":"Point","coordinates":[-1.03,51.45]},"properties":$props}""")

    @Test
    fun `the pin's price field is the hub's label, qualifier and auction guide included`() {
        // priceLabel() on the hub already folds the qualifier / guide into `price`; the popup is field-driven, so it shows verbatim.
        val guide = agentFeatureInfo(propertyLayer, pin("""{"price":"guide £220,000","address":"14 Tyle Road, Tilehurst","beds":3,"country":"UK","portal":"rightmove","url":"https://www.rightmove.co.uk/properties/92428200","listingId":"92428200","searchId":"ps_uk","_icon":"🏠"}"""), 0.0, 0.0)
        assertEquals(listOf("price" to "guide £220,000", "address" to "14 Tyle Road, Tilehurst", "beds" to "3", "country" to "UK", "portal" to "rightmove"), guide.fields)
        assertEquals("https://www.rightmove.co.uk/properties/92428200", guide.url)
        assertEquals("92428200", guide.listingId)
        assertEquals("ps_uk", guide.searchId)
        assertNull(guide.review)
        assertEquals(51.45, guide.lat, 1e-9)
        assertEquals(-1.03, guide.lon, 1e-9)

        val floor = agentFeatureInfo(propertyLayer, pin("""{"price":"offers over £390,000","address":"17 Hamilton Park","listingId":"92242653","searchId":"ps_gold"}"""), 0.0, 0.0)
        assertEquals("offers over £390,000", floor.fields.first { it.first == "price" }.second)

        // Price on request: the hub omits the field and the popup skips it — never a "null" row.
        val poa = agentFeatureInfo(propertyLayer, pin("""{"price":null,"address":"Auf Anfrage, Varel","listingId":"1","searchId":"ps_de"}"""), 0.0, 0.0)
        assertEquals(listOf("address" to "Auf Anfrage, Varel"), poa.fields)
    }
}
