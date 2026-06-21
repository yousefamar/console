// Bridge so the global keybinding handler can drive the (imperative) MapLibre
// map without a ref. MapTab populates these on mount and clears them on unmount.
export const mapController: {
  fetchHere?: () => void
  flyToMe?: () => void
} = {}
