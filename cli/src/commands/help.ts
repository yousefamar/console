import type { GlobalFlags } from '../output.js'

const HELP_TEXT = `
con — Console CLI for AI agents and power users

Usage: con <command> [verb] [args] [--flags]

Services:
  mail         Email (Gmail) — list, read, archive, trash, snooze, reply, send
  chat         Chat (Matrix) — rooms, messages, send, react, mark-read
  bookmarks    Obsidian bookmarks — list, get, update, delete, tags
  notes        Obsidian vault notes — list, read, write, search, daily
  feeds        RSS/Atom feeds — list, items, mark-read, add, delete
  cal          Google Calendar — events, create, edit, delete, rsvp
  money        Monzo banking — balance, transactions, pots, spending
  agent        Claude Code sessions — create, send, tail, approve/deny
  spaces       Spaces pane — kanban boards ('con spaces board', alias 'con board')
  blog         Blog drafts + publishing
  map          Map tab — geocaching, meetup, layers, property, gmaps, flights
  music        Spotify remote — play, pause, search, playlists, volume
  dashboard    Home pane — servers, canvas tabs/islands, costs
  cron         Hub-side agent scheduler — list, add, remove, run
  event        Hub event bus — topics, log, tail, emit (what happened)
  listen       Event-driven rules — add, list, test, pause (react to it without polling)
  mic          System mic owner + push-to-talk routing
  whatsapp     WhatsApp (via AL) — send, call, calls, voice, contacts, status
  glasses      G1 smart glasses — status, text, clear, bmp, notify, mic, nav, teleprompt
  pen          Neo smartpen — status, devices, connect, scan, unlock, research
  ring         Pebble Index 01 ring — webhook setup, recordings, say (simulate), schema
  webhook      Inbound project webhooks — setup, status, list, show, test, redeliver
  location     Where Yousef is (OwnTracks) + geofences — now, for, eta, late-check, geofence, events

System:
  auth         Manage accounts — login, logout, status
  hub          Hub lifecycle — restart
  status       Hub health and sync status
  search       Cross-service search
  capabilities Self-discovery for AI agents
  schema       JSONSchema for any command
  help         Show this help
  version      Show version

Global flags:
  --json       JSON envelope output (default when piped)
  --plain      Stable TSV output
  --select     Field projection (dot-path, comma-separated)
  --agent      Agent mode (--json + --no-input)
  --hub <url>  Hub URL (default: http://localhost:9877)
  --dry-run    Preview without executing
  --no-input   Never prompt
  --verbose    Show request details
  --timeout    Request timeout in ms (default: 30000)

Aliases:
  m=mail  c=chat  b=bookmarks  n=notes  f=feeds  mo=money  a=agent  s=search

Examples:
  con mail list --max 10
  con mail archive 18f3a2b
  con chat rooms --filter unread
  con notes search "meeting notes"
  con cal events --from today --to +7d
  con agent create "Fix the bug" --wait
  con capabilities --json
`.trim()

