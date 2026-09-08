---
name: flights
description: Console's SerpApi flight search + watchlists (server/src/flights): engines, 24 h poller + quota guard, routes, CLI, FlightsPanel/Sheet, and the flight arcs drawn on the Map tab as an agent layer. Use when touching server/src/flights, src/store/flights.ts or `con cal flights` / `con map flights`.
paths: server/src/flights/**, server/src/routes/flights.ts, src/store/flights.ts, src/components/FlightsPanel.tsx, src/components/FlightsSheet.tsx, cli/src/commands/map-flights.ts
user-invocable: false
metadata:
  card_keywords: "flight search, serpapi, flight watchlist, flight arcs, con cal flights, con map flights"
---

# Flights

Moved out of `CLAUDE.md` on 2026-09-08 (the CLAUDE.md diet, ^rosy-owl) — the text below is the trimmed reference that used to load into every request. The CLAUDE.md stanza for this subsystem keeps only the cross-cutting invariants; treat THIS file as the authoritative detail and keep it current the way you would CLAUDE.md.

- SerpApi-backed flight search + watchlists. Hub stores one API key in `AuthStore.serpApi` (`POST /flights/credentials --key <serpapi-key>` or via CLI).
- `server/src/flights/serpapi.ts` wraps the `google_travel_explore` (anywhere/region discovery) and `google_flights` (point-to-point) engines.
- `server/src/flights/store.ts` persists watchlists (`~/.config/console/flight-watchlists.json`); `server/src/flights/sync.ts` polls every 24 h (SerpApi has a hard monthly request cap; daily catches every meaningful move at ~30/mo; manual refresh via `pollOne`), diffs best price vs last snapshot, broadcasts `flights.polled` on the sync bus with the delta.
- Routes at `/flights/*` (status, credentials, explore, search, watch CRUD, history). CLI: `con cal flights {status, credentials, explore, search, watch, watch list, watch remove}`.
- SPA: `FlightsPanel.tsx` mounts in the calendar sidebar (desktop) or `FlightsSheet.tsx` as a full-screen sheet (mobile, via `CalendarMobileControls`). Backed by `src/store/flights.ts`, which mirrors hub state via the sync bus — no client polling.
- **Flight arcs on the Map tab** (`con map flights`, second word = tab — the arc *render* lives on the Map tab; calendar-side search/watch stays under `con cal flights`). `FlightSync.updateOffersLayer()` rebuilds a `flights/offers` agent map-layer from every watchlist's `lastResults` on each poll (and manual `pollOne`): a watchlist with a `destination` → one origin→dest arc (best fare), a region/anywhere watchlist → arcs fanning to its cheapest destinations (cap `MAX_EXPLORE_ARCS=8`). Reuses the agent map-layers transport (persistence + SyncBus + Layers-panel toggle) — no new storage. Pure geometry in `server/src/flights/arcs.ts` (`bezierArc` = perpendicular-bow quadratic curve so short hops still visibly arc; `legsToGeoJSON` → curved LineStrings + midpoint `_label` points) + `server/src/flights/airports.ts` (small IATA→lat/lon table; unknown code → leg skipped). Hub route `POST /flights/map {name,legs,color?,fit?}` + `DELETE /flights/map` (manual push to `flights/<name>`); CLI `con map flights {push,clear}` (`cli/src/commands/map-flights.ts`). Unit-tested in `server/src/__tests__/flights-arcs.test.ts`.
- **Quota anti-spam**: `SerpApiClient.searchesLeft()` hits the **free** `/account` endpoint (doesn't consume a search); `FlightSync.tick()`/`pollOne()` skip polling when `total_searches_left <= 0`, so a dead quota fires no search requests and SerpApi's "out of searches" emails stop until the monthly reset. `updateOffersLayer()` is a no-op on empty results (keeps the last-good board rather than blanking).
