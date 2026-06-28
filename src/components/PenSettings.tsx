import { useEffect, useState } from 'react'
import { PenTool, Radar, EyeOff, Lock, Battery, HardDrive, Save, Plug, Radio } from 'lucide-react'
import { usePenStore } from '@/store/pen'

/** Trim a BLE MAC to its last two octets for a compact label. */
function shortMac(mac: string): string {
  const parts = mac.split(':')
  return parts.length > 2 ? parts.slice(-2).join(':') : mac
}

/**
 * Settings → Pen (Neo smartpen) section. Unlike Glasses (native bridge), the
 * pen is driven entirely through the hub's `/pen/*` routes — the hub RPCs the
 * phone, which owns the BLE link. So this talks to the hub via the store, which
 * uses `hubFetch`. Mirrors `GlassesSettings.tsx` in look + terseness.
 */
export function PenSettings() {
  const snap = usePenStore((s) => s.snapshot)
  const apkOffline = usePenStore((s) => s.apkOffline)
  const scanning = usePenStore((s) => s.scanning)
  const observations = usePenStore((s) => s.observations)
  const refresh = usePenStore((s) => s.refresh)
  const scan = usePenStore((s) => s.scan)
  const connect = usePenStore((s) => s.connect)
  const disconnect = usePenStore((s) => s.disconnect)
  const unlock = usePenStore((s) => s.unlock)
  const streaming = usePenStore((s) => s.streaming)
  const setStreaming = usePenStore((s) => s.setStreaming)
  const refreshStream = usePenStore((s) => s.refreshStream)

  const [password, setPassword] = useState('')
  const [pairOpen, setPairOpen] = useState(false)

  // Poll status every 3s while the settings panel is open. The pen's live
  // dot readout (lastDotX/Y) updates as the user writes, so a fast-ish poll
  // makes "first light" obvious.
  useEffect(() => {
    void refresh()
    void refreshStream()
    const id = window.setInterval(() => { void refresh() }, 3_000)
    return () => window.clearInterval(id)
  }, [refresh, refreshStream])

  const status = snap?.status ?? 'disconnected'
  const connected = status === 'connected' && !apkOffline
  const connecting = status === 'connecting' && !apkOffline

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <PenTool size={13} className="text-text-tertiary flex-shrink-0" />
          <span className="text-sm text-text-secondary truncate">
            {apkOffline
              ? 'Phone not reachable'
              : connected
                ? `${snap?.name || 'Pen'} connected`
                : connecting
                  ? 'Connecting…'
                  : 'No pen connected'}
            {connected && snap?.firmware && (
              <span className="text-text-tertiary"> · fw {snap.firmware}</span>
            )}
          </span>
        </div>
        {connected ? (
          <button
            onClick={() => disconnect()}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex-shrink-0"
            title="Disconnect (keeps pairing)"
          >
            <EyeOff size={11} />
            <span>Disconnect</span>
          </button>
        ) : (
          <button
            onClick={() => connect()}
            disabled={connecting || apkOffline}
            className="flex items-center gap-1.5 text-xs text-text-primary bg-surface-2 hover:bg-surface-3 border border-border rounded-sm px-2.5 py-1 transition-colors duration-fast flex-shrink-0 disabled:opacity-50"
            title="Reconnect the saved pen"
          >
            <Plug size={12} className={connecting ? 'animate-pulse' : ''} />
            <span>{connecting ? 'Connecting…' : 'Connect'}</span>
          </button>
        )}
      </div>

      {/* Battery / storage / offline-save line (only when connected). */}
      {connected && (
        <div className="ml-[21px] text-[11px] text-text-tertiary flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1">
            <Battery size={10} />
            {snap?.battery != null ? `${snap.battery}%` : '…'}
          </span>
          <span className="flex items-center gap-1">
            <HardDrive size={10} />
            {snap?.usedMemPct != null ? `${snap.usedMemPct}% used` : '…'}
          </span>
          {snap?.offlineSaveOn != null && (
            <span className="flex items-center gap-1">
              <Save size={10} />
              offline save {snap.offlineSaveOn ? 'on' : 'off'}
            </span>
          )}
        </div>
      )}

      {/* Live-stream pages into Notes — opt-in; coexists with offline-save. */}
      {connected && (
        <button
          onClick={() => void setStreaming(!streaming)}
          className="ml-[21px] flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
          title="Stream live pages into the Notes tab (scratch/pen/…). Off leaves the pen in its normal offline-save mode."
        >
          <Radio size={10} className={streaming ? 'text-green-500' : ''} />
          <span>live → Notes {streaming ? 'on' : 'off'}</span>
        </button>
      )}

      {/* Live dot readout — updates as the pen writes; great for first light. */}
      {connected && (snap?.lastDotX != null || snap?.lastDotY != null) && (
        <div className="ml-[21px] text-[11px] text-text-tertiary font-mono">
          dot ({snap?.lastDotX ?? '–'}, {snap?.lastDotY ?? '–'})
        </div>
      )}

      {/* Unlock — only when the pen reports locked and we're not authorized. */}
      {connected && snap?.locked && !snap?.authorized && (
        <div className="ml-[21px] flex items-center gap-1">
          <Lock size={11} className="text-text-tertiary flex-shrink-0" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 min-w-0 bg-surface-2 border border-border rounded-sm px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-text-tertiary"
            placeholder="Pen password"
          />
          <button
            onClick={() => { void unlock(password); setPassword('') }}
            className="px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary border border-border rounded-sm"
          >
            Unlock
          </button>
        </div>
      )}

      {snap?.lastError && (
        <div className="ml-[21px] text-[11px] text-red-500 truncate" title={snap.lastError}>
          {snap.lastError}
        </div>
      )}

      {/* Secondary: pair a new pen. Collapsed by default — the saved-pen
          "Connect" above is the primary path and needs no scan. */}
      {!connected && (
        <div className="ml-[21px]">
          <button
            onClick={() => {
              const next = !pairOpen
              setPairOpen(next)
              if (next) void scan()
            }}
            className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
          >
            <Radar size={10} className={scanning ? 'animate-pulse' : ''} />
            <span>{pairOpen ? (scanning ? 'Scanning…' : 'Re-scan') : 'Pair a new pen'}</span>
          </button>

          {pairOpen && (
            <div className="mt-1 space-y-1">
              {observations.slice(0, 6).map((o) => (
                <button
                  key={o.mac}
                  onClick={() => connect(o.mac)}
                  className="block w-full text-left text-xs text-text-secondary hover:text-text-primary truncate"
                  title={o.mac}
                >
                  <span>{o.name || 'Smart Pen'}</span>
                  <span className="text-text-tertiary font-mono"> · {shortMac(o.mac)}</span>
                  {o.rssi != null && <span className="text-text-tertiary"> · {o.rssi}dBm</span>}
                </button>
              ))}
              {observations.length === 0 && (
                <div className="text-[11px] text-text-tertiary italic">
                  {scanning ? 'Scanning… make a mark with the pen to wake it.' : 'No pens found.'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
