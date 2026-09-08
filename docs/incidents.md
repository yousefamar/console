# Incident ledger

Dated narratives that used to live inline in `CLAUDE.md` (moved out by the diet, ^rosy-owl, 2026-09-08) plus new ones as they happen. Each entry keeps the rule it produced in CLAUDE.md; this file holds the story — what happened, how it was found, what fixed it. The `^card` is the board card with the full record.

**Adding an entry:** when a fix lands, put the RULE in CLAUDE.md (or the subsystem skill) and the STORY here — one `###` per incident, newest last within its date.

### 2026-06-09 — `--end` left a running "<name> (fork)"

A duplicate hub session shared the fork's claudeSessionId (a resume during a restart spawns one): kill_session killed only the resolved session while delete_session's dup-guard cleared all. kill_session gained the same dup-guard + a sessions_list broadcast; Session.kill() sets status:ended unconditionally.

### 2026-06-09 — Al cutover from the standalone daemon into the Console hub

### Cutover (one-off, 2026-06-09)
1. `pm2 stop al`.
2. `mv /home/amar/.local/share/al/auth_whatsapp /home/amar/.config/console/auth_whatsapp` — atomic, same-fs, no re-QR.
3. `pm2 restart console-server --update-env` (env loaded via `--env-file-if-exists=.env` in `server/package.json` scripts; `server/.env` carries `ATOMS_API_KEY`, `ATOMS_AGENT_ID`, `NOTIFY_JID`).
4. Baileys reconnects from the moved creds; Al session spawns + persists `al-session.json`.
5. Caddyfile: `al.amar.io` backend swapped from `localhost:18789` to `https://localhost:9877` (with `tls_insecure_skip_verify`).
6. Sanity-check single "WhatsApp Web" entry on Yousef's phone (more than one = stale session leaked).
Rollback: stop console-server, `mv` auth dir back, restart old al daemon. Auth state is preserved; Baileys reconnects without re-QR.

### 2026-06-14 — WhatsApp @lid duplicates folded into canonical contact files

The 2026-06-14 cleanup used it to fold every lid dup into its real-phone file (nica-1/nica-2→nica, olly→olly-styles, yousef-amar→yousef; enriched ab/emese with real numbers; deleted the Slack-orphan `u072ylu7znc.md`).

### 2026-06-24 — spotifyd → go-librespot

