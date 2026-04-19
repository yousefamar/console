import { useEffect, useState } from 'react'
import { Glasses, Radar, LogOut, Send, Eye, EyeOff, NotebookPen, Hand } from 'lucide-react'
import { useGlassesStore } from '@/glasses/store'
import {
  disconnect as bridgeDisconnect,
  pair as bridgePair,
  unpair as bridgeUnpair,
  sendText,
  clear as bridgeClear,
  type ScanCandidate,
} from '@/glasses/bridge'
import {
  getRecentEvents,
  onRecentEventsChange,
  classify as classifyLocal,
  type RawG1Event,
} from '@/glasses/events'

/**
 * Settings → Glasses section. Only rendered when running inside the APK
 * shell; the web build never sees this because `glassesSupported()` is false.
 */
export function GlassesSettings() {
  const supported = useGlassesStore((s) => s.supported)
  const snap = useGlassesStore((s) => s.snapshot)
  const scanning = useGlassesStore((s) => s.scanning)
  const candidates = useGlassesStore((s) => s.candidates)
  const startScan = useGlassesStore((s) => s.startScan)
  const stopScan = useGlassesStore((s) => s.stopScan)
  const refresh = useGlassesStore((s) => s.refresh)

  const [testOpen, setTestOpen] = useState(false)
  const [testText, setTestText] = useState('Hello from Console')
  const [eventsOpen, setEventsOpen] = useState(false)
  const [events, setEvents] = useState<readonly RawG1Event[]>(() => getRecentEvents())
  const notesMirrorEnabled = useGlassesStore((s) => s.notesMirrorEnabled)
  const setNotesMirrorEnabled = useGlassesStore((s) => s.setNotesMirrorEnabled)

  // One-shot refresh on mount — snapshot might be stale if the JS bridge was
  // still booting when the store was first initialized.
  useEffect(() => { refresh() }, [refresh])

  // Live-subscribe to the event ring buffer only while the panel is open —
  // avoids re-renders on touchbar activity when the user isn't looking.
  useEffect(() => {
    if (!eventsOpen) return
    setEvents(getRecentEvents())
    return onRecentEventsChange(setEvents)
  }, [eventsOpen])

  if (!supported) return null

  const connected = !!snap?.connected
  // "Connecting…" should reflect *actual* in-progress attempts — not just
  // "paired but not connected", because that state also covers radio-off
  // and would otherwise spin forever. The APK reports arm statuses as
  // 'connecting' only while a real GATT attempt is mid-flight.
  const pairing = snap?.left.status === 'connecting' || snap?.right.status === 'connecting'
  const paired = !!snap?.channel
  const leftBatt = snap?.left.battery
  const rightBatt = snap?.right.battery

  function handlePair(c: ScanCandidate) {
    if (!c.leftMac || !c.rightMac) return
    bridgePair(c.leftMac, c.rightMac, c.channel)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Glasses size={13} className="text-text-tertiary flex-shrink-0" />
          <span className="text-sm text-text-secondary truncate">
            {connected ? 'G1 connected' : pairing ? 'Connecting…' : paired ? 'G1 disconnected' : 'No glasses paired'}
          </span>
        </div>
        {paired ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            {connected && (
              <button
                onClick={() => bridgeDisconnect()}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                title="Temporarily disconnect (keeps pairing)"
              >
                <EyeOff size={11} />
                <span>Pause</span>
              </button>
            )}
            <button
              onClick={() => { if (confirm('Forget these glasses?')) bridgeUnpair() }}
              className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
            >
              <LogOut size={11} />
              <span>Unpair</span>
            </button>
          </div>
        ) : (
          <button
            onClick={() => (scanning ? stopScan() : startScan())}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex-shrink-0"
          >
            <Radar size={11} className={scanning ? 'animate-pulse' : ''} />
            <span>{scanning ? 'Stop' : 'Scan'}</span>
          </button>
        )}
      </div>

      {/* Battery + firmware line (only when we know the arms) */}
      {connected && (
        <div className="ml-[21px] text-[11px] text-text-tertiary">
          L {leftBatt != null ? `${leftBatt}%` : '…'} · R {rightBatt != null ? `${rightBatt}%` : '…'}
          {snap?.channel && <span> · ch {snap.channel}</span>}
        </div>
      )}

      {snap?.lastError && (
        <div className="ml-[21px] text-[11px] text-red-500 truncate" title={snap.lastError}>
          {snap.lastError}
        </div>
      )}

      {/* Scan results */}
      {!paired && candidates.length > 0 && (
        <div className="ml-[21px] space-y-1">
          {candidates.map((c) => (
            <button
              key={c.channel}
              disabled={!c.ready}
              onClick={() => handlePair(c)}
              className="block w-full text-left text-xs text-text-secondary hover:text-text-primary disabled:text-text-tertiary disabled:cursor-not-allowed"
            >
              <span className="font-mono">G1 #{c.channel}</span>
              {!c.ready && <span className="text-text-tertiary"> (need both arms)</span>}
              {c.rssi != null && <span className="text-text-tertiary"> · {c.rssi} dBm</span>}
            </button>
          ))}
        </div>
      )}
      {!paired && scanning && candidates.length === 0 && (
        <div className="ml-[21px] text-[11px] text-text-tertiary italic">Scanning… wake the glasses (open + put on).</div>
      )}

      {/* Notes mirror — short-circuits hub; phone → BLE. */}
      {connected && (
        <div className="ml-[21px] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <NotebookPen size={13} className="text-text-tertiary flex-shrink-0" />
            <span className="text-sm text-text-secondary truncate">Mirror Notes to lenses</span>
          </div>
          <button
            onClick={() => setNotesMirrorEnabled(!notesMirrorEnabled)}
            className={`relative w-7 h-4 rounded-full transition-colors duration-fast flex-shrink-0 ${notesMirrorEnabled ? 'bg-text-secondary' : 'bg-surface-2'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-surface-0 transition-transform duration-fast ${notesMirrorEnabled ? 'translate-x-3' : ''}`} />
          </button>
        </div>
      )}

      {/* Recent events — diagnostic panel, reveals raw 0xF5 subcmds so we can
          tune the semantic classifier in `glasses/events.ts` against real
          firmware behavior. Available whenever the APK is live (doesn't need
          a G1 *connection* — useful if the touchbar fires while disconnected).
          Covers taps, long-press, head-tilts, and dashboard show/hide — not
          just touchbar gestures, hence "events" not "touches". */}
      <div className="ml-[21px]">
        <button
          onClick={() => setEventsOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
        >
          <Hand size={10} />
          <span>{eventsOpen ? 'Hide' : 'Recent events'}</span>
        </button>
        {eventsOpen && (
          <div className="mt-1 font-mono text-[11px] text-text-tertiary space-y-0.5 max-h-40 overflow-y-auto">
            {events.length === 0 ? (
              <div className="italic">No events yet — tap a touchbar or tilt your head.</div>
            ) : (
              events
                .slice()
                .reverse()
                .map((e, i) => {
                  const hex = `0x${e.subcmd.toString(16).padStart(2, '0')}`
                  const kind = classifyLocal(e.subcmd)
                  return (
                    <div key={`${e.t}-${i}`} className="flex gap-2">
                      <span className="w-10 text-text-secondary">{e.arm === 'left' ? 'L' : 'R'}</span>
                      <span className="w-12">{hex}</span>
                      <span>{kind}</span>
                    </div>
                  )
                })
            )}
          </div>
        )}
      </div>

      {/* Dev affordance: send a line + clear the display. Only when connected. */}
      {connected && (
        <div className="ml-[21px]">
          <button
            onClick={() => setTestOpen((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
          >
            <Eye size={10} />
            <span>{testOpen ? 'Hide' : 'Test display'}</span>
          </button>
          {testOpen && (
            <div className="mt-1 flex items-center gap-1">
              <input
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                className="flex-1 min-w-0 bg-surface-2 border border-border rounded-sm px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-text-tertiary"
                placeholder="Text to show on G1"
              />
              <button
                onClick={() => sendText(testText)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary border border-border rounded-sm"
                title="Send to G1"
              >
                <Send size={10} />
              </button>
              <button
                onClick={() => bridgeClear()}
                className="px-2 py-1 text-[11px] text-text-tertiary hover:text-text-secondary border border-border rounded-sm"
                title="Clear display"
              >
                clr
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
