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
  glasses      G1 smart glasses — status, text, clear, bmp, notify, mic

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

Examples:
  con notes list
  con notes read scratch/todo.md
  con notes write scratch/new.md --content "# New Note"
  con notes search "meeting" --mode content
  con notes daily --content "- Task done"
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
