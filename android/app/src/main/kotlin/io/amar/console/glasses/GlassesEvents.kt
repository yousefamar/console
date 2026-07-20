package io.amar.console.glasses

import io.amar.console.core.DebugAgent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Native port of the SPA's `src/glasses/events.ts` — semantic classification of
 * inbound `0xF5` touchbar / head-tilt / dashboard / charging-case events, a
 * ring buffer of the last 20 raw events for the in-app diagnostic panel, and a
 * typed subscription surface for consumers (the mirror re-asserts on head-down;
 * the settings panel renders the ring).
 *
 * Fed by [GlassesController.wireDiagnostics] which registers a
 * [BleManager.Listener] that calls [record] on every parsed touch subcmd. Each
 * event is also mirrored to the hub `/debug/log` via [DebugAgent] as
 * `[glasses-event] arm=… subcmd=0x… kind=…` so it shows up in `curl /debug/log`.
 *
 * Protocol reference: `docs/g1-protocol.md` §8. Verified subcmds match
 * events.ts (firmware 2026-04-19).
 */
object GlassesEvents {

    enum class Kind {
        TAP_SINGLE, TAP_DOUBLE, TAP_TRIPLE,
        LONGPRESS_START, LONGPRESS_END,
        HEAD_UP, HEAD_DOWN,
        DASHBOARD_SHOW, DASHBOARD_HIDE,
        CONNECTED,
        CASE_REMOVED, CASE_OPENED, CASE_CLOSED, CASE_CHARGING, CASE_BATTERY,
        UNKNOWN;

        /** Lowercase kebab label matching the SPA's G1EventKind strings. */
        fun label(): String = name.lowercase().replace('_', '-')
    }

    /** Raw event as delivered off the BLE frame. `t` is uptime ms at receipt. */
    data class RawEvent(val arm: G1Protocol.Arm, val subcmd: Int, val t: Long)

    /** Map the raw `subcmd` byte to a semantic kind (mirrors events.ts classify). */
    fun classify(subcmd: Int): Kind = when (subcmd) {
        0x00 -> Kind.TAP_DOUBLE
        0x01 -> Kind.TAP_SINGLE
        0x02 -> Kind.HEAD_UP
        0x03 -> Kind.HEAD_DOWN
        0x04, 0x05 -> Kind.TAP_TRIPLE
        0x06, 0x07 -> Kind.CASE_REMOVED
        0x08 -> Kind.CASE_OPENED
        0x0b -> Kind.CASE_CLOSED
        0x0e -> Kind.CASE_CHARGING
        0x0f -> Kind.CASE_BATTERY
        0x11 -> Kind.CONNECTED
        0x17 -> Kind.LONGPRESS_START
        0x18 -> Kind.LONGPRESS_END
        0x1e -> Kind.DASHBOARD_SHOW
        0x1f -> Kind.DASHBOARD_HIDE
        0x20 -> Kind.TAP_DOUBLE
        else -> Kind.UNKNOWN
    }

    // --- Ring buffer (last 20) ------------------------------------------------

    private const val RING_SIZE = 20
    private val ring = ArrayDeque<RawEvent>()

    @Synchronized
    fun recent(): List<RawEvent> = ring.toList()

    // --- Listeners ------------------------------------------------------------

    private val ringListeners = CopyOnWriteArrayList<() -> Unit>()
    private val eventListeners = CopyOnWriteArrayList<(RawEvent, Kind) -> Unit>()

    /** Subscribe to ring-buffer changes (settings panel live update). */
    fun addRingListener(l: () -> Unit) { ringListeners.add(l) }
    fun removeRingListener(l: () -> Unit) { ringListeners.remove(l) }

    /** Subscribe to classified events (mirror head-down re-assert, etc.). */
    fun addEventListener(l: (RawEvent, Kind) -> Unit) { eventListeners.add(l) }
    fun removeEventListener(l: (RawEvent, Kind) -> Unit) { eventListeners.remove(l) }

    /**
     * Record a raw touch event: push to the ring, log to `/debug/log`, and
     * fan out to event listeners. Called from the BLE listener on the worker
     * thread — cheap (only fires on real user interaction).
     */
    fun record(arm: G1Protocol.Arm, subcmd: Byte) {
        val sub = subcmd.toInt() and 0xFF
        val kind = classify(sub)
        val ev = RawEvent(arm, sub, System.currentTimeMillis())
        synchronized(this) {
            ring.addLast(ev)
            while (ring.size > RING_SIZE) ring.removeFirst()
        }
        // Mirror the SPA's console.log so the hub debug feed sees every event.
        runCatching {
            DebugAgent.log(
                "console", "log",
                "[glasses-event] arm=${if (arm == G1Protocol.Arm.LEFT) "left" else "right"} " +
                    "subcmd=0x${sub.toString(16).padStart(2, '0')} kind=${kind.label()}",
            )
        }
        for (l in ringListeners) runCatching { l() }
        for (l in eventListeners) runCatching { l(ev, kind) }
    }
}