const SERVICE_HELP: Record<string, string> = {
  mail: `
con mail — Email (Gmail)

Commands:
  list          List inbox threads
  read          Read a thread with messages
  archive       Archive thread(s)
  trash         Move thread(s) to trash
  snooze        Snooze a thread
  unsnooze      Unsnooze a thread
  mark-read     Mark thread(s) as read
  mark-unread   Mark thread(s) as unread
  reply         Reply to a thread
  forward       Forward a thread
  send          Send a new email
  attachments   List attachments
  download      Download an attachment
  contacts      Search contacts
  aliases       List send-as aliases
  undo          Undo last action

Examples:
  con mail list
  con mail list --query 'from:alice is:unread' --max 10
  con mail read 18f3a2b
  con mail archive 18f3a2b 18f3a2c
  con mail snooze 18f3a2b --until tomorrow
  con mail reply 18f3a2b --body "Thanks!"
  con mail send --to alice@example.com --subject "Hello" --body "Hi"
`.trim(),

  chat: `
con chat — Chat (Matrix)

Commands:
  rooms         List chat rooms
  messages      Read messages in a room
  send          Send a message
  send-file     Send a file
  react         React to a message
  mark-read     Mark room(s) as read
  mark-unread   Mark a room as unread
  snooze        Snooze a room
  draft         Leave a draft in the room's composer without sending (--clear discards)
  drafts        List rooms with an unsent draft
  info          Get room details
  tail          Stream new messages (NDJSON)
  undo          Undo last action

Examples:
  con chat rooms --filter unread
  con chat messages !roomid:matrix.org --limit 20
  con chat send !roomid:matrix.org --body "Hello"
  con chat draft !roomid:matrix.org --body "Reply for Yousef to review"
`.trim(),

  bookmarks: `
con bookmarks — Obsidian Bookmarks

Commands:
  list          List bookmarks
  get           Get bookmark details
  tags          List all tags with counts
  update        Update bookmark tags/title
  delete        Delete a bookmark
  reload        Force reload from disk

Examples:
  con bookmarks list --tag dev/frontend
  con bookmarks get my-bookmark.md
  con bookmarks update my-bookmark.md --add-tag dev/react
`.trim(),

  notes: `
con notes — Obsidian Vault Notes

Commands:
  list          List vault files
  read          Read a note
  write         Write/create a note
  append        Append to a note
  delete        Delete a note
  rename        Rename/move a note
  mkdir         Create a directory
  search        Search notes
  daily         Read or append to daily note
  enrich        Run the list enrichers now (movies → year/series; groceries → the open Sainsbury's order)
  open          Open a note in the running Console SPA (remote control)

Examples:
  con notes list
  con notes read scratch/todo.md
  con notes write scratch/new.md --content "# New Note"
  con notes search "meeting" --mode content
  con notes daily --content "- Task done"
  con notes open projects/astera/index.md
  con notes open "log/2026-08-03.md#Decisions"     # scroll to a heading
  con notes open scratch/idea.md --create          # create if missing
`.trim(),

  feeds: `
con feeds — RSS/Atom Feeds

Commands:
  list          List feed subscriptions
  items         List feed items
  read          Read a feed item
  mark-read     Mark items as read
  mark-unread   Mark an item as unread
  add           Subscribe to a feed
  delete        Unsubscribe from a feed
  import        Import feeds from OPML
  export        Export feeds as OPML

Examples:
  con feeds list
  con feeds items --unread --limit 20
  con feeds add https://example.com/feed.xml --folder Tech
`.trim(),

  cal: `
con cal — Google Calendar

Commands:
  calendars     List calendars
  events        List events
  get           Get event details
  create        Create an event
  edit          Edit an event
  delete        Delete an event
  rsvp          RSVP to an event
  location      Set working location
  link          Attach a PRIVATE link (file path/URL) to your copy of an event — guests never see it
  unlink        Remove a private link
  links         List an event's private links ('get' returns them as links too); --cat prints local text files
  linked        Events carrying private links (--from/--to, default -30d..+90d)
  accounts      List calendar accounts
  add-account   Add a calendar account
  remove-account Remove a calendar account
  flights       SerpApi flight search + watchlists (con cal flights …)
  eventbrite    Follow Eventbrite organisers → read-only "Eventbrite" calendar overlay
                status | events [--force] | follow <organiser|event URL|id> | unfollow <id> | token <token>

Examples:
  con cal events --from today --to +7d
  con cal eventbrite follow https://www.eventbrite.co.uk/o/wilding-with-harry-121041407049
  con cal create --calendar primary --title "Lunch" --start 2026-04-05T12:00 --end 2026-04-05T13:00
  con cal rsvp event123 --calendar primary --status accept
  con cal link event123 ~/sync/brain/root/projects/x/notes.md --calendar primary   # private: only YOUR copy carries it
  con cal links event123 --calendar primary
  con cal linked --from -7d --to +30d
`.trim(),

  money: `
con money — Monzo Banking

Commands:
  status        Connection status
  accounts      List accounts
  balance       Current balance
  transactions  List transactions (cached)
  get           Transaction detail
  pots          List pots with balances
  deposit       Deposit to pot
  withdraw      Withdraw from pot
  annotate      Annotate transaction
  spending      Spending by category
  sync          Trigger transaction sync

Examples:
  con money balance
  con money transactions --category groceries --limit 20
  con money spending --month 2026-04
  con money deposit --pot pot_xxx --amount 500
`.trim(),

  glasses: `
con glasses — Even Realities G1 smart glasses

Commands:
  status       Connection + battery snapshot, and what's on the lens right now
  text         Write a line of text to the display
  clear        Blank the display (exit current app)
  bmp          Send a 576x136 1-bpp BMP (heavier — ~400 packets)
  notify       Push a notification card, or 'notify dismiss <msgId>' to clear one
  mic          Toggle the glasses microphone (on|off)
  disconnect   Drop BLE link but keep pairing (DND-style)
  unpair       Glasses forget the bond (needs --confirm) — for a broken pairing
  scan         Trigger / stop a BLE scan, or dump recent observations
  research     Reverse-engineering frame log: on|off|tail [N]
  nav          The glasses' NATIVE turn-by-turn card: start | step | arrived | exit | map
               (layout primitive only — no route source yet; see docs/g1-protocol.md section 18)
  teleprompt   The glasses' NATIVE teleprompter: <file|-> starts (5-line pages; right tap = next,
               left tap = previous, double-tap ends), then next | prev | goto <n> | exit | status
               (docs/g1-protocol.md section 20)
  timer        The glasses' NATIVE countdown: timer 10m | 1h30m | "90 seconds" | 12:30, then
               timer cancel. The lens shows hh:mm:ss and leaves the screen at zero
               (docs/g1-protocol.md section 21)

status also reports runningApp / runningAppLabel — the feature drawing on the
lens (idle | app <n> | none), read live with a 0x39 query.

notify prints the msgId it pushed the card under; pass that to
'notify dismiss <msgId>' to clear it (cards otherwise linger on the lens).

Glasses are owned by the phone's APK — the hub talks to it over the push
WebSocket. If the APK isn't connected you'll get a 503 'APK not connected'.

Examples:
  con glasses status
  con glasses text "Hello from the terminal"
  con glasses notify --title 'Bus' --message '12 arrives in 3min'
  con glasses notify dismiss 7      # clear the card pushed as msgId 7
  con glasses bmp ./logo.bmp
  con glasses mic on
  con glasses unpair --confirm      # last resort for a broken bond
  con glasses scan start           # trigger phone-side BLE scan
  con glasses scan observations    # what names were advertising (debug)
  con glasses research tail 200    # recent frames (jq-friendly NDJSON)
  con glasses research on          # also log heartbeats
  con glasses nav start
  con glasses nav step --dir 5 --road "High St" --dist "200 m" --eta "12 min" --remaining "3.4 km"
  con glasses nav arrived --prompt "You have arrived" --complete
  con glasses nav exit
  con glasses timer 10m
  con glasses timer cancel
`.trim(),

  location: `
con location — where Yousef is (OwnTracks via the hub) + server-side geofences

Commands:
  [now]                               Latest fix: coords, ±accuracy, age, battery, fences he is inside
  refresh                             Fetch the Recorder's /last now, then as 'now' (the hub normally
                                      holds a live WebSocket to the Recorder; 'now' shows its state)
  history [--from D] [--to D] [--limit N]
                                      Recorder fixes for a day range (default today), oldest first
  geofence list                       Every fence with INSIDE/outside state and who it wakes
  geofence add <name> (--at "<address>" | --lat L --lon L) [--radius M] [--id slug]
               [--wake al,ceo] [--url https://…] [--url-token T] [--private]
               [--on enter|leave|both] [--expires +2h|ISO] [--note …]
                                      Create/replace a circular fence (default r 150 m, wakes @al on both).
                                      --at geocodes via Google Places; --expires makes it one-shot
                                      (a meeting venue that self-prunes); --private = a privacy zone
                                      that disclosure tools name but never locate (home).
  geofence remove <id>
  events [--limit N] [--fence id]     Transitions, newest first, with who was notified
  replay [--from D] [--to D] [--fence id] [--device d]
                                      DRY RUN: the transitions the fences as configured would have
                                      fired over Recorder history (default last 7 d). Nothing is
                                      woken, no state changes — tune a radius against a known week.
                                      (Reconnects replay the gap for real, automatically.)
  test <fence-id> [--event enter|leave]
                                      Fire a synthetic transition through the real wake/POST pipeline
  for <user-slug>                     What THAT person may be told about where he is. The hub applies
                                      users/<slug>.md in AL's workspace (trust: owner → exact;
                                      location: exact|area|city|country|none; legacy allow: location
                                      → exact; nothing → REFUSE) and prints the sentence to relay.
                                      Inside a private fence exact/area collapse to "At home (Reading)".
                                      THE ONLY way to answer a third party — never relay 'con location'.
  eta "<place>" [--mode DRIVE|TRANSIT|WALK|BICYCLE]
                                      Traffic-aware ETA from the current fix (Google), arrival time
  late-check [--threshold 10] [--window 180] [--mode DRIVE] [--guard]
                                      Upcoming events with a physical venue he will reach more than
                                      --threshold min after they start: geocoded venue, ETA, minutes
                                      late, attendees. One report per event (re-reports only when
                                      lateness grows by another threshold; state in
                                      ~/.config/console/location-late-alerts.json). Skips virtual/home
                                      venues, declined, cancelled, all-day; says nothing on a fix
                                      older than 30 min. --guard = cron guard semantics: report + exit
                                      0 only when late, else silent exit 1 (zero agent tokens).

How it works: the hub polls the OwnTracks Recorder (maps.amar.io) every 60 s
for the latest fix, runs it through every fence with hysteresis (leave needs
radius + max(30 m, 15 %); a fix coarser than the fence is ignored), and on a
transition appends to ~/.config/console/geofence-events.jsonl, wakes each
'wake' agent with a [GEOFENCE — Yousef ENTERED/LEFT "<name>"] envelope, and
POSTs the event JSON to the fence's url (Bearer url-token) if set. A new fence
is initialised silently from the current fix — events are transitions only.

The fix is owner-grade data. Relaying it to anyone else goes through
'con location for <user>', never straight from 'con location'.
`.trim(),

  event: `
con event — the hub's event bus: what topics exist, what happened, publish your own

Commands:
  topics                      Every topic with its fields, how often it fired and the last example
  log [<topic-glob>] [--since 2h] [--limit 50] [--source s]   Archived events, newest first
  tail [<topic-glob>]         Live stream (poll-based) — watch a filter take shape
  show <id>                   One event in full
  emit <topic> [--data '{…}'] [--key k] [--ref '<cmd>']    Publish a custom event (any script can)
  redeliver <id> --listener <lid>   Re-run one listener against an archived event
  status                      Bus counters

Topics are dotted and lower-case (mail.received, chat.message, geo.enter,
webhook.received, board.card.moved, cal.event.starting, hub.started, …). Custom
topics register themselves on first emit and are named <project>.<noun>.<verb>
— e.g. a release script running \`con event emit astera.release.landed --data
'{"sha":"…"}'\` replaces a cron that tails its log. EMIT WHENEVER ANOTHER AGENT
MAY BE WAITING ON YOUR RESULT (a build landed, a corpus refreshed, a card's
work done): the waiter holds a \`con listen add --once --on <topic>\` and is
woken the moment you emit, instead of polling you. Events carry a summary + a \`ref\` (the command that fetches the
full thing), never the full payload. Log: ~/.config/console/events/<day>.jsonl,
90 days. \`location.fix\` is ring-buffered only. Same (topic, --key) within
24 h is dropped as a duplicate.

Examples:
  con event topics
  con event tail chat.message
  con event log geo.* --since 7d
  con event emit astera.release --data '{"sha":"abc1234","state":"RELEASED"}' --key abc1234
`.trim(),

  listen: `
con listen — event-driven rules that survive hub restarts (cron = time, listen = something happened)

Commands:
  add --on <topic|glob> [filters] [gates] ACTION      Register a rule (see below)
  expect --on <topic> [--where …] WHEN --else ACTION   Act on the event NOT arriving in time (see "Expectations" below)
  list [--mine] [--topic t]                            Fleet-wide table: id, state, owner, rule, action, stats
  show <id>                                            Full record incl. the outcome journal
  log <id> [--limit N]                                 Outcomes newest first: fired / guard-skipped / dropped / paused / skipped / error (expect: armed / satisfied / missed)
  test <id> [--event <eid> | --topic t --data '{…}']   Dry run: which rung stops it (where / window / cooldown / guard / would-fire; expect: would-arm / would-satisfy / would-count / ignored). Never acts.
  pause <id> | resume <id> | flush <id>                Hold, release (clears skips/ceiling), fire the pending batch now (expect: judge the nearest deadline now)
  remove <id> [--force]                                403 for another session's listener without --force (the owner is told)

Filters (all ANDed, repeatable):
  --where <path><op><value>   ops: = != ~ (regex, /…/i for flags) ^= (prefix) > < >= <= in (a|b|c)
                              paths: data.room, data.isSelf, data.headers.x-github-event, topic, source
  --guard "<cmd>"             bash -c in your cwd; the batch as JSON on stdin ({listener, events}), exit 0 = proceed,
                              stdout rides in the wake envelope. Env: LISTENER_ID EVENT_TOPIC EVENT_ID EVENT_IDS EVENT_COUNT
Gates:
  --coalesce 30s              Quiet period; matching events in it become ONE action (default 60s for --wake, 0 otherwise)
  --cooldown 10m              Minimum gap between actions; events inside it are held, not dropped
  --hours 07:00-23:00 --days Mon-Fri [--drop-outside]   Active window (Europe/London); outside it events are held to the opening
  --max-per-hour N            Ceiling; exceeding it PAUSES the listener + pushes you (default 12 for --wake, 60 otherwise)
Lifetime (a one-off wait must not live forever):
  --once | --times N          Self-remove after 1 / N fires (a guard-skip or dead target does not count)
  --expires 2h | <iso>        Self-remove at the deadline whether or not it fired (pending events are dropped, logged)
Actions (exactly one):
  --wake "<prompt>" [--as <agentKey>]   Inject an [EVENT] envelope + your prompt into your session (or @agentKey's). The only rung that costs tokens.
    [--fork [--model haiku]]            …into a FRESH single-turn fork of that session instead — your context stays clean, the fork is
                                        closed when its turn ends (unless it pinged Yousef). --model pins the fork's model (haiku = cheap).
  --run "<cmd>"                         bash -c in your cwd, batch JSON on stdin — a software listener, no LLM
  --post <url> [--method M] [--header k:v]   Outbound webhook, JSON body {listener, events}
  --notify "<title>" [--body "…"]       Push to Yousef's phone/SPA. {{data.x}} templates from the first event
  --emit <topic> [--data '{…}']         Derive a new event (compose rules; hops capped at 5)
  --card <project> --body "<text>" [--to Backlog] [--assign key]   File a board card
--session defaults to your own claudeSessionId (CONSOLE_CLAUDE_SESSION_ID); --name labels the rule.

Ownership works like cron: --wake needs your session live (3 skips warn, 10 auto-disable); run/post/notify/emit/card
keep working after you end. A ticket-fork's listeners die with the card — register long-lived rules on the parent.

WAITING ON ANOTHER AGENT goes through events, never a polling cron or con agent send. The waiter registers a
one-off; the doer emits when done. Topics are <project>.<noun>.<verb>, e.g. astera.release.landed,
console.card.hazy-fawn.done, deen.corpus.refreshed. If someone may be waiting on your result, emit it.
  waiter:  con listen add --once --expires 6h --on astera.release.landed --wake "Release landed — verify prod and close the card."
  doer:    con event emit astera.release.landed --data '{"sha":"abc1234","cards":["^sly-owl"]}' --key abc1234
  ...and to be told if it NEVER lands:  con listen expect --on astera.release.landed --within 6h --else wake "Release did not land in 6 h — find out why."

Expectations (con listen expect) — the "didn't happen on time" half. Cron = time, listen = event, expect = both.
  --on <topic> [--where …]      The event you expect (same filters as add)
  --by <cron|iso|+dur> [--window 3h]   ABSOLUTE: at every tick (cron, Europe/London; ISO/+dur = once) satisfied iff a matching event
                                arrived in [tick − window, tick]; else the --else runs. Default window: since the previous tick.
                                A one-shot --by self-removes after its tick is judged.
  --within 90m [--after <topic> [--where …]…]   RELATIVE: every --after event arms a deadline; a matching --on event before it
                                disarms (all pending). No --after = armed ONCE at creation: a one-shot wait that self-removes on
                                satisfied OR missed — the replacement for "--once --expires 6h and hope".
  --else <type> <arg> [opts]    REQUIRED. wake "…" [--as k] | run "…" | post <url> | notify "…" [--body] | emit <topic> [--data] | card <p> "<text>"
  --then <type> <arg> [opts]    Optional: runs when the expectation IS satisfied (same action grammar).
  --guard "<cmd>" runs before the --else with the expect.missed event on stdin (exit 1 = don't nudge — e.g. "no yoga booked today");
  --hours/--days gate ARMING (relative) / judging (absolute); --max-per-hour, --once/--times (count --else fires), --expires, --name as for add.
  {{data.deadlineAt}} {{data.trigger.<field>}} {{data.confidence}} template from the expect.missed event; geo topics carry confidence=stale
  when the last location fix is >30 min old at the deadline (phone dead ≠ not there). Restart: a deadline the hub slept through fires
  the --else if <24 h late (envelope says how late), else is logged as expect.missed{reason:"hub down"} with no action.
  con listen expect --on geo.enter --where data.fence=buzz-gym --by "10 19 * * 2" --window 3h \\
      --guard 'python3 ~/exec/yoga-booked.py' --else wake "Not at the gym by 19:10 and yoga is booked. Nudge Yousef."
  con listen expect --on geo.enter --where data.fence=office --after geo.leave --where data.fence=home --within 90m \\
      --else notify "Left home 90 min ago, not at the office" --then notify "Made it to the office"
  con listen expect --on geo.leave --where data.fence=home --by 2026-09-25T07:15 --else wake "Equinox camp — you meant to leave at 07:00."
  con listen expect --on mail.received --where 'data.fromEmail=alerts@astera.catering' --by "0 9 * * 1-5" --window 24h --else notify "No Astera alert mail in 24 h — is the mirror running?"

Examples:
  con listen add --on chat.message --where 'data.room=!abc:beeper.local' --where data.isSelf=false \
      --guard 'python3 ~/exec/gmgn.py --event' --hours 07:00-23:00 --wake "Tell Yousef in one line what Mai said."
  con listen add --on mail.received --where 'data.fromEmail=alerts@astera.catering' --wake "Triage this Astera alert."
  con listen add --on geo.enter --where data.fence=home --hours 22:00-06:00 --run '~/exec/evening.sh'
  con listen add --on webhook.received --where data.project=astera --where 'data.headers.x-github-event in push|pull_request' \
      --guard 'python3 ~/exec/astera-conflict-relay.py --event' --wake "Resolve the conflict per the guard output."
  con listen test L3f9a2b
`.trim(),

  webhook: `
con webhook — inbound webhooks routed to a project's owner

Commands:
  setup <project> [--rotate]   Mint the project's token; prints the URL + header to give
                               the provider (plaintext shown once; --rotate revokes the old one)
  status                       Every project with a token/deliveries: URL, owner, undelivered
  list <project> [--limit N]   Deliveries for a project, newest first, with routing outcome
  show <id>                    One delivery in full (headers, body, route, redeliveries)
  test <project> [--body …]    Run the full pipeline as if a payload had arrived (no token needed)
                               [--content-type <ct>]; --body may be JSON or plain text
  redeliver <id>               Replay an archived delivery to the project's CURRENT owner

Wire: ANY https://con.amar.io/hub/hook/<project>[/<subpath>] with the token as
'Authorization: Bearer <token>' or '?token=<token>' (providers that can't set
headers). The token is scoped to that one project. The hub archives every
delivery under ~/.config/console/webhooks/deliveries/ (never pruned), then
wakes the project's owner — board frontmatter default_owner:, else the
project's bound session by the "* general" convention (the same resolver the
board uses for an unassigned card) — with a [WEBHOOK] envelope: method, path,
headers (credentials stripped), body (pretty JSON, clipped at 6 KB), and the
delivery id for 'con webhook show'. The owner decides what the payload means.
No live owner → 202, archived as undelivered; 'con webhook redeliver <id>'
replays it once someone is live.
`.trim(),

  ring: `
con ring — Pebble Index 01 smart ring

Commands:
  status       Webhook URL, recording count, fallback, agent roster
  setup        Mint a ring-scoped bearer + print the Pebble app webhook settings
  list         Recent recordings (--limit N): transcript, source, routing outcome
  show <id>    Full recording metadata (sidecar JSON)
  audio <id>   Download the M4A (--out <path>)
  say "<text>" Simulate a ring transcript (no audio) — runs the FULL pipeline, so a
               "play" resumes Spotify and a "message" sends; --dry routes only
  schema       Print the effective command tree, every target resolved (--check → exit 1 on problems)
  reminders    Pending "remind" one-shots (id, due, text); reminders cancel <id> drops one

The ring's app POSTs multipart (audio/mp4 + transcription + recordedAt) to
https://con.amar.io/hub/ring/webhook with the bearer from 'setup'. The hub
archives everything under ~/.config/console/ring/recordings/ (never pruned),
falls back to hub STT when the ring's transcript is missing, then routes the
text through the command tree in the vault note projects/console/ring-schema.md:
  <verb> <target> <payload>
  add|log <target> <text>    append to a list/log note under scratch/lists/
                             (dated targets = logs: day heading + HH:MM bullet;
                              lists = a stamped table row | Item | Added |; a target
                              with enrich: is worked by the hub list watcher
                              seconds later — see "con notes enrich")
  add <project> <text>       board card on that project (Backlog — queued)
  start <project> <text>     board card in In Progress (dispatched — an agent forks now)
  message <person> <text>    sent AS YOU through your own chat (Beeper WhatsApp DM)
  echo <text>                straight to your own WhatsApp, no LLM (smoke test)
  remind [me] [in …|at …] <text>  your own words back to your WhatsApp at that time
                             (time phrase may lead or trail; none → in 2 h)
  al <text>                  escape hatch: straight to AL's ring fork, skipping the tree
  play | pause | next | previous | play <query>   (any word order: "music plays" works)
Every note entry is "canonical: [ways to say it]". There is no "agent" verb —
you talk to projects (add = backlog it, start = kick it off). Text no verb
claims goes to AL — into an "AL ↔ ring" fork seeded with this tree, which acts
on it and files a "Ring schema gap" card when the tree should have caught it.
Verbs/targets tolerate one-letter mis-transcriptions and the note's aliases;
the LLM classifier runs only when no rule fires; anything still unclaimed goes
to the fallback agent (AL). The ring ignores the HTTP response, so the outcome
arrives as a push notification.

Examples:
  con ring setup
  con ring say "echo testing one two"
  con ring say "log dream I was escaping a prison made of cheese"
  con ring say --dry "Music, plays Taylor Swift."     # what WOULD happen, nothing runs
  con ring schema --check
  con ring list --limit 5
`,
  pen: `
con pen — Neo smartpen

Commands:
  status       Connection, battery, storage, lock/auth state snapshot
  devices      List bonded/known candidate pens
  connect      Connect to a pen (mac optional → last/known)
  disconnect   Drop the BLE link but keep pairing
  scan         Trigger a BLE scan, or dump recent observations
  unlock       Unlock a password-locked pen
  research     Reverse-engineering frame log: on|off|tail [N]
  offline      Rescue stored offline data (non-destructive)

The pen is owned by the phone's APK — the hub talks to it over the push
WebSocket. If the APK isn't connected you'll get a 503 'APK not connected'.

Offline rescue (non-destructive — the APK forces keep + saves-before-ack):
  con pen offline notes                        # list stored notes
  con pen offline pages <section> <owner> <note>   # page ids in a note
  con pen offline pull <section> <owner> <note> <page>  # rescue a page to disk
  con pen offline files                        # saved .bin files
  con pen offline progress                     # current transfer progress
Rescued bytes land in ~/.config/console/pen/offline/<s>-<o>-<n>-<p>.bin.

Examples:
  con pen status
  con pen devices
  con pen connect                  # connect to the last/known pen
  con pen scan                     # trigger phone-side BLE scan
  con pen scan observations        # what names were advertising (debug)
  con pen unlock 0000
  con pen research tail 200        # recent frames (jq-friendly NDJSON)
  con pen research on              # also log heartbeats
  con pen offline notes            # enumerate stored notes
  con pen offline pull 0 27 1 1    # rescue note (0,27,1) page 1
`.trim(),

  spaces: `
con spaces — Spaces pane (project-first UI)

Board (kanban) commands — 'con board' is an alias for 'con spaces board':
  board <project>                       Show the board (columns, cards, ^ids, assignees)
  board <project> add "text"            Add a card [--to|--column <column>] [--assign <key>] [--detail "a|b"] [--bottom]
  board <project> move "<card>" <col>   Move a card to a column
  board <project> assign "<card>" <key|none>
  board <project> owner <agentKey|none>          Board default owner (unassigned → In Progress auto-assigns to it)
  board <project> model "<card>" <alias|id|none>   Pin the ticket-fork's model (haiku/sonnet/opus/fable — or just type #sonnet on the card)
  board <project> nofork "<card>"       Dispatch wakes the assignee directly (no ticket-fork)
  board <project> forkok "<card>"       Undo nofork
  board <project> inherit "<card>"      Ticket-fork inherits the parent's whole transcript (default: fresh context + digest)
  board <project> fresh "<card>"        Undo inherit
  board <project> block "<card>"        Tag #blocked (keeps column position) [--note "why"]
  board <project> unblock "<card>"
  board <project> note "<card>" "text"  Append note lines under a card (newlines → one line each)
  board <project> attach "<card>" <file> Attach a screenshot (png/jpg/gif/webp) or clip (webm/mp4, ≤20 MB) [--caption "what"]
  board <project> edit "<card>"         Rewrite text/detail [--text "new"] [--detail "a|b"]
  board <project> remove "<card>"       Delete a card (human judgment — agents move, never delete)
  board <project> redispatch "<card>"   Re-wake a stamped card's assignee (re-forks if its session is gone)
  board <project> history               Pre-write journal copies of the board (last 100, hub-side)
  board <project> restore <ts> --confirm  HUMAN-ONLY: overwrite the board with a journal copy (reversible)

Notes:
  <project> is a slug resolved like the Spaces UI (board.md/kanban.md by name,
  else the first kanban-flagged file) or a vault-relative .md path.
  "<card>" is a ^blockid or a UNIQUE text substring — ambiguity errors, never guesses.
  --detail takes pipe-separated bullets. The hub is the single writer with a
  per-board lock, so concurrent agents serialize cleanly.
  Hand-back: before moving a card to Under Review, "note" a concise "- " bulleted
  summary of exactly what you did and "attach" screenshots where a visual check
  helps (always when you worked in a worktree). A move into Under Review with no
  summary bullets returns a warning.

Examples:
  con board console
  con board console add "Fix the tree" --to Backlog --assign console-general
  con spaces board console move "^ab12cd" "Under Review"
  con spaces board console block "^ab12cd" --note "needs API key"
`.trim(),

  agent: `
con agent — Claude Code Sessions

Commands:
  list          List agent sessions
  create        Create a new session
  send          Send a message to a session
  resume        Resume a past session
  kill          Kill a session
  interrupt     Interrupt a session
  approve       Approve tool use
  deny          Deny tool use
  tail          Stream session output (NDJSON)
  wait          Block until session completes
  chat          Talk to another agent (forks it, returns its reply)
  merge         Merge a fork back into its parent (summary folded in), then close it
  reparent      Move a session under another in the fork tree (<session> <parent> | --root)
  fork-cost    Per-turn spend of ticket-forks, fresh vs inherited context [--days N]
  model         Inspect/switch the model all agents spawn with
  search        Find past sessions by full text (all transcripts on this machine) [--project --here --since --file --tools]
  read          Read a past session / turn / tool result by address [--grep --turns --tools]
  inbox create <name> [--agent <key> | --project <slug>] [--from-name --signature --domain --quota --password --quiet]
                Give an agent its own <name>@amar.io: mxroute mailbox (API key in ~/.config/console/mxroute.env)
                + ~/.config/<name>-mail/.env for al-mail.py + IMAP IDLE watch + <name>-email SKILL.md in its cwd
                + mail.received listener on its session + one onboarding wake. Like al@ and ceo@, automated.
  inbox list    Agent mailboxes: local config ⋈ mxroute (usage, sent today), watched?, listeners
  inbox remove <name> [--keep-mailbox]   Undo create (mxroute mailbox deleted unless --keep-mailbox)

Examples:
  con agent inbox create opsec --agent opsec --from-name "OpSec"
  con agent create "Fix the auth bug" --cwd /path/to/project --wait
  con agent list
  con agent tail session_1
  con agent chat "Gravel general" "what auth does the control plane use?"
  con agent chat --id <conv-id> "follow-up question"
  con agent search "pruned transcript crons" --since 30d
  con agent read 27c3625f --grep "rekey"
  con agent chat --id <conv-id> --end
`.trim(),

  auth: `
con auth — Account Management

Commands:
  login         Connect an account (google or matrix)
  logout        Disconnect an account
  status        Show authentication status
  accounts      List all connected accounts

Examples:
  con auth login google
  con auth login matrix
  con auth status
`.trim(),

  hub: `
con hub — Hub Lifecycle

Commands:
  restart       Restart the hub via pm2 (controlled)

Notes:
  Agent sessions that were mid-turn when the hub stopped are auto-resumed
  with a "hub was restarted, continue" nudge. Idle sessions resume silently.

Examples:
  con hub restart
`.trim(),
}

export function help(args: string[], _flags: GlobalFlags): void {
  const command = args[0]
  if (command && SERVICE_HELP[command]) {
    process.stdout.write(SERVICE_HELP[command] + '\n')
  } else if (command) {
    process.stdout.write(`No help available for '${command}'. Run 'con help' for usage.\n`)
  } else {
    process.stdout.write(HELP_TEXT + '\n')
  }
}
