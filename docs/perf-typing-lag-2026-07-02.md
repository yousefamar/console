# Typing-lag fix, 2026-07-02 — what changed + how to reverse it

Commit `a57d125` ("Perf: collapse hidden email iframes — the cross-pane typing-lag root cause").
Full reversal: `git revert a57d125` (also restore the CLAUDE.md caveat + `memory/project_emailframe_iframe_perf.md` if you do).
Partial reversals below, per change.

## Diagnosis (for context)

Typing in the Agents tab lagged, but the input path was clean (~0.3 ms/keystroke —
the April 2026 uncontrolled-textarea fix in `27a35f1` had NOT regressed). The lag
was recurring 450–700 ms main-thread long tasks with **zero user-code samples**
(JS Self-Profiling) and no DOM mutations: browser-internal style/layout across
~31 live email iframe documents kept mounted by the pre-render architecture.
A/B via the debug agent (blank all `title="Email content"` iframes → long tasks
vanish) pinned it.

## Change 1 — EmailFrame placeholder when hidden (THE fix)

`src/components/EmailFrame.tsx`: when `!visible`, render a height-preserving
`<div>` instead of the `<iframe>`. The iframe mounts fresh on thread select:

- load effect keyed on `[messageId, visible]` (was `[messageId]`), resets `loaded.current`
- ResizeObserver effect keyed on `[measure, visible]` so it re-attaches to the new element

**Behavioural consequence**: an email document now re-parses on every thread
select instead of staying warm. Height is cached (`email-cache.ts`) so there's
no layout shift, but very heavy emails re-render on open (~when the blob URL
loads). If that ever feels slow, THIS is the change to reverse: make the render
unconditional again and drop `visible` from the two dependency arrays. Doing so
brings back the cross-pane long tasks.

## Change 2 — AgentSessionView streaming-tail isolation (defence-in-depth)

`src/components/AgentSessionView.tsx`:

- `pendingText`/`pendingThinking` go through `useDeferredValue` → tail renders
  are low-priority/interruptible; keystrokes preempt them. Reversal: subscribe
  the raw store values directly (as before).
- `StreamingTail` extracted + `memo`'d, with `renderMarkdownLite` result in a
  `useMemo`. Reversal: inline the JSX back into the parent.
- `MessageList` extracted + `memo`'d so the (up to 300) finalized messages don't
  re-reconcile per delta flush; tool_results are indexed once in a
  `Map<toolUseId, msg>` (was O(n²) `messages.slice(i+1).find(...)` per tool_use).
  Reversal: inline the map loop back; note the O(n²) pairing cost returns.

**Behavioural consequence**: during a fast stream the visible tail can lag the
store by a frame or two (deferred value). If streaming text ever looks "sticky",
this is why — but reverting it re-couples tail rendering to input priority.

## Change 3 — MapTab dash loop skips hidden pane

`src/components/MapTab.tsx` `ensureDashLoop`: skip `setPaintProperty` (a full
MapLibre re-render) when `map.getContainer().offsetParent === null` (Map pane
is `display:none`). Only matters while flight-arc layers exist. Reversal: drop
the `continue` guard. Consequence of reverting: constant per-130 ms MapLibre
renders under every other pane whenever animated arcs are loaded.

## Docs touched

- `CLAUDE.md` "Pre-rendered panes" bullet: caveat rewritten as fixed.
- `memory/project_emailframe_iframe_perf.md`: marked FIXED, kept the debug
  recipe (PerformanceObserver A/B via `/debug/eval`) for recognising this
  class of bug again.