spotifyd 0.4.2 silently dropped its Connect/dealer presence when idle (every control 404'd "Device not found" until a restart); go-librespot holds presence reliably. Device name stayed amarhp-spotifyd so hub/CLI needed no change; spotifyd is disabled-but-installed for rollback (systemctl --user start spotifyd). Design was modelled on the archived spotify-tui (network.rs IoEvent→endpoint map).

### 2026-07 — claude-fable-5 withdrawn → every session errored, recovery needed a source edit

The model id was a source const. Led to model-config.ts: runtime model + fallback chain, auto-fallback on model errors, fleet restart.

### 2026-08-04 — Posts published as stale — rebuild raced Syncthing

publishDraft wrote log/<ts>.md then hit /rebuild immediately; Eleventy on the VPS built before Syncthing delivered the file and nothing re-triggered. Fix: waitForVaultSync (force-scan + completion poll per remote) before triggerRebuild.

### 2026-08-11 — Calendar: five silent data-loss paths in the create pipeline

- **Five silent data-loss paths in the create pipeline, all closed 2026-08-11** (found after a hand-written event with a description vanished; the Google-side forensic sweep — `updatedMin` + `showDeleted=true` across every calendar — proved it *never reached Google*, so the loss was entirely client-side. Note a deleted Google event **loses its `summary`**, so a keyword/`q=` query can never find a tombstone; `updatedMin` is the only usable sweep, and the hub's `/cal/events` can't do it at all since `calendar-client.ts getEvents` forwards no `showDeleted`). An optimistic row is the **only** copy of what the user typed until it reaches Google, so every path that deletes calendar rows must exempt it:
1. `fetchEvents`'s stale-reap deletes any IDB event in the fetched range that Google didn't return. Its `pendingKeys` guard covered only `pending`/`processing` queue rows plus the **reload-volatile** module-level `pendingTempIds` map — so a create that failed 3× (→ `failed`) *or* any page reload left the temp row unprotected and the next fetch ate it. Now the status filter includes `failed`/`conflict` **and** there's a durable `isTempEventId` (`~` prefix) exemption, which is the guard that survives a reload.
2. The per-calendar fetch is `Promise.allSettled`, but the reap ran unconditionally — a **rejected** calendar contributes nothing to `freshKeys`, which the reap read as "Google deleted everything here", destroying even successfully-synced events on any hub hiccup/401. Now only calendars in the `reapable` set (fulfilled fetches) may be reaped.
3. A permanently-failed `calCreate`/`calLocation` had **no rollback branch and no notification** — total silence, indistinguishable from success. Now `notifyFailure` pushes a 30 s error toast naming the event title.
4. `CalendarEventForm.handleSubmit` had zero error handling and always `closeEventForm()`d — the UI reported success unconditionally and threw away the typed text. Now a `saveError` state keeps the form open with the content intact and relabels the button "Retry".
5. Ctrl/Cmd+refresh on the calendar pane called `db.calendarEvents.clear()` outright. Now preserves `~`-id rows, mirroring how the email branch preserves snoozed threads.
- Also: `createEvent` now passes `tempCompoundKey` as the `clientToken` the hub's `DedupStore` (`cal-create-dedup.json`, constructed in `index.ts` and passed to `handleCalendarRoutes`) already honoured — it was dead code because no client ever sent a token, so a retried create could double-book.
- **Still open** (not loss paths, but they made the forensics impossible): `markDone` *deletes* queue rows, so a success leaves no audit trail, and `db.queue` has no `eventCompoundKey` index.

### 2026-08-11 — "No text at all off mobile" — STT turns never closed

gpt-realtime-whisper rejects turn_detection and streams the tail lazily; every client closed the socket on mic release so the ending was discarded (short utterances lost their last words, brief ones produced nothing). The relay had a `let commitInterval` that was never assigned — dead code that read as a working feature. Fix: idle-gap commit + client `{type:done}` that the relay waits on; flat client grace periods removed.

### 2026-08-14 — Dream Lab calendar account connected-then-lost twice

yousef@dreamlab.bm silently un-promoted to reader twice; nothing logged, no Caddy access logs, actor unrecoverable. Likeliest culprit at the time: the APK calendar sheet's per-account Delete with no confirmation. Actual cause found 2026-08-16 (next entry).

### 2026-08-15 — Two ring-loop crashes silently shrank property polls

IS24 XML→JSON singleton flattening (one hit → bare object → "entries is not iterable") and immobiliare rejecting a 3-point sliver ring after Douglas-Peucker ("This collection should contain 4 elements or more"). Both found via the count-vs-lastTotal discrepancy.

### 2026-08-15 — Transient-error auto-resume never fired for weeks

The CLI's stream-json flag is is_api_error_message (snake_case); the hub matched isApiErrorMessage (camelCase — the on-disk JSONL shape). Handler now accepts both plus fallbacks.

### 2026-08-16 — The 16-day orphan AuthStore that reverted auth.json every 55 minutes

A one-off server/scripts/rescue-voicenote.ts (run 2026-07-31, finished in seconds, since deleted) was still running 16 days later holding a frozen July-31 AuthStore snapshot: the constructor arms scheduleRefresh timers that were not unref()'d, so the script never exited; every ~55 min its Google refresh save()d the old snapshot over auth.json — deleting yousef@dreamlab.bm and every hub session, which is why both the global login and dreamlab had to be re-done after every hub restart (the restart just re-read a file the orphan had already reverted). Proof was in its own stdout under /tmp/claude-1000/<project>/<uuid>/tasks/. fuser/lsof refuted the theory wrongly for a whole session because writeFileSync holds no fd.

### 2026-08-16 — Property pins/pushes were dead ends on Android

The generic agent-layer port in MapScreen.kt predated listingId/searchId/dismiss, and a pin push opened a bare Map pane. Two fixes: the panel special-cases url as an open button + adds "not interested"; PushMessage.url bypasses pane navigation. Rule: agent-layer UI features need a SPA change AND an Android change.

### 2026-08-18 — "Gravel sessions choke on figuring out which model to use"

The CLI's retention had deleted old JSONLs; --resume exited pre-init with 'No conversation found', which the exit handler misread as a model failure — every wake burned a model-fallback restart and the session never answered. Fix: stderr sets resumeTargetMissing → fresh respawn + re-delivered message.

### 2026-08-21 — Proxied POSTs hit closed hub sockets → 502 (^jade-lark)

Node's 5 s default keepAliveTimeout raced Caddy's connection reuse, so a proxied POST occasionally hit a socket the hub had just closed → RST → 502 (it ate a dictated board card). Fix: keepAliveTimeout 75 s / headersTimeout 76 s in index.ts so Caddy always closes first.

### 2026-08-21 — A stale Notes buffer clobbered the "Enter Console" draft

A tab holding an old read overwrote a newer disk copy on save. Fix (f866974 + 642115a): every tab carries baseMtime, the hub writeConditional 409s when disk is newer, Overwrite/Keep-editing dialog; saves serialized per path.

### 2026-08-27 — al.amar.io bare-proxied every hub path — the original canvas leak (^pink-tern)

The al.amar.io Caddy vhost reverse-proxied all hub paths, exposing unpublished canvases. Scoped to /voice/* only (backup /etc/caddy/Caddyfile.bak-pink-tern); /canvas/* removed from the auth exemption list and gated by the console_canvas SameSite=None cookie.

### 2026-08-27 — Deleting the Agents tab emptied the whole fleet (^deft-ant)

The always-mounted AgentTab was the accidental owner of fleet boot wiring (agents-WS connect, mic init, cron hydrate+poll, listSessions poll) — Spaces mounts lazily, so the fleet sat empty. Moved to GatedBoot (15ce291). Rule: audit mount effects before deleting any always-mounted component.

### 2026-08-27 — WhatsApp address-censor terms sat as literals in the public repo (^quick-tern)

findBlockedTerm's terms (a home address) were hardcoded for a month while the repo was public. Moved to ~/.config/console/wa-blocklist.json (0600); history purged with git-filter-repo, then delete+recreate of the repo when /activity showed the SHAs were still reachable (^quick-tern, ^cosy-finch).

### 2026-08-31 — OwnTracks basic-auth password leaked in the public repo seed (71 days) (^green-otter)

auth-store.ts shipped a real default owntracks password — also Yousef's sudo password — since 2026-06-21. Rotated end-to-end (VM .env, caddy), seed blanked, POST /owntracks/credentials became the only write path, history purged with git-filter-repo + repo delete/recreate.

### 2026-09-02 — Inbox reused viewers gated on the legacy pane (^neat-boar)

YouTubePiP.isInline checked activePane === "feeds", so every YouTube play on Inbox fell to floating PiP (^neat-boar feb4275a); ChatRoomView mounted a pane only for rooms the Chat pane LISTED, so 18 of 33 Inbox chat items (read overdue DMs) rendered blank (^lean-ant c712802c — selectRoom now lists what it selects). Rule: a reused viewer must never gate on a legacy pane id, and the select primitive must list what it selects.

### 2026-09-02 — #model/sonnet forks ran on Sonnet 4.5, billed untagged (^red-fawn)

~/.claude/settings.json had drifted to only ANTHROPIC_DEFAULT_FABLE_MODEL, so every #model/sonnet ticket-fork 24–28 Aug resolved the alias to the CLI's baked-in us.anthropic.claude-sonnet-4-5-20250929-v1:0 — the "Sonnet 4.5" rows in the Costs card. Fix: syncBackendSettings() re-bakes all six ANTHROPIC_*_MODEL keys at boot (^red-kite); the env is the only thing between an alias and the CLI default.

### 2026-09-02 — Al's mail/yoga/grocery crons died on every persona reload (^hazy-ram)

`con agent reload Al` is a fresh spawn (new csid); the crons stayed keyed to the dead id, hit 10 "session not found" misses and auto-disabled — Al missed a watched reply and blamed a hub reboot. Fix (^hazy-ram 3360883c): reloadAlSession and the pruned-transcript respawn re-key active crons via reassignSession (session_init.rekeyedFrom).

### 2026-09-02 — `con ring say` executed a bare test utterance and resumed Yousef's Spotify (^ripe-orca)

The schema note called `say` a dry-run; it runs the FULL pipeline. Added `con ring say --dry` → POST /ring/dry-run (route decision only, nothing archived or executed).

### 2026-09-02 — The Al↔Nica fork answered a 34-hour-old message (^rosy-kiwi)

Ring sends said "Veronica" → phone JID; the reply came from the lid as "Nica"; the fork seed's "ONE conversation (thread …@lid)" framing made the model treat them as separate threads, so it replied to a yoga message instead of the dinosaur fact sent 60 s earlier. A first fix quoted Al's last 3 sends into every envelope — vetoed as heavy; the shipped fix labels identity once (envelope From line, send result, fork seed).

### 2026-09-03 — Prefs: a timed-out /config load looked like a loaded one (^prim-lark)

initPrefs() used to `catch → cache = {}` and set loaded=true anyway, so one 4 s /config timeout on a busy hub left every reader seeing defaults while every guard said 'safe to persist'; the next automatic write pushed defaults up (calendar.visibleIds shrank from 9 to 2). Diagnosed from ~/.config/console/debug.log, which records request AND response bodies. Fix: resolve only on success, retry with backoff, graft newer local writes.

### 2026-09-03 — AI-edit review "sometimes doesn't show" — it only fired on Edit/Write tool_diffs (^spry-fox)

Bash / con notes write / heredoc / Syncthing writes emit no tool_diff, so the buffer stayed stale and :e blindly replaced it. Fix (^spry-fox f2e79b3e): the primitive is "disk moved under an open buffer" — reconcileWithDisk with four triggers (agent_edit, BoardWatcher file_changed poll, reconnect sweep, :e). Also that day: accepted chunks resurrected after a pane switch (store base now advances on accept) and :q!/:e! had never worked (codemirror-vim parses the bang as argString). ^deft-toad (888bea4): a review finished by accepting the last chunk stuck at "0 pending" because acceptChunk never doc-changes — auto-exit now gates on mayResolveChunks.

### 2026-09-03 — Inbox snooze "didn't work" for mail — four bugs and a starved rebuild (^rare-lark)

(1) Inbox `b` hardcoded tomorrow with no dialog; (2) the mail store's snoozeThread/archiveThread ran the legacy select-next-and-mark-read dance, marking a NEIGHBOUR read; (3) chat's snoozeRoom had never had a UI caller — `b` on the Chat pane snoozed whatever mail thread was selected; (4) agents couldn't be snoozed. The row also lingered 1–3 s because the 300 ms trailing debounce was reset by the agent store's 2–3 writes/s (measured gaps up to 1.7 s). Fixes: one SnoozePicker/applySnooze for every source, optimistic dropAndAdvance + handledKeys, rebuild-scheduler 1 s max-wait, snoozed view.

### 2026-09-03 — Uncapped card forks saturated the disk (^tame-bear)

6–9 concurrent forks running tsc/vitest in worktrees on ONE spinning disk: iowait 55–59 %, load 21 on 8 cores, 4–15 min pre-push hooks; con spaces board timed out at 120 s and the dispatcher's own writes failed (astera ^lime-kiwi/^pale-yak). Fix: boards.maxRunningForks cap (default 4) + global FIFO queue + the heavy-step wrapper hint in the envelope (^tame-bear).

### 2026-09-03 — "The parent worked my card" — an orphan twin misidentifying itself (^blue-vole)

A mid-turn hub restart spawned a twin of the ^rare-lark fork; both wrote the same worktree and JSONL. The twin read `--resume <parent>` in its own argv and believed it WAS the parent (pre-pin forks carried no own id). The real parent never received the envelope. Fix: forks spawn with --session-id <own> (^blue-vole 2a36c43a) and the envelope quotes the fork csid with a ps self-check.

### 2026-09-03 — /voice/delegate was an unauthenticated write primitive into Al for ~86 days (^gold-hare)

The auth exemption list claimed Atoms callbacks "authenticate via their own signed payloads" — nothing ever checked one, and the route also accepted GET + ?request=. Opsec rem #63 (HIGH). Fix (^gold-hare ac7714c9): a voice-scoped bearer minted at boot and installed on the Atoms tool + webhook record; POST-only, phone-shaped callerPhone, path-safe callId. Lesson: when a fix narrows an exposure to an allowed subset, audit the subset.

### 2026-09-04 — Hub restart resumed every fork while the old hub's children were still alive (^neat-newt)

Each fork ended up with two processes running the same "Continue" in the same worktree; one twin rewrote files under the other. Root cause: shutdown() SIGTERMed then process.exit(0)ed in the same tick; survivors reparented to init. Fix: boot reap + 60 s StaleProcessSweeper + shutdown that waits for children (^neat-newt). Related: SIGINT kills a claude child outright (^odd-tern), and a fork's --resume names its PARENT (^blue-vole pinned --session-id).

### 2026-09-04 — Board-card screenshots published on yousefamar.com (^trim-seal)

9 card screenshots (incl. Astera client-confidential) written to the vault's assets/images/ went live because the site publishes assets/ by a dir allow-list that includes images/. Site added a card-* exclusion + _site prune; Console moved attachments to assets/board/ (unlisted = private by construction). Opsec rem #65/#66.

### 2026-09-04 — Ring misses: fuzzy verb + unknown target died silently; UTC day headings; order_uid (^kind-bee)

"Look at the movie titles…" matched `add` via lock≈look and died as unknown-target instead of reaching AL (rule: a FUZZY verb hit with an unknown target falls through). Dated logs used the UTC day, filing a 00:16 BST entry under the previous day (now local clock, TZ pinned in tests). ~/exec/grocery-usuals.sh read .order_id where the CLI emits order_uid, so it never detected the open order and booked fresh every week.

### 2026-09-05 — Space-bound sessions ran from the hub's own cwd (^spry-seal)

createSession fell back to ctx.cwd (~/proj/code/console/server) for bound creates with no cwd, so Demovid general and every ticket-fork it spawned read Console's CLAUDE.md as their own; and the CLI derived auto-memory from the git root, so every vault-homed session shared one MEMORY.md (76 entries) and a fork at console/server filed under Console's. Fix: spaceCwd(), Session.relocate(), per-cwd memory pin, fleet sweep of 22 strays.

### 2026-09-05 — `message al` rerouted to al.direct on a card's say-so, reverted same day (^glad-ibis)

The card prescribed the reroute; Yousef vetoed within the hour ("I want to WhatsApp Al sometimes so he replies on there"). Lesson: a card's "should do X" is a hypothesis about the remedy — verify intent before changing what a command MEANS.

### 2026-09-06 — OutdoorLads calendar overlay removed (^wise-stag)

Yousef dropped the OutdoorLads group (a gay men's club, not for him); the RSS-fed synthetic calendar (server/src/outdoorlads.ts, routes/outdoorlads.ts, src/outdoorlads/) was deleted. Do not re-add. Android copy is dead code pending a BACKLOG entry. Replaced by the Eventbrite organiser overlay.

### 2026-09-06 — The astera board lost 106 Done cards (^lean-toad)

The watcher, reading OUTSIDE BoardOps' lock, caught a move's fs.writeFile mid-flight (O_TRUNC + chunked → a 64 KiB + 170 B prefix ending mid-word), stamped that prefix and wrote it back as the whole file; Syncthing's 5-slot versioning had rotated past it within minutes. Fix (^lean-toad 6f29a941): atomic NoteStore writes, one BoardFiles lock shared with the watcher, size-verified reads + 60 % shrink guard, hub-side journal with history/restore. A scratch race saw 7,394 prefix reads of 11,260 pre-fix, 0 after.

### 2026-09-07 — VPS Eleventy build hung 14 min at 100 % CPU — a repo symlink cycle (^calm-otter)

projects/memo/repo → ~/sync/brain (created by the fleet cwd sweep) cycled the wiki-link file walker back into the vault. Fixed in brain f5faa2e: walkDir uses lstat and never follows symlinks; .eleventyignore alone does not cover that walker.

### 2026-09-07 — Hub froze 30 s+ every hourly property tick (^spry-tern)

MapLayerStore.getGeojson() re-read and parsed the 1.2 MB zone on every clipToLayer call, per search per redraw, with a redraw after each of 8 searches → >100 parses + 27k point-in-polygon tests, 16 times a tick; the CLI reported HUB_UNAVAILABLE. Fix: cached geometry per updatedAt, memoised clip verdicts, one deferred redraw per tick.

### 2026-09-07 — Hub restarts stopped nudging mid-turn sessions (^odd-tern)

wasRunning was derived from status at shutdown, but SIGINT kills claude children before the hub's own handler runs, so every mid-turn session saved as not-running (26 restored, 0 "Resumed + continued", two provably mid-turn). Then the subtler leak: SIGINT mid-tool-call makes the CLI emit result/error_during_execution before exiting, which cleared midTurn. Fixes: Session.midTurn cleared only by a success result or interrupt(); markShuttingDown() before save; two-restart rule for anything computed at shutdown.

### 2026-09-08 — Farmland classifier promoted 236 of 8,039 UK houses (^spry-tern)

**Classifier tightened 2026-09-08 (Home) after the first real UK pass promoted 236 of 8,039 houses**: agents write "woodland walks nearby", "acres of countryside", "Acres Estate Agents", "equestrian centre", "converted stable block", "Cherry Orchard Primary School", "community orchards", "500 acres of park" about houses with a patio. `FARMLAND_TEXT_RE` lost woodland / bare acre(s) / stable(s) / equestrian; every keyword and every prose acreage now passes `hasLandKeyword`-style context checks (proper names via street/house/business suffixes, neighbourhood via before/after word lists); prose figures over 25 acres are the surroundings, not the plot; word fractions ("one third of an acre", "0.13 of an acre") parse; postcodes ("WV14 8HA") no longer read as hectares. Rightmove/OnTheMarket have no plot field, so `listingKind` ignores a stored `plotArea` from those portals and re-derives it from prose under the current rules (an older enrichment had stored "215 acres of woodland" as the plot). Portals with a real plot field are trusted at any size. Result: UK 236 → 7 farmland rows, DE/IT unchanged.

### 2026-09-08 — Kleinanzeigen range-blocked the whole home connection on its first skim

**Kleinanzeigen: search `ps_0d00ebbff8` "DE houses (Kleinanzeigen)" exists but is DISABLED (2026-09-08).** Created 11:40 BST after the parsers were verified against real pages that morning; its first skim at the 12:36 tick was range-blocked on request 16 — fifteen `/s-ort-empfehlungen.json` location lookups 25 s apart, then 403 — so the search was disabled the same hour to stop the hourly retry re-triggering the block on the whole home connection. Client hardened (`maxLookupsPerCall` 2, 45 s pacing, 40 req/h, 14 more location ids pinned in `SEED_LOCATIONS` from the live cache; Bremen came back as id 1 — re-verify before pinning). Re-enable (`con map property set ps_0d00ebbff8 --enabled true`) only on a hub running that code, and only after the range block has been clear for a day (`~/exec/watch-kleinanzeigen-unblocked.sh`). `kleinanzeigen.ts` is a paced crawler: IPv4-only (the IPv6 range stays blocked for hours), one request per 25 s shared across count/newest/detail, 120 requests per rolling hour then `truncated`, any 403/429/block page ⇒ throws `kleinanzeigen: BLOCKED` and refuses the network for 30 min. Declares `pacing = { fullSyncIntervalMs: 24h, enrichPerTick: 40 }` — `PortalClient.pacing` is the general hook `PropertySync.tick()` honours per search. Cards carry no coordinates (and no date); `detail()` supplies the PLZ centroid (`'area'`), plot, Haustyp, date. The 2026-09-07 build shipped on SYNTHETIC fixtures because the IP range was blocked; the first unblocked day (2 paced requests, both 200) replaced them with real pages (`__tests__/fixtures/kleinanzeigen-{list,ad}.html`) and exposed five parser bugs, all fixed — the two that mattered: the SRP pads thin result sets with out-of-radius cards under `<h2>Weitere Ergebnisse in anderen Orten</h2>` (now skipped; `total` comes from `von N Ergebnis`), and `<h1 id="viewad-title">` carries `data-soldlabel="Nicht mehr verfügbar"` on EVERY live ad (a template label, not a state — the old parser returned `null` for every ad, so enrichment would never have worked). Full list in the vault's `kleinanzeigen-api.md`. The search was created only after the hub was running this code — an older hub polls a `--portal` search through the country default. Its first pull runs on the hub's own hourly tick at 25 s/request; never `sync` it by hand (a forced full pull is ~30 queries × pages and the block is a RANGE block on the whole home connection). Related general fix: `fullSync()` passes `full: !r.truncated` to the inventory — a capped or budget-cut pull merges but never marks the unreached rows removed. **Fixtures saved from real portal pages must be scrubbed of token-shaped strings before commit** — the SRP fixture carried Kleinanzeigen's own public Google Maps key (`AIza…`, in a map component's `props`) and GitHub secret scanning flagged the public repo (^teal-mole, 2026-09-08). Not our key, but grep captures for `AIza|sk-|ghp_|xox[a-z]-|AKIA|eyJ[A-Za-z0-9_-]{20,}` and replace with a placeholder; the parsers never read those fields.

### 2026-09-08 — Ticket-forks re-read the parent's whole transcript on every message (^tall-colt)

^odd-toad's spend analysis: `--fork-session` copies the parent's entire transcript into a ticket-fork, so a Console-general fork started at hundreds of k tokens and re-read ~130k per message; two live forks (Jade stag, Deft tern) read ~50M cache tokens over ~400 messages each while root sessions read 0–4k. Anthropic's own guidance is the opposite shape — sub-agents work in clean context and return a 1–2k digest. Fix: `forkRoleSessionForTicket` spawns a FRESH session (hub-minted csid pinned with `--session-id`, no `--resume`) at the parent's cwd, so CLAUDE.md + auto-memory arrive natively, and the envelope carries a template digest of the parent's recent human conversation; `#inherit` / `fork_context: inherit` restore the copy for cards that need it (those still get ^brisk-wolf's `/compact`-first wake). Measurement lives in `~/.config/console/fork-cost.jsonl` + `con agent fork-cost`. Rule + mechanics: CLAUDE.md → Board-driven delegation, skill `ticket-forks`.

