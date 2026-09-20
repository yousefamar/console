// Live location subscriber. The hub holds the Recorder's WebSocket and pushes
// every fix, every fence-state change and the feed's health over SyncBus
// service 'location'; the Map's pin, track and fence tints follow without a
// poll. A (re)connect refetches the snapshot over HTTP, like the layers do.

import { hubBus } from '@/sync-bus'
import { useMapStore, type LocationFeed, type MapFence, type OtFix } from '@/store/map'

/** Idempotent; call once on boot. */
export function wireLocationSubscription(): () => void {
  const st = () => useMapStore.getState()
  const unsubFix = hubBus.on('location', 'fix', (d) => st().applyLiveFix((d as { fix: OtFix }).fix))
  const unsubFences = hubBus.on('location', 'fences', (d) => st().setFences((d as { fences: MapFence[] }).fences))
  const unsubFeed = hubBus.on('location', 'feed', (d) => st().setLocationFeed((d as { live: LocationFeed }).live))
  const unsubConnect = hubBus.onConnect(() => { void st().loadLocation() })
  return () => {
    unsubFix()
    unsubFences()
    unsubFeed()
    unsubConnect()
  }
}
