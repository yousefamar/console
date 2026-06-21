// Map pane renderer.
//
// Status row: current device + my coordinates + loaded-cache count.
// Body: selected geocache details, or my-location + cache summary.

import { useMapStore } from '@/store/map'
import { buildStatus, clipRow, type MirrorFrame, BODY_ROWS } from '../mirror'

export function renderMap(): MirrorFrame | null {
  const { current, pins, selectedCode } = useMapStore.getState()
  const me = current[0]
  const meLabel = me ? `${me.lat.toFixed(3)},${me.lon.toFixed(3)}` : null

  if (selectedCode) {
    const c = pins.find((p) => p.code === selectedCode)
    if (c) {
      const body = [
        clipRow(c.name),
        clipRow(`${c.code} ${c.type}`),
        clipRow(`D${c.difficulty} T${c.terrain} ${c.size}`),
        clipRow(c.detail?.hint ? `hint: ${c.detail.hint}` : c.owner ? `by ${c.owner}` : ''),
      ].slice(0, BODY_ROWS)
      return { status: buildStatus(['Map', c.code]), body }
    }
  }

  const body = [
    clipRow(me ? `me ${meLabel}` : 'no location'),
    clipRow(`${pins.length} caches loaded`),
  ].slice(0, BODY_ROWS)
  return { status: buildStatus(['Map', me?.device, meLabel]), body }
}
