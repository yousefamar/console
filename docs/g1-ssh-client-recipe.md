# "SSH on my glasses" — recipe

Before Console's glasses integration existed, Yousef built a standalone
web app at `~/proj/code/g1-term` that mirrored an SSH session onto the G1
display. The SSH client itself is **not** being ported into Console — the
features that motivated it (mail, chat, agents, notes, calendar) are all
already first-class panes. But the SSH-to-glasses trick is a neat
technique and might justify a dedicated pane one day, so this file records
how it worked.

## Topology

```
Split keyboard ─USB/BT─▶ phone/laptop (Chrome)
                              │
              ┌───────────────┴──────────────┐
              │  small Node/Express web app │
              │  (g1-term)                  │
              │  xterm.js in page           │
              │  ssh2 bridge over WS        │
              └───────────────┬──────────────┘
                              │ Web Bluetooth (Chrome only)
                              ▼
                          G1 glasses
```

Three tiers:

1. **Browser** renders `xterm.js`, holds the Web Bluetooth connection to
   both arms of the G1.
2. **Node/Express server** (`ssh-client.js`) owns an `ssh2` client per
   session, relays stdin/stdout via a WebSocket at `/ssh`.
3. **Glasses** receive the last 5 lines of the terminal at 10 Hz.

## Data flow

- Terminal output from `ssh2` → WS → browser → `xterm.js.write(…)`.
- A 100 ms interval reads `xterm.buffer.active` for the last 5 lines,
  strips ANSI escapes, and calls the `G1.render()` protocol layer.
- `G1.render()` fires a "fast" write immediately, then schedules a
  "reliable" correction 300 ms later to tolerate BLE drops. Packets are
  the normal `0x4E` chunks described in `g1-protocol.md`.

## Why it's a neat hack

- **Free leverage.** Anything that runs in a terminal — `btop`, `tmux`,
  `weechat`, `vim`, `aerc` — instantly becomes glasses-compatible without
  per-feature code.
- **Latency masking.** The fast-then-reliable trick (immediate noisy send +
  delayed corrective send) made BLE packet loss feel like flicker instead
  of freezes.
- **10 Hz refresh.** The 100 ms tick is the upper bound we found before
  the write queues started backing up.

## Known pain points from `g1-term`

- Chrome-only (Web Bluetooth). Firefox unsupported. Linux BlueZ flaky.
  Main reason Console uses native Kotlin BLE instead.
- Image rendering is "janky" (user's own words) — the 1-bit 576×136 BMP
  pipeline is correct but Floyd-Steinberg dithering on arbitrary content
  looks bad. The lesson taken into Console: rely on text or pre-designed
  BMPs, don't try to dither screenshots.
- Only one BLE write queue per arm, so a long BMP upload blocks text
  updates. Console's BleManager keeps per-opcode urgency in mind.

## If we ever add a terminal pane to Console

Skeleton:

- Reuse `ssh2` in the hub (it's already a dep in `g1-term`).
- Add `/terminal` WS in the hub — subprocess-style session like agents.
- SPA pane: mount `xterm.js`, relay keystrokes over WS.
- On a 100 ms tick, read last 5 lines, strip ANSI, call
  `bridge.glassesSendText(text)`.
- No changes needed in the glasses stack — the dumb pipe already handles
  this.

The existing `g1-term` can be kept around as a standalone playground for
experiments; it doesn't need to merge into Console.
