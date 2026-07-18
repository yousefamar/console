package io.amar.console.sync

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReconcilerTest {

    @Test
    fun `coalesces a burst of triggers into one run`() = runTest {
        var runs = 0
        val r = Reconciler(this, debounceMs = 150) { runs++ }
        r.trigger(); r.trigger(); r.trigger()
        advanceUntilIdle()
        assertEquals(1, runs)
    }

    @Test
    fun `separate bursts run separately`() = runTest {
        var runs = 0
        val r = Reconciler(this, debounceMs = 150) { runs++ }
        r.trigger()
        advanceUntilIdle()
        r.trigger()
        advanceUntilIdle()
        assertEquals(2, runs)
    }

    @Test
    fun `trigger during a run sets dirty and re-runs once`() = runTest {
        var runs = 0
        val firstRunStarted = CompletableDeferred<Unit>()
        val releaseFirstRun = CompletableDeferred<Unit>()
        val r = Reconciler(this, debounceMs = 10) {
            runs++
            if (runs == 1) {
                firstRunStarted.complete(Unit)
                releaseFirstRun.await()
            }
        }
        r.trigger()
        advanceTimeBy(20) // debounce fires, run 1 starts and blocks
        firstRunStarted.await()
        // Three triggers while running — must collapse to ONE follow-up run.
        r.trigger(); r.trigger(); r.trigger()
        advanceTimeBy(20)
        releaseFirstRun.complete(Unit)
        advanceUntilIdle()
        assertEquals(2, runs)
    }

    @Test
    fun `an action that throws does not break subsequent runs`() = runTest {
        var runs = 0
        val r = Reconciler(this, debounceMs = 10) {
            runs++
            if (runs == 1) throw RuntimeException("boom")
        }
        r.trigger()
        advanceUntilIdle()
        r.trigger()
        advanceUntilIdle()
        assertEquals(2, runs)
    }
}
