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
  mic          System mic owner + push-to-talk routing
  whatsapp     WhatsApp (via AL) — send, contacts, status
  glasses      G1 smart glasses — status, text, clear, bmp, notify, mic
  pen          Neo smartpen — status, devices, connect, scan, unlock, research
  ring         Pebble Index 01 ring — webhook setup, recordings, say (simulate), config

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
  info          Get room details
  tail          Stream new messages (NDJSON)
  undo          Undo last action

Examples:
  con chat rooms --filter unread
  con chat messages !roomid:matrix.org --limit 20
  con chat send !roomid:matrix.org --body "Hello"
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
  accounts      List calendar accounts
  add-account   Add a calendar account
  remove-account Remove a calendar account

Examples:
  con cal events --from today --to +7d
  con cal create --calendar primary --title "Lunch" --start 2026-04-05T12:00 --end 2026-04-05T13:00
  con cal rsvp event123 --calendar primary --status accept
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
  status       Connection + battery snapshot
  text         Write a line of text to the display
  clear        Blank the display (exit current app)
  bmp          Send a 576x136 1-bpp BMP (heavier — ~400 packets)
  notify       Push a notification card
  mic          Toggle the glasses microphone (on|off)
  disconnect   Drop BLE link but keep pairing (DND-style)
  scan         Trigger / stop a BLE scan, or dump recent observations
  research     Reverse-engineering frame log: on|off|tail [N]

Glasses are owned by the phone's APK — the hub talks to it over the push
WebSocket. If the APK isn't connected you'll get a 503 'APK not connected'.

Examples:
  con glasses status
  con glasses text "Hello from the terminal"
  con glasses notify --title 'Bus' --message '12 arrives in 3min'
  con glasses bmp ./logo.bmp
  con glasses mic on
  con glasses scan start           # trigger phone-side BLE scan
  con glasses scan observations    # what names were advertising (debug)
  con glasses research tail 200    # recent frames (jq-friendly NDJSON)
  con glasses research on          # also log heartbeats
`.trim(),

  ring: `
con ring — Pebble Index 01 smart ring

Commands:
  status       Webhook URL, recording count, router config, agent roster
  setup        Mint a ring-scoped bearer + print the Pebble app webhook settings
  list         Recent recordings (--limit N): transcript, source, routing outcome
  show <id>    Full recording metadata (sidecar JSON)
  audio <id>   Download the M4A (--out <path>)
  say "<text>" Simulate a ring transcript through the router (no audio)
  config       Show or set: --fallback <agentKey|none>, --llm on|off

The ring's app POSTs multipart (audio/mp4 + transcription + recordedAt) to
https://con.amar.io/hub/ring/webhook with the bearer from 'setup'. The hub
archives everything under ~/.config/console/ring/recordings/ (never pruned),
falls back to hub STT when the ring's transcript is missing, then routes the
text: deterministic rules first (server/src/ring/router.ts — "tell <agent> …",
"<agent>, …", music play/pause/next/previous), the LLM classifier only when
rules miss, then the fallback agent (default AL). The ring ignores the HTTP
response, so the outcome arrives as a push notification.

Examples:
  con ring setup
  con ring say "tell al to buy milk"
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
  board <project> add "text"            Add a card [--to <column>] [--assign <key>] [--detail "a|b"] [--bottom]
  board <project> move "<card>" <col>   Move a card to a column
  board <project> assign "<card>" <key|none>
  board <project> owner <agentKey|none>          Board default owner (unassigned → In Progress auto-assigns to it)
  board <project> model "<card>" <alias|id|none>   Pin the ticket-fork's model (haiku/sonnet/opus)
  board <project> nofork "<card>"       Dispatch wakes the assignee directly (no ticket-fork)
  board <project> forkok "<card>"       Undo nofork
  board <project> block "<card>"        Tag #blocked (keeps column position) [--note "why"]
  board <project> unblock "<card>"
  board <project> note "<card>" "text"  Append note lines under a card (newlines → one line each)
  board <project> attach "<card>" <img>  Attach a screenshot (png/jpg/gif/webp) [--caption "what"]
  board <project> edit "<card>"         Rewrite text/detail [--text "new"] [--detail "a|b"]
  board <project> remove "<card>"       Delete a card (human judgment — agents move, never delete)
  board <project> redispatch "<card>"   Re-wake a stamped card's assignee (re-forks if its session is gone)

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
  model         Inspect/switch the model all agents spawn with

Examples:
  con agent create "Fix the auth bug" --cwd /path/to/project --wait
  con agent list
  con agent tail session_1
  con agent chat "Gravel general" "what auth does the control plane use?"
  con agent chat --id <conv-id> "follow-up question"
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
