package io.amar.console.data.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** shortCwd / isStrayCwd — SPA parity with src/utils/cwd.ts (^spry-seal, refined e4779bf9). */
class CwdDisplayTest {
    private val home = "/home/amar/sync/brain/root/projects/demovid"

    @Test fun `shortCwd collapses a Linux home prefix`() {
        assertEquals("~/sync/brain/root/projects/demovid", shortCwd(home))
        assertEquals("~", shortCwd("/home/amar"))
        assertEquals("/opt/hub", shortCwd("/opt/hub"))
        assertEquals("/homer/amar", shortCwd("/homer/amar"))
    }

    @Test fun `stray when the session runs outside its space home`() {
        assertTrue(isStrayCwd("/home/amar/proj/code/console/server", home))
    }

    @Test fun `not stray for the space home with or without trailing slash`() {
        assertFalse(isStrayCwd(home, home))
        assertFalse(isStrayCwd("$home/", home))
        assertFalse(isStrayCwd(home, "$home/"))
    }

    @Test fun `a subdir of the space home is NOT a stray`() {
        // AL runs from projects/al/workspace under the al project (e4779bf9).
        assertFalse(isStrayCwd("$home/workspace", home))
        assertFalse(isStrayCwd("$home/repo/server/", home))
    }

    @Test fun `a sibling dir sharing the home as a string prefix IS a stray`() {
        assertTrue(isStrayCwd("$home-archive", home))
        assertTrue(isStrayCwd("${home}2/x", home))
    }

    @Test fun `never stray when either side is unknown`() {
        assertFalse(isStrayCwd(null, home))
        assertFalse(isStrayCwd(home, null))
        assertFalse(isStrayCwd("", home))
    }
}
