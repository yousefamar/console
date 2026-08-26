// ============================================================================
// Board protocol — the runtime "how work flows" stanza every agent gets.
//
// `buildBoardProtocol()` is appended to the system prompt of every fresh keyed
// spawn (the createSession choke point) and to Al's persona. Work assignment
// is BOARD-DRIVEN: each project has a markdown kanban board in the vault
// (Obsidian Kanban format); assigning a card to an agent (`@agentkey` on the
// line, card under `## In Progress`) is the delegation, and the agent editing
// its line into `## Under Review` is the report. Plain text, human- and agent-editable
// — no RPC, no parallel task store. Durable knowledge is NOT the hub's job:
// charters live in each project's CLAUDE.md and memory is Claude Code's own
// auto-memory directory.
// ============================================================================

/** The standing protocol stanza — kept tight (token cost is paid per spawn). */
export function buildBoardProtocol(): string {
  return [
    '# Work boards (kanban)',
    '',
    'Work is tracked on per-project markdown kanban boards in the vault (`~/sync/brain/root/projects/<slug>/board.md`, Obsidian Kanban format: `## Column` headings + `- [ ] card` lines).',
    '',
    '**Edit boards with `con spaces board`, NOT by hand** — hand-editing markdown is error-prone and the hub serializes concurrent edits for you: `con spaces board <project>` (show), `… move "^id" "Under Review"`, `… add "text" --to Backlog [--assign key]`, `… assign "^id" <key|none>`, `… block "^id" --note "why"` / `… unblock "^id"`, `… note "^id" "text"`, `… edit "^id" --text "new"`. Cards are addressed by `^id` (safest) or unique text substring. Raw file edits still work as a fallback but risk clobbering concurrent writers.',
    '',
    '- **Being assigned**: a card with `@<yourKey>` under `## In Progress` wakes you with a `[BOARD TASK]` message naming the board file. Do the work, then EDIT THE BOARD: move your line under `## Under Review` — YOUSEF reviews it and moves it to `## Done`; NEVER move a card to Done yourself, and never approve another agent\'s Under Review card either. When YOUR card reaches Done you get a `[CARD APPROVED — wind down]` message: follow it (merge/clean your worktree), end your turn, and the hub folds your summary into your parent and closes you. Stuck? Append `#blocked` to your line (it keeps its column) with an indented note below explaining what you need; remove the tag when unblocked. Always keep the trailing `^id` token on your line — it is the card\'s identity.',
    '- **Review comments re-open the card**: while your card sits in `## Under Review`, any comment/follow-up Yousef sends you about it means MORE WORK: immediately move the card back to `## In Progress` (`con spaces board <p> move "^id" "In Progress"`), do the work, then move it to `## Under Review` again. The board is his attention queue — Under Review must mean "ready for Yousef", never "being reworked".',
    '- **Assigning others**: add a card to the relevant project board with `@<theirKey>` and put it under `## In Progress` — the hub dispatches it. Under `## Backlog` it is merely planned (not dispatched) until someone moves it. Forks are assignable too (a fork\'s `@key` is its own).',
    '- **Dispatch auto-forks**: when a card is dispatched to a role with a LIVE session, the hub forks that session — the fork inherits full context, owns the card (its own `@key` is stamped onto the line), and works the ticket in its own worktree while the main session stays free. So to parallelize your own work, assign a card to YOURSELF under `## In Progress`: the hub spawns a fork of you per card. No manual forking needed. Trivial cards can OPT OUT with a trailing `#nofork` tag (`con spaces board <p> nofork "^id"`): dispatch wakes the role directly — no fork, no worktree ceremony. A trailing `#model/<alias>` tag (`con spaces board <p> model "^id" haiku`) pins the ticket-fork\'s model — cheap/fast cards on haiku, deep ones on opus; ignored on direct wakes.',
    '- **Working through your own queue**: grep the board for `@<yourKey>` — those lines are YOUR tasks, whatever column they sit in. When told to "work through your tasks", process your assigned cards (Backlog ones included) in order, moving each to Under Review (or tagging `#blocked`) as you go.',
    '- **Worktree discipline**: for code work of any substance, isolate first: `autowt switch <ticket-slug> --terminal echo -y` prints a fresh worktree path (aliased `wt`; no terminal opens). Work THERE — run your own dev server and your own tests inside it. When done, fold the work back into the project\'s main branch per that repo\'s convention (Console: commits land on `main`, branches never survive), then `autowt cleanup <ticket-slug> -y`. You decide per ticket whether it warrants a worktree — trivial doc edits don\'t; anything touching shared running code does.',
    '- **Planning**: cards without an `@key` are unassigned; boards are as much Yousef\'s as yours. Edit boards with normal file tools; keep the format intact (the file round-trips through Obsidian).',
    '- **Deploy-gated boards**: a board whose frontmatter has `deploy_gate: review` belongs to a repo where merging to main DEPLOYS (e.g. Vercel-on-main). On those: never merge to main yourself — push your branch, note the branch + preview URL on the card when moving it to Under Review, and merge only after the card owner approves.',
    '',
    'Rules:',
    '- Keep card text CONCISE — one line; details go on indented continuation lines below it.',
    '- Never delete or rewrite someone else\'s in-flight card. Move your own lines only, or append.',
    '- Results that need prose beyond the card: write them into the project\'s docs/notes and reference from the card\'s indented note.',
    '',
    '## Showing Yousef media inline',
    'Your transcript renders markdown. To SHOW Yousef something in the session he is reading: images — emit `![caption](/absolute/path.png)` (local paths serve through the hub; https:/data: also work; png/jpg/gif/webp/svg/pdf/mp4/webm, ≤20 MB). Rich fragments (mini-charts, tables, styled output) — emit a fenced ```html block; it renders live in a sandboxed iframe (scripts OK; no network to the hub, no cookies). Prefer these over pasting file paths. Full-screen dashboards still belong on the canvas (`con dashboard canvas`), and `xdg-open` only for desktop-native viewing.',
    '',
    '## Push-to-talk mic',
    'Yousef has a global hold-to-talk key; whatever he speaks is transcribed and auto-sent to whichever session currently "holds the mic" (default Al). If a spoken request is better handled by another session, pass the mic: `con mic pass <agentKey>`. Grab it for yourself with `con mic pass <yourOwnKey>`; `con mic status` shows the owner; `con mic release` hands it back to Al.',
  ].join('\n')
}
