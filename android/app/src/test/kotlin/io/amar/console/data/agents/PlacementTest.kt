package io.amar.console.data.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** placement → glyph kind / chip — SPA parity with SpacesTab.tsx + AgentSessionView.tsx (83157d29, baf9d507). */
class PlacementTest {
    @Test fun `only forge is remote — null and local are not`() {
        assertTrue(isRemotePlacement("forge"))
        assertFalse(isRemotePlacement("local"))
        assertFalse(isRemotePlacement(null))
        assertFalse(isRemotePlacement(""))
    }

    @Test fun `cloud wins the glyph slot on both lineage axes`() {
        assertEquals(SessionGlyph.BOT, sessionGlyph(null, isFork = false))
        assertEquals(SessionGlyph.BRANCH, sessionGlyph("local", isFork = true))
        assertEquals(SessionGlyph.BOT_CLOUD, sessionGlyph("forge", isFork = false))
        assertEquals(SessionGlyph.BRANCH_CLOUD, sessionGlyph("forge", isFork = true))
    }

    @Test fun `chip names forge and the tunnelled dev port`() {
        assertNull(placementChip(null, null))
        assertNull(placementChip("local", 5174))
        assertEquals("forge", placementChip("forge", null))
        assertEquals("forge:5174", placementChip("forge", 5174))
    }
}
