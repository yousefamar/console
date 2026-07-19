# Console SPA — exhaustive feature inventory

Line-by-line crawl of all 51.7k lines of `src/` (13 agents, every file read in full).
This is the parity reference for the native Android app: every entry must be
PRESENT, DEGRADED (with a reason), or consciously N/A on mobile.

Total: 1321 features across 15 areas.


## agents (232)

1. **Read-aloud (TTS) button on every agent text block, hover-revealed**
   - Floating Volume2 button top-right on hover (always visible while speaking, shows Square to stop). Strips markdown (code blocks → '(code block)'); uses browser speechSynthesis chunked by sentence when voices exist, else falls back to hub POST /tts (espeak-ng) playing returned audio blob; toggling off cancels synthesis/pauses audio.
   - src: `src/components/AgentMessageBlock.tsx:65-141`
2. **@handoff(<key>) sentinel stripped from displayed agent text**
   - Regex-removed before markdown render; also collapses runs of 2+ spaces/tabs to one and trims trailing whitespace.
   - src: `src/components/AgentMessageBlock.tsx:68`
3. **Thinking block collapsible with char-count hint when collapsed**
   - Click toggles per-message collapsed state via store toggleThinkingCollapsed; collapsed shows '(N chars)' rounded up to nearest 100 when >100; expanded body is italic, max-h-60 scrollable.
   - src: `src/components/AgentMessageBlock.tsx:148-173`
4. **Tool-use row: click to expand/collapse the tool result**
   - Row shows tool icon (Read/Write=FileText, Edit=Pencil, Bash=Terminal, Glob/Grep=Search, WebSearch/WebFetch=Globe, default Terminal), tool name, and human-readable args (primary arg first, rest as key=value, skipping old_string/new_string/content/data/prompt); row turns red on error result; expanded result <pre> max-h-60, error styling when isError.
   - src: `src/components/AgentMessageBlock.tsx:179-217,376-402,693-705`
5. **Inline red/green diff table under Edit/Write tool calls, rendered by default (not behind expand)**
   - structuredPatch hunks rendered as table with gutter line numbers, +/- glyph column, green/red row tints, '···' hunk separators, max-h-96 scroll; capped at 80 lines with 'Show all N lines' expand button.
   - src: `src/components/AgentMessageBlock.tsx:241-306`
6. **+N/-N diff stat chip on tool-use row**
   - Counts added/removed lines across hunks; green +N and red -N in 10px mono next to the tool detail.
   - src: `src/components/AgentMessageBlock.tsx:224-239`
7. **EnterPlanMode renders as 'Entered plan mode' divider; ExitPlanMode renders 'Exited plan mode' divider + collapsible Plan card**
   - Plan card expanded by default, markdown-rendered plan body, toggle via header button.
   - src: `src/components/AgentMessageBlock.tsx:32-37,408-454`
8. **TodoWrite renders as a live checklist, not raw JSON**
   - Header shows 'Todos done/total' + current in-progress item (activeForm preferred); items get glyphs: green Check (completed, struck-through), spinning amber Loader (in_progress, bold, shows activeForm), Circle (pending); empty list renders nothing.
   - src: `src/components/AgentMessageBlock.tsx:38-40,470-512`
9. **Background task chip (bash-in-background / Task subagent) with lifecycle state**
   - Rounded chip labeled 'Agent' (local_agent) or 'Shell'; spinner while started, green check on completed, warning triangle+red on failed; description truncated at 40ch; completion summary appended '· summary' when different from label.
   - src: `src/components/AgentMessageBlock.tsx:312-335`
10. **Per-turn result footer: duration, ttft, cost, output tokens, stop reason, multi-model breakdown**
   - Single 10px line: 'X.Xs', 'ttft X.Xs' (tooltip 'Time to first token'), '$0.0000', 'N out'; stop_reason shown in warning color when ≠ end_turn; '· N models' when >1 model used; clicking expands per-model in/out tokens + cost with Bedrock ARN/us.anthropic prefixes shortened.
   - src: `src/components/AgentMessageBlock.tsx:342-372`
11. **User prompt block with 'You' label, attached-image thumbnails, and inline-markdown body**
   - Images render max-h-32 thumbnails above text; body rendered with inline markdown so hub-injected data-URL images (e.g. WhatsApp QR) display as <img>.
   - src: `src/components/AgentMessageBlock.tsx:518-540`
12. **Error block: red bordered box with warning icon**
   - Session errors render inline in the stream.
   - src: `src/components/AgentMessageBlock.tsx:546-553`
13. **Code fences render with language label and copy button ('copied' confirmation for 1.5s)**
   - navigator.clipboard.writeText; label uppercased, defaults to 'code'; horizontal scroll for long lines.
   - src: `src/components/AgentMessageBlock.tsx:559-590`
14. **```mermaid fences render as live SVG diagrams with source/diagram toggle and copy button**
   - Mermaid dynamically imported once (theme follows dark mode, securityLevel strict); render errors fall back to source view with error text; 'source'/'diagram' toggle; copy copies the mermaid source with 1.5s 'copied' state.
   - src: `src/components/AgentMessageBlock.tsx:599-687`
15. **Markdown-lite rendering in agent text: pipe tables, inline code, bold, italic, links, images, bare-URL autolinking**
   - Tables detected via header+separator lines, rendered as bordered table with markdown cells; links open in new tab with noopener; unsafe schemes (javascript:/data: hrefs) rendered as plain text (only http/https/mailto/tel//#/ allowed); bare URLs autolinked with trailing punctuation ([.,;:!?]) split back to text; markdown images render max-h-64 inline.
   - src: `src/components/AgentMessageBlock.tsx:708-897`
16. **Prompt textarea is uncontrolled — zero React renders per keystroke**
   - Text lives in a ref + DOM value; auto-resizes via rAF-scheduled height recompute, min 24px, max 50vh.
   - src: `src/components/AgentPromptInput.tsx:20-133`
17. **Enter sends; Ctrl/Cmd+Enter or Shift+Enter inserts newline; Shift+Cmd/Ctrl+Enter starts a NEW session with the typed prompt**
   - handleKeyDown: plain Enter preventDefault+send; Shift+(Meta|Ctrl)+Enter → handleNewSession keeping current dir.
   - src: `src/components/AgentPromptInput.tsx:362-373`
18. **Send routes to: follow-up message (active session) / resume past session / create new session**
   - Empty text with images sends 'What do you see in this image?'; clears input+images, closes slash menu, refocuses textarea; re-entrancy guarded by sendingRef.
   - src: `src/components/AgentPromptInput.tsx:253-289`
19. **Interrupt button (Square, warning color) replaces action buttons while session is running**
   - Calls store interrupt; tooltip 'Interrupt (Esc)'.
   - src: `src/components/AgentPromptInput.tsx:640-647`
20. **Slash-command autocomplete when input starts with '/'**
   - Opens dropdown filtered by prefix (case-insensitive) over session slashCommands; ArrowUp/Down navigate (selected item scrolled into view), Enter/Tab complete to '/cmd', Escape closes; mousedown on item also completes+focuses; menu closes when '/' prefix removed.
   - src: `src/components/AgentPromptInput.tsx:92-107,331-360,549-579`
21. **Working-directory picker with autocomplete (shown only when no active session and project dirs exist)**
   - Text input placeholder '~ (home directory)'; dropdown merges known Claude project dirs (substring match on full path or basename) with live hub filesystem completions; ArrowUp/Down navigate, Enter selects+focuses prompt, Tab selects but stays in dir field with caret at end (keep refining), Escape closes, blur closes after 150ms; 'clear' button resets selection.
   - src: `src/components/AgentPromptInput.tsx:56-90,375-436,457-508`
22. **Filesystem dir suggestions fetched from hub when input starts with / or ~, debounced 80ms with abort**
   - GET /agents/list-dirs?q=…; merged deduped after project dirs.
   - src: `src/components/AgentPromptInput.tsx:58-74`
23. **'Resume a past session' picker appears after selecting a directory**
   - Lists up to 5 past sessions for that cwd (first prompt + relative date: just now/Nm/Nh/Nd/Nw ago, then locale date); click toggles selection (highlighted) and focuses prompt; 'clear' (X) deselects; sending with a selection resumes that session; placeholder becomes 'Send a message to resume...'.
   - src: `src/components/AgentPromptInput.tsx:225-233,511-547,691-704`
24. **Image attach via paperclip button (file picker, multiple, image/* only) and clipboard paste**
   - Paste intercepts first image item and prevents default; files read as base64 data URLs; preview strip of 12x12px thumbnails each with hover-revealed × remove button; images sent as attachments with the prompt.
   - src: `src/components/AgentPromptInput.tsx:291-329,581-610,650-656`
25. **Voice dictation mic button — inserts streamed speech at the caret as editable text**
   - useDictation (browser SpeechRecognition, hub /stt fallback); mic pulses red while listening; committed chunks insert at caret respecting selection, auto-space only when gluing word chars; interim text appended visually and replaced on revision; sending auto-stops dictation; toggle-off refocuses textarea.
   - src: `src/components/AgentPromptInput.tsx:135-177,438-448,667-675`
26. **Push-to-talk 'compose' delivery: PTT transcript lands UNSENT in the mic-owner session's composer**
   - On composeSeq increment: switches to owner session if not active, APPENDS transcript to existing composer text (space-separated), sets caret to end, focuses; consumedComposeSeq ref initialized to current seq so remounts never re-drop an utterance; successive utterances accrue into one message.
   - src: `src/components/AgentPromptInput.tsx:179-223`
27. **Composer text mirrored to glasses on every keystroke**
   - useGlassesStore setComposerText('agents', value) in onInput/insert/clear paths so the lens composer echo row tracks typing.
   - src: `src/components/AgentPromptInput.tsx:221,250,629`
28. **New-session Plus button next to send (visible only with an active session)**
   - Starts a fresh session with the current text/images instead of following up; disabled when empty; tooltip 'New session (Shift+Cmd+Enter)'.
   - src: `src/components/AgentPromptInput.tsx:657-666`
29. **Prompt placeholder varies by context**
   - 'Message Al...' for Al session, 'Follow up...' for active session, 'Send a message to resume...' with a resume selection, else 'Start a new agent session...'; whole input hidden when hub not connected.
   - src: `src/components/AgentPromptInput.tsx:450,634`
30. **'Agent Hub not connected' empty state with start command**
   - Shows 'cd server && npm run dev' snippet when the agent WS is down.
   - src: `src/components/AgentSessionView.tsx:129-141`
31. **'No active session' empty state still shows the prompt input**
   - Type a prompt below to start a new agent session.
   - src: `src/components/AgentSessionView.tsx:143-157`
32. **Auto-scroll to bottom on new content only when already near bottom (<120px), forced after sending a prompt**
   - Sending a user_prompt force-scrolls and re-arms near-bottom flag; otherwise reading history is not disturbed.
   - src: `src/components/AgentSessionView.tsx:88-101`
33. **'Jump to bottom' floating pill button appears when scrolled >200px above bottom**
   - Smooth-scrolls to bottom on click.
   - src: `src/components/AgentSessionView.tsx:103-127,199-207`
34. **Infinite upward scroll: older messages load when scrollTop <100px, with scroll-position preservation and spinner**
   - loadOlderMessages(sessionId) guarded by hasOlder/!loadingOlder; scroll offset restored next frame after prepend; 'Loading older messages...' indicator at top.
   - src: `src/components/AgentSessionView.tsx:112-122,185-191`
35. **Tailing (message window-cap) enabled only while user is near bottom**
   - setTailing(sessionId, nearBottom) on scroll; on session switch tailing re-enabled and view jumps to bottom.
   - src: `src/components/AgentSessionView.tsx:78-86,110-111`
36. **Mobile swipe-right on message stream marks session read and returns to session list**
   - useSwipeActions with green Check reveal icon on left; mirrors mail swipe-to-archive UX; mobile only.
   - src: `src/components/AgentSessionView.tsx:62-72,166-178`
37. **Red 'NEW' unread divider between last-read and first unread message**
   - Shown when prev message timestamp ≤ lastReadTs < message timestamp and message isn't the user's own prompt.
   - src: `src/components/AgentSessionView.tsx:503-522`
38. **Status bar per-session model picker — selecting a model PINS the session; '(hub)' option unpins**
   - Select offers hub model + fallback chain + current pin (deduped); pinned shows amber Pin icon; tooltip explains pinned sessions ignore fleet-wide model changes and that changes apply immediately with context preserved; Al session shows a plain non-interactive model label instead.
   - src: `src/components/AgentSessionView.tsx:216-226,322-362`
39. **Status bar permission-mode badge when not 'default'**
   - Warning-colored 10px label (e.g. plan / acceptEdits).
   - src: `src/components/AgentSessionView.tsx:227-231`
40. **Status bar git branch with +added/-deleted line stats or dirty asterisk**
   - GitBranch icon + branch name truncated; green +N / red -N when stats present, yellow '*' when merely dirty.
   - src: `src/components/AgentSessionView.tsx:234-247`
41. **Context-usage meter: color-coded bar (gray/yellow >50%/red >80%) with used/window label and breakdown tooltip**
   - Numbers formatted k/M (e.g. '37k / 200k'); tooltip lists exact tokens plus per-category breakdown (system prompt/tools/messages/free space); hidden until contextUsed > 0.
   - src: `src/components/AgentSessionView.tsx:249-277`
42. **Active sub-agent counter in status bar with spinner and names tooltip**
   - 'N sub-agent(s)' in warning color; title lists active subagent descriptions.
   - src: `src/components/AgentSessionView.tsx:279-285`
43. **Cron pill in status bar opens the CronPanel for the session's scheduled prompts**
   - CronPill shows count for claudeSessionId (only non-disabled tasks make the status bar appear); click opens CronPanel; panel closable.
   - src: `src/components/AgentSessionView.tsx:52-55,287-288,306-309`
44. **Running status: spinner + status text ('Processing...' fallback) right-aligned in status bar**
   - Shown while session status is 'running' or statusText present (e.g. 'Waiting for model…', 'Context compacted').
   - src: `src/components/AgentSessionView.tsx:290-296`
45. **Live streaming tail: thinking preview, text with blinking cursor, and tool-input being typed**
   - Deltas flushed per animation frame but rendered via useDeferredValue so keystrokes preempt markdown re-render; 'Thinking...' spinner with italic scrolling preview (max-h-40); streaming text ends with pulsing cursor block.
   - src: `src/components/AgentSessionView.tsx:33-43,367-399`
46. **Live 'Edit being typed' tool-input preview mined from partial JSON**
   - Extracts file_path/path/url/pattern/query as label and tail of content/new_string/command/prompt/old_string as body (JSON escapes unescaped, capped to last 2000 chars with leading '…'), shown in a mono pre with pulsing cursor until finalized block lands.
   - src: `src/components/AgentSessionView.tsx:401-446`
47. **Tool approval overlay shown only for the active session's pending approval**
   - AgentToolApproval mounted when pendingApproval.sessionId === activeSessionId.
   - src: `src/components/AgentSessionView.tsx:300-301`
48. **tool_result/tool_diff/status blocks never render standalone; one bg-task chip per taskId showing latest lifecycle state at the started-event position**
   - Results/diffs paired to tool_use via O(1) toolUseId maps; status shown only in status bar; a completed background task doesn't leave both a spinner chip and a done chip.
   - src: `src/components/AgentSessionView.tsx:451-500`
49. **Session sidebar auto-connects to hub WS on mount and stays connected across pane switches**
   - connect() on mount; deliberately no disconnect on unmount
   - src: `src/components/AgentTab.tsx:82-87`
50. **Al session pinned at top of the session list**
   - Session with id 'al' rendered as dedicated AlListItem above all others
   - src: `src/components/AgentTab.tsx:65,297`
51. **Ended sessions stay visible in the list while unread**
   - filter keeps sessions where status!=='ended' OR hasUnread — a killed fork survives for audit until acknowledged; marking read removes it
   - src: `src/components/AgentTab.tsx:75-78`
52. **'Needs me' filter toggle (ListFilter icon) shows only alerted sessions**
   - Alerted = hasUnread || needsAttention || pendingApproval || status==='running'. Store-backed/persisted, shared between list and org-chart views; also filters Al out when not alerted; blue when active
   - src: `src/components/AgentTab.tsx:72-79,152-163`
53. **Delegation Tasks panel toggle with open-task count badge**
   - ClipboardList icon; violet badge shows count of tasks with status pending/in_progress/blocked; opens TasksPanel in a 70vh bottom-sheet (mobile) / 80vh centered modal (desktop), click backdrop to close
   - src: `src/components/AgentTab.tsx:51,166-189`
54. **View-mode toggle between session list and org chart**
   - List/Network icon button flips agentViewMode ('list'|'orgchart'); persisted via store (localStorage console:agents:viewMode)
   - src: `src/components/AgentTab.tsx:141-149,210`
55. **New session button (Plus) deselects and focuses the prompt input**
   - selectSession(null) then focuses [data-agent-input] after 50ms
   - src: `src/components/AgentTab.tsx:129-136,263-269`
56. **Connection status dot + label in sidebar header**
   - Green 'Connected' / red 'Disconnected' 6px filled circle
   - src: `src/components/AgentTab.tsx:270-279`
57. **Model-fallback amber banner when a model dies**
   - Shows '<failedModel> was unavailable — agents fell back to <model>' with monospace ids; dismissible via Check button
   - src: `src/components/AgentTab.tsx:283-293`
58. **Mic ownership store initialized on Agents tab mount**
   - useMicStore.getState().init() subscribes hub SyncBus 'mic' service
   - src: `src/components/AgentTab.tsx:90`
59. **Cron store refreshed for all sessions every 30s**
   - refreshAllCron on mount + 30_000ms interval so sidebar per-row cron counts stay current across clients
   - src: `src/components/AgentTab.tsx:94-99`
60. **Session list re-fetched every 10s to keep backgroundProcessCount live**
   - listSessions() on 10_000ms interval — hub only recomputes bg-process count on getInfo()
   - src: `src/components/AgentTab.tsx:101-109`
61. **Ctrl/Cmd+Z undo and Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redo for org-chart reparents/renames**
   - Only while Agents pane active and focus not in input/textarea/contentEditable (keeps native undo in text fields)
   - src: `src/components/AgentTab.tsx:114-127`
62. **Mobile shows list OR session view, never both**
   - showList = !activeSessionId && !creatingNewSession; showDetail = activeSessionId || creatingNewSession || !connected; desktop always shows both (w-72 sidebar)
   - src: `src/components/AgentTab.tsx:138-139,255-256`
63. **Org-chart mode: left-click agent node opens its live session; folders/parked roles open the info dialog instead**
   - handlePickRole finds live (non-ended) session by agentKey, else openRoleInfo
   - src: `src/components/AgentTab.tsx:211-215`
64. **Org-chart desktop layout: chart in 42% left panel (min 340px, max 640px), chat view right; mobile shows one at a time**
   - Mirrors Notes circles-view + editor layout
   - src: `src/components/AgentTab.tsx:231-249`
65. **Handoff banner: 'Al suggests you talk to <agent>' with Talk → and dismiss (X) buttons**
   - Fixed bottom-center violet-bordered bar; Talk calls acceptHandoff(targetAgentKey); title resolved from agentRoles by key with key fallback
   - src: `src/components/AgentTab.tsx:190-196`
66. **'Back to Al' floating pill after accepting a handoff**
   - Fixed bottom-left; shown only when handoffReturnTo set and no pending handoff; calls returnFromHandoff
   - src: `src/components/AgentTab.tsx:197-201`
67. **Agent quick switcher overlay**
   - AgentQuickSwitcher rendered when showAgentSwitcher store flag set
   - src: `src/components/AgentTab.tsx:181`
68. **Role info modal (AgentInfoDialog) with Escape-to-close and backdrop-click-to-close**
   - Centered (bottom sheet on mobile), max-h 85vh scrollable, hosts AgentProfilePanel keyed by roleKey
   - src: `src/components/AgentTab.tsx:398-420`
69. **Empty state text in session list**
   - 'Nothing needs you' when filterAlerted active, else 'No active sessions' — only when connected and no Al shown
   - src: `src/components/AgentTab.tsx:299-305`
70. **Backend switch segmented control: 'Max sub' vs 'Bedrock'**
   - Two-button segmented control above model picker; tooltips explain cost/limit tradeoffs; disabled while disconnected or switching; spinner while switching; error text shown below on failure; switching rewrites hub auth env + model chain + respawns fleet
   - src: `src/components/AgentTab.tsx:756-808`
71. **Fleet model picker <select> in sidebar footer**
   - Lists current chain (entries after first labeled '(fallback N)'), then Direct first-party and Bedrock optgroups of known ids not already in the chain; active model always selectable even if not in chain; changing restarts live sessions onto the new model
   - src: `src/components/AgentTab.tsx:343-373`
72. **Model picker locked by CLAUDE_MODEL env var**
   - Select disabled + amber 'env' badge with tooltip when agentModelLockedByEnv; also disabled when disconnected or chain empty
   - src: `src/components/AgentTab.tsx:348-349,374-376`
73. **Session row context menu: Rename**
   - Turns row into inline input pre-filled with current name, text selected; Enter/blur commits (only if changed and non-empty), Escape cancels
   - src: `src/components/AgentTab.tsx:500-513,517,624-637`
74. **Session row context menu: Generate title**
   - Calls generateTitle(sessionId); row shows italic 'Generating title…' while in flight
   - src: `src/components/AgentTab.tsx:518,643-647`
75. **Session row context menu: Reload history**
   - reloadSessionHistory(sessionId)
   - src: `src/components/AgentTab.tsx:519`
76. **Session row context menu: Fork**
   - forkSession(sessionId)
   - src: `src/components/AgentTab.tsx:520`
77. **Session row context menu: Show info (role-backed sessions only)**
   - Prepended when session.agentKey set; opens role profile modal
   - src: `src/components/AgentTab.tsx:522-524`
78. **Session row context menu: Mark unread**
   - Mobile-reachable equivalent of Shift+E / swipe-left
   - src: `src/components/AgentTab.tsx:526`
79. **Session row context menu: Give mic to this agent / Release mic to Al**
   - Toggles PTT mic owner via useMicStore.setMic(sessionId | 'al')
   - src: `src/components/AgentTab.tsx:528-530`
80. **Session row context menu: Merge into parent**
   - Shown for non-ended sessions that are forks (parentClaudeSessionId) OR org children with a manager (agentKey != 'al'); folds knowledge into the parent instead of discarding
   - src: `src/components/AgentTab.tsx:444-446,533-535`
81. **Session row context menu: End session (destructive)**
   - killSession(id); hidden for already-ended sessions
   - src: `src/components/AgentTab.tsx:536-542`
82. **Mobile swipe-right on a session row marks it read**
   - useSwipeActions; green Check icon reveals under the row; also cancels the long-press-drag timer at swipe start
   - src: `src/components/AgentTab.tsx:481-491,549-557`
83. **Mobile swipe-left on a session row marks it unread**
   - Blue filled circle icon reveals on right side
   - src: `src/components/AgentTab.tsx:488,558-566`
84. **Desktop drag-and-drop session reorder, restricted to same cwd group**
   - HTML5 drag with application/x-agent-cwd payload; cross-group drop is a no-op; drop target shows 2px top border highlight; onReorder(fromId, toId)
   - src: `src/components/AgentTab.tsx:573-600`
85. **Mobile long-press (500ms) on a session row arms drag-reorder**
   - Row becomes draggable + opacity 0.5; touchend clears timer and restores opacity
   - src: `src/components/AgentTab.tsx:601-614`
86. **Fork sessions display a GitBranch glyph with the '(fork)' suffix stripped from the name**
   - isFork detected by /\s\(fork\)$/ on session.name; shows bare parent name
   - src: `src/components/AgentTab.tsx:493-497,646`
87. **@amar attention marker on session row: red left rail + red tint + AlertCircle badge**
   - border-l-2 red-500 + bg-red-500/5; badge tooltip shows the attention snippet or fallback text
   - src: `src/components/AgentTab.tsx:619,651-658`
88. **Session row subtitle shows statusText or last text/user_prompt snippet (100 chars)**
   - Walks messagesBySession backwards for the latest text or user_prompt block
   - src: `src/components/AgentTab.tsx:451-461,692-696`
89. **'ended' label on terminated sessions**
   - Uppercase 9px tag; ended sessions render name in tertiary color
   - src: `src/components/AgentTab.tsx:659-661`
90. **Background-process badge per session row (Terminal icon + count)**
   - Amber; shows session.backgroundProcessCount from hub ps -eo pid,ppid on the claude PID; tooltip explains
   - src: `src/components/AgentTab.tsx:465,662-670`
91. **Cron badge per session row (Clock icon + count)**
   - Blue; counts non-disabled scheduled prompts keyed by claudeSessionId
   - src: `src/components/AgentTab.tsx:467-471,671-679`
92. **Unread dot on session row**
   - 5px blue filled circle; unread also renders name font-semibold
   - src: `src/components/AgentTab.tsx:644,680-682`
93. **Hibernation moon glyph on idle-reaped sessions**
   - Moon icon with tooltip 'Hibernated — subprocess reaped to save memory; wakes on next message'; hidden if ended
   - src: `src/components/AgentTab.tsx:683-687`
94. **Status dot: only 'running' shows an amber dot; idle/ended show nothing**
   - Deliberate — absence means fine (avoids green-vs-orange confusion)
   - src: `src/components/AgentTab.tsx:814-819`
95. **Mic adornment on each session row: owner always visible (red when recording), others revealed on hover/active**
   - Click toggles ownership (owner→release to Al, else take mic); rendered as span (nested-button-invalid workaround); tooltips per state
   - src: `src/components/AgentTab.tsx:827-847`
96. **Al pinned entry shows last text preview (80 chars) + mic button + status dot**
   - No context menu, no drag, no badges — simplified row
   - src: `src/components/AgentTab.tsx:708-747`
97. **Sessions grouped by cwd into collapsible folder sections with fork-lineage indentation inside**
   - buildGroupTree + peelUniversalRoot; indent = 8 + depth*10 px; arrangeLineage nests forks under parents
   - src: `src/components/AgentTab.tsx:306-330,850-872`
98. **Collapsed group header shows aggregate badges: running dot, unread count, total count**
   - Recursively rolled up over descendants; chevron + Folder/FolderOpen icons; header tooltip = full path; click toggles collapsed (persisted in store)
   - src: `src/components/AgentTab.tsx:876-923`
99. **AskUserQuestion approval UI with option buttons + free-text answer**
   - Options render as toggle buttons (label + '— description'); single-select clears others, multiSelect allows many; free text appended to answer; answer schema Record<question,string[]>
   - src: `src/components/AgentToolApproval.tsx:45-123,164-193`
100. **AskUserQuestion multi-question paging: prev/next chevrons, per-question dot indicators, page counter**
   - Header 'Claude is asking · N/M'; dots clickable to jump, filled blue when current, half-blue when answered; Send button disabled until every question answered, shows 'Send all (answered/total)'
   - src: `src/components/AgentToolApproval.tsx:146-252`
101. **AskUserQuestion keyboard: Enter advances page or sends on last; Cmd/Ctrl+Enter sends from anywhere**
   - Shift+Enter inserts newline (unhandled); textarea auto-focused on each page change and new approval
   - src: `src/components/AgentToolApproval.tsx:71-73,128-137`
102. **AskUserQuestion state resets when a new approval requestId arrives**
   - Answers, selections, and page reset to blank/0
   - src: `src/components/AgentToolApproval.tsx:62-68`
103. **AskUserQuestion normalizes legacy single-question input shape**
   - Accepts input.questions[] or legacy top-level question/options/multiSelect; renders nothing if no questions; optional per-question uppercase header label
   - src: `src/components/AgentToolApproval.tsx:51-55,139,159-161`
104. **ExitPlanMode approval: plan rendered as lite-markdown in a scrollable (50vh) review box with Approve (y) / Reject (n) buttons**
   - Reject denies with reason 'Plan rejected'; kbd hints on buttons
   - src: `src/components/AgentToolApproval.tsx:262-303`
105. **Generic tool permission sheet: Allow (y) / Deny (n) / 'Allow all <tool>' (a)**
   - Bottom sheet slides up; Deny sends 'Denied by user'; Allow-all auto-approves that tool name for the session
   - src: `src/components/AgentToolApproval.tsx:309-358`
106. **Tool input previews specialized per tool**
   - Bash → monospace command block with Terminal icon; Edit → file path + red strikethrough old_string / green new_string diff box (max-h 24); Write → file path + '(N chars)'; default → pretty-printed JSON block
   - src: `src/components/AgentToolApproval.tsx:365-411`
107. **Org chart: canvas node-link tree with d3 pan/zoom (wheel/pinch/drag empty space)**
   - Zoom clamped 0.25–2.5x; gestures over nodes/toggles filtered out of d3-zoom so they don't fight click/drag; cursor grab/grabbing; auto-fits to width on first layout and when the focus filter toggles
   - src: `src/components/agent/AgentOrgChart.tsx:331`
108. **Org chart: click a node opens the agent's session (or selects the folder)**
   - Click = pointer travel under 6px; onPick(roleKey)
   - src: `src/components/agent/AgentOrgChart.tsx:453`
109. **Org chart: drag a node onto another to reparent; drop on empty space cancels**
   - 6px threshold before a press becomes a drag; Al (root) never draggable; own subtree excluded as drop target; live hint tooltip follows cursor ('Into <folder>' / 'To top level' (drop on Al) / 'Report to <agent>' / 'Release to cancel'); drop applies setAgentManager optimistically; positions lerp (0.28/frame) so nodes slide
   - src: `src/components/agent/AgentOrgChart.tsx:461`
110. **Org chart: ＋/－ toggle circle collapses/expands a subtree, persisted per device**
   - Collapsed keys in localStorage 'console:agents:orgCollapsed'; collapsed toggle drawn indigo with descendant-count badge next to it
   - src: `src/components/agent/AgentOrgChart.tsx:68`
111. **Org chart: right-click or 500ms touch long-press opens a per-node context menu**
   - Long-press cancelled if pointer moves past 6px; menu at cursor coords
   - src: `src/components/agent/AgentOrgChart.tsx:403`
112. **Org context menu items: Show info / Open / Fork / Merge into parent / Reload history / Reload role / Revive / Delegate task… / Rename / New folder inside / Move to top level / Park / Delete**
   - Conditional: live session → Open/Fork/Reload x2 (+Merge if fork-parent or manager exists); parked → Revive; Delegate prompts for a brief via showPrompt then delegate(key, brief); Rename prompts (not for Al); 'New folder inside' only on folders/Al; 'Move to top level' when not Al and has a manager; Park (kill live session, destructive) and Delete role/folder (confirm dialog: folder → 'Its children become roots.', agent → 'removes role file and kills any live session') never for Al
   - src: `src/components/agent/AgentOrgChart.tsx:483`
113. **Org chart node status dot: red attention > amber running > blue unread; no dot = fine**
   - Deliberately no green idle dot; dot shifts up when a badge row exists
   - src: `src/components/agent/AgentOrgChart.tsx:237`
114. **Org chart node badges: violet ↓ delegated-task count, amber shell count, blue cron count**
   - Task badge = open (pending/in_progress/blocked) tasks assigned to the role; shell = backgroundProcessCount; cron = non-disabled hub cron tasks bound to the session's claudeSessionId; drawn bottom-left of node, mirrors sidebar list badges
   - src: `src/components/agent/AgentOrgChart.tsx:254`
115. **Org chart: active delegation edges render yellow with marching dashes**
   - Edges on any open task's chain (consecutive hops) drawn #eab308 dashed [6,4] with animated dashOffset (0.5px/frame rAF loop that stays alive while any active edge exists); inactive edges are gray bezier curves
   - src: `src/components/agent/AgentOrgChart.tsx:177`
116. **Org chart node visual language: fork = violet border + italic violet title (" (fork)" suffix stripped); parked = dashed border + dimmed title; active session = blue border/slate fill; dangling-manager or broken-cycle = amber border; folders = dashed-border box with folder glyph and ·childCount**
   - Drop target gets thicker blue border; dragged origin fades to 35% alpha and a shadowed ghost follows the cursor; titles ellipsized to node width
   - src: `src/components/agent/AgentOrgChart.tsx:197`
117. **Org chart toolbar: New folder / Collapse all / Expand all buttons (top-right)**
   - New folder prompts for a name (top-level); collapse-all persists every collapsible non-Al key; hidden while the 'needs me' filter is on
   - src: `src/components/agent/AgentOrgChart.tsx:554`
118. **'Needs me' filter prunes the chart to alerted roles and their ancestors**
   - Alerted = live session with unread, needsAttention, pending approval, or status running; manual collapse ignored while filtering; chart re-fits when the filter toggles; '<=1 node' shows 'Nothing needs you' overlay
   - src: `src/components/agent/AgentOrgChart.tsx:78`
119. **Org chart help legend bottom-left**
   - 'click to open · right-click for menu · drag onto a folder/agent to move · ＋/－ to collapse'; while filtered: 'focused on what needs you · clear the filter to see everyone'; 'No agent roles yet' empty state when there are zero nodes
   - src: `src/components/agent/AgentOrgChart.tsx:564`
120. **Agent profile panel header: title, key, 'parked' marker; folder titles editable inline**
   - Folder title is an input committing on blur/Enter via renameRole; agents show 'key · parked' when no live session; X closes; 'Role not found.' fallback
   - src: `src/components/agent/AgentProfilePanel.tsx:49`
121. **Profile panel action buttons: Open / Reload / Park (live) or Revive (parked) / Delete**
   - Open selects the live session; Reload respawns it; Park kills it (hidden for Al); Revive fresh-spawns a parked role; Delete confirms (danger dialog, folder vs agent wording) then deleteRole + closes panel; Al can never be parked/deleted/reparented
   - src: `src/components/agent/AgentProfilePanel.tsx:65`
122. **Profile panel 'Reports to'/'Inside' manager dropdown**
   - All other roles alphabetized, folders prefixed 📁, '— (root)' option = null manager; change applies setAgentManager immediately; hidden for Al
   - src: `src/components/agent/AgentProfilePanel.tsx:88`
123. **Profile panel read-only Goals / Charter / Memory sections + role file path**
   - Charter body split at '## Memory' heading; empty charter shows '— (the agent maintains this in its file)'; file path ~/.config/console/agents/<key>.md shown as code; agent-owned, edited only via the .md file
   - src: `src/components/agent/AgentProfilePanel.tsx:100`
124. **Agent quick switcher ('/' on Agents pane): fuzzy-jump to any agent**
   - Modal overlay listing live non-ended sessions plus parked roles (excl. folders and Al); empty query ordered Al first, then live sessions, then parked, alphabetical within; fuzzy match: contiguous substring ranked by position beats scattered subsequence (1000+firstIdx); works over list and org-chart views
   - src: `src/components/agent/AgentQuickSwitcher.tsx:11`
125. **Quick switcher picking a parked role revives it and auto-opens on spawn**
   - Sets pendingSessionActivate=true then reviveAgent(key); live sessions selectSession directly; closes after pick
   - src: `src/components/agent/AgentQuickSwitcher.tsx:53`
126. **Quick switcher row indicators: violet branch icon for forks, amber dot for running, 'parked · revive' tag**
   - ' (fork)' suffix stripped from displayed title; mouse hover moves selection; footer hints '↑↓ navigate · ↵ jump · esc close'
   - src: `src/components/agent/AgentQuickSwitcher.tsx:90`
127. **Quick switcher keyboard: ArrowUp/Down or Ctrl+N/P, Enter jumps, Esc closes**
   - Selection clamped and scrolled into view; backdrop click closes; 'No agents match' empty state
   - src: `src/components/agent/AgentQuickSwitcher.tsx:60`
128. **Cron side panel per session listing scheduled prompts**
   - Right-docked 320px panel keyed by claudeSessionId; refreshes task list on open/session change; empty state 'No scheduled prompts for this session.'; returns null when session has no claudeSessionId
   - src: `src/components/agent/CronPanel.tsx:18-76`
129. **Plus button toggles cron create form (icon rotates 45° when open)**
   - Title flips 'New scheduled task'/'Hide form'
   - src: `src/components/agent/CronPanel.tsx:36-43`
130. **X button closes cron panel**
   - onClose callback
   - src: `src/components/agent/CronPanel.tsx:44-46`
131. **Cron task row shows Repeat icon for recurring vs Calendar icon for one-shot**
   - 10px icon before the trigger
   - src: `src/components/agent/CronPanel.tsx:95`
132. **Cron task row shows trigger expression as monospace code, truncated**
   - Plus a red 'disabled' label when task.disabledAt set
   - src: `src/components/agent/CronPanel.tsx:97-100`
133. **Cron task prompt shown clamped to 2 lines with full text in title tooltip**
   - line-clamp-2 break-words
   - src: `src/components/agent/CronPanel.tsx:102-104`
134. **Cron task row shows 'next in Xs/m/h/d' computed client-side via croner nextRun**
   - Hidden when task disabled or trigger unparseable; formatRelativeIn: <60s→s, <60m→m, <24h→h, else d; 'now' when ≤0
   - src: `src/components/agent/CronPanel.tsx:82-106,314-323`
135. **Cron task row shows 'fired Xm ago' since lastFiredAt**
   - Same s/m/h/d relative formatting
   - src: `src/components/agent/CronPanel.tsx:86,107,325-333`
136. **Cron task row shows yellow guard-skip reason with consecutive-skip count tooltip**
   - 'skip: <lastSkipReason>' with title '<N> consecutive skips'
   - src: `src/components/agent/CronPanel.tsx:108`
137. **Run-now button (Play icon) fires a cron task immediately**
   - Calls store runOnce(taskId)
   - src: `src/components/agent/CronPanel.tsx:112-114`
138. **Delete button (Trash icon) removes a cron task with no confirmation**
   - Calls store remove(taskId) directly
   - src: `src/components/agent/CronPanel.tsx:115-117`
139. **Cron create form: Recurring / One-shot mode toggle buttons**
   - Recurring uses cron expression (default '*/5 * * * *'); one-shot uses datetime-local defaulting to now+30min
   - src: `src/components/agent/CronPanel.tsx:128-135,188-199`
140. **Cron expression live preview of next 3 fire times**
   - Rendered as 'next: <locale strings joined by ·>' below the input; invalid expression shows the croner error message in red instead
   - src: `src/components/agent/CronPanel.tsx:143-159,210-215`
141. **One-shot datetime validation: 'Invalid datetime' / 'Datetime is in the past' errors**
   - Schedule button disabled while error present
   - src: `src/components/agent/CronPanel.tsx:161-169`
142. **One-shot quick-set chips +15m / +1h / +1d**
   - Set the datetime-local input to now+offset in local time
   - src: `src/components/agent/CronPanel.tsx:225-242`
143. **Cron prompt textarea (3 rows) — sent verbatim on each fire; Schedule button disabled when empty or trigger invalid or submitting**
   - One-shot trigger converted to ISO; on success prompt clears and form closes; server error shown in red
   - src: `src/components/agent/CronPanel.tsx:171-268`
144. **ICS calendar-subscription row at cron panel bottom with copy button**
   - Fetches token on mount; label 'Calendar URL (public)' vs '(tailnet)' with explanatory tooltip; Copy writes URL to clipboard and shows 'copied' for 1.5s; row hidden when no URL
   - src: `src/components/agent/CronPanel.tsx:276-310`
145. **'cron: N' pill in session status bar opens the cron panel**
   - Counts only non-disabled tasks; hidden when 0; refreshes on mount + polls every 30s for cross-client mutations (CLI/mobile)
   - src: `src/components/agent/CronPill.tsx:15-40`
146. **Delegation TasksPanel: open tasks (pending/in_progress/blocked) on top sorted by updatedAt desc, then up to 8 recent terminal tasks under a 'Recent' divider**
   - Header shows '· N open'; empty state 'No tasks yet'; X closes panel
   - src: `src/components/agent/TasksPanel.tsx:7-39`
147. **Task status badge color-coding**
   - pending=tertiary, in_progress=amber, blocked=red, done=green, failed=red, cancelled=struck-through tertiary; underscores rendered as spaces
   - src: `src/components/agent/TasksPanel.tsx:42-49,62`
148. **Task row shows from→to with clickable assignee name opening its live session**
   - openAssignee finds live (non-ended) session by agentKey and selectSession; also an explicit 'open' Play button
   - src: `src/components/agent/TasksPanel.tsx:19-22,64-73`
149. **Task cancel button (Ban icon) on open tasks only**
   - Calls cancelTask(id); not shown on recent/terminal rows
   - src: `src/components/agent/TasksPanel.tsx:34,74`
150. **Task row shows delegation chain with 'Yousef → …' prefix for human-origin tasks**
   - Chain of role titles joined with →, truncated with full chain in tooltip; result text clamped to 2 lines
   - src: `src/components/agent/TasksPanel.tsx:57,69-71`
151. **Org chart layout: Al is root; manager edges nest agents; managerless/dangling/cyclic-manager roles hang under Al**
   - Cycle in manager chain treated as top-level; dangling manager annotated on node; folders (roles flagged folder) sort before agents within a level, then alphabetical by title
   - src: `src/components/agent/agent-orgchart-helpers.ts:57-97`
152. **Org chart 'needs me' filter prunes tree to alerted nodes plus their ancestor chain**
   - A node survives if in filterKeys or any descendant is; Al always kept
   - src: `src/components/agent/agent-orgchart-helpers.ts:103-118`
153. **Org chart collapse/expand toggle circle on a parent node's right edge, with '+N' descendant-count badge when collapsed**
   - Hit radius TOGGLE_R=11px (+3 slack); collapsed subtrees pruned from layout but full-tree descendant counts preserved
   - src: `src/components/agent/agent-orgchart-helpers.ts:119-178`
154. **Org chart reparent drag forbids dropping a node onto its own subtree**
   - subtreeKeys computes inclusive descendant set as illegal drop targets
   - src: `src/components/agent/agent-orgchart-helpers.ts:191-204`
155. **Sidebar session ordering: sessions clustered into a cwd group tree, ordered by persisted flat sessionOrder (ties broken newest createdAt first)**
   - Nested cwds nest under longest sessioned ancestor with relative-path labels; '' bucket labelled '(no directory)'; single universal root group header is peeled (its sessions promoted to top level)
   - src: `src/components/agent/session-tree.ts:25-105`
156. **Fork sessions render nested directly after their parent, one indent deeper**
   - Via parentClaudeSessionId lineage; fork whose parent isn't in the list is treated as a root
   - src: `src/components/agent/session-tree.ts:119-142`
157. **j/k session cycling skips sessions inside collapsed groups**
   - flattenSidebarOrder excludes collapsed cwds so cycling matches visible order; Al excluded (callers prepend)
   - src: `src/components/agent/session-tree.ts:147-160`
158. **Agents keys: '/' agent fuzzy switcher, y/n/a approve/deny/auto-approve pending tool, E mark unread, e mark read, j/k or arrows next/prev session, Enter focus prompt input**
   - y/n/a only apply when pending approval is NOT AskUserQuestion; a = autoApproveTool(toolName) (allow-all for that tool); Enter focuses [data-agent-input].
   - src: `src/hooks/useKeybindings.ts:187-251`
159. **Agent WS auto-reconnect with backoff**
   - On unintentional close, reconnect after 3s; after 5 failed attempts the delay becomes 10s. Manual disconnect suppresses reconnection.
   - src: `src/store/agent.ts:985-997`
160. **Notification suppression during replay**
   - On WS open all notifications are suppressed for 2 seconds while the hub replays sessions_list + message history, so reconnects don't spam 'finished'/'attention' notifications.
   - src: `src/store/agent.ts:954-961`
161. **In-memory message window cap while tailing**
   - While the user is near the bottom (tailing, default true), a session's in-memory messages are capped at 300; older ones stay hub-side and flip hasOlder=true so a 'load older' affordance appears on scroll-up. Scrolling up (setTailing false) disables the cap.
   - src: `src/store/agent.ts:14,1764-1770`
162. **Create session**
   - createSession(prompt, cwd?, images?, name?) sends create_session over WS; sets pendingSessionActivate so the resulting session_created auto-activates only for the requesting client; clears any pending approval.
   - src: `src/store/agent.ts:475-489`
163. **Send message auto-marks session read**
   - sendMessage optimistically sets lastReadIndex past the log and hasUnread=false locally (hub also auto-marks and broadcasts session_read_state for cross-device sync); records the last message timestamp for the unread divider.
   - src: `src/store/agent.ts:491-503`
164. **/clear command wipes the session's chat UI**
   - Typing exactly '/clear' clears messagesBySession for the session, drops buffered (not-yet-flushed) appends so a later rAF flush can't resurrect rows, and clears pending text/thinking deltas; no user_prompt bubble is added.
   - src: `src/store/agent.ts:506-518`
165. **User message echoes with image previews**
   - Sent messages render immediately as a user_prompt bubble; attached images render as data-URL previews; session status flips to 'running'.
   - src: `src/store/agent.ts:520-527`
166. **Approve tool (echoes original input)**
   - approveTool finds the approval in the per-session map (works for non-active sessions too) and sends approve_tool with modifiedInput = caller override OR the original tool input unchanged (CLI requires updatedInput); clears the approval locally.
   - src: `src/store/agent.ts:530-542`
167. **Deny tool with optional reason**
   - denyTool sends deny_tool {requestId, reason} and clears the approval.
   - src: `src/store/agent.ts:544-549`
168. **Allow-all for a tool ('a' key)**
   - autoApproveTool adds the tool name to a session-lifetime (in-memory, not persisted) auto-approve set and immediately approves any pending approval for that tool; future approval_required for that tool auto-approve silently.
   - src: `src/store/agent.ts:552-559,1425-1428`
169. **Interrupt active session (Esc)**
   - interrupt sends interrupt for the active session only — aborts the turn, never kills the session.
   - src: `src/store/agent.ts:561-565`
170. **Kill session**
   - killSession sends kill_session (hub marks ended but keeps it listed/readable).
   - src: `src/store/agent.ts:567-569`
171. **Mobile back-to-list without new-session mode**
   - goToSessionList clears activeSessionId WITHOUT setting creatingNewSession (unlike selectSession(null)), so the 10s auto-select doesn't yank the user back into a session; also clears the notifications module's active-session marker.
   - src: `src/store/agent.ts:571-574`
172. **Selecting a session does NOT mark it read**
   - selectSession snapshots the last-read timestamp of the session being LEFT (for the unread divider), re-projects that session's pending approval into the denormalized view, and deliberately does NOT clear unread or the @amar marker (chat-style: read only on reply or explicit 'e'). Requests history from the hub if no messages loaded yet.
   - src: `src/store/agent.ts:576-599`
173. **j/k session cycling follows the visible sidebar order**
   - selectNext/PrevSession iterate exactly what the sidebar renders: Al pinned first, custom sessionOrder clustering by cwd, fork lineage nesting, collapsed groups skipped, 'needs me' filter applied (alerted = unread OR needsAttention OR pending approval OR running); ended-but-unread sessions remain visible; clamped at ends.
   - src: `src/store/agent.ts:601-625,1868-1879`
174. **Hub-wide agent model switch**
   - setAgentModel sends set_model — hub persists it and restarts live sessions on the new model; picker disabled when agentModelLockedByEnv (CLAUDE_MODEL env override).
   - src: `src/store/agent.ts:631-633`
175. **Auth backend toggle (Max subscription ↔ Bedrock)**
   - setAgentBackend POSTs /agents/backend over HTTP; throws with the server error on failure; optimistically sets agentBackend, then the model_state broadcast confirms with the full chain. Switching forces every live session to respawn.
   - src: `src/store/agent.ts:635-649`
176. **Per-session model pin**
   - setSessionModel(sessionId, model|null) pins ONE session to a model mid-session (in-place set_model with respawn fallback); null unpins back to hub-wide model. Pinned sessions show an amber pin icon and skip fleet-wide model changes.
   - src: `src/store/agent.ts:651-653`
177. **Model-fallback banner**
   - When model_state arrives with autoFellBack, a dismissible notice {failedModel, model} is set AND a desktop/push notification fires ('Agent model fell back: X unavailable — switched to Y'); dismissModelFallbackNotice clears it.
   - src: `src/store/agent.ts:655,1120-1137`
178. **Org-chart reparent with optimistic update**
   - setAgentManager patches the role's manager locally so the chart reparents instantly (hub agents_list broadcast reconciles/reverts on rejection e.g. cycle), no-ops if dropped on the current parent, and pushes an undo entry by default.
   - src: `src/store/agent.ts:657-666`
179. **Org-chart undo/redo (Ctrl+Z/Ctrl+Y)**
   - undoOrg/redoOrg walk orgPast/orgFuture stacks covering reparent and rename edits (folder create/delete not undoable — key is hub-minted async); replayed with record=false so they don't re-push history.
   - src: `src/store/agent.ts:682-698`
180. **'Needs me' filter toggle**
   - toggleFilterAlerted flips a filter shared by the session list and org chart (alerted subtree only); persisted device-locally to localStorage 'console:agents:filterAlerted'.
   - src: `src/store/agent.ts:668-674`
181. **Role info modal open/close**
   - openRoleInfo(agentKey)/closeRoleInfo drive the centered role-profile dialog (charter/goals/Memory, manager dropdown, revive/reload/park/delete).
   - src: `src/store/agent.ts:676-677`
182. **'/' agent quick-switcher**
   - openAgentSwitcher/closeAgentSwitcher toggle a fuzzy-find-agent-by-name jump dialog.
   - src: `src/store/agent.ts:679-680`
183. **Revive parked role**
   - reviveAgent(agentKey) sends revive_agent — spawns a fresh session for a parked org role.
   - src: `src/store/agent.ts:700-702`
184. **Reload session (re-derives charter)**
   - reloadSession sends reload_session — role-backed sessions fresh-spawn with re-derived charter; others respawn via --resume with history preserved.
   - src: `src/store/agent.ts:704-706`
185. **Delete role**
   - deleteRole kills the role's live session and removes its file (orphaned children become roots).
   - src: `src/store/agent.ts:708-710`
186. **Create org folder**
   - createFolder(title, manager?) creates an organization-only folder node (no session, drag-drop target, renamable).
   - src: `src/store/agent.ts:712-714`
187. **Rename role with optimistic title + undo**
   - renameRole updates the title locally immediately, sends rename_role, and pushes an undo entry (no-op if unchanged).
   - src: `src/store/agent.ts:716-723`
188. **List/org-chart view toggle**
   - setAgentViewMode('list'|'orgchart') persists to localStorage 'console:agents:viewMode' (device-local) and flips the Agents pane between session list and canvas org chart.
   - src: `src/store/agent.ts:725-728,406`
189. **Delegate task to a role**
   - delegate(toKey, brief, fromKey='al') sends a delegate WS message — hub creates a task and wakes the assignee's session.
   - src: `src/store/agent.ts:730-732`
190. **Cancel delegation task (optimistic)**
   - cancelTask optimistically flips the task to 'cancelled' locally then sends cancel_task.
   - src: `src/store/agent.ts:734-737`
191. **Hand-off banner: accept / dismiss / return**
   - session_handoff (Al emitted @handoff(key)) sets pendingHandoff → a 'Talk to X' banner. acceptHandoff opens the target's live session (or revives the parked role) and records Al as handoffReturnTo for a '↩ Back to Al' control; dismissHandoff drops the offer; returnFromHandoff jumps back and clears the marker.
   - src: `src/store/agent.ts:739-754,1098-1103`
192. **Thinking block collapse toggle**
   - toggleThinkingCollapsed flips collapsed on a thinking message in the active session; historical/finalized thinking blocks arrive collapsed:true, live-streamed ones flush collapsed:false.
   - src: `src/store/agent.ts:756-773`
193. **Mark-read on an ENDED session deletes it**
   - markSessionRead on a status:'ended' session removes it locally immediately and sends delete_session — an ended fork lingers in the list only while unread; reading it acknowledges and removes it for good.
   - src: `src/store/agent.ts:775-790`
194. **Mark session read ('e') clears unread + @amar marker**
   - Optimistic local lastReadIndex=messageLogLength + hasUnread=false, then mark_session_read (hub broadcasts session_read_state for cross-device sync); if the session had a needsAttention (@amar) marker it is also cleared via clear_attention (cancels the phone push).
   - src: `src/store/agent.ts:791-800`
195. **Mark session unread**
   - markSessionUnread sets lastReadIndex = len-1 locally (hasUnread if any messages exist) and syncs via mark_session_unread.
   - src: `src/store/agent.ts:802-811`
196. **Load older messages on scroll-up (pagination)**
   - loadOlderMessages computes beforeIndex = total messageLogLength − messages already loaded and requests get_older_messages; guarded by loading flag and hasOlder=false; older_messages response prepends blocks and updates hasMore. Sessions with >50 logged messages (REPLAY_LIMIT) start with hasOlder=true.
   - src: `src/store/agent.ts:813-827,1635-1653`
197. **Reload full session history from disk**
   - reloadSessionHistory drops the in-memory view + all pending deltas/tool-input previews/buffered appends, then re-requests get_session_history (hub reads the complete JSONL) — recovers from a stale/truncated local view.
   - src: `src/store/agent.ts:829-844`
198. **Group collapse toggle synced via hub**
   - toggleGroupCollapsed flips a cwd group's collapsed state and syncs via set_collapsed_groups (hub-persisted, cross-device; collapsed_groups broadcast applies remote changes).
   - src: `src/store/agent.ts:852-858`
199. **Drag-reorder sessions in the sidebar**
   - reorderSession(fromId,toId) rebuilds the full order (custom order first, then unlisted sessions newest-first), splices fromId to toId's position, and syncs via reorder_sessions (hub-persisted; session_order broadcast applies remote changes). Al and ended sessions excluded.
   - src: `src/store/agent.ts:860-876`
200. **Fork session (with branch-point seed + org role)**
   - forkSession sends fork_session with seed:true (branch-point marker injected so the fork knows its own work) and seedRole:true (mints a child org role under the source so the fork appears in the org chart); inherits the source's cwd; the new session auto-activates.
   - src: `src/store/agent.ts:878-895`
201. **Merge fork/child back into parent**
   - mergeSession sends merge_session (child self-summarises, digest injected into parent, child closed). On the session_merged broadcast a 'Fork merged — Summary folded into <parent name>' notification fires (suppressed during replay), deep-linking to the parent session.
   - src: `src/store/agent.ts:897-899,1105-1118`
202. **Rename session (optimistic)**
   - renameSession sends rename_session and updates the name locally immediately.
   - src: `src/store/agent.ts:901-905`
203. **AI title generation with spinner state**
   - generateTitle sends generate_title and adds the session to generatingTitleFor (drives a spinner); the session_renamed broadcast applies the name and clears the flag.
   - src: `src/store/agent.ts:907-910,1533-1543`
204. **Resume a past Claude session**
   - resumeSession(claudeSessionId, prompt, cwd?) sends resume_session and auto-activates the result; listPastSessions(cwd) requests the list of past JSONL sessions for a directory (past_sessions response populates the picker).
   - src: `src/store/agent.ts:912-928`
205. **Hub URL override reconnects immediately**
   - setHubUrl persists the URL (ws→http normalized), disconnects, and reconnects to the new hub.
   - src: `src/store/agent.ts:930-935`
206. **Hub-restart session ID remap preserves state**
   - sessions_list detects hub-ID changes via matching claudeSessionId and remaps messagesBySession, pending delta accumulators, buffered unflushed appends, and activeSessionId to the new IDs — a hub restart doesn't lose the open transcript or yank selection.
   - src: `src/store/agent.ts:1140-1239`
207. **Desktop auto-select of first active session; skipped on mobile**
   - When nothing is selected and not creating-new, the first non-ended session auto-selects — but NOT on viewports <768px, where the 10s sessions_list poll would repeatedly yank the user (typically into pinned-first Al) while browsing the list.
   - src: `src/store/agent.ts:1226-1238`
208. **Unread badge derived from hub read state**
   - hasUnread = messageLogLength > lastReadIndex (hub is source of truth for lastReadIndex via session_read_state broadcasts); local bumpMessageLog increments the count on each logged message so the badge flips without waiting for the next sessions_list.
   - src: `src/store/agent.ts:1170-1177,1555-1564,1687-1695`
209. **Live streaming text/thinking with per-frame coalescing**
   - text_delta/thinking_delta chunks accumulate in a plain Map and flush once per animation frame (one setState/frame) so streaming bursts don't stall typing; the finalized 'text' message supersedes pending deltas without duplication.
   - src: `src/store/agent.ts:1306-1327,1782-1839`
210. **Live tool-input preview ('Edit being typed')**
   - tool_input_delta chunks accumulate per-session (one live tool preview per session; a new toolUseId resets the accumulator), rAF-coalesced, rendered as a live preview of the tool call being typed; cleared when the finalized tool_use lands or the turn ends (result).
   - src: `src/store/agent.ts:1329-1333,1797-1818`
211. **Inline diff rendering for Edit/Write**
   - tool_diff messages carry filePath + jsdiff hunks (lines with their own +/−/space prefixes) rendered as terminal-style red/green diff tables under the paired tool row.
   - src: `src/store/agent.ts:1373-1382`
212. **Background-task chips**
   - bg_task messages (background bash / Task subagents) render lifecycle chips: started (spinner) → completed/failed with optional description/summary.
   - src: `src/store/agent.ts:1384-1395`
213. **Plan-mode indicator tracking**
   - EnterPlanMode tool_use flips session permissionMode to 'plan'; ExitPlanMode back to 'default' — drives the mode indicator in the session UI.
   - src: `src/store/agent.ts:1356-1360`
214. **Active sub-agent tracking**
   - An 'Agent' tool_use registers a running sub-agent (description or first 40 chars of prompt) until its tool_result arrives — surfaces live 'sub-agent running' indicators.
   - src: `src/store/agent.ts:1361-1369,1406-1414`
215. **Tool-approval request notification**
   - approval_required stores the approval per-session (multiple sessions can be blocked simultaneously; only the active session's approval shows in the main view) and fires a 'Claude needs input' notification — body is the AskUserQuestion question (or tool name) truncated to 80 chars + '...'; suppressed during the 2s replay window; deep-links to the session.
   - src: `src/store/agent.ts:1418-1449`
216. **Approvals cleared cross-client**
   - tool_approved/tool_denied broadcasts from OTHER clients clear the matching approval locally, so answering on the phone dismisses the prompt on desktop.
   - src: `src/store/agent.ts:1608-1611,1700-1717`
217. **Turn-complete notification with duration + cost**
   - On result, session goes idle, totalCost updates (cumulative from hub), and a '<name> finished' notification fires with body '<seconds>s · $<cost to 4dp>' — only if the session was actually running and not during replay; deep-links to the session. Result footer data (ttft, stopReason, numTurns, per-model usage) is stored for the expandable per-turn telemetry row.
   - src: `src/store/agent.ts:1452-1505`
218. **Session status text (e.g. 'Waiting for model…')**
   - status messages set a transient statusText on the session (shown in the status bar); cleared when the turn ends.
   - src: `src/store/agent.ts:1508-1511`
219. **Ended session drops pending approval**
   - session_ended flips status and clears any pending approval for the session (can't be answered anymore).
   - src: `src/store/agent.ts:1524-1531`
220. **@amar attention marker + notification**
   - session_attention sets a sticky needsAttention {ts,snippet} (red sidebar marker + Agents-pane dot); a '<name> wants your attention' desktop notification fires with the ~140-char snippet — skipped only when that session is already active or during replay. Marker persists until explicit mark-read.
   - src: `src/store/agent.ts:1567-1590`
221. **Real-time Monzo transaction notification (cross-pane)**
   - monzo_transaction messages on the agent WS feed the money store AND fire a notification titled with the merchant/counterparty name, body = formatted amount, icon = merchant logo, deep-linking to the Money pane with the transaction id.
   - src: `src/store/agent.ts:1614-1633`
222. **Al session preserved across list refreshes**
   - If a sessions_list response omits Al, the existing Al entry is re-added (pinned) rather than dropped; Al's status is managed only by sessions_list, not by user_prompt injections.
   - src: `src/store/agent.ts:1163-1165,1201`
223. **Message-burst batching on reconnect**
   - Replayed messages (~50/session, ≈1400 on a 48-session fleet) are buffered in a plain Map and flushed once per animation frame instead of one setState each — prevents visible typing stalls when the phone foregrounds and the WS reconnects.
   - src: `src/store/agent.ts:1728-1776`
224. **Cron tasks list per session with loading/error states**
   - Cron store polls GET /cron?session=<claudeSessionId> on demand (CronPanel open); per-session loading flags and error messages surfaced; refreshAll groups all tasks by session.
   - src: `src/store/cron.ts:53-79`
225. **Create cron task from the panel**
   - add POSTs {claudeSessionId, trigger, prompt, recurring} to /cron then refreshes that session's list.
   - src: `src/store/cron.ts:81-85`
226. **Delete cron task**
   - remove DELETEs /cron/:id and refreshes the owning session's list (owner located by scanning tasksBySession).
   - src: `src/store/cron.ts:87-95`
227. **Run cron task now**
   - runOnce POSTs /cron/:id/run and returns {ok, reason} — a guarded task may report skipped with the guard's reason.
   - src: `src/store/cron.ts:97-99`
228. **ICS calendar subscription URL with public-funnel preference**
   - fetchIcsToken gets {token, publicUrl}; icsUrl() returns the public GCal-ready URL when the hub reports one, else the local hub URL /cron.ics?token=…, else null.
   - src: `src/store/cron.ts:101-112`
229. **Cron task rows expose guard/skip telemetry**
   - Task shape carries guard command, lastFiredAt, lastCheckedAt, lastGuardResult (fired|skipped|error), lastSkipReason, consecutiveSkips, disabledAt for display in CronPanel.
   - src: `src/store/cron.ts:9-25`
230. **Mic ownership indicator mirrored live from hub**
   - Mic store subscribes SyncBus mic.state (owner session id + name + hot recording flag), re-fetches status on every reconnect; MicButton shows who owns the mic and whether it's live.
   - src: `src/store/mic.ts:35-54`
231. **PTT compose delivery drops transcript into composer unsent**
   - mic.compose events (transient, not replayed) set composeText/composeOwner and bump composeSeq (monotonic so identical transcripts re-trigger); AgentPromptInput fills its textarea for review instead of auto-sending.
   - src: `src/store/mic.ts:47-51`
232. **Hand mic to another session**
   - setMic RPCs mic.set with a target session id/name/agentKey; 'al' resets ownership to Al.
   - src: `src/store/mic.ts:56-58`

## app-wide (102)

1. **Pre-auth render gate: nothing renders until /auth/session probe resolves**
   - GatedBoot fetches ${hub}/auth/session with credentials; while loading renders null (no DOM scaffolding leaked); on !ok, non-authenticated, or network error → forced login screen; on success lazy-loads the whole app chunk.
   - src: `src/GatedBoot.tsx:112-153`
2. **Forced login screen with 'Sign in with Google' button (autofocused)**
   - Redirects to ${hub}/auth/google/start?return=<current URL>; on native APK appends &callback=app so hub deep-links back via console://auth/done with one-time-token for WebView cookie handoff.
   - src: `src/GatedBoot.tsx:159-187`
3. **Stale hub-URL override auto-purge at boot**
   - If localStorage console_hub_url host differs from page host (and isn't localhost/127.0.0.1), it and sessionStorage console_hub_legacy are removed with a console warning; unparseable value also removed.
   - src: `src/GatedBoot.tsx:22-40`
4. **Post-auth lazy boot wiring: sync-bus connect drives hub online/offline UI flag**
   - hubBus.onConnect/onDisconnect set uiStore hubOnline true/false; connection started only after auth. Also registers service worker (prod), requests navigator.storage.persist() on native, wires glasses store/events, geocaching, meetup, meetup+OutdoorLads calendar overlays, and map layers subscriptions.
   - src: `src/GatedBoot.tsx:42-100`
5. **Offline-first boot: loading screen released immediately, hub calls run in background**
   - App shows 'Loading...' only until synchronous IDB/localStorage hydration; setLoading(false) before any hub fetch; hub-unreachable keeps cached state. Cached matrix_user_id hydrated from localStorage synchronously.
   - src: `src/App.tsx:137-205`
6. **Hub pref hydration on boot: DND, notes expanded dirs, calendar default/visible calendar ids**
   - After initPrefs: dnd pref true → setDoNotDisturb(true) + uiStore.doNotDisturb; notesExpandedDirs pref restores tree expansion; calendar.defaultId / calendar.visibleIds patch the calendar store (which read nulls at module init).
   - src: `src/App.tsx:161-184`
7. **Primary Google account email displayed in UI after auth status fetch**
   - On signed-in boot, GET /auth/status; picks account with isPrimary (else first) and sets uiStore.userEmail.
   - src: `src/App.tsx:186-197`
8. **Session-expired amber banner with re-auth button**
   - onAuthExpired (refresh token dead) sets needsReAuth → fixed top amber banner 'Session expired — please sign in again' with 'Sign in with Google' button opening 500x600 popup to /auth/google/start; button shows 'Connecting...' while pending; banner clears on success; popup cancel silently resets.
   - src: `src/App.tsx:24-57,208-212`
9. **Notification permission auto-request on every app start**
   - requestPermission() called on mount; no-ops if browser already recorded a decision — deliberately not localStorage-gated so revoked permission (Brave inactivity) re-prompts.
   - src: `src/App.tsx:86-90`
10. **beforeunload warning when unsaved work exists**
   - Blocks tab close if: any open note content ≠ savedContent, compose modal open, email reply mode open, sync queue count > 0, or any focused input/textarea has a value.
   - src: `src/App.tsx:59-101`
11. **Stuck sync-queue items reset on boot**
   - resetStuckProcessing() resets queue items left in 'processing' from a previous session so they retry.
   - src: `src/App.tsx:142`
12. **Global overlays conditionally mounted: search, keybinding help, snooze picker, compose modal, Matrix login, account modal, undo toast, toasts, dialog**
   - Each gated on its uiStore flag; compose modal is bottom-sheet-on-mobile/centered-max-w-2xl with dim backdrop that closes on click.
   - src: `src/App.tsx:113-134`
13. **Google sign-in screen with popup OAuth flow**
   - Opens ${hub}/auth/google/start in a 500x600 popup; on success stores user email in ui store and calls onAuth; button shows 'Connecting...' and disables while loading; error text below; privacy blurb 'Your data stays in your browser'
   - src: `src/components/AuthScreen.tsx:14-60`
14. **Keyboard-shortcut help modal (?) listing all bindings grouped by section (Navigation/Triage/Compose/Bookmarks/Notes/Feeds/Calendar/Money/Agents/App)**
   - Closable via backdrop click or 'Esc' button in header; scrollable body max-h 60vh.
   - src: `src/components/KeybindingHelp.tsx:3-76`
15. **Desktop top bar pane tabs: Home, Mail, Calendar, Chat, Agents, Feeds, Notes, Bookmarks, Map, Money**
   - Mail tab shows as '+Mail' when Gmail not connected (still opens the pane); Chat shows as '+Chat' which opens the Matrix login modal instead of the pane.
   - src: `src/components/Layout.tsx:274-309`
16. **Pane-tab unread counts: Mail = inbox thread count, Chat = unread rooms, Feeds = totalUnread, Agents = sessions with hasUnread, Notes = dirty (unsaved) open files**
   - Rendered as blue '(N)' next to label on desktop; mobile shows a blue badge capped at '99+'.
   - src: `src/components/Layout.tsx:443-453`
17. **Red attention dot on Agents tab when any session has needsAttention (@amar), and on Notes tab while the pen is live-streaming strokes**
   - 1.5px red dot top-right of tab; tooltips 'A session wants your attention (@amar)' / 'Pen is streaming into Notes'. Visible from any pane.
   - src: `src/components/Layout.tsx:454-477`
18. **Pane-aware Refresh button (Ctrl/Cmd+click = full resync)**
   - Mail: incrementalSync, or Ctrl = clear threads/messages/attachments/historyId (preserving snoozed threads) + evict iframes + fullSync. Feeds: refreshItems, Ctrl also clears feedItems + lastSync. Calendar: refreshAll, Ctrl also clears calendarEvents. Money: refreshSync. Map: store refresh. Chat: matrix syncNow RPC, Ctrl also clears chatMessages + matrixSyncToken. Hidden on Agents/Bookmarks/Notes panes and on Mail when not connected. In APK also triggers ConsoleNative.checkForUpdate().
   - src: `src/components/Layout.tsx:203-261`
19. **Music drawer toggle button in header; icon highlights (accent) while drawer open**
   - Drawer mounted only while open — that gates the hub Spotify poller. Esc closes (in drawer).
   - src: `src/components/Layout.tsx:324-330,407`
20. **Settings gear button opens the Account modal**
   - src: `src/components/Layout.tsx:331-337`
21. **DND indicator: BellOff icon shown only while Do Not Disturb is on; clicking it disables DND**
   - Tooltip 'Do Not Disturb is on — click to disable'.
   - src: `src/components/Layout.tsx:799-811`
22. **Hub-offline indicator: CloudOff icon when hub WebSocket is closed**
   - Tooltip: 'Hub unreachable — actions will queue and flush when it's back'.
   - src: `src/components/Layout.tsx:816-827`
23. **'? help' hint in header (desktop only)**
   - src: `src/components/Layout.tsx:338-342`
24. **All panes pre-mounted and toggled with display:hidden for instant switching; Map pane is the exception — lazy-mounted on first activation then kept alive**
   - MapTab is React.lazy (MapLibre ~250KB gz code-split); Suspense fallback 'Loading map…'.
   - src: `src/components/Layout.tsx:346-400,196-200`
25. **Mobile bottom tab bar with 10 panes, horizontally scrollable; tapping the already-active tab acts as back/deselect**
   - mobileGoBack per pane: mail deselect thread, chat deselect room, bookmarks deselect, notes close active file, feeds clear item then feed/folder, money deselect tx, agents deselect session + clear creatingNewSession. Chat tab when not connected opens Matrix login modal.
   - src: `src/components/Layout.tsx:486-535`
26. **Mobile header back chevron appears only when the active pane has a selection (detail view showing)**
   - Selection per pane includes feeds feed/folder selection and agents creatingNewSession.
   - src: `src/components/Layout.tsx:717-753`
27. **Desktop footer: clickable action hints per pane (e Done/Read, b Snooze opens snooze picker, r Reply, c Compose; feeds e Read / o Open) plus keybinding legend that changes per pane**
   - 'e' click runs archiveThread (mail), markRead (feeds), or markRoomRead (chat). Agents/Bookmarks/Notes/Calendar/Money/Map show legend only, no action buttons. Always shows 'Tab switch pane'.
   - src: `src/components/Layout.tsx:579-684`
28. **YouTube picture-in-picture overlay mounted globally above panes**
   - src: `src/components/Layout.tsx:404`
29. **Mobile pull-to-refresh indicator**
   - src: `src/components/Layout.tsx:410`
30. **Full-screen hub sign-in overlay when a hub request returns 401 ConsoleSession; single 'Sign in with Google' button redirects top-level nav with return URL (adds &callback=app in APK)**
   - z-1000, blocks everything; autoFocus on the button; subscribes to authPending so it appears/disappears live.
   - src: `src/components/LoginScreen.tsx:16-48`
31. **Context menu opens on right-click (desktop) at cursor position**
   - preventDefault+stopPropagation; no-op when items empty
   - src: `src/components/ContextMenu.tsx:34`
32. **Context menu opens on 500ms long-press (mobile); cancelled if finger moves >10px**
   - Long-press timer 500ms; touchmove beyond ~10px in either axis cancels (matches swipe threshold); trigger element gets select-none + WebkitTouchCallout:none on mobile to suppress native selection/callout
   - src: `src/components/ContextMenu.tsx:43`
33. **Context menu closes on outside mousedown or any scroll; position clamped to viewport**
   - Capture-phase scroll listener; menu repositioned so it never overflows window edges (4px margin)
   - src: `src/components/ContextMenu.tsx:114`
34. **Context menu items support destructive (red) styling and optional header slot (e.g. quick-react emoji strip)**
   - header(close) render-prop rendered above items with divider; item click closes menu then runs onClick; ContextMenuView also exported as controlled variant for canvas-based triggers
   - src: `src/components/ContextMenu.tsx:143`
35. **In-app dialog system replaces native alert/confirm/prompt**
   - Three kinds: alert (single OK), confirm (resolves true/false), prompt (text input, resolves string; cancel resolves null to distinguish from empty string). Optional uppercase title, whitespace-pre-line message, custom confirm/cancel labels, danger flag makes OK button red
   - src: `src/components/Dialog.tsx:4`
36. **Dialog keyboard handling: Enter=OK (confirm/prompt only), Escape=cancel; backdrop click cancels**
   - Prompt input auto-focused and text pre-selected on open (keyed on dialog.id); non-prompt dialogs focus the OK button
   - src: `src/components/Dialog.tsx:45`
37. **PDF lightbox: full-screen browser-native PDF viewer**
   - iframe with browser's built-in viewer; dark backdrop; header shows filename (default 'document.pdf')
   - src: `src/components/PdfLightbox.tsx:50`
38. **PDF lightbox Download button**
   - <a download> with the filename
   - src: `src/components/PdfLightbox.tsx:33`
39. **PDF lightbox closes on Esc, X button, or backdrop click**
   - window keydown Escape; header/iframe clicks stopPropagation so only backdrop closes
   - src: `src/components/PdfLightbox.tsx:14`
40. **Pull-to-refresh indicator (mobile): arrow tracks pull distance, flips at threshold, spins while refreshing**
   - Fixed top-center; translates with pull up to 90px; at PULL_THRESHOLD arrow rotates 180° and turns accent; refreshing shows spinning RefreshCw pinned at 36px; renders nothing when idle
   - src: `src/components/PullIndicator.tsx:8`
41. **Swipeable row gesture: direction locked after 10px, action fires past 100px threshold**
   - Touch-only; first 10px decides horizontal vs vertical (vertical ignored); row translates with finger, background tints in action color up to 0.3 alpha and icon fades in proportional to progress; past threshold on release row flies off-screen over 200ms then triggers the action; below threshold snaps back over 150ms; directions without a configured action don't swipe
   - src: `src/components/SwipeableRow.tsx:24`
42. **Sync status pill: colored dot + label (Synced/Syncing/Error/Offline) with pending count**
   - Worst-of email vs matrix status (error>offline>syncing>idle); hub WS down forces 'Offline'/'Hub unreachable' regardless of per-service state; 'N pending' shown when the offline queue is non-empty (live Dexie query)
   - src: `src/components/SyncStatus.tsx:40`
43. **Hovering the sync pill opens a details tooltip (150ms close grace)**
   - Loads pending + conflict queue entries on hover; mouse-leave schedules close after 150ms, re-enter cancels; shows first 5 pending actions (type + 8-char threadId) with '+N more', and all conflicts with error text
   - src: `src/components/SyncStatus.tsx:62`
44. **'Flush' button in sync tooltip runs the offline queues immediately**
   - processQueue() + processChatQueue() in parallel, button disabled with ⟳ while flushing, details reloaded after
   - src: `src/components/SyncStatus.tsx:69`
45. **'Copy' button copies the sync error text to clipboard**
   - Shown only in error state; label flips to 'Copied' for 1.5s
   - src: `src/components/SyncStatus.tsx:80`
46. **Toast notifications (top-right) with success/error/info icons and auto-expiry**
   - Green check / red alert / blue info; each toast auto-dismisses at its expiresAt timestamp; optional detail line in 10px break-all text
   - src: `src/components/Toasts.tsx:5`
47. **Toast with href opens the link in a new tab on click**
   - window.open(href,'_blank','noopener,noreferrer'); pointer cursor + hover style only when href present (e.g. published blog-post permalink)
   - src: `src/components/Toasts.tsx:28`
48. **Toast X button dismisses without triggering the link**
   - stopPropagation then dismiss(id)
   - src: `src/components/Toasts.tsx:39`
49. **Undo toast for destructive actions with 'Undo' button and 'u' key hint**
   - Bottom-center (bottom-20 on mobile above nav, bottom-4 desktop); slides/fades out at undoAction.expiresAt (store sets ~5s), fully removed 200ms after fade; clicking Undo runs the stored undo closure
   - src: `src/components/UndoToast.tsx:27`
50. **Offline sync queue: enqueue triggers immediate flush listeners; actions retried up to 3 times before status 'failed'; conflict status supported; stuck 'processing' items reset to 'pending' on reload**
   - markDone deletes the row; removeByThread/removeByEvent drop pending actions for an undone thread/event; getQueueCount counts pending+processing for the UI badge
   - src: `src/db/sync-queue.ts:12-90`
51. **IndexedDB schema v11 (console-inbox): threads/messages/attachments, chat, feeds+read-state, multi-account calendar (v7 upgrade clears old-format calendar rows), geocaches, meetup events, map layers; v9 dropped offline basemaps**
   - src: `src/db/index.ts:83-206`
52. **Debug agent streams all console output, fetch requests (method/url/status/duration, req/res bodies truncated to 2048 chars), window errors and unhandled rejections to hub /debug WS; buffers 50 events, flushes every 200ms, reconnects every 3s**
   - URL contains '/debug' excluded to avoid loops; early errors buffered pre-load in window.__earlyErrors are drained; connects to /hub/debug same-origin (or :9877 when on Vite port 5173)
   - src: `src/debug-agent.ts:30-33,104-127`
53. **Debug agent answers remote commands: debug_eval (eval JS in page), debug_get_state (serialized Zustand stores, functions stripped), debug_screenshot (html2canvas if installed), debug_toggle (enable/disable capture)**
   - src: `src/debug-agent.ts:284-358`
54. **Dev-only window.__console exposes 8 Zustand stores, Dexie db, hubBus, and perf.longTasks; PerformanceObserver records main-thread long tasks (last 200), warns to console when a task exceeds 100ms**
   - src: `src/debug.ts:50-87`
55. **Project-wide dialog system replacing native alert/confirm/prompt: promise-based showAlert/showConfirm/showPrompt with title, confirm/cancel labels, danger styling, default value/placeholder**
   - src: `src/dialog.ts:19-61`
56. **Dictation: browser SpeechRecognition with automatic hub-STT fallback**
   - Browser SR (continuous, interim results, lang default en-GB) commits final chunks via onText and exposes interim text for preview; on 'network'/'not-allowed'/'service-not-allowed' errors it transparently switches to the hub /stt WebSocket. Native APK skips browser SR entirely (unreliable WebView shim).
   - src: `src/hooks/useDictation.ts:147-199`
57. **Hub STT streams 24kHz PCM16 with delta/final dedup**
   - Mic audio captured via ScriptProcessor(4096), base64 PCM chunks over WS; streaming 'interim' deltas each commit as text; a 'final' commits ONLY when no deltas covered the utterance (prevents duplicated text). Suspended AudioContext is resumed (mobile Safari/WebView gotcha).
   - src: `src/hooks/useDictation.ts:86-145`
58. **Dictation stop fully releases the OS mic**
   - Teardown disconnects processor/source nodes, stops all MediaStream tracks, and closes the AudioContext — each guarded — so Android's green mic indicator turns off; toggle() flips start/stop.
   - src: `src/hooks/useDictation.ts:54-84,201-205`
59. **Escape key: layered dismissal priority chain**
   - Esc closes, in order: search overlay → keybinding help → snooze picker → compose → matrix login → account modal; then pane-specific: bookmarks (blur input / exit add mode / exit triage / clear search+tag / deselect), calendar (close event form / deselect event), feeds (close add modal / blur / clear search / deselect item), notes (close command palette / link picker / quick switcher; in-editor Esc passes to vim), money (deselect tx / clear search), map (deselect cache), agents (blur input, else interrupt a running session), email reply mode off, generic blur, chat deselect room.
   - src: `src/hooks/useKeybindings.ts:43-110`
60. **Ctrl+Tab / Ctrl+Shift+Tab switch panes even while editing**
   - toggleActivePane(shiftKey) — works in inputs. Bare Tab also cycles panes but only when not editing.
   - src: `src/hooks/useKeybindings.ts:166-184`
61. **Mail/Chat shared triage keys: j/k navigate, e archive(mail)/mark-read(chat), E/Shift+e mark chat room unread, b open snooze picker, u undo (within undo window), c compose (mail), '/' search, '?' help, Shift+T dark mode**
   - u only fires if the ui undoAction exists and Date.now() < expiresAt. Chat 'i' focuses [data-chat-input] compose box.
   - src: `src/hooks/useKeybindings.ts:563-657`
62. **Ctrl+H/Ctrl+L universal prev/next browsing per pane (capture-phase)**
   - Maps to notes prev/next tab, email prev/next thread, chat prev/next room, agents prev/next session, feeds prev/next item, bookmarks prev/next, money prev/next tx, calendar prev/next week. Capture phase beats CodeMirror keymaps and preventDefault blocks Brave/Chromium's Ctrl+H history accelerator; works while editing/composing.
   - src: `src/hooks/useKeybindings.ts:668-691`
63. **Responsive mobile detection at 768px breakpoint**
   - useIsMobile listens to a matchMedia (max-width: 767px) and re-renders on change; drives mobile layouts throughout.
   - src: `src/hooks/useMediaQuery.ts:3-17`
64. **Pull-to-refresh gesture on scroll containers**
   - Drag down from scrollTop=0: distance damped x0.5, capped at 120px, rendered by global PullIndicator; release past PULL_THRESHOLD runs the async refresh with a spinner until it resolves; flick-scroll mid-pull abandons it; passive listeners (no preventDefault), native overscroll disabled globally in CSS.
   - src: `src/hooks/usePullToRefresh.ts`
65. **Swipe actions on list rows: right=archive (green), left=snooze (amber)**
   - Direction locked after 10px movement; horizontal swipe translates the row with the finger, background tints green (right) / amber (left) proportional to progress up to threshold (default 120px), side icons fade in; past threshold the row animates off-screen over 200ms then fires onSwipeRight/onSwipeLeft; below threshold snaps back over 150ms. Touches starting inside a horizontally-scrollable element or data-no-swipe ancestor are suppressed so wide tables/code blocks scroll instead.
   - src: `src/hooks/useSwipeActions.ts`
66. **Email iframe/attachment/contact preload after sync completes**
   - On sync status transition syncing→idle: preloadAllInbox() then preloadAttachments(), plus preloadContacts() — makes opening threads instant.
   - src: `src/hooks/useSync.ts:30-41`
67. **Manual full-refresh action syncs Gmail and forces Matrix syncNow**
   - triggerFullSync (used by refresh UI / pull-to-refresh) runs Gmail fullSync when signed in and hub RPC matrix.syncNow when connected.
   - src: `src/hooks/useSync.ts:350-356`
68. **Hub URL resolution: same-origin /hub with localStorage override and legacy :9877 fallback**
   - Default ${origin}/hub; 'console_hub_url' localStorage override wins (legacy keys 'consoleServerUrl'/'console-server-url' auto-migrate). If a /hub request returns 200 text/html (Caddy not reloaded — Vite catch-all), flips to legacy ${hostname}:9877 for the page lifetime, persisted in sessionStorage 'console_hub_legacy'.
   - src: `src/hub.ts:11-143`
69. **Login screen triggered only by explicit ConsoleSession 401 challenge**
   - A 401 with WWW-Authenticate containing 'ConsoleSession' flips the global authPending flag → LoginScreen mounts; generic 401s from individual handlers deliberately do NOT pop the login dialog.
   - src: `src/hub.ts:72-122`
70. **hubFetch sends cookies only same-origin; supports per-request timeout**
   - credentials:'include' only when URL origin matches the SPA (legacy :9877 stays unauthenticated); timeoutMs option merges caller AbortSignal with a timeout controller; non-OK → HubError(status, body text); empty body → {}.
   - src: `src/hub.ts:92-197`
71. **Pre-auth render gate: nothing renders before session probe**
   - main.tsx mounts GatedBoot which probes /hub/auth/session first, renders an empty div while loading, only LoginScreen if unauthenticated, and lazy-imports the whole app (stores, sync-bus, panes) only after auth — an unauthenticated visitor sees no SPA DOM.
   - src: `src/main.tsx:21-33`
72. **Cross-origin IndexedDB migration slave mode**
   - When loaded in an iframe with ?migrate=1 by another origin, the page dumps IDB+localStorage to the parent via postMessage and skips app boot entirely.
   - src: `src/main.tsx:8-13`
73. **Build timestamp logged at boot; StrictMode toggleable**
   - console.log '[console] built <time>' helps detect stale service-worker cache; VITE_STRICT_MODE=false disables StrictMode double-renders for profiling.
   - src: `src/main.tsx:15-19`
74. **Debug agent installed before any app code**
   - debug-agent import is first in main.tsx so console/fetch/error hooks capture from page load.
   - src: `src/main.tsx:1`
75. **'Import from another origin' data migration (AccountModal)**
   - Spawns hidden iframe at ${sourceOrigin}/?migrate=1, waits ≤30s for ready handshake and ≤120s for the dump, then bulkPuts 11 IDB tables (threads/messages/attachments/chat/queue/meta/feeds/calendar) + copies all localStorage keys except console_hub_url; returns row/key counts + duration for display; origin-checked both directions
   - src: `src/migration.ts:114-181`
76. **Page loaded in an iframe with ?migrate=1 becomes an export slave instead of booting the app**
   - maybeRunExportSlave answers the parent's export request with full IDB + localStorage dump; app render skipped entirely in that mode
   - src: `src/migration.ts:54-98`
77. **Context-aware notification suppression**
   - Suppressed when: DND enabled, permission not granted, or app focused on the same pane as the notification (agents pane exception: notifications for non-active sessions still fire); always fires when window unfocused/minimized
   - src: `src/notifications.ts:52-68`
78. **Notification icons proxied through hub for same-origin**
   - Remote http(s) icons rewritten to ${hub}/proxy/icon?url=… because Brave/Linux only passes same-origin icons to the notification daemon
   - src: `src/notifications.ts:72-75`
79. **Notification click deep-links to pane + item**
   - Click focuses the window, closes the notification, switches to the target pane and selects the item: money→transaction, chat→room, email→thread, agents→session
   - src: `src/notifications.ts:85-125`
80. **Deep links from service worker and APK route identically**
   - SW 'notification-click' messages and the APK's console:navigate CustomEvent (from console://pane/... deep links) both dispatch through the same handleNotificationClick path
   - src: `src/notifications.ts:128-148`
81. **Do Not Disturb toggle silences all in-browser notifications**
   - setDoNotDisturb flag checked before every notify(); set by the UI store (hub-synced DND pref)
   - src: `src/notifications.ts:48-55`
82. **Native APK detection changes OAuth + storage behavior**
   - isNative() reads window.__isConsoleAPK (injected by the APK); drives ?callback=app OAuth redirect, persistent-storage request, update banner; nativeVersion() exposes APK version/code; onNativeAuthReturn subscribes to the console:auth-return event fired after Custom Tabs OAuth completes
   - src: `src/platform.ts:15-32`
83. **Pull-to-refresh with 70px release threshold**
   - Global PullIndicator reflects damped pull distance and refreshing spinner; release past PULL_THRESHOLD=70px triggers refresh; single instance app-wide.
   - src: `src/store/pull.ts:20`
84. **Pane ↔ URL path mapping with browser back/forward support**
   - Each pane maps to a path (/ /mail /chat /bookmarks /notes /agents /feeds /calendar /map /money); setActivePane uses history.replaceState; popstate listener syncs the store on back/forward; unknown paths default to home.
   - src: `src/store/ui.ts:8`
85. **Cycle-pane order (Tab / Ctrl+Tab)**
   - toggleActivePane cycles panes in fixed order home→email→calendar→chat→agents→feeds→notes→bookmarks→map→money (reverse=backwards, wraps).
   - src: `src/store/ui.ts:166`
86. **Active pane feeds notification suppression**
   - Every pane change (init, set, cycle) calls setActiveNotificationPane so notifications for the visible pane are suppressed.
   - src: `src/store/ui.ts:39`
87. **Dark mode toggle (default on) flips document class**
   - toggleDarkMode toggles the 'dark' class on <html>; separate emailDarkMode toggle controls the email iframe's inverted rendering independently.
   - src: `src/store/ui.ts:150`
88. **Toast system: errors last 8s, others 4s, optional detail + click-through URL**
   - pushToast assigns TTL (ttlMs override, else 8000ms for kind 'error', 4000ms otherwise), supports detail second line and href opened on click; dismissToast removes by id.
   - src: `src/store/ui.ts:206`
89. **Undo toast slot with expiry**
   - Single undoAction {label, undo(), expiresAt} — the 5-second undo affordance for destructive actions like email delete/archive.
   - src: `src/store/ui.ts:203`
90. **In-app dialog system (alert/confirm/prompt) replacing native dialogs**
   - DialogState supports title, message, prompt defaultValue/placeholder, custom confirm/cancel labels, and danger (red OK button); resolves an awaited promise.
   - src: `src/store/ui.ts:51`
91. **Header offline pill from hub WS state**
   - hubOnline defaults true (optimistic), flipped by sync-bus connect/disconnect; when false mutations still enqueue and flush on reconnect.
   - src: `src/store/ui.ts:112`
92. **Sync status indicators for Gmail, Matrix, and pending queue count**
   - syncStatus/syncDetail, matrixSyncStatus/matrixSyncDetail, and queueCount (pending offline mutations) drive header status UI.
   - src: `src/store/ui.ts:107`
93. **Do-not-disturb toggle synced via hub pref**
   - doNotDisturb reads hub pref 'dnd' on boot (re-applied after initPrefs resolves) and setDoNotDisturb persists to hub + updates the notifications module — cross-device DND.
   - src: `src/store/ui.ts:228`
94. **Picture-in-picture YouTube video survives pane switches**
   - pipVideo {youtubeId,title} managed only by explicit play/close user actions; tab switches never affect it.
   - src: `src/store/ui.ts:135`
95. **Modal/panel visibility flags for search, keybinding help, snooze picker, schedule picker, compose, Matrix login, account modal**
   - Seven independent show* booleans each with a setter — e.g. '?' opens keybinding help, 'b' opens snooze picker, 'c' opens compose.
   - src: `src/store/ui.ts:91`
96. **Re-auth banner state**
   - needsReAuth flag surfaces a sign-in-again prompt when the hub reports expired Google auth; userEmail and matrixUserId shown in the account modal.
   - src: `src/store/ui.ts:141`
97. **Hub WS auto-reconnect with exponential backoff 500ms→30s**
   - On close, reconnect after delay doubling from 500ms capped at 30s; delay resets to 500ms on successful open; subscriptions re-established and pending RPCs re-sent on reconnect.
   - src: `src/sync-bus.ts:290`
98. **WS heartbeat: 15s ping, 30s staleness force-reconnect**
   - Client pings every 15s; if no inbound message for 30s the WS is considered dead-but-OPEN and is force-closed to reconnect — catches Android-background/NAT-dead sockets without visibility events.
   - src: `src/sync-bus.ts:59`
99. **Offline pill shows within 5s on failed initial connect**
   - CONNECT_HINT_MS=5000: if the WS hasn't opened in 5s, disconnect handlers fire (offline pill shows) while the connect keeps trying (slow cellular paths may take 10–20s); UI flips back online when it opens.
   - src: `src/sync-bus.ts:206`
100. **RPC calls default 30s timeout**
   - hubBus.rpc rejects with 'hub timeout' after timeoutMs (default 30_000; 0 disables); pending RPCs survive a reconnect by being re-sent (caller responsible for idempotency).
   - src: `src/sync-bus.ts:33`
101. **Relative time formatting incl. future (snooze) times**
   - Past: 'now' <1m, then Nm/Nh/Nd up to 7 days, then 'Mon D' (year appended if not current year). Future: 'in Nm/Nh/Nd' up to 7 days, then short date.
   - src: `src/utils/date.ts:5`
102. **Calendar-date-aware absolute formatting**
   - formatDate: 'Today at H:MM', 'Yesterday at H:MM' (compares calendar dates so 11pm-yesterday at 1am is Yesterday), weekday name within 7 days, else 'Mon D[, YYYY] H:MM'.
   - src: `src/utils/date.ts:39`

## bookmarks (49)

1. **Add-bookmark mode replaces the list with a URL input auto-focused on entry**
   - Header 'Add bookmark' with X to exit; Escape also exits; input disabled while loading
   - src: `src/components/BookmarkAddBar.tsx:41-93`
2. **URL fetch auto-prepends https:// when protocol missing**
   - Enter or 'Fetch' button triggers fetchAddPreview; Fetch disabled on empty input; spinner replaces it while loading
   - src: `src/components/BookmarkAddBar.tsx:46-105`
3. **Add-preview shows fetched title, description (3-line clamp), and URL before saving**
   - Enter after preview saves the bookmark instead of re-fetching
   - src: `src/components/BookmarkAddBar.tsx:54-62,110-125`
4. **AI-suggested tags shown with Sparkles 'AI suggested' label; spinner while suggestions load**
   - Selected tags render accent-tinted with X to deselect; unselected suggestions render gray with Plus to select; status/active tag hidden everywhere
   - src: `src/components/BookmarkAddBar.tsx:128-172`
5. **Custom tag input with autocomplete from all existing tags (max 6, substring match, excludes already-selected)**
   - Enter picks first suggestion if any else adds raw input; Escape clears input; dropdown click adds tag; status/active excluded from source set
   - src: `src/components/BookmarkAddBar.tsx:22-39,174-215`
6. **'Save bookmark' button persists the new bookmark**
   - Full-width accent button with Check icon
   - src: `src/components/BookmarkAddBar.tsx:218-226`
7. **Add-mode empty and loading states**
   - 'Paste a URL and press Enter…' hint when idle; 'Fetching page info...' with spinner while fetching
   - src: `src/components/BookmarkAddBar.tsx:229-245`
8. **Detail pane empty state 'Select a bookmark'**
   - Shown when no bookmark selected
   - src: `src/components/BookmarkDetail.tsx:85-91`
9. **Detail: persistent iframe preview pool with preload of ±2 neighbours, capped at 20 iframes**
   - Iframes stay mounted with display toggled; current selection never evicted; pool cleared when search/tag filter changes; desktop only (hidden on mobile); sandbox allow-scripts allow-same-origin
   - src: `src/components/BookmarkDetail.tsx:6-80,181-195`
10. **Detail header: title, clickable URL (new tab), open-in-new-tab button (o), delete button (d)**
   - ExternalLink and Trash2 icons with keyboard-hint tooltips; delete hover turns destructive red
   - src: `src/components/BookmarkDetail.tsx:107-136`
11. **Detail shows description, archive-snapshot link, and 'Added <d MMM yyyy>' date**
   - Archive link opens bookmark.archive in new tab with Archive icon; date formatted en-GB day/short-month/year, falls back to raw string on parse failure
   - src: `src/components/BookmarkDetail.tsx:139-161,323-331`
12. **Detail notes section renders bookmark markdown body**
   - selectedBookmarkBody shown whitespace-pre-wrap under 'Notes' divider
   - src: `src/components/BookmarkDetail.tsx:171-178`
13. **Mobile back button in detail returns to the list**
   - ChevronLeft 'Back' calls selectBookmark(null)
   - src: `src/components/BookmarkDetail.tsx:97-105`
14. **Tag editor: removable tag chips + add-tag input with autocomplete (max 8 suggestions)**
   - status/broken tags styled destructive red; Enter adds first suggestion else raw input; Escape blurs; suggestions dropdown persists 150ms after blur so clicks register; updates persist via updateBookmarkTags
   - src: `src/components/BookmarkDetail.tsx:204-306`
15. **List search box filters bookmarks live**
   - data-bookmark-search input; filterBookmarks(bookmarks, query, selectedTag)
   - src: `src/components/BookmarkList.tsx:46-56`
16. **Add-bookmark button (Plus, shortcut 'a') in search bar enters add mode**
   - Add mode replaces the whole list panel with BookmarkAddBar
   - src: `src/components/BookmarkList.tsx:38-41,57-63`
17. **Mobile pull-to-refresh re-fetches bookmarks**
   - usePullToRefresh on the list container, mobile only
   - src: `src/components/BookmarkList.tsx:22`
18. **Stats bar: total or 'N of M' filtered count, broken count, active-tag clear chip**
   - '· N broken' appended when filtered set contains status/broken; '×<tag>' accent button clears the tag filter
   - src: `src/components/BookmarkList.tsx:36,67-81`
19. **'triage' button (shortcut 'm') enters Tinder-style triage mode**
   - enterTriageMode; triage view replaces the whole tab
   - src: `src/components/BookmarkList.tsx:82-88`
20. **Selected list item auto-scrolls into view**
   - scrollIntoView block:'nearest' keyed by data-bookmark-id
   - src: `src/components/BookmarkList.tsx:30-34`
21. **List empty state 'No bookmarks found'**
   - When filter yields zero
   - src: `src/components/BookmarkList.tsx:93-96`
22. **List item shows title, domain (www. stripped), one-line description, up to 4 tags + '+N' overflow**
   - Tags show only last path segment (tag.split('/').pop()); status/active hidden; broken bookmarks get red left border and red tag chips; click selects
   - src: `src/components/BookmarkListItem.tsx:8-71`
23. **Bookmarks fetched once on tab mount (hub caches)**
   - Only when list empty and not loading
   - src: `src/components/BookmarkTab.tsx:19-23`
24. **Loading state 'Loading bookmarks...' and server-down state with 'cd server && npm run dev' hint**
   - Server-down state shown when not connected and no cached bookmarks
   - src: `src/components/BookmarkTab.tsx:25-45`
25. **Desktop three-pane layout: tag tree (176px) | list (288px) | detail; mobile shows list or detail**
   - Triage mode overrides everything when active
   - src: `src/components/BookmarkTab.tsx:47-72`
26. **Tag tree with 'All bookmarks' root, hierarchical expand/collapse (▾/▸), per-tag counts**
   - Click name selects tag as filter; click triangle toggles expansion without selecting; active tag highlighted; indent 10px/level; 'No tags' empty state
   - src: `src/components/BookmarkTagTree.tsx:10-110`
27. **Triage mode: progress bar + 'N / M' counter + exit X (Esc)**
   - Progress = (index+1)/filtered*100 with animated width
   - src: `src/components/BookmarkTriageView.tsx:48-81`
28. **Triage card shows title, domain link (new tab), description, editable tags, notes body**
   - Body auto-fetched by selecting the current triage item; TriageTagEditor identical semantics to detail editor (8 suggestions, Enter picks first), input placeholder 'Add tag... (t)'
   - src: `src/components/BookmarkTriageView.tsx:26-121,222-317`
29. **Triage actions: Delete (d) / Skip (s) / Keep (e) buttons across bottom**
   - Delete styled destructive, Keep styled success; keyboard hints inline
   - src: `src/components/BookmarkTriageView.tsx:124-144`
30. **Triage completion state 'All done!' with 'Back to browse' link**
   - Shown when index runs past the filtered queue
   - src: `src/components/BookmarkTriageView.tsx:33-45`
31. **Triage iframe pool preloads current + next 2 pages, capped at 20 (keeps most recent), desktop only**
   - URL bar above iframe with current URL + external-link; iframes persist with display toggling; sandbox allow-scripts allow-same-origin
   - src: `src/components/BookmarkTriageView.tsx:147-215`
32. **Bookmarks keys: j/k navigate, e triage-keep, d triage-delete or delete bookmark, s triage-skip, o open URL, a toggle add mode, m toggle triage mode, t focus tag input, '/' focus search**
   - e only acts in triage mode; d deletes the bookmark outside triage; t (unshifted) focuses [data-bookmark-tag-input].
   - src: `src/hooks/useKeybindings.ts:453-520`
33. **Bookmark list fetch + alphabetical sort**
   - fetchBookmarks GETs /bookmarks and /bookmarks/tags in parallel; bookmarks sorted alphabetically by title (localeCompare); any failure sets connected:false (drives a disconnected indicator) and keeps loading:false.
   - src: `src/store/bookmarks.ts:142-161`
34. **Tag filter includes descendant tags**
   - Selecting tag 'foo' matches bookmarks tagged exactly 'foo' OR any 'foo/...' descendant (hierarchical tags).
   - src: `src/store/bookmarks.ts:46-49`
35. **Search filter across title/url/description/tags**
   - Case-insensitive substring match against title, url, description, and every tag; composed after the tag filter.
   - src: `src/store/bookmarks.ts:53-61`
36. **Select bookmark loads body lazily**
   - selectBookmark sets selection immediately with body=null (loading state), fetches the full markdown body in background, and only applies it if the selection hasn't changed meanwhile (stale-response guard).
   - src: `src/store/bookmarks.ts:163-178`
37. **j/k next/prev bookmark navigation**
   - selectNext/PrevBookmark walk the FILTERED list (search+tag applied), clamped at ends (no wrap); in triage mode they move triageIndex instead; if nothing selected, next/prev both land on index 0.
   - src: `src/store/bookmarks.ts:180-210`
38. **Delete bookmark with auto-advance selection**
   - deleteBookmark DELETEs /bookmarks/<file> (NOT optimistic — bails silently if the request fails), removes from local list, and auto-selects the next bookmark in the filtered list (or previous if last was deleted); in triage mode clamps triageIndex to new length.
   - src: `src/store/bookmarks.ts:212-253`
39. **Edit bookmark tags**
   - updateBookmarkTags PUTs {tags} to /bookmarks/<file> and applies the server-confirmed tags to the local row; errors are swallowed (vault is source of truth).
   - src: `src/store/bookmarks.ts:255-276`
40. **Tag select toggles off + auto-expands ancestors**
   - Clicking the already-selected tag deselects it; selecting 'a/b/c' auto-expands 'a', 'a/b', and 'a/b/c' in the tag tree sidebar.
   - src: `src/store/bookmarks.ts:280-297`
41. **Tag tree expand/collapse toggle**
   - toggleTagExpanded flips a tag's expansion in the sidebar tree (expandedTags Set, session-only, not persisted).
   - src: `src/store/bookmarks.ts:299-304`
42. **Triage mode enter/exit**
   - enterTriageMode starts Tinder-style triage at index 0 of the current filtered list (respects active search/tag filter); exit just flips the flag.
   - src: `src/store/bookmarks.ts:306-319`
43. **Triage keep/skip advances; auto-exits at end**
   - triageKeep advances to the next filtered bookmark and auto-exits triage mode when past the last one; triageSkip is identical to keep.
   - src: `src/store/bookmarks.ts:321-339`
44. **Triage delete**
   - triageDelete deletes the current triage item, keeps the same index (next item slides in), and auto-exits triage if the index passes the end of the re-filtered list.
   - src: `src/store/bookmarks.ts:341-357`
45. **Open bookmark URL in new tab**
   - openBookmarkUrl window.open(url, '_blank') for the selected bookmark.
   - src: `src/store/bookmarks.ts:359-365`
46. **Add-bookmark mode with URL preview**
   - enterAddMode resets the add form; fetchAddPreview(url) POSTs /bookmarks (server fetches metadata AND creates the file immediately — the bookmark exists as soon as preview loads), shows title/description preview, inserts it into the local list (alpha-sorted) and selects it. addLoading flag drives a spinner; failure silently clears loading.
   - src: `src/store/bookmarks.ts:367-439`
47. **AI tag suggestions on add**
   - After preview, POST /bookmarks/suggest-tags runs in parallel (non-blocking); when it returns and add mode is still open, suggested tags replace the selected-tags set AND are immediately written to the bookmark file via updateBookmarkTags.
   - src: `src/store/bookmarks.ts:416-433`
48. **Toggle / add custom tag in add form**
   - toggleAddTag flips a tag's membership in the selected set; addCustomTag appends a free-text tag (dedup, empty rejected).
   - src: `src/store/bookmarks.ts:441-457`
49. **Save new bookmark commits tags + refreshes tag tree**
   - saveNewBookmark finds the created bookmark by URL, PUTs the final tag selection, re-fetches /bookmarks/tags to refresh the sidebar tree, then exits add mode.
   - src: `src/store/bookmarks.ts:459-479`

## calendar (125)

1. **Add Google Calendar account via OAuth popup with 1s polling**
   - Opens 500x600 popup to /auth/google/start; polls /auth/google/poll every 1000ms; resolves+closes popup when done; rejects 'Sign-in cancelled' if popup closed by user; hard 5-minute timeout rejects 'Sign-in timed out' and closes popup; rejects 'Popup blocked' when popup is null.
   - src: `src/calendar/accounts.ts:31-75`
2. **Remove calendar account also purges its local data**
   - DELETE /cal/accounts/:email on hub, then deletes all Dexie calendarList and calendarEvents rows for that accountEmail.
   - src: `src/calendar/accounts.ts:77-84`
3. **Account list fetch failure degrades to empty list silently**
   - getAccounts catches any error and returns [] — offline shows no accounts rather than an error.
   - src: `src/calendar/accounts.ts:19-25`
4. **Offline queue processor drains calCreate/calUpdate/calDelete/calRsvp/calReminder/calLocation actions in createdAt order under a single-flight lock**
   - Picks pending+processing cal* actions sorted by createdAt; lock boolean prevents concurrent drains; each action marked processing → done/failed.
   - src: `src/calendar/sync.ts:15-30`
5. **calCreate: temp event ID swapped for real Google ID after server create**
   - On success deletes temp compoundKey row + pendingTempIds entry, writes real event row with server data (summary fallback '(No title)'), then triggers store loadEventsFromDb so UI re-renders with real event.
   - src: `src/calendar/sync.ts:33-74`
6. **calUpdate writes the authoritative server response back over the optimistic row**
   - After PATCH, merges server fields (summary/description/location/times/allDay/status/attendees/reminders/updated) into the existing IDB row and reloads events.
   - src: `src/calendar/sync.ts:76-103`
7. **calDelete clears its optimistic-delete marker on success**
   - optimisticallyDeleted set (compound keys) shared with the store keeps deleted events hidden until server confirms; entry removed on success.
   - src: `src/calendar/sync.ts:105-114`
8. **calRsvp persists server-confirmed attendee list after RSVP patch**
   - Patches attendees array; writes returned attendees JSON back to the IDB row.
   - src: `src/calendar/sync.ts:116-132`
9. **calReminder: minutes=null means 'use calendar default', otherwise single popup override**
   - null → {useDefault:true}; number → {useDefault:false, overrides:[{method:'popup', minutes}]}; server response written back to remindersJson.
   - src: `src/calendar/sync.ts:134-154`
10. **calLocation implemented as delete-old-then-create-new event**
   - Deletes old event (tolerating already-gone), clears its optimistic-delete marker, creates new event, swaps temp compound key for real, reloads events.
   - src: `src/calendar/sync.ts:156-202`
11. **Failed cal actions roll back optimistic changes after 3 retries**
   - markFailed increments retryCount; once status becomes 'failed' (retryCount>=3), calUpdate/calDelete payload.rollback rows are restored to IDB (delete also un-hides via optimisticallyDeleted removal) and events reload — user sees the original event reappear.
   - src: `src/calendar/sync.ts:206-225`
12. **Event fetch uses Google syncToken when available, else timeMin/timeMax window, always singleEvents=true**
   - Recurring events arrive pre-expanded; incremental sync via nextSyncToken.
   - src: `src/calendar/api.ts:26-45`
13. **Event form modal for create/edit with backdrop-click and X to close**
   - Title 'New Event' vs 'Edit Event'; title input autofocused; Enter in title submits
   - src: `src/components/CalendarEventForm.tsx:136-165`
14. **Calendar selector shown only when >1 writable calendar; defaults to user default → primary → first writable**
   - Writable = accessRole owner|writer; defaultCalendarId store pref honoured
   - src: `src/components/CalendarEventForm.tsx:20-24,169-181`
15. **All-day checkbox toggles between date-only and date+time inputs**
   - All-day sends {date}, timed sends ISO dateTime; new events default to clicked slot or now with +1h end
   - src: `src/components/CalendarEventForm.tsx:32,66-71,110-116,184-231`
16. **Changing start date auto-bumps end date if end < start**
   - onChange of start date sets endDate when empty or earlier
   - src: `src/components/CalendarEventForm.tsx:202`
17. **Guests field with contact autocomplete; organizer auto-included as accepted attendee**
   - Parsed via parseAddressList, entries must contain '@'; guests format 'Name <email>'; edit mode pre-fills existing attendees excluding self with trailing ', '
   - src: `src/components/CalendarEventForm.tsx:46-49,83-94,245-255`
18. **Google Meet auto-added when event has guests and no existing conference link**
   - conferenceData.createRequest with hangoutsMeet + unique requestId; skipped if hangoutLink or entryPoints exist
   - src: `src/components/CalendarEventForm.tsx:96-100`
19. **Moving an event to a different calendar = delete from old + create in new**
   - Google PATCH can't change calendar; original account resolved from the old calendar
   - src: `src/components/CalendarEventForm.tsx:118-127`
20. **Form submit disabled without title; button shows 'Saving...' / 'Save Changes' / 'Create Event'**
   - Location/description trimmed, empty → undefined
   - src: `src/components/CalendarEventForm.tsx:102-108,269-276`
21. **Event popover closes on Escape, click-outside, backdrop click, or X**
   - Fixed overlay centered near top (pt-20)
   - src: `src/components/CalendarEventPopover.tsx:26-42,69-94`
22. **Popover header shows calendar color swatch, event title, calendar name**
   - Color from calendar.backgroundColor, fallback #3b82f6
   - src: `src/components/CalendarEventPopover.tsx:58,76-95`
23. **Popover time row: 'All day' or 'Ddd Mon N · HH:MM – HH:MM' (24h)**
   - All-day = no dateTime but has date
   - src: `src/components/CalendarEventPopover.tsx:46-54,99-103`
24. **'Join video call' link with authuser appended for Google Meet**
   - Uses hangoutLink or video entryPoint; appends ?/&authuser=<accountEmail> only for meet.google.com so it opens under the right account
   - src: `src/components/CalendarEventPopover.tsx:61-66,113-126`
25. **Popover attendee list capped at 5 with '+N more' and status dots, '(organizer)' label**
   - Dot colors green/yellow/red/gray for accepted/tentative/declined/needsAction
   - src: `src/components/CalendarEventPopover.tsx:128-145,232-240`
26. **Description block sanitized + auto-linkified, max-h 32 scrollable**
   - sanitizeAndLinkify → dangerouslySetInnerHTML with styled links
   - src: `src/components/CalendarEventPopover.tsx:147-150,272-280`
27. **Reminder picker with presets At start/5/10/15/30 min/1 hr; clicking active preset clears the reminder**
   - Only for owner/writer calendars on timed (non-all-day) events; resolves useDefault→calendar defaultReminders; Bell/BellOff icon reflects whether a reminder exists; onChange(null) clears
   - src: `src/components/CalendarEventPopover.tsx:154-160,263-270,282-318`
28. **RSVP buttons Accept/Maybe/Decline shown only when user is an attendee; active status highlighted**
   - canRsvp = attendees contains self; calls rsvp(calendarId, accountEmail, eventId, status)
   - src: `src/components/CalendarEventPopover.tsx:56-57,163-187,242-261`
29. **Popover Edit button opens the event form and closes the popover**
   - Owner/writer calendars only
   - src: `src/components/CalendarEventPopover.tsx:191-199`
30. **Popover Delete with project confirm dialog (danger style, 'Delete' label)**
   - showConfirm (not native confirm); deletes then closes popover; owner/writer only
   - src: `src/components/CalendarEventPopover.tsx:200-211`
31. **'Google' link in popover opens the event in Google Calendar**
   - Shown when event.htmlLink present, new tab
   - src: `src/components/CalendarEventPopover.tsx:215-225`
32. **Week/day time grid with 24 hourly rows at 48px per hour**
   - HOUR_HEIGHT=48px; hour labels shown on left gutter (h:00, hour 0 blank); minHeight 24*48px scrollable grid
   - src: `src/components/CalendarGrid.tsx:12,555-563`
33. **Prev/next week navigation chevrons in grid header**
   - ChevronLeft/ChevronRight call navigateWeek(-1)/(1)
   - src: `src/components/CalendarGrid.tsx:482-487`
34. **Grid header label formats week range or day**
   - Day view: 'Weekday, Month D, YYYY'; week same-month: 'July 13–19, 2026'; cross-month: 'Jun 29 – Jul 5, 2026'
   - src: `src/components/CalendarGrid.tsx:303-313`
35. **'+ Event' button in grid/month header opens create form**
   - openCreateForm() with no args; on mobile the 'Event' text label is hidden, icon only
   - src: `src/components/CalendarGrid.tsx:491-497`
36. **Pull-to-refresh on the grid and month views (mobile only)**
   - usePullToRefresh on scroll container calls refreshAll(); enabled only when isMobile
   - src: `src/components/CalendarGrid.tsx:153, CalendarMonth.tsx:104`
37. **Drag on empty grid column creates an event**
   - Mousedown+drag on empty column shows blue preview with live 'H:MM – H:MM' label; snaps to 15-min increments (12px); on release opens create form pre-filled with start/end; drags shorter than one 15-min snap are ignored (plain click does NOT create)
   - src: `src/components/CalendarGrid.tsx:316-325,392-406,602-606`
38. **Drag event body to move it (including across day columns)**
   - Only for owner/writer calendars (cursor-grab); snaps to 15-min grid; cursor column detection allows cross-day moves; dragged event dims to 40% opacity with preview block; no-op if position unchanged; commits via updateEvent with new start+end dateTimes
   - src: `src/components/CalendarGrid.tsx:328-344,407-425,613,630`
39. **Drag bottom edge of event to resize (change end time)**
   - 2px-high s-resize handle at event bottom, writable calendars only; snap 15min; min height one snap; commits end dateTime only
   - src: `src/components/CalendarGrid.tsx:347-361,426-444,668-674`
40. **Moving/resizing a recurring event opens a scope dialog**
   - RecurringEditDialog: radio 'This event' (default) vs 'All events' (patches the master recurringEventId), shows old time struck-through → new time, 'Save event' commits, 'Discard change' or backdrop click cancels
   - src: `src/components/CalendarGrid.tsx:417-418,684-777`
41. **Click event opens popover; click suppressed after a drag**
   - selectEvent(id); didDragRef prevents the click-after-drag from opening the popover; reader/overlay calendars are click-to-open only (cursor-pointer)
   - src: `src/components/CalendarGrid.tsx:625-630`
42. **Selected event highlighted with ring + brightness**
   - ring-1 ring-white/30 brightness-125 when selectedEventId matches; hover:brightness-125 otherwise
   - src: `src/components/CalendarGrid.tsx:629`
43. **Events colored by calendar with muted palette**
   - muteColor mixes hex: bg = c*0.35+25, text = c*0.5+160, border = raw calendar color; unknown calendar falls back to #3b82f6
   - src: `src/components/CalendarGrid.tsx:16-27,211`
44. **Duplicate events across calendars merged into one block with color stripes**
   - Merge key = start+end+summary; merged block shows one 3px stripe per source calendar color; display/RSVP prefers the user's own calendar copy; accepted if ANY copy accepted
   - src: `src/components/CalendarGrid.tsx:230-256,643-650`
45. **Unaccepted invites render as dashed-outline transparent blocks**
   - accepted = no attendees OR organizer.self OR self attendee responseStatus==='accepted'; otherwise dashed border, transparent background
   - src: `src/components/CalendarGrid.tsx:223,627,636-640`
46. **Google Task events show a square checkbox icon**
   - isTask = description contains 'tasks.google.com/task/'; 8px Square icon before title
   - src: `src/components/CalendarGrid.tsx:221,653`
47. **Bell icon on events with a reminder**
   - hasReminder = explicit reminder overrides, or useDefault with calendar defaultReminders present
   - src: `src/components/CalendarGrid.tsx:224-226,654`
48. **Event block shows time range when >30px tall, location when >50px tall**
   - HH:MM–HH:MM (24h locale) at height>30; location line at height>50 with location present; title always shown truncated
   - src: `src/components/CalendarGrid.tsx:657-666`
49. **Overlapping events share width via greedy column packing**
   - Events placed in first non-overlapping column; width = 1/concurrent-columns at that time; non-overlapping events stack full-width
   - src: `src/components/CalendarGrid.tsx:260-296`
50. **Red current-time indicator line on today's column**
   - Red dot + horizontal line positioned at now-minutes; pointer-events-none, z-20; today column tinted bg-accent/3
   - src: `src/components/CalendarGrid.tsx:475-476,582-590`
51. **Day headers highlight today**
   - Today column header gets bg-accent/5 tint and accent-colored day number; day names Mon-Sun (Monday-start weeks)
   - src: `src/components/CalendarGrid.tsx:503-511`
52. **Working-location row above the grid**
   - Shown only when workingLocation events exist; MapPin gutter icon; per-day label Home/office-label/custom-label (falls back to summary or 'Home'); '—' when no location; click opens the location picker
   - src: `src/components/CalendarGrid.tsx:42-53,514-540`
53. **All-day bar with multi-day spanning bars**
   - Shown only when all-day events exist; greedy row packing (sorted by start col then longer span first), row height 18px; Google exclusive end dates handled; click selects event; selection ring + hover brighten
   - src: `src/components/CalendarGrid.tsx:542-551,785-893`
54. **Working-location picker popup**
   - Modal at top-center; shows date ('Wed, Jul 22'); options: Home, each known office label (collected from existing workingLocation events, sorted), default 'Office' when none known, and 'Custom location...' which reveals a text input committing on Enter; current choice highlighted; closes on Escape, outside-click, backdrop click, or X button
   - src: `src/components/CalendarLocationPicker.tsx:37-150`
55. **Month view 6-week grid, Monday-anchored**
   - buildMonthWeeks: always 6 rows × 7 days including prev/next-month spillover; spillover day numbers dimmed (text-tertiary/50); row minHeight 110px desktop / 70px mobile
   - src: `src/components/CalendarMonth.tsx:36-50,321,326-349`
56. **Month header prev/next month chevrons + 'Month YYYY' label**
   - navigateMonth(-1)/(1)
   - src: `src/components/CalendarMonth.tsx:283-289`
57. **Click empty month cell creates event 9:00–10:00 that day**
   - handleCellClick opens create form with start 09:00 end 10:00
   - src: `src/components/CalendarMonth.tsx:268-272,332`
58. **Month cell '+N more' overflow link jumps to day view**
   - Lane cap 4 desktop / 6 mobile; overflowing events counted; click sets view='day' and navigates to that date; label '+N' on mobile, '+N more' on desktop
   - src: `src/components/CalendarMonth.tsx:77-78,274-277,391-399`
59. **Month single-day event pills with time prefix, task/bell icons**
   - Desktop pills show HH:MM (timed events), Square for tasks, Bell for reminders, truncated title; mobile pills are 5px-high color bars with no text; all-day pills sort before timed, timed by start time
   - src: `src/components/CalendarMonth.tsx:245-247,353-388`
60. **Month multi-day all-day events render as spanning bars across the week row**
   - Percentage-positioned bars clamped per row, lane-shared with pills; title hidden on mobile; unaccepted = dashed transparent; click selects
   - src: `src/components/CalendarMonth.tsx:404-434`
61. **Month today cell: accent tint + filled circle day number**
   - bg-accent/5 cell, w-5 h-5 rounded-full bg-accent white number
   - src: `src/components/CalendarMonth.tsx:325,340-346`
62. **Month day-name header shows single letters on mobile**
   - 'M T W T F S S' mobile vs 'Mon Tue…' desktop
   - src: `src/components/CalendarMonth.tsx:302-311`
63. **Month view merges duplicate cross-calendar events like week view**
   - Same key/color-merge/own-copy-preference/accepted-union logic; workingLocation events excluded from month view
   - src: `src/components/CalendarMonth.tsx:123-172`
64. **Mobile header controls: Today button + M/W/D view switcher**
   - CalendarMobileControls rendered in grid/month header only on mobile (desktop has these in sidebar); active view button highlighted
   - src: `src/components/CalendarMobileControls.tsx:16-37`
65. **Mobile flights button with watchlist count badge**
   - Plane icon opens FlightsSheet (setSheetOpen(true)); accent-colored count superscript shown when watchlists > 0
   - src: `src/components/CalendarMobileControls.tsx:38-49`
66. **Sidebar Today button + M/W/D view toggle (desktop)**
   - navigateToday; setView('month'|'week'|'day'); active view highlighted bg-surface-2
   - src: `src/components/CalendarSidebar.tsx:38-70`
67. **Sidebar mini month picker**
   - 42-cell Monday-start grid; chevrons jump to 1st of prev/next month; clicking any day navigates the main view to it; selected day = accent bg, today = surface-2 bold, out-of-month days dimmed
   - src: `src/components/CalendarSidebar.tsx:176-238`
68. **Sidebar calendar list grouped by account; synthetic overlays collapse into one 'Overlays' group**
   - Groups keyed by accountEmail; all synthetic (Meetup, OutdoorLads) calendars share a single 'Overlays' header
   - src: `src/components/CalendarSidebar.tsx:23-33,77-82`
69. **Per-calendar visibility toggle (click name/swatch or eye icon)**
   - toggleCalendarVisibility; visible = filled color swatch + Eye on hover; hidden = outline swatch, dimmed name, EyeOff at 50% opacity always shown
   - src: `src/components/CalendarSidebar.tsx:93-125`
70. **Calendar swatch badges: RSS icon for imported ICS, person icon for read-only**
   - Rss glyph when id includes '@import.calendar.google.com'; User glyph when accessRole reader/freeBusyReader (non-import)
   - src: `src/components/CalendarSidebar.tsx:104-109`
71. **Star to set/unset default calendar for new events**
   - Only on writable (owner/writer) calendars; filled star when default; click toggles (clicking current default clears it to null); star hidden until row hover unless default
   - src: `src/components/CalendarSidebar.tsx:126-140`
72. **'Add calendar account' opens Google OAuth popup**
   - window.open hub /auth/google/start (500×600 popup), then addAccount(popup) tracks completion
   - src: `src/components/CalendarSidebar.tsx:148-161`
73. **Flight watchlists panel embedded at bottom of sidebar**
   - FlightsPanel rendered below a border separator (desktop sidebar)
   - src: `src/components/CalendarSidebar.tsx:164-167`
74. **Calendar boot chain retries with backoff until accounts load**
   - Attempts at 0/1.5s/4s/10s/25s delays; skips while not signed in; loads accounts→calendars→events, then inits flights store; prevents pane stuck on 'Loading calendars...' forever
   - src: `src/components/CalendarTab.tsx:24-53`
75. **Signed-out state shows 'Sign in with Google to view your calendar'**
   - Rendered when isSignedIn() false
   - src: `src/components/CalendarTab.tsx:55-61`
76. **'Loading calendars...' empty state**
   - Shown when not connected, zero calendars, and not loading
   - src: `src/components/CalendarTab.tsx:63-69`
77. **Sidebar hidden on mobile; month vs grid view switch; popover/form/location-picker/flights-sheet conditionally mounted**
   - 52-width sidebar desktop only; view==='month' → CalendarMonth else CalendarGrid; CalendarEventPopover when selectedEventId; CalendarEventForm when showEventForm; FlightsSheet mounted on mobile
   - src: `src/components/CalendarTab.tsx:71-88`
78. **Flights sidebar section collapsible with watchlist count badge (desktop compact mode)**
   - Chevron+Plane header toggles collapse; count shown when >0; mobile sheet variant omits the header (sheet itself toggles)
   - src: `src/components/FlightsPanel.tsx:64`
79. **Amber warning when SerpApi key unset**
   - 'SerpApi key not set. Run con cal flights credentials --key …' with TriangleAlert icon, shown when configured===false
   - src: `src/components/FlightsPanel.tsx:84`
80. **'No watchlists yet' empty state and 'Loading…' indicator**
   - Empty state only after loaded and when add form closed
   - src: `src/components/FlightsPanel.tsx:91`
81. **Watchlist row: label (or auto-description), latest best price, delta arrow vs previous poll**
   - Auto-description: explore = 'ORG → region/dest · Mon|next 6mo', route = 'ORG → DST · date'. Price green when <= maxPriceMajor alert threshold. Delta from last two history entries: ↓N green when cheaper, ↑N gray; hidden when 0. Prices rounded, £/$/€ symbol else 'N CUR'
   - src: `src/components/FlightsPanel.tsx:154`
82. **Per-watchlist refresh (poll now) button with spinning icon while running; disabled during run**
   - Compact mode: buttons hidden until row hover (opacity 0 → 60 → 100). runOne(id) triggers hub SerpApi poll
   - src: `src/components/FlightsPanel.tsx:176`
83. **Per-watchlist remove (trash) button**
   - remove(id), same hover-reveal behavior in compact mode
   - src: `src/components/FlightsPanel.tsx:183`
84. **Click watchlist row to expand results: 8 results in compact sidebar, 20 in mobile sheet**
   - One row expanded at a time (expandedId toggle). Expanded shows lastError in red italic, 'No results yet — refresh to poll.' when empty, and 'Checked Nm/Nh/Nd ago' footer
   - src: `src/components/FlightsPanel.tsx:97`
85. **Result row: label (explore results deep-link to Google Flights), dep→arr times, or date window, price, meta line**
   - Times parsed as HH:MM tail of SerpApi 'YYYY-MM-DD HH:MM' ('?' when missing); date window formatted 'DD Mon–DD Mon'; meta = flight numbers (else airlines) · 'direct'/'Nst' stops · duration 'XhYm'
   - src: `src/components/FlightsPanel.tsx:242`
86. **New-watchlist form with Anywhere/Route kind toggle**
   - Explore fields: Origin (default LHR, uppercased), Region select (Europe/Asia/N.America/S.America/Africa/Oceania), optional Destination, Month select ('Next 6mo' or Jan..Dec), Duration (Weekend/1 week/2 weeks). Route fields: Destination + Outbound date (required — submit disabled without them) + optional Return date. Common: optional Label, 'Alert under (£)' max price (decimal inputMode). Submit shows 'Adding…'; Cancel closes form
   - src: `src/components/FlightsPanel.tsx:347`
87. **Mobile full-screen flights sheet with Escape-to-close and X button**
   - z-[55] overlay titled 'Flight watchlists'; wraps FlightsPanel compact=false; opened from CalendarMobileControls; keydown Escape closes
   - src: `src/components/FlightsSheet.tsx:17`
88. **Calendar keys: t today, h/l or arrows prev/next week, w/d/m week/day/month views, c open create form**
   - Plus '?' help and Shift+T dark mode within the pane scope.
   - src: `src/hooks/useKeybindings.ts:255-302`
89. **Calendar refetch on hub 'cal.delta' (500ms debounce), on WS reconnect, and 15-min fallback**
   - If the store isn't connected (boot failed while hub down) the refetch retries the full loadAccounts→fetchCalendars→fetchEvents chain so the pane recovers without a reload.
   - src: `src/hooks/useSync.ts:226-261`
90. **Calendar offline-queue flush: 500ms after enqueue + every 5s**
   - processCalendarQueue for calCreate/calUpdate/calDelete/calRsvp/calReminder/calLocation actions.
   - src: `src/hooks/useSync.ts:264-286`
91. **Client-side event reminders: 60s checker with per-reminder dedup**
   - Every 60s (and on mount) scans events; reminder minutes from event overrides or calendar defaults (useDefault); fires when reminderTime fell within the last 60s. Notification: title=summary, body '<In N min|In N hr|Now> · HH:MM · location', tag 'cal-<id>-<mins>', deep-link pane calendar. Fired keys persisted to localStorage 'cal_reminded' (last 200 kept).
   - src: `src/hooks/useSync.ts:289-348`
92. **Meetup events appear as a read-only synthetic 'Meetup' calendar (brand pink #ff4a79)**
   - Every map-store Meetup event (incl. online/hybrid with no map pin) becomes a timed CalendarEvent; no end time → 1h block; location 'Online' or 'venue, city'; description = group name + 'N going' + event URL; accessRole reader blocks drag/edit/delete; overlay auto-unregisters when event list empties
   - src: `src/meetup/calendar-overlay.ts:21-98`
93. **OutdoorLads camping events as a read-only synthetic 'OutdoorLads' calendar (brand orange #f5821f)**
   - Hub feed filtered to event types containing 'camp' (case-insensitive substring); feed has no end times so events render as 2h blocks; description = type + text + link; accessRole reader blocks editing; overlay unregisters when zero matching events
   - src: `src/outdoorlads/calendar-overlay.ts:36-117`
94. **OutdoorLads overlay refresh cadence with boot retry backoff**
   - Refreshes on boot, on every hub reconnect, and every 6h; boot fetch retries at 0/1s/3s/8s/20s so a hub-restart race can't leave the overlay permanently missing; overlapping refreshes guarded by a single-flight flag; unreachable → keeps last overlay
   - src: `src/outdoorlads/calendar-overlay.ts:85-127`
95. **Default view: day on phones, week on desktop**
   - Initial view is 'day' when window.innerWidth < 768 (7-col grids too cramped), else 'week'; user can switch.
   - src: `src/store/calendar.ts:199-201`
96. **Calendar visibility persists via hub prefs**
   - visibleCalendarIds and defaultCalendarId hydrate from hub prefs ('calendar.visibleIds', 'calendar.defaultId') at boot; toggleCalendarVisibility flips a calendar and persists the full set, then reloads events from IDB (display filter only — hidden calendars' events stay cached).
   - src: `src/store/calendar.ts:210-211,502-511`
97. **Add Google account via OAuth popup**
   - addAccount runs the OAuth flow (optionally into a supplied popup window), then refreshes accounts, calendars, and events.
   - src: `src/store/calendar.ts:221-232`
98. **Remove account**
   - removeAccount drops the account, filters its calendars out of the sidebar, and reloads events from IDB.
   - src: `src/store/calendar.ts:234-242`
99. **Calendar list dedupe across accounts with best-token routing**
   - fetchCalendars fetches every account's calendar list (Promise.allSettled — one account failing doesn't block others), filters selected!==false, dedupes shared calendars by id (displayed under the primary account), and picks the best apiAccountEmail per calendar: exact owner (id==email) first, else highest access role (owner>writer>reader>freeBusyReader). Offline/no-accounts falls back to the IDB-cached calendar list so the UI isn't stuck on 'Loading calendars…'.
   - src: `src/store/calendar.ts:246-369`
100. **First-load default: all calendars visible**
   - When no saved visibleIds pref exists and prefs are confirmed loaded, all calendars (incl. overlays) default visible and the set is persisted; if prefs are still loading, the in-memory set is left alone (no clobber on hub race).
   - src: `src/store/calendar.ts:337-347`
101. **Overlay visibility re-asserted after pref load**
   - A saved visibleIds pref that predates an overlay (Meetup/OutdoorLads) would hide it; fetchCalendars re-adds any overlay not in OVERLAY_SEEN_PREF (first-seen defaults visible) or currently in the live set — only an explicit toggle-off sticks.
   - src: `src/store/calendar.ts:348-358`
102. **Event fetch window pads the visible range**
   - fetchEvents covers the visible view plus padding (week/day: −1wk to +2wks around the week; month: 8 weeks starting a week before the grid), fetches ALL non-synthetic calendars regardless of visibility (so toggling a calendar visible instantly shows cached events), skips cancelled events, and bulk-puts to IDB.
   - src: `src/store/calendar.ts:117-125,371-440`
103. **Stale-event cleanup protects pending optimistic writes**
   - After a fetch, IDB events in the range that the API didn't return are deleted (removed on GCal) — EXCEPT events with pending/processing queue actions or temp IDs awaiting server IDs, so offline creates/updates aren't wiped by a refresh.
   - src: `src/store/calendar.ts:411-431`
104. **Week/day prev-next navigation (h/l)**
   - navigateWeek(±1) moves 7 days in week view, 1 day in day view (delegates to navigateMonth in month view); clears event selection; loads IDB-cached events instantly then background-refreshes the new range from Google.
   - src: `src/store/calendar.ts:450-463`
105. **Month navigation clamps day-of-month**
   - navigateMonth adds months clamping to the target month's last day (Jan 31 → Feb 28); same instant-IDB-then-refresh pattern.
   - src: `src/store/calendar.ts:110-115,465-472`
106. **Today jump (t)**
   - navigateToday resets to now, clears selection, instant IDB load + background fetch.
   - src: `src/store/calendar.ts:474-480`
107. **Jump to arbitrary date**
   - navigateToDate(date) same semantics as today-jump for any target date (e.g. mini-calendar click).
   - src: `src/store/calendar.ts:482-487`
108. **View switch (w/d/month) re-fetches range**
   - setView re-hydrates IDB events for the new view's range immediately then background-refreshes; no-ops the fetch if the view didn't change.
   - src: `src/store/calendar.ts:489-499`
109. **Read-only overlay sources (Meetup/OutdoorLads)**
   - registerOverlaySource merges a synthetic calendar (sidebar toggle + colour) + in-memory events; first-ever registration defaults it visible and atomically persists OVERLAY_SEEN + visibleIds (both gated on isPrefsLoaded — deferred if prefs not ready, so a boot race can't record seen-but-hidden). Overlay events merge into the grid filtered by same range + visibility; never persisted to Dexie, never synced to Google. unregister removes both.
   - src: `src/store/calendar.ts:520-559,819-827`
110. **Create event — optimistic with temp ID**
   - createEvent writes a '~timestamp.random' temp-ID event to IDB immediately (shows in grid instantly), then enqueues calCreate on the offline sync queue (3 retries, survives reload); the temp ID is registered in pendingTempIds so refreshes don't wipe it before the real Google ID replaces it.
   - src: `src/store/calendar.ts:563-597`
111. **Update event — optimistic merge with rollback payload**
   - updateEvent merges changed fields (summary/description/location/start+allDay/end/status/attendees/reminders) into IDB immediately and enqueues calUpdate carrying the pre-edit row as rollback.
   - src: `src/store/calendar.ts:599-627`
112. **Delete event with 5-second undo toast**
   - deleteEvent removes the event from the grid instantly (optimisticallyDeleted set) and shows an undo toast expiring after 5000ms; undo restores the IDB row and removes the queued calDelete; otherwise the IDB delete + enqueue proceed in the background.
   - src: `src/store/calendar.ts:629-658`
113. **RSVP accept/decline/tentative — optimistic**
   - rsvp flips the self-attendee's responseStatus locally in IDB and enqueues calRsvp.
   - src: `src/store/calendar.ts:660-676`
114. **Set/clear event reminder — optimistic**
   - setReminder(minutes|null) writes reminders {useDefault:false, overrides:[{popup, minutes}]} (or empty overrides to clear) to IDB and enqueues calReminder.
   - src: `src/store/calendar.ts:678-694`
115. **Working-location picker (Home/Office/Custom)**
   - updateLocation optimistically deletes the old working-location event and creates a temp-ID replacement: homeOffice → summary 'Home'; officeLocation → custom label or 'Office'; customLocation → label. Event created as workingLocation type, transparent, public; enqueues calLocation. openLocationPicker/closeLocationPicker drive the dialog.
   - src: `src/store/calendar.ts:696-752,765-766`
116. **Create-event form defaults to next full hour**
   - openCreateForm without a drag-selected range defaults start = top of the next hour, end = +1 hour.
   - src: `src/store/calendar.ts:756-761`
117. **Edit-event form**
   - openEditForm opens the same form pre-populated with an existing event; closeEventForm clears form + pending range.
   - src: `src/store/calendar.ts:763-764`
118. **Grid load merges timed + all-day events, sorted by start**
   - loadEventsFromDb queries IDB by view range (day: single day; week: ±1 day pad; month: 44-day grid window), separately catches all-day events (date-only startTime keys), dedupes by compoundKey, filters to visible calendars and not-optimistically-deleted, merges overlay events in the same range, and sorts everything by start time.
   - src: `src/store/calendar.ts:770-830`
119. **Flights watchlist panel mirrors hub via sync bus (no client polling)**
   - init() (idempotent via loaded flag) fetches watchlists + configured status, then subscribes SyncBus flights.polled/created/updated/deleted so the panel updates live when the hub's 24h poll or another device changes anything; deleted also collapses the expanded row.
   - src: `src/store/flights.ts:131-223`
120. **Create flight watchlist (route or explore kind)**
   - create POSTs the input (origin, optional destination/region, month, duration Weekend|1 week|2 weeks, dates, travelClass 1-4, adults, maxPrice, notifyOnDrop) and appends the result, auto-closing the add form.
   - src: `src/store/flights.ts:148-155`
121. **Delete flight watchlist**
   - remove DELETEs by id and clears its expanded state.
   - src: `src/store/flights.ts:157-163`
122. **Run watchlist now with per-row spinner**
   - runOne adds the id to runningIds (spinner on that row), POSTs /run, replaces the row with the fresh result, clears the spinner even on error.
   - src: `src/store/flights.ts:165-182`
123. **Expandable watchlist rows + add-form toggle + mobile sheet**
   - expandedId toggles one open row (price history, lastResults with airlines/stops/segments); showAddForm toggles the create form; sheetOpen controls the mobile full-screen FlightsSheet (desktop renders inline).
   - src: `src/store/flights.ts:184-186`
124. **SerpApi not-configured state**
   - configured flag from /flights/status (null while unknown, false on error) lets the panel show a credentials-needed message.
   - src: `src/store/flights.ts:189-196`
125. **Event descriptions sanitized with URLs auto-linked, opening in new tabs**
   - sanitizeAndLinkify allows a small tag whitelist (a/b/i/u/strong/em/br/p/span/div/ul/ol/li, href only), wraps raw http(s) URLs in anchors (skipping text already inside links), and forces target=_blank rel=noopener on all anchors.
   - src: `src/utils/html.ts:18`

## chat (148)

1. **Uncontrolled chat textarea — zero React renders per keystroke**
   - Text lives in a ref; only hasContent flips or autocomplete state trigger renders; auto-resize 24px min to 120px max, rAF-coalesced
   - src: `src/components/ChatComposeInput.tsx:48-53,403-414`
2. **Enter sends, Shift+Enter newline**
   - Enter without shift preventDefaults and sends
   - src: `src/components/ChatComposeInput.tsx:397-400`
3. **Emoji shortcode autocomplete via ':query'**
   - Triggers after ':' + ≥1 char of [a-z0-9_+-]; dropdown shows emoji + :shortcode:; ArrowUp/Down navigate, Enter/Tab insert, Escape dismisses; mouse-down insert; cursor placed after emoji; re-checks on arrow-key cursor moves (keyup)
   - src: `src/components/ChatComposeInput.tsx:117-136,220-243,336-388,428-435,462-479`
4. **@-mention autocomplete**
   - Opens only when '@' at input start or after whitespace (emails don't trigger); searches room members (list primed on room switch so first '@' isn't blank); same keyboard nav as emoji; picking inserts '@DisplayName ' with trailing space and records userId; dropdown shows @display + full MXID when display differs from localpart
   - src: `src/components/ChatComposeInput.tsx:141-163,188-218,339-362,483-506`
5. **Mentions become matrix.to links + m.mentions only if the @token survives to send**
   - buildMentionsFormatted regex-checks each recorded mention still present as discrete '@Name' token (deleted mentions don't notify); longer names replaced first; formatted_body anchors per MSC3952
   - src: `src/components/ChatComposeInput.tsx:25-45,320-329`
6. **Editing a message rebuilds mentions from full room member list**
   - Edit candidates = freshly picked mentions + all room members so pre-existing @Name tokens still resolve; dedup by userId keeping picked first
   - src: `src/components/ChatComposeInput.tsx:265-291`
7. **Multi-file attachment queue with previews**
   - Paperclip button opens multi-file picker; images get object-URL thumbnail (max-h-24) with X remove button; non-images get filename chip with Paperclip icon, size formatted B/KB/MB(1dp), and remove X; each removable individually
   - src: `src/components/ChatComposeInput.tsx:165-183,540-575,578-591`
8. **Paste attaches ALL images from clipboard**
   - Every image item attached (not just first); preventDefault only when an image was consumed so plain-text paste still works
   - src: `src/components/ChatComposeInput.tsx:437-451`
9. **Sending N attachments dispatches N sequential Matrix events; typed text captions only the FIRST**
   - WhatsApp/Beeper behavior; images → sendImage, others → sendFile, in order; input cleared before awaiting
   - src: `src/components/ChatComposeInput.tsx:294-317`
10. **Reply preview pill above composer**
   - Shows sender name + truncated body with left border; X cancels (setReplyingTo(null)); input auto-focuses when a reply target is set
   - src: `src/components/ChatComposeInput.tsx:87-92,510-520`
11. **Edit mode: composer pre-fills with message body, blue 'Editing' pill**
   - Pre-fills textarea, cursor at end, focus; keyed on editingMessage.seq so re-editing the same message re-arms; Escape or X cancels and clears input; send submits m.replace via editMessage and skips attach/reply paths
   - src: `src/components/ChatComposeInput.tsx:97-115,260-291,390-395,522-538`
12. **Send button disabled when no text and no attachments; re-entrancy guard**
   - sendingRef blocks double-send; input refocused after send
   - src: `src/components/ChatComposeInput.tsx:260-261,604-611`
13. **Composer text echoed to glasses mirror**
   - Every change + clear pushes to useGlassesStore.setComposerText('chat', value) so lenses show live typing
   - src: `src/components/ChatComposeInput.tsx:257,425`
14. **Message bodies render Matrix formatted_body HTML sanitized, else lightweight markdown, else linkified plain text**
   - DOMPurify allowlist (b/i/code/pre/blockquote/lists/tables/headings etc.); <mx-reply> blocks and bridge data-mx-profile-fallback sender prefixes stripped; bare URLs auto-linkified inside HTML; markdown supports fenced/inline code, bold/italic/strike, h1-h3, blockquotes, [text](url) links
   - src: `src/components/ChatMessageBubble.tsx:16-115`
15. **Bare URLs in plain text become clickable blue links (new tab)**
   - Linkified splits on http(s) regex; target=_blank rel noopener
   - src: `src/components/ChatMessageBubble.tsx:171-215`
16. **Link preview card for the first URL in a text message**
   - Homeserver URL-preview API; only first URL; renders og:image (mxc converted), og:title, og:description (2-line clamp), hostname; whole card is a link; a single failed fetch marks previews unsupported for the session (no repeated 404s); suppressed on deleted messages
   - src: `src/components/ChatMessageBubble.tsx:217-280,972-973`
17. **E2EE image/video/file/audio decryption to blob URLs**
   - encryptedFile decrypted client-side via decryptAttachment; plain mxc served via hub proxy; italic placeholder ([Image: alt] etc.) while unavailable
   - src: `src/components/ChatMessageBubble.tsx:283-406`
18. **Image messages: click opens lightbox; filename-only captions suppressed**
   - data-chat-image, max 320×240 thumbnail, lazy-loaded; caption shown under image unless it's just a filename (extension regex); same for video with video-extension regex
   - src: `src/components/ChatMessageBubble.tsx:304-314,936-949`
19. **PDF attachments open in in-app PDF lightbox; other files are download links**
   - isPdf by mime or .pdf name → onPdfClick button '📄 label'; others '📎 label' anchor with download filename derived from MIME extension map when body empty
   - src: `src/components/ChatMessageBubble.tsx:319-368,950-951`
20. **Voice-note/audio player with waveform, seek, speed cycle, download**
   - Play/pause round button; canvas waveform (≤48 bars, progress-colored) or thin progress bar; click-to-seek maps x-fraction to duration; speed button cycles 1×→1.5×→2×→1×, persisted in localStorage 'chat:audioRate'; preservesPitch true so speedup doesn't chipmunk; time label shows current when playing else total; Download icon saves file (default voice.ogg/audio.mp3)
   - src: `src/components/ChatMessageBubble.tsx:408-649`
21. **Deleted messages recover original content from hub archive**
   - Struck-through red original text; recovered images render inline (eager-loaded, red-tinted border, click opens lightbox); non-image recovered attachments as '📎 recovered attachment' download; falls back to 'Message deleted' only after archive miss; '(deleted by name)' suffix when redactor known; local-echo IDs skip the archive RPC (8s timeout)
   - src: `src/components/ChatMessageBubble.tsx:656-727,934-935`
22. **Edited messages show inline word diff**
   - diffWords: removed = red strikethrough, added = green, unchanged normal, '(edited)' suffix; plain '(edited)' tag when originalBody unavailable
   - src: `src/components/ChatMessageBubble.tsx:729-745,966-967,976-978`
23. **Message grouping: avatar + sender + timestamp only on first of a sender run**
   - showSender controls avatar/name/time header; grouped messages get mt-0.5 vs mt-3; own messages labeled 'You'; avatar = 24px mxc thumbnail or initial letter circle; timestamp via formatDate
   - src: `src/components/ChatMessageBubble.tsx:879-924`
24. **Bridge 'name: ' prefix stripped from message body when it matches sender name**
   - displayBody removes leading 'senderName: '
   - src: `src/components/ChatMessageBubble.tsx:772-778`
25. **Pending/failed send indicators without layout shift**
   - Local-echo (~id) messages dim to 60% with Clock icon; sendFailed tints text red with AlertCircle icon (title = failure reason); indicators absolutely positioned so state flips don't reflow
   - src: `src/components/ChatMessageBubble.tsx:786,908-913,983-993`
26. **Reply-context quote line above replied messages**
   - Left-bordered truncated quoted body, 'Original message' fallback
   - src: `src/components/ChatMessageBubble.tsx:927-931`
27. **Desktop hover toolbar on messages: Reply, React (emoji grid), Edit**
   - Appears on hover top-right; Edit only for own, non-deleted, acked (non-~) text messages; emoji picker = 24-emoji 8-col grid popover, closes on outside mousedown or select
   - src: `src/components/ChatMessageBubble.tsx:119-168,892-904`
28. **Mobile long-press context menu on messages: quick reactions + Reply/Edit/Copy text**
   - Header strip of 6 quick reactions (❤️👍😂😮😢🙏) one-tap; items: Reply, Edit (same gating as desktop), 'Copy text' → clipboard; deleted messages get no menu
   - src: `src/components/ChatMessageBubble.tsx:127,828-856,1042-1052`
29. **Swipe-right-to-reply on mobile**
   - Horizontal-direction lock after 5px; bubble translates up to 80px with Reply icon fading in; release past 50px triggers reply; snaps back with 0.2s transition
   - src: `src/components/ChatMessageBubble.tsx:789-816,858-877`
30. **Reaction chips under messages; click toggles your reaction; tooltip lists reactors by name**
   - emoji + count pill per reaction; onReact(message, emoji); title = resolved display names joined by comma
   - src: `src/components/ChatMessageBubble.tsx:995-1009`
31. **Read-receipt avatar stack on messages**
   - Up to 5 16px avatars (or initial circles) bottom-right; '+N' overflow count; tooltip 'name • time'
   - src: `src/components/ChatMessageBubble.tsx:1011-1036`
32. **Notice messages italic tertiary; emote messages rendered '* sender action'**
   - m.notice and m.emote styling
   - src: `src/components/ChatMessageBubble.tsx:962-965`
33. **Room list shows only favourites + unread inbox rooms**
   - Dexie liveQuery filter: favourites always; others require isUnread && !snoozed && !lowPriority && !muted; sorted by lastMessageTime descending
   - src: `src/components/ChatRoomList.tsx:62-73`
34. **Pinned favourites section above 'Inbox' divider**
   - Pinned sorted alphabetically by name; divider with 'INBOX' label only when both sections non-empty; store rooms set in visual order so j/k navigation matches
   - src: `src/components/ChatRoomList.tsx:86-99,131-149`
35. **Mobile 'Search all chats…' bar opens the same SearchOverlay as desktop '/'**
   - Rendered at top of room list on mobile only
   - src: `src/components/ChatRoomList.tsx:49-57`
36. **Pull-to-refresh on room list triggers hub matrix syncNow (mobile)**
   - hubBus.rpc('matrix','syncNow')
   - src: `src/components/ChatRoomList.tsx:59`
37. **Desktop auto-selects first room when none selected**
   - Prefers first inbox room, falls back to first pinned; mobile never auto-selects
   - src: `src/components/ChatRoomList.tsx:102-108`
38. **Selected room auto-scrolled into view in the list**
   - scrollIntoView block:nearest on selection change
   - src: `src/components/ChatRoomList.tsx:111-115`
39. **'No unread chats' empty states**
   - Full-pane version when list empty; inline version when pinned exist but inbox empty
   - src: `src/components/ChatRoomList.tsx:117-126,162-166`
40. **Room list re-render suppression via field-level identity stabilization**
   - Rooms whose rendered fields (id/name/avatar/networkIcon/lastMessage*/isUnread/snoozedUntil/isLowPriority/tags) didn't change reuse prior object identity so memo'd items skip re-render each sync tick
   - src: `src/components/ChatRoomList.tsx:19-37,77-83`
41. **Room row: avatar with bridge network badge**
   - 32px avatar thumbnail or MessageCircle placeholder; bottom-right mini badge with brand icon for whatsapp/slack/discord/instagram/signal/telegram/linkedin/facebook/twitter(X)/googlechat/gmessages/imessage
   - src: `src/components/ChatRoomListItem.tsx:23-47,138-155`
42. **Room row content: name, relative time, 'sender: preview', unread count**
   - Pin icon (40% opacity) when favourite; snoozed rows show Clock icon + snoozedUntil relative time instead of lastMessageTime, and dim to 50%; unread count in blue, capped '99+'
   - src: `src/components/ChatRoomListItem.tsx:158-182`
43. **Room right-click/long-press context menu: Pin/Unpin, Mute/Unmute, Demote to low priority/Restore to inbox, Reload room**
   - All toggles optimistic: local Dexie row flipped immediately, then hub call (setRoomTag/removeRoomTag m.favourite/m.lowpriority, setRoomMuted); failures self-heal via next Matrix sync
   - src: `src/components/ChatRoomListItem.tsx:84-124,198`
44. **'Reload room' wipes cached messages and re-fetches, preserving recoverable deleted text**
   - Deletes all cached messages EXCEPT deleted ones that still carry a body (re-pagination would return empty tombstones, losing the text forever); clears prevBatch; re-resolves room name from state; ensureMessages re-loads
   - src: `src/components/ChatRoomListItem.tsx:57-78`
45. **Swipe-right on room row marks it read (mobile)**
   - SwipeableRow with green Check action → markRoomRead; disabled for snoozed rows
   - src: `src/components/ChatRoomListItem.tsx:186-196`
46. **Image lightbox: click backdrop or press Escape to close (cursor-zoom-out backdrop)**
   - Key handler bound in capture phase with stopPropagation so Esc doesn't also deselect the chat room behind it; clicking the image itself does not close.
   - src: `src/components/ImageLightbox.tsx:22-44`
47. **Lightbox gallery nav: ←/→ keys and on-screen chevron buttons page through images (only when onPrev/onNext provided)**
   - Chevrons in black/50 circles at left/right mid-height; tooltips 'Previous (←)' / 'Next (→)'.
   - src: `src/components/ImageLightbox.tsx:26-67`
48. **Lightbox position counter chip 'i / total' at bottom center, only when total > 1**
   - tabular-nums; click on chip doesn't close.
   - src: `src/components/ImageLightbox.tsx:69-76`
49. **Lightbox image capped at 90vh × 90vw, object-contain**
   - src: `src/components/ImageLightbox.tsx:54-59`
50. **Chat pane: fixed 288px room list on desktop; mobile master/detail keyed on selectedRoomId**
   - src: `src/components/Layout.tsx:145-168`
51. **Matrix login modal: homeserver (with .well-known discovery hint), username, password with show/hide eye toggle; Connect disabled until all filled; success stores matrix_user_id then reloads the page to start sync; errors inline**
   - Closable via X or backdrop; homeserver field autofocused; button label 'Connecting...' while busy.
   - src: `src/components/MatrixLoginModal.tsx:17-111`
52. **Chat pane empty state shows InboxZero when no rooms exist**
   - rooms.length===0 renders InboxZero component instead of room view
   - src: `src/components/ChatRoomView.tsx:101`
53. **'Select a chat' placeholder when no room selected**
   - Centered tertiary text when rooms exist but selectedRoomId is null
   - src: `src/components/ChatRoomView.tsx:105`
54. **Room header shows room name (truncated) and member count**
   - Member count line only shown when memberCount>2 ('N members'); one header per room, display toggled to selected only
   - src: `src/components/ChatRoomView.tsx:123`
55. **External profile link icon in room header (e.g. LinkedIn)**
   - Lazily fetched from GET /matrix/rooms/:id/info on room selection, cached per roomId (never refetched). LinkedIn network gets FaLinkedin icon, others generic ExternalLink; opens in new tab; tooltip 'Open <network> profile'. Fetch failure silently omits the icon
   - src: `src/components/ChatRoomView.tsx:131`
56. **Bridge network label in room header**
   - room.networkIcon rendered uppercase tracking-wider (e.g. WhatsApp/Slack bridge indicator)
   - src: `src/components/ChatRoomView.tsx:144`
57. **Image lightbox with ←/→ paging across all images in the visible room**
   - Gallery order queried live from DOM (img[data-chat-image] in visible scroller, chronological); prev/next wrap around modulo; position indicator 'index/total' passed to ImageLightbox; if current src no longer present jumps to first image
   - src: `src/components/ChatRoomView.tsx:30`
58. **PDF lightbox opens on PDF attachment click**
   - onPdfClick(src, filename) opens PdfLightbox overlay with close
   - src: `src/components/ChatRoomView.tsx:188`
59. **Reply to message action wires into compose reply state**
   - handleReply → setReplyingTo(msg), consumed by ChatComposeInput
   - src: `src/components/ChatRoomView.tsx:76`
60. **React-with-emoji action sends reaction**
   - handleReact → sendReaction(roomId, msgId, emoji)
   - src: `src/components/ChatRoomView.tsx:80`
61. **Edit-message action puts message into edit mode**
   - handleEdit → setEditingMessage(msg)
   - src: `src/components/ChatRoomView.tsx:84`
62. **All rooms pre-rendered with display toggling; DOM order stable by room id**
   - Rooms sorted by id.localeCompare so switching rooms never reorders DOM nodes (Chrome would reset scrollTop); message scrollers absolutely positioned, hidden via display:none
   - src: `src/components/ChatRoomView.tsx:88`
63. **Bounded message window: 30 bubbles initially, grows by 30 on scroll-up**
   - INITIAL_WINDOW=30, WINDOW_STEP=30. Dexie liveQuery via [roomId+timestamp] compound index newest-first limited to window. Window resets to 30 when room is hidden (frees DOM). Only visible room re-renders on sync (ref+state split)
   - src: `src/components/ChatRoomView.tsx:203`
64. **Scroll-to-top loads older messages: local IDB first, then homeserver paginate**
   - scrollTop<100 triggers: if IDB has more than window, expand window locally (no network); else onLoadOlder(roomId) network fetch then bump window. Scroll offset restored via rAF so user stays anchored. 'Loading…' indicator shown during fetch
   - src: `src/components/ChatRoomView.tsx:449`
65. **Auto-load older messages when content doesn't fill container**
   - One-shot per visibility (didAutoLoad guard prevents runaway loop): if scrollHeight<=clientHeight, expands window/fetches older once
   - src: `src/components/ChatRoomView.tsx:427`
66. **Initial scroll lands on unread divider (centered) or bottom**
   - On first render of a room: if lastReadTs set, scrollIntoView({block:'center'}) on [data-unread-divider]; else scroll to bottom. Runs once per visibility
   - src: `src/components/ChatRoomView.tsx:362`
67. **Auto-scroll on new message: always for own messages, only if near bottom (<80px) for others**
   - Keyed off newest message id (not length, since window saturates). Own = senderId===matrixUserId or local-echo id starting '~'. First tail observation after initial scroll is skipped
   - src: `src/components/ChatRoomView.tsx:389`
68. **'Jump to bottom' floating button appears when scrolled >200px from bottom**
   - Circular ChevronDown button bottom-center, smooth-scrolls to bottom, title 'Jump to bottom'
   - src: `src/components/ChatRoomView.tsx:545`
69. **Red 'NEW' unread divider between read and unread messages**
   - Shown when prev msg ts<=lastReadTs and current msg ts>lastReadTs and sender isn't self; red bordered rule with 'New' uppercase label
   - src: `src/components/ChatRoomView.tsx:515`
70. **Sender name shown on sender change or >5min gap**
   - showSender true when previous message is from a different sender or timestamp gap exceeds 5 minutes
   - src: `src/components/ChatRoomView.tsx:513`
71. **'No messages yet' empty state per room**
   - Shown when window empty and not loading older
   - src: `src/components/ChatRoomView.tsx:506`
72. **Read receipts grouped per message; reaction tooltips resolve display names from 3 sources**
   - receiptsByEventId groups room.readReceipts by eventId. Name lookup priority: read-receipt displayName > message senderName > room-info member list (fetched once per mount when room first visible, covers react-only WhatsApp ghosts); fallback = MXID localpart
   - src: `src/components/ChatRoomView.tsx:239`
73. **'/' search overlay on the Chat pane searches rooms by name**
   - Same overlay auto-switches to room search when activePane==='chat'; empty query lists 20 most-recent rooms by lastMessageTime; typed query filters all rooms, exact-prefix matches ranked first then by recency; 100ms debounce; selecting an off-list room appends it to the store rooms list so it stays visible
   - src: `src/components/SearchOverlay.tsx:123`
74. **Room search results show avatar (or initial), name, relative time, last-message preview, unread dot**
   - Avatar via mxc thumbnail 32x32, fallback circle with first letter uppercased; preview 'Sender: body'; blue 2px dot when isUnread
   - src: `src/components/SearchOverlay.tsx:226`
75. **Matrix gap-recovery reconcile on wake signals with 150ms debounce**
   - WS onConnect, visibilitychange→visible, and window online all converge on one debounced (150ms) single-flight reconcile: client hands its persisted next_batch cursor to hub matrix.resume RPC; missed events replayed; if hub flags isInitial (expired cursor / cold start), all rooms are preloaded. Concurrent trigger during in-flight sets a dirty flag and re-runs after.
   - src: `src/hooks/useSync.ts:83-164`
76. **Matrix boot heals: media backfill, room-info backfill, doubled-room-name heal, stale bridge-state heal**
   - Run at Matrix block start; stale-state heal runs in background (per-room hub calls). Then hub-owned chat-rooms snapshot subscription is wired so room metadata (name/unread/avatar/tags) is hub-authoritative across devices.
   - src: `src/hooks/useSync.ts:128-142`
77. **Chat offline-queue flush: 500ms after enqueue + every 5s; chat snooze check every 60s**
   - processChatQueue debounced on enqueue and interval-backed; checkChatSnoozes wakes snoozed rooms each minute. Matrix block tears down/re-wires on auth transitions (handles APK async auth hydration).
   - src: `src/hooks/useSync.ts:167-199`
78. **Link previews in message bubbles fetched via hub /matrix/url-preview**
   - getUrlPreview returns og:title/description/image; on first 404 it permanently disables previews for this browser via localStorage 'matrix_preview_url_disabled'='1' (returns {} thereafter until localStorage cleared)
   - src: `src/matrix/api.ts:48-64`
79. **Room tag set/remove (favourite, lowpriority, archive) via context menu**
   - setRoomTag PUT /matrix/rooms/:id/tags/:tag with optional order; removeRoomTag DELETE — backs the room-list context-menu tag actions
   - src: `src/matrix/api.ts:84-100`
80. **Room mute/unmute toggle**
   - setRoomMuted PUT (mute) / DELETE (unmute) /matrix/rooms/:id/mute
   - src: `src/matrix/api.ts:102-107`
81. **Attachment upload to Matrix via hub**
   - uploadMedia POST raw bytes to /matrix/media/upload?filename=…, Content-Type header carries mime; returns mxc:// content_uri; throws with server error text on failure
   - src: `src/matrix/api.ts:111-130`
82. **All chat images/avatars load through hub media proxy, never the homeserver**
   - mxcToHttp/mxcToThumbnail rewrite mxc:// URLs to ${hub}/matrix/media/download|thumbnail/…; thumbnails default 48x48 crop; non-mxc URLs return undefined (no image)
   - src: `src/matrix/api.ts:138-155`
83. **Matrix login accepts bare localpart or full MXID and server name or URL**
   - resolveHomeserver tries https://<server>/.well-known/matrix/client discovery, falls back to https://<server>; bare username auto-expanded to @user:server; hub stores token, browser caches userId/deviceId/homeserver in localStorage for display + own-message checks
   - src: `src/matrix/auth.ts:62-104`
84. **Matrix logout clears hub session and local sync state**
   - POST /matrix/hub/logout best-effort, then deletes IDB meta matrix_refresh_token + matrixSyncToken and the three localStorage identity keys (also legacy matrix_access_token); UI flips to login prompt via auth-change listeners
   - src: `src/matrix/auth.ts:107-117`
85. **Boot-time Matrix auth hydration from hub (fresh WebView / cleared browser still shows logged-in)**
   - initMatrixAuth GETs /matrix/hub/status with 4s timeout; hub-has-creds → persist identity locally; hub-says-none while local metadata exists → clear so UI prompts login; hub unreachable → leave localStorage as-is
   - src: `src/matrix/auth.ts:138-158`
86. **One-time migration backfilling missing media URLs on legacy image/file/audio rows**
   - Runs once (meta key backfill_media_v3): for cached media messages lacking mediaUrl/encryptedFile, refetches the event and fills them so old attachments render; encrypted legacy rows skipped
   - src: `src/matrix/backfill-media.ts:10-44`
87. **One-time migration cleaning bridge-bot names out of room titles and filling bridge network icons**
   - Runs once (backfill_rooms_v2): strips e.g. 'Slack bridge bot, Ben Camara' → 'Ben Camara'; infers networkIcon (whatsapp/signal/slack/etc incl Beeper 'go' variants) from ghost or bot MXIDs
   - src: `src/matrix/backfill-rooms.ts:56-108`
88. **One-time migration fixing isDirect/memberCount/avatars for bridged rooms**
   - Runs once (backfill_rooms_fix_v7): recomputes DM-ness (≤2 real members), real member count (bots excluded), avatar priority explicit room avatar > DM other-member avatar > self-room own avatar > parent Space avatar (Slack workspace icon)
   - src: `src/matrix/backfill-rooms.ts:115-200`
89. **Cross-device room list sync — hub-authoritative snapshot mirrored to local IDB**
   - On connect/reconnect sends last seen seq to chat-rooms.snapshotSince → cheap patch or full snapshot (full snapshot prunes local rooms the hub dropped); live per-key delta broadcasts applied only if seq is contiguous, a gap triggers full reconcile; seq persisted in meta so page reload reconciles with a patch not a full download; 'mark read on PC → phone updates'
   - src: `src/matrix/chat-rooms-subscribe.ts:52-127`
90. **One-shot wipe of legacy locally-derived room list**
   - First boot of hub-sync code clears db.chatRooms entirely (meta key console:chatRoomsHubSync:v1) so stale per-device unread badges die immediately
   - src: `src/matrix/chat-rooms-subscribe.ts:40-46`
91. **E2EE attachment encrypt-on-send**
   - encryptAttachment generates random AES-CTR-256 key + 64-bit random IV, encrypts, exports JWK + SHA-256 hash into Matrix v2 EncryptedFile metadata for encrypted-room sends
   - src: `src/matrix/decrypt-media.ts:13-53`
92. **E2EE attachment decrypt-on-view**
   - decryptAttachment downloads ciphertext via hub proxy, AES-CTR decrypts in-browser, returns Blob stamped with original mime type (so PDFs render in iframes and img/video don't fall back to download)
   - src: `src/matrix/decrypt-media.ts:57-96`
93. **@-mention autocomplete member list cached 60s per room**
   - getRoomMembers returns cached list synchronously and refreshes in background past 60s TTL; returns [] until first fetch resolves; primeRoomMembers warms cache on compose mount so the first '@' keystroke has data
   - src: `src/matrix/room-members.ts:34-55`
94. **@-mention search matches display name or MXID localpart, case-insensitive substring, max 8 results**
   - Empty query returns first 8 members; bridge ghost users (real contact names) naturally rank by list order
   - src: `src/matrix/room-members.ts:61-76`
95. **WhatsApp bridge 'Decrypting message from WhatsApp failed' notices are silently dropped**
   - buildMessageFromContent filters this m.notice at the single conversion choke point so the grey-italic noise never persists on live-sync or paginate paths
   - src: `src/matrix/sync.ts:47-50`
96. **Message type rendering variants: text/notice/emote/image/file/audio/video, stickers rendered as images**
   - msgtype mapped to DbChatMessage.type; m.sticker converted to image; edits (m.replace) excluded as standalone rows
   - src: `src/matrix/sync.ts:52-58,138-140`
97. **Voice-note metadata: duration + waveform + voice flag**
   - Audio messages carry duration (MSC1767 org.matrix.msc1767.audio.duration or info.duration), waveform array, and isVoiceNote (MSC3245) for the voice-message bubble UI
   - src: `src/matrix/sync.ts:75-84`
98. **Undecryptable messages render '🔒 Encrypted message' placeholder**
   - m.room.encrypted with ciphertext the hub couldn't decrypt gets a lock-emoji placeholder row; original event JSON stored for later decrypt-retry after key import
   - src: `src/matrix/sync.ts:121-136`
99. **Decryption-regression guard: placeholder never overwrites an already-decrypted message**
   - If an m.room.encrypted event arrives for an event_id whose DB row already decrypted (no encryptedEvent), the write is skipped — prevents cold resume rolling a good body back to '🔒 Encrypted message'
   - src: `src/matrix/sync.ts:448-451`
100. **Deleted-message tombstones for bridge redactions (WhatsApp/Signal deletes)**
   - m.room.encrypted with no ciphertext + existing row → isDeleted=true + deletedBy=<redactor>; if the original was never decrypted the body is blanked so the bubble says 'Message deleted' rather than a struck-through lock emoji
   - src: `src/matrix/sync.ts:421-439`
101. **Explicit m.room.redaction marks message deleted but keeps content for diff view**
   - isDeleted + deletedBy set; row never removed — soft-delete only
   - src: `src/matrix/sync.ts:488-496`
102. **Reactions aggregated per emoji with per-sender dedup**
   - m.reaction m.annotation events append sender to reactions[emoji] on the target message (checks same-batch in-flight messages before DB)
   - src: `src/matrix/sync.ts:464-486`
103. **Bridge send-failure surfaced on the message bubble + desktop notification**
   - com.beeper.message_send_status FAIL_* sets sendFailed='bridge: <status> (<reason>)' on the local echo and fires a 'Message failed to send' notification deep-linking to the room; SUCCESS clears any prior fail marker
   - src: `src/matrix/sync.ts:502-557`
104. **Auto-recovery of wedged-Megolm bridge failures: rotate key + resend once**
   - FAIL_RETRIABLE with 'undecryptable_event' reason triggers a one-shot (autoRotateRetried guard) matrix.resendAfterRotate RPC (30s timeout); on success the dead echo is deleted so only the delivered copy shows; failure falls back to the visible error
   - src: `src/matrix/sync.ts:522-539`
105. **Message edits show edited flag and preserve original body for diff view**
   - m.replace events update body/formattedBody, set isEdited=true, keep first originalBody (never overwritten by later edits)
   - src: `src/matrix/sync.ts:561-579`
106. **Reply previews resolved from same batch then DB**
   - replyTo.body/sender filled by looking up the replied-to event in the current sync batch first, falling back to cached messages
   - src: `src/matrix/sync.ts:582-599`
107. **Local echoes replaced when server-confirmed message arrives**
   - Own messages matched to '~'-prefixed local echoes by body (also stripping a leading '📷 ' for image echoes) and the echo deleted
   - src: `src/matrix/sync.ts:605-619`
108. **Read receipts shown per room (others only)**
   - m.receipt ephemeral events tracked per user with ts/displayName/avatar; own receipts and bridge-bot receipts skipped; in bridged DMs a ghost user's receipt shows under the room's contact name and falls back to the room avatar
   - src: `src/matrix/sync.ts:628-652`
109. **Room display name derivation: explicit name > canonical alias > other-member names**
   - Bridge-bot display names stripped from explicit names; DM name = other member's displayname; groups = up to 3 unique other-member names joined by ', ' (Set dedupe prevents 'Alice, Alice' from bridge re-link transients)
   - src: `src/matrix/sync.ts:149-193`
110. **Room preview (last message body/sender/time) only advances, never regresses**
   - advancesPreview gate: newest-by-timestamp in batch must be newer than stored lastMessageTime, so out-of-order resume ingestion can't roll a room preview back
   - src: `src/matrix/sync.ts:665-696,739-741`
111. **Unread semantics: message from own account on another device marks room read**
   - latestIsFromMe → isUnread=false, unreadCount=0; server notification_count dropping to 0 with no newer messages also clears unread (read elsewhere); low-priority rooms only go unread on @highlight; unreadCount accumulates count of others' new messages
   - src: `src/matrix/sync.ts:742-759`
112. **'New' divider anchor set when unread messages first arrive**
   - lastReadTs seeded to the previous lastMessageTime when newer messages from others arrive and no read marker exists, so the New divider renders at the right boundary
   - src: `src/matrix/sync.ts:763-766`
113. **Desktop notification for new inbound messages**
   - Fires only when newer messages from others arrived AND room not low-priority AND server notification_count>0 (mutes respected); title '<sender>' or '<sender> in <room>' for groups, body = first 100 chars, icon = 96x96 room-avatar thumbnail via hub, tag chat-<roomId> (coalesces per room), click deep-links to the room
   - src: `src/matrix/sync.ts:787-802`
114. **'Matrix: hub initial sync (N rooms)' status banner only on true first boot**
   - Shown only when the initial-sync flag is set AND IDB has zero cached rooms; cursor-less reconciles against a populated cache stay silent so users don't fear a data rebuild
   - src: `src/matrix/sync.ts:926-932,965`
115. **Authoritative mute state applied from hub push-rules on each delta**
   - When delta carries mutedRoomIds, every room's isMuted is set/cleared to match (undefined list = keep existing)
   - src: `src/matrix/sync.ts:943-949`
116. **Left rooms disappear from the room list with their messages**
   - delta.leaves removes room row and deletes all its cached messages
   - src: `src/matrix/sync.ts:952-955`
117. **Sync cursor persisted only after ingestion fully flushed**
   - meta matrix:lastBatch advanced after IDB writes so a crash never claims progress for unstored data; handed back to hub on reconcile for gap replay
   - src: `src/matrix/sync.ts:957-963`
118. **One-shot boot migration healing 'Alice, Alice' doubled room names**
   - healDoubledRoomNames scans all rooms once (meta console:nameDedupe:v1) and collapses names whose comma-parts are all identical
   - src: `src/matrix/sync.ts:835-849`
119. **One-shot boot migration refreshing stale bridge-room state**
   - healStaleBridgeRoomState targets bridge rooms claiming 3-6 members with no avatar; refetches room state in batches of 5 with 200ms gaps and recomputes name/isDirect/memberCount/avatar (meta console:staleBridgeState:v1)
   - src: `src/matrix/sync.ts:866-915`
120. **Offline-first send queue: sends/mark-read/reactions retry 3 times then fail visibly**
   - processChatQueue drains pending chat* queue actions oldest-first over hub RPC; bails silently when hub WS down (queue survives, reflushes on reconnect); after 3rd failure a chatSend marks the matching local echo sendFailed and fires a 'Message failed to send' notification deep-linking to the room; single-flight lock prevents double processing
   - src: `src/matrix/sync.ts:985-1103`
121. **Sends carry HTML formatting, reply relation, and MSC3952 intentional mentions**
   - chatSend content includes formatted_body when present, m.in_reply_to for replies, and m.mentions.user_ids so Element/Cinny/bridges treat @-mentions as real pings; on success the local echo is immediately re-keyed to the real event_id
   - src: `src/matrix/sync.ts:1009-1047`
122. **Room snooze auto-expiry**
   - checkChatSnoozes clears snoozedUntil on any room whose snooze time has passed, returning it to the normal list
   - src: `src/matrix/sync.ts:1107-1118`
123. **Undecryptable encrypted events render as lock placeholder**
   - Events of type m.room.encrypted with a string ciphertext (hub couldn't decrypt) render as '🔒 Encrypted message' text bubble; raw event JSON stored in encryptedEvent for later decrypt.
   - src: `src/store/chat.ts:84-95`
124. **Bridge-delete tombstones render as deleted message preserving prior text**
   - m.room.encrypted with non-string ciphertext + unsigned.redacted_because is treated as a redaction tombstone: message marked isDeleted with deletedBy=redactor; if a previously-decrypted body was cached (and isn't the lock placeholder) it is preserved so the struck-through original text still shows.
   - src: `src/store/chat.ts:55-82`
125. **Stickers render as image messages**
   - m.sticker events are converted with msgtype m.image so they render as image bubbles.
   - src: `src/store/chat.ts:109-111`
126. **Reactions from pagination update target message emoji counts**
   - m.reaction annotation events (processed in a deferred second pass so backward-paginated reactions preceding their targets still resolve) append sender to reactions[emoji], deduped per sender.
   - src: `src/store/chat.ts:118-142`
127. **Redactions mark messages deleted but keep them (diff view)**
   - m.room.redaction sets isDeleted:true + deletedBy on the target; original row is kept, never hard-deleted.
   - src: `src/store/chat.ts:144-153`
128. **Edits (m.replace) update body and preserve original for diff**
   - Edit events store originalBody (first edit only), swap in new body/formattedBody (HTML only when format=org.matrix.custom.html), set isEdited marker.
   - src: `src/store/chat.ts:155-181`
129. **Reply previews backfilled from batch or DB**
   - Messages with replyTo but no body get the quoted body+sender resolved from the same fetched batch, else IndexedDB.
   - src: `src/store/chat.ts:184-199`
130. **Sender names fall back to localpart, DM rooms fall back to room name**
   - Unknown senders display the MXID localpart; in direct rooms unresolved bridge senders display the room name; member info comes from /messages state or cached room state (fetched once per room per session).
   - src: `src/store/chat.ts:46-47,264-273`
131. **Selected room stays in list even after going read**
   - setRooms re-adds the currently selected room if the live query dropped it (e.g. user replied → room read) so the open conversation doesn't vanish until navigation; if gone from both lists selection is cleared.
   - src: `src/store/chat.ts:335-354`
132. **Navigating away drops read non-favourite rooms from the list**
   - selectRoom removes the previously-selected room from the visible list if it is read and not tagged m.favourite (inbox-zero behavior).
   - src: `src/store/chat.ts:356-369`
133. **Next/previous room keyboard navigation**
   - selectNextRoom/selectPrevRoom move selection within the room list; with no selection, next picks the first room and prev picks the last; stops at list ends (no wrap).
   - src: `src/store/chat.ts:371-395`
134. **Opening a room lazily loads messages with gap detection**
   - ensureMessages: if room has cached messages but room.lastMessageTime is >60s newer than newest cached message (missed delta gap), forward-fills up to 3 pages of 30; cold rooms paginate up to 5 pages of 30 until ≥20 displayable messages (busy rooms can have pages of only state/reaction events).
   - src: `src/store/chat.ts:398-449`
135. **Load older messages (backward pagination)**
   - loadOlderMessages fetches 30 more from the room's prevBatch token; returns false when history exhausted or on error (UI can stop showing loader).
   - src: `src/store/chat.ts:451-465`
136. **Mark room read — optimistic removal with 5s undo**
   - markRoomRead: non-favourite rooms are removed from the list instantly (added to optimisticallyRemoved set so the live query can't resurrect them) and selection advances to next room at same index; favourites just clear the unread badge in place; a 'Marked read' undo toast is shown for 5000ms.
   - src: `src/store/chat.ts:467-504`
137. **Read receipt sent for newest real message; fallback fetches newest event when none cached**
   - After mark-read the newest non-local-echo (~-prefixed) message id is queued as chatMarkRead receipt; if no real message is cached, hub is asked (paginate limit 1) for the newest event of ANY type and that is receipted — prevents rooms perpetually resurrecting as unread.
   - src: `src/store/chat.ts:507-540`
138. **Undo mark-read restores unread state and reselects room**
   - undoMarkRead re-marks the room unread with its prior unreadCount/lastRead fields, reselects it, and dismisses the undo toast.
   - src: `src/store/chat.ts:988-993`
139. **Mark room unread**
   - markRoomUnread optimistically sets isUnread:true, unreadCount:1 in IDB+UI, then routes through hub chat-rooms.markUnread RPC so all devices flip immediately; failure silently reconciles on next snapshot.
   - src: `src/store/chat.ts:543-561`
140. **Snooze room (later today / tomorrow / next week / custom datetime)**
   - snoozeRoom computes snoozedUntil via getSnoozeTime, optimistically removes room from list, advances selection to the next room at same index, closes the snooze picker, then hub chat-rooms.snooze RPC syncs all devices.
   - src: `src/store/chat.ts:563-588`
141. **Send text message — instant local echo, offline-queued**
   - sendMessage puts a local echo with id ~timestamp.random, attaches replyTo if replying (clears reply state), marks room read, updates room preview (lastMessageBody/sender/time), enqueues chatSend (with formattedBody + mention userIds + replyToEventId) to the offline sync queue, and queues a read receipt for the latest real message.
   - src: `src/store/chat.ts:590-641`
142. **Send image — dimensions probed, unencrypted upload, echo swap, failure notification**
   - sendImage shows local echo with blob URL immediately; room preview becomes '📷 <caption|filename>'; image dimensions read via Image(); media uploaded RAW (unencrypted — Beeper bridges can't decrypt attachments) then m.image event sent via hub RPC; on success local echo id swapped for real event_id; on failure message flagged sendFailed and a push notification 'Message failed to send' (tag send-failed:<id>, deep-links to the room) fires.
   - src: `src/store/chat.ts:643-746`
143. **Send generic file — msgtype from MIME, voice-note format demotion**
   - sendFile mirrors sendImage: video/* → m.video (preview 🎬), whitelisted audio (ogg/mp4/mpeg/aac/m4a/webm) → m.audio (🎵), other audio (WAV/AIFF/FLAC — bounced by WhatsApp bridge as unsupported voice notes) and everything else → m.file (📎, downloadable attachment); same local-echo/reply/failure-notification flow.
   - src: `src/store/chat.ts:753-856`
144. **Preload unread rooms' messages in background**
   - preloadAllRooms fetches an initial page (20) for every unread non-snoozed room with nothing cached, sets prevBatch and updates room preview to the latest fetched message; failures are silent (messages load on open).
   - src: `src/store/chat.ts:858-886`
145. **Reply-to state for composer**
   - setReplyingTo stores {eventId, body, senderName} of the message being replied to; consumed and cleared on next send.
   - src: `src/store/chat.ts:888-890`
146. **Edit-in-place with re-arm nonce**
   - setEditingMessage puts the target message into edit mode with a monotonically bumped seq nonce so re-editing the SAME message twice still re-fills the compose textarea.
   - src: `src/store/chat.ts:892-906`
147. **Edit send — no-op on unchanged text, optimistic flip, preview refresh, failure marker**
   - editMessage: empty body ignored; identical body+formattedBody exits edit mode without a roundtrip (avoids spurious '(edited)' marker); otherwise IDB flips instantly (originalBody preserved), room preview updated if edited message was the last, m.replace event sent with ' * ' fallback body and m.mentions rebuilt on both outer content and m.new_content; failure sets sendFailed (red alert icon on the bubble).
   - src: `src/store/chat.ts:908-971`
148. **React to a message with an emoji — optimistic**
   - sendReaction adds own userId under the emoji immediately (deduped) then enqueues chatReact to the offline queue.
   - src: `src/store/chat.ts:973-986`

## feeds (59)

1. **Add-feed modal: URL input, optional folder, Enter submits**
   - URL field autofocused; Enter in either field triggers add; button label 'Adding...' while in flight; modal closes on success, backdrop click, or X button
   - src: `src/components/FeedAddModal.tsx:87`
2. **Folder autocomplete in add modal from existing folder names**
   - Suggestions from unique feed.folder values, sorted, filtered case-insensitively as you type; opens on focus, closes 150ms after blur; click fills field
   - src: `src/components/FeedAddModal.tsx:98`
3. **Folder-only creation: no URL + folder name changes button to 'Create Folder' (implicit — just closes)**
   - Folders are implicit from feed.folder so nothing is actually persisted; user adds feeds to it later
   - src: `src/components/FeedAddModal.tsx:39`
4. **'Fetch full article text' checkbox shown only when a URL is entered**
   - Passes fullText flag to addFeed → server Readability extraction
   - src: `src/components/FeedAddModal.tsx:126`
5. **OPML import via file picker (.opml/.xml)**
   - Button 'Import OPML File' → 'Importing...' while in flight; closes modal on completion
   - src: `src/components/FeedAddModal.tsx:155`
6. **Feed sidebar 'All' entry with total unread badge (blue)**
   - Clicking clears both selectedFeedId and selectedFolderId; highlighted when neither selected
   - src: `src/components/FeedFolderTree.tsx:96`
7. **Folders expandable/collapsible via chevron; folder click selects folder scope**
   - Chevron click stopPropagation toggles expansion (open/closed folder icon swaps); row click selects folder; per-folder unread count = sum of member feeds' unread, blue badge; folders sorted alphabetically; folderless feeds listed at top level; feeds in folders indented (pl-6)
   - src: `src/components/FeedFolderTree.tsx:118`
8. **Per-feed unread count badge**
   - Blue [10px] number after feed title when unread>0
   - src: `src/components/FeedFolderTree.tsx:316`
9. **'+' button in sidebar header opens Add Feed modal**
   - Title 'Add feed'
   - src: `src/components/FeedFolderTree.tsx:87`
10. **Feed right-click context menu: Mark all read, Feed info, Open site (if siteUrl), Copy feed URL, Delete feed**
   - Custom fixed-position menu at cursor; closes on any window click; Copy uses navigator.clipboard; Delete is red with divider above; Open site opens siteUrl in new tab
   - src: `src/components/FeedFolderTree.tsx:165`
11. **Folder right-click context menu: Mark all read**
   - markFolderRead(folder); single-item menu
   - src: `src/components/FeedFolderTree.tsx:227`
12. **Feed info modal: feed URL (copyable), site URL (copyable link), folder, added date, full-text toggle**
   - Added date formatted 'Mon D, YYYY'; full-text checkbox PUTs {fullText} to /feeds/:id then refetches feed list; copy buttons write to clipboard; closes on backdrop or Close button
   - src: `src/components/FeedFolderTree.tsx:246`
13. **Item-list header shows current scope title (All Feeds / folder name / feed title) and scoped mark-all-read button with count**
   - Scope unread = feed's count, folder sum, or total. Mark-all-read shows CheckCheck+count, opens confirm dialog 'Mark N unread article(s) in <scope> as read?' before executing
   - src: `src/components/FeedItemList.tsx:60`
14. **Unread-only filter toggle (Eye/EyeOff icon)**
   - Tooltip flips 'Show all'/'Show unread only'; empty state text adapts ('No unread articles' vs 'No articles')
   - src: `src/components/FeedItemList.tsx:83`
15. **Article search box filters items**
   - setSearchQuery live on change; placeholder 'Search articles...'; input tagged data-feed-search (keybinding focus target)
   - src: `src/components/FeedItemList.tsx:93`
16. **Pull-to-refresh on the item list (mobile)**
   - usePullToRefresh calls refreshItems() — mobile only
   - src: `src/components/FeedItemList.tsx:50`
17. **Swipe-right on an item row marks it read (mobile)**
   - SwipeableRow with green Check icon reveal; desktop renders plain row
   - src: `src/components/FeedItemList.tsx:117`
18. **Selected item auto-scrolled into view in list**
   - scrollIntoView({block:'nearest'}) on selectedItemId change (supports j/k nav)
   - src: `src/components/FeedItemList.tsx:53`
19. **Item list row: 2-line clamped title, relative time, feed name (max 120px), author (max 80px), 2-line snippet, lazy 16:9 thumbnail**
   - Relative time: 'now' <1min, Nm <60min, Nh <24h, Nd <7d, 'Mon D' <1yr, 'Mon D, YYYY' older. Thumbnail hides itself onError
   - src: `src/components/FeedItemListEntry.tsx:19`
20. **Article detail header: title, feed · author · date ('Mon D, YYYY'), Open link, Comments link**
   - Comments link shown for Reddit URLs (item.link) or HN items (parses news.ycombinator.com/item?id= from content, labelled 'HN'); Open opens item.link in new tab
   - src: `src/components/FeedItemView.tsx:371`
21. **Per-feed item-limit menu (⋯): Top 3/5/10/25/Unlimited with checkmark on current**
   - updateFeed(id,{maxItems}); menu closes on outside mousedown; also contains red 'Unsubscribe' item guarded by danger confirm dialog 'Unsubscribe from <title>?'
   - src: `src/components/FeedItemView.tsx:419`
22. **Article body sanitized with DOMPurify (iframes allowed, script/style forbidden); all links forced target=_blank**
   - Global DOMPurify afterSanitizeAttributes hook adds target=_blank rel=noopener to every anchor; rich typography styles for headings/lists/code/tables/blockquotes
   - src: `src/components/FeedItemView.tsx:338`
23. **'No article content available' fallback with 'Open in browser' link**
   - When item has no content but has a link
   - src: `src/components/FeedItemView.tsx:529`
24. **Content scrolls to top when switching articles**
   - contentRef.scrollTo(0,0) on selectedItemId change
   - src: `src/components/FeedItemView.tsx:348`
25. **YouTube items show clickable thumbnail with play overlay; click starts playback via single persistent iframe**
   - Thumb from i.ytimg.com hqdefault; setPipVideo({youtubeId,title}); if this video is already playing, an empty data-pip-placeholder div is rendered and the global iframe overlays it (inline mode, position tracked per-frame via rAF); if a different video is playing, clicking swaps
   - src: `src/components/FeedItemView.tsx:474`
26. **YouTube PiP mode: floating player when navigating away from the playing article**
   - Defaults bottom-right 16px/80px, 440px wide desktop; mobile full-width above bottom nav (bottom 56px, no rounding); title bar with truncated video title and X close; iframe is youtube-nocookie autoplay=1; single iframe never remounted (video keeps playing across panes)
   - src: `src/components/FeedItemView.tsx:177`
27. **PiP window draggable by title bar (desktop) and resizable from NW + SE corners (min 240x160)**
   - Pointer-capture drag ignores clicks on buttons/iframe; NW resize anchors bottom-right corner; resize pins geometry and drops aspect-ratio lock; position/size reset when returning inline or on new video
   - src: `src/components/FeedItemView.tsx:198`
28. **HN comments rendered inline under the article (depth 3) with score and comment count**
   - Fetched from hub /feeds/hn/:id?depth=3; header 'N Comments · N points'; loading text 'Loading comments...'; red error 'Failed to load comments: <msg>'
   - src: `src/components/FeedItemView.tsx:96`
29. **HN comment threads collapsible per comment; header shows author · relative age; collapsed shows '(N replies)'**
   - Click anywhere on comment toggles collapse EXCEPT on links or while text is selected (drag-to-highlight preserved); nested replies indented with left border; time ago: 'just now'/Nm/Nh/Nd ago; comment HTML DOMPurify-sanitized
   - src: `src/components/FeedItemView.tsx:41`
30. **Feed pane onboarding empty state when hub not connected and no feeds**
   - Rss icon + explanation + 'Import OPML or Add Feed' button opening the modal; separate 'Loading feeds...' state while loading with zero feeds
   - src: `src/components/FeedTab.tsx:34`
31. **Feed pane boot sequence: fetch feeds → load items from IDB → compute unread → background refresh**
   - Offline-first: cached items shown before the network refresh
   - src: `src/components/FeedTab.tsx:25`
32. **Desktop 3-pane layout (folder tree 176px / item list / article); mobile 3-layer drill-down nav**
   - Mobile shows one layer at a time: folder tree → item list (when feed/folder selected) → article detail (when item selected)
   - src: `src/components/FeedTab.tsx:62`
33. **Swipe-right on mobile article detail marks the item read**
   - useSwipeActions with green Check reveal icon on left edge; markRead() with no arg = current item
   - src: `src/components/FeedTab.tsx:94`
34. **Feeds keys: j/k next/prev item, e mark read, E mark whole feed/folder read, u mark selected unread, o open in browser, a add-feed modal, d delete selected feed, '/' focus search**
   - E targets selectedFeedId first, else selectedFolderId.
   - src: `src/hooks/useKeybindings.ts:388-450`
35. **Feeds auto-refresh every 15 minutes when connected**
   - Interval calls refreshItems() only if feed store reports connected.
   - src: `src/hooks/useSync.ts:209-220`
36. **Feed list fetched and sorted alphabetically**
   - fetchFeeds GETs /feeds, sorts by title (localeCompare), sets connected flag; failure shows disconnected state.
   - src: `src/store/feeds.ts:112-126`
37. **Incremental item sync with ?since cursor**
   - refreshItems only runs when connected; passes lastSync ISO timestamp as ?since, bulk-puts new items into IndexedDB for offline reading.
   - src: `src/store/feeds.ts:128-152`
38. **Hub-authoritative item reconciliation preserving read state**
   - Items absent from the hub's currentItemIds are deleted locally, but feedRead entries are NEVER deleted — a rolled-off item that reappears stays read rather than resurfacing as unread.
   - src: `src/store/feeds.ts:164-171`
39. **Bidirectional read-state sync — local repairs hub**
   - Hub readIds are additively merged locally; local-only read ids are pushed back to the hub in 500-id chunks so the most complete device repairs over-pruned hub read history.
   - src: `src/store/feeds.ts:175-196`
40. **Select feed / folder / item**
   - Selecting a feed clears folder+item selection and reloads the item list; selecting a folder clears feed+item; item selection is independent.
   - src: `src/store/feeds.ts:211-223`
41. **Next/previous item keyboard navigation**
   - selectNextItem clamps at list end; selectPrevItem clamps at 0; with no selection next picks index 0.
   - src: `src/store/feeds.ts:225-239`
42. **Mark item read — dismisses playing PiP video, auto-advances**
   - markRead: if the item is the currently-playing YouTube video (matched by extracted youtubeId) the PiP is dismissed instead of floating; optimistic local read write; if the marked item was selected, selection auto-advances to the next item (or previous when at end); read id pushed to hub in background.
   - src: `src/store/feeds.ts:241-277`
43. **Mark item unread**
   - markUnread deletes the local read entry, reloads list + unread counts, PUTs {remove:[id]} to hub.
   - src: `src/store/feeds.ts:279-289`
44. **Mark entire feed read**
   - markFeedRead marks all of one feed's unread items read locally then pushes ids to hub in one PUT.
   - src: `src/store/feeds.ts:291-307`
45. **Mark entire folder read**
   - markFolderRead marks all unread items across the folder's feeds read; no-op for empty folders.
   - src: `src/store/feeds.ts:309-328`
46. **Mark all read scoped to the current view**
   - markAllRead scopes to selected feed, else selected folder, else everything; pushes to hub in 500-id chunks.
   - src: `src/store/feeds.ts:330-360`
47. **Folder expand/collapse toggle**
   - toggleFolder flips a folder in the expandedFolders set (sidebar tree state, in-memory only).
   - src: `src/store/feeds.ts:362-367`
48. **Unread-only filter toggle (default on)**
   - showUnreadOnly defaults true; toggleUnreadOnly flips it and reloads the item list (unread = not in read set).
   - src: `src/store/feeds.ts:104,369-372`
49. **Item search over title/snippet/author**
   - setSearchQuery filters items case-insensitively by title, contentSnippet, or author on every keystroke (reload from IDB).
   - src: `src/store/feeds.ts:374-377,492-499`
50. **Item list sorted newest-first, capped at 200**
   - loadItemsFromDb sorts by publishedAt descending and slices to 200 items for performance.
   - src: `src/store/feeds.ts:475-504`
51. **Add feed by URL with optional folder + full-text flag**
   - addFeed POSTs {xmlUrl, folder, fullText}; on success refetches feeds and items; failures silent.
   - src: `src/store/feeds.ts:379-393`
52. **Edit feed (title/folder/fullText/maxItems)**
   - updateFeed PUTs updates; changing maxItems immediately re-trims local items to the new cap and recounts unread.
   - src: `src/store/feeds.ts:395-413`
53. **Delete feed removes its items and read entries locally**
   - deleteFeed DELETEs on hub then purges the feed's items + their read entries from IndexedDB and clears selection if it pointed at the deleted feed.
   - src: `src/store/feeds.ts:415-437`
54. **OPML import**
   - importOpml uploads the file's XML to /feeds/import-opml then refetches the feed list; deliberately does NOT refresh all items (slow with ~170 feeds).
   - src: `src/store/feeds.ts:439-454`
55. **Open selected item in browser**
   - openItemInBrowser window.opens the selected item's link in a new tab with noopener.
   - src: `src/store/feeds.ts:456-462`
56. **Per-feed item cap with 50 default**
   - trimItems deletes items beyond feed.maxItems (default 50) keeping newest; read entries for trimmed items are kept so resurfaced items stay read.
   - src: `src/store/feeds.ts:529-547`
57. **Per-feed unread badge counts + total unread**
   - computeUnreadCounts derives per-feed unread counts and totalUnread from IDB (sidebar badges + pane badge).
   - src: `src/store/feeds.ts:507-522`
58. **Add-feed modal visibility state**
   - showAddModal flag with setShowAddModal controls the add-feed dialog.
   - src: `src/store/feeds.ts:108-110`
59. **YouTube ID extraction covers watch, shorts, and youtu.be URLs**
   - extractYoutubeId matches youtube.com/watch?v=, youtube.com/shorts/, and youtu.be/ — feeds items with these URLs render the in-app player / PiP.
   - src: `src/utils/youtube.ts:1`

## glasses (50)

1. **Glasses settings section hidden entirely unless running inside the APK (glassesSupported)**
   - Returns null when store.supported is false; web build never sees it.
   - src: `src/components/GlassesSettings.tsx:100`
2. **Connection status line shows one of: 'G1 connected' / 'Connecting…' / 'G1 disconnected' / 'No glasses paired'**
   - 'Connecting…' only when either arm's status is 'connecting' (real GATT attempt in flight), not merely paired-but-disconnected.
   - src: `src/components/GlassesSettings.tsx:126`
3. **Pause button temporarily disconnects glasses while keeping pairing**
   - EyeOff icon, only shown while connected; calls store.disconnect().
   - src: `src/components/GlassesSettings.tsx:132`
4. **Unpair button forgets glasses after confirm dialog**
   - Uses project showConfirm ('Forget these glasses?', danger, 'Forget'); only shown while connected.
   - src: `src/components/GlassesSettings.tsx:140`
5. **Connect button reconnects the saved pair without scanning**
   - Shown when paired-but-disconnected; disabled + pulsing Plug icon + label 'Connecting…' during attempt.
   - src: `src/components/GlassesSettings.tsx:152`
6. **'not paired' label shown when nothing saved**
   - Scan/pair disclosure is the only path in that state.
   - src: `src/components/GlassesSettings.tsx:163`
7. **Battery/wear line: 'L n% · R n%' with '…' while unknown, '· on head/off head', '· ch N' channel**
   - Only rendered while connected.
   - src: `src/components/GlassesSettings.tsx:169-174`
8. **Charging-case line: briefcase icon, 'Case · n%', green BatteryCharging icon when charging vs plain Battery**
   - Shown when paired even if arms not connected (case sends 0xF5 subcmds independently).
   - src: `src/components/GlassesSettings.tsx:179-192`
9. **Last BLE error rendered in red, truncated, full text in title tooltip**
   - Only when snap.lastError set.
   - src: `src/components/GlassesSettings.tsx:194-198`
10. **'Pair new glasses' / 'Pair different glasses' disclosure toggles BLE scan**
   - Hidden while connected. Opening starts scan; closing stops it. Radar icon pulses while scanning; label becomes 'Scanning…' then 'Re-scan'.
   - src: `src/components/GlassesSettings.tsx:205-216`
11. **Scan candidate list: 'G1 #<channel>' clickable to pair, disabled '(need both arms)' until both MACs seen, shows RSSI dBm**
   - handlePair requires leftMac+rightMac; pairs via store.pair(leftMac,rightMac,channel).
   - src: `src/components/GlassesSettings.tsx:220-231`
12. **Scan empty state: 'Scanning… wake the glasses (open + put on).' or 'No glasses found.'**
   - Depends on scanning flag.
   - src: `src/components/GlassesSettings.tsx:232-236`
13. **'Mirror current tab' pill toggle renders active pane onto lenses**
   - Only while connected; persists via store setMirrorEnabled (localStorage console:glasses:mirrorEnabled).
   - src: `src/components/GlassesSettings.tsx:244-252`
14. **'Notifications to glasses' master toggle, persisted hub-side via POST /glasses/config**
   - Optimistic local patch then hub POST; config fetched once on mount; section requires connected + config loaded.
   - src: `src/components/GlassesSettings.tsx:257-265`
15. **Per-source notification channel toggles (Mail/Chat/Calendar/Agents/Money) under 'Sources…' expander**
   - Unset channel defaults to on (?? true); expander label flips to 'Hide sources'. Only visible while notifyEnabled.
   - src: `src/components/GlassesSettings.tsx:266-288`
16. **'HUD on head-tilt' toggle enables idle dashboard on head-up gesture**
   - Persisted hub-side in glasses-config.json.
   - src: `src/components/GlassesSettings.tsx:291-297`
17. **Tilt-angle slider 10–60° step 5, label 'Tilt angle N°', patched to hub on every change**
   - Only visible while hudEnabled.
   - src: `src/components/GlassesSettings.tsx:298-311`
18. **'Recent events' diagnostic panel lists raw 0xF5 events (arm L/R, hex subcmd, classified kind), newest first, max-h scroll**
   - Available even when disconnected; subscribes to event ring buffer only while open (no re-renders otherwise). Empty state: 'No events yet — tap a touchbar or tilt your head.'
   - src: `src/components/GlassesSettings.tsx:321-351`
19. **'Test display' dev tool: text input + Send button pushes a line to the lenses, 'clr' button clears the display**
   - Only while connected; default text 'Hello from Console'.
   - src: `src/components/GlassesSettings.tsx:354-386`
20. **'Test notification' button fires a real push through POST /push/send exercising the full lens-notification pipeline**
   - Label states: 'Sending…' → 'Sent ✓' or 'Failed'. Sends type:chat title 'Test notification'.
   - src: `src/components/GlassesSettings.tsx:390-415`
21. **One-shot snapshot refresh on settings mount (bridge may have been booting at store init)**
   - refresh() called once in useEffect.
   - src: `src/components/GlassesSettings.tsx:77`
22. **All glasses functions no-op in the browser; support detected via window.ConsoleNative bridge presence (avoids boot-order race with __isConsoleAPK)**
   - src: `src/glasses/bridge.ts:100-121`
23. **Glasses bridge surface: status snapshot (per-arm status/mac/battery/charging/serial, worn, case battery/charging, phone battery, lastError), scan (default 15s) + candidates, pair/unpair, disconnect (keeps saved pair), reconnect without scan (APK v18+)**
   - src: `src/glasses/bridge.ts:113-161`
24. **Glasses output/input controls: sendText, clear, sendBmp (576×136 1-bpp BMP b64), sendNotification (firmware card), startMic/stopMic**
   - src: `src/glasses/bridge.ts:163-186`
25. **Mirror 'stealth screen' dim: setMirrorDim keeps Activity foreground with brightness ~0 so HW keyboard works while the phone looks off; falls back to legacy setNotesMirrorDim for APK v12-16**
   - src: `src/glasses/bridge.ts:195-199`
26. **Hub bearer-token bridge for APK pairing: setHubToken (called by AccountModal 'Pair this APK'), hasHubToken, clearHubToken**
   - src: `src/glasses/bridge.ts:40-45`
27. **Native→web glasses state/event subscriptions via console:glasses:state and console:glasses:event DOM events**
   - src: `src/glasses/bridge.ts:207-230`
28. **G1 touchbar/head-tilt event classification: double-tap 0x00/0x20, single-tap 0x01, head-up/down 0x02/0x03, triple-tap 0x04/0x05, long-press start/end 0x17/0x18, dashboard show/hide 0x1e/0x1f, connected 0x11, case removed/opened/closed/charging/battery**
   - semantic consumers include mirror re-assert on head-down and mic auto-arm
   - src: `src/glasses/events.ts:79-129`
29. **Ring buffer of last 20 raw G1 events feeds the in-app glasses debug panel with live updates; every event also console.logged as '[glasses-event] arm=… subcmd=0x…' so it appears in /debug/log**
   - src: `src/glasses/events.ts:131-163,199-205`
30. **Mirror-to-glasses master toggle persisted in localStorage**
   - Persists under 'console:glasses:mirrorEnabled'='1'; legacy key 'console:glasses:notesMirrorEnabled' auto-migrates on load (set new key, delete old). Toggling off cancels pending frame, clears lenses via bridgeClear(); toggling on pushes a frame immediately (no debounce).
   - src: `src/glasses/mirror.ts:56-132`
31. **Mirror renders active pane onto lenses as 5 rows x 40 cols**
   - Row 1 = status bar 'Pane · focus · meta' joined by ' · '; rows 2-5 = pane body, bottom-biased padding (new content at row 5, blanks unshifted on top). Each row hard-clipped (never wrapped) to 40 chars. Renderer dispatch per activePane covers all 10 panes (home/notes/chat/agents/email/calendar/feeds/bookmarks/money/map).
   - src: `src/glasses/mirror.ts:53-217`
32. **Mirror frame coalescing: 30ms debounce + dedupe against last sent frame**
   - Bursts of store updates collapse into one BLE write per 30ms tick; identical frames are not re-sent (lastSent comparison). Keystroke→BLE latency ≤100ms, hub not involved.
   - src: `src/glasses/mirror.ts:58,220-238`
33. **Mirror stealth-screen dim on toggle**
   - Enabling the mirror calls setMirrorDim(true) (APK holds FLAG_KEEP_SCREEN_ON + brightness 0.01) so the phone screen looks off but HW keyboard input still reaches the WebView; re-applied on cold start if the persisted toggle is on.
   - src: `src/glasses/mirror.ts:118-120; src/glasses/store.ts:124-126`
34. **Mirror re-asserts on head-down after HUD/notification clobber**
   - Subscribes onG1Event; a 'head-down' event with mirror enabled triggers immediate pushNow() so lenses aren't left blank after the hub HUD or a notification card cleared them.
   - src: `src/glasses/mirror.ts:306-312`
35. **Mirror subscribes to all 10 pane stores + ui store + glasses store**
   - Any Zustand set() in chat/agent/inbox/calendar/feeds/bookmarks/money/map/notes/dashboard stores or an activePane change schedules a re-render; handlers short-circuit on one boolean when the toggle is off. CM6 editor changes flow via pushFromEditor() since Zustand can't see selection changes.
   - src: `src/glasses/mirror.ts:273-302,258-260`
36. **Word-boundary wrap helper for lens text**
   - wrapLine breaks at the last space in the right half of the 40-col window (spaceIdx > width/2), else hard-splits mid-word; supports distinct first-row and continuation prefixes for gutter alignment.
   - src: `src/glasses/mirror.ts:150-176`
37. **Composer echo row with left-truncation**
   - composerRow renders '> <text>|'; text longer than width is left-truncated with a leading '…' so the latest typed character is always visible; trailing '|' cursor glyph.
   - src: `src/glasses/mirror.ts:200-205`
38. **Chat pane mirror: last 3 messages + composer echo**
   - Rows 2-4 = last 3 non-deleted text/image messages in the selected room (over-fetch 12 from Dexie, image bodies show '[image]', matrix @user:server senders shortened to local-part, bodies flattened of whitespace); row 5 = live composer echo of what's typed in ChatComposeInput. Status: 'Chat · <room name> · Nu' where Nu = unread count if >0. No room selected → 'Chat · no room selected'.
   - src: `src/glasses/panes/chat.ts`
39. **Chat mirror tail cache with async Dexie refresh**
   - Message tail cached per room; changing rooms kicks a background Dexie query (in-flight guard) that then triggers scheduleFrame(); invalidateChatTail() clears cache when active-room messages change.
   - src: `src/glasses/panes/chat.ts:20-49,97-99`
40. **Agents pane mirror: last activity + status + composer**
   - Rows 2-3 = last assistant text / '⚙ <toolName>' / status text wrapped; row 4 = '· <status>' where status = 'approve <tool>?' if approval pending for the session, else statusText/'running…' when running, else status word; row 5 = agents composer echo. Status bar: 'Agents · <session name|prompt[:30]|id[:8]>'. No session → 'Agents · no session' + composer only.
   - src: `src/glasses/panes/agents.ts`
41. **Mail pane mirror: open thread vs inbox top-4**
   - With a selected thread: row = subject (1 wrapped row), '↳ <sender>' (name from '"Name" <addr>' or addr local-part), remaining rows = latest message snippet wrapped. Status 'Mail · open · Nu'. No selection: top 4 unread threads as 'Sender: Subject'; status shows 'Nu' or 'zero' at inbox zero.
   - src: `src/glasses/panes/mail.ts`
42. **Calendar pane mirror: next 4 upcoming events or selected event detail**
   - Upcoming = visible-calendar events starting ≥ now-60min (includes ongoing), sorted by start, first 4; each row '<time>  <summary>'. Time format: today→HH:MM, other day→'DD MMM HH:MM', all-day→'DD MMM'. Selected event shows summary, '@ <start>', '📍 location', 'by <organizer>'. Status 'Calendar · clear|upcoming|event'.
   - src: `src/glasses/panes/calendar.ts`
43. **Feeds pane mirror: selected article or top items**
   - Selected item: title (≤2 wrapped rows), '↳ author', snippet wrapped in remaining budget; status 'Feeds · read'. Otherwise top 4 items as '<feed title[:14]>: <item title>'; status 'Feeds · <feed|folder|all> · Nu' with total unread.
   - src: `src/glasses/panes/feeds.ts`
44. **Bookmarks pane mirror: selected bookmark or filtered list**
   - Selected: title (≤2 rows), url, '# tag1 tag2…' (first 5 tags); status shows 'triage i/N' when in triage mode else 'open'. Otherwise top 4 filtered titles; status 'Bookmarks · #tag · <count>'.
   - src: `src/glasses/panes/bookmarks.ts`
45. **Money pane mirror: balance + spend-today in status; tx list/detail body**
   - Status 'Money · £X.XX · today <spend>'. Selected tx: display name, amount, category, notes-or-date (today→HH:MM else 'DD MMM'). Otherwise 4 most recent txs as right-padded-9 amount + name.
   - src: `src/glasses/panes/money.ts`
46. **Map pane mirror: selected geocache detail or my-location summary**
   - Selected cache: name, 'CODE type', 'Dx Ty size', hint ('hint: …') else owner ('by …'). Otherwise 'me lat,lon' (3dp) or 'no location', plus 'N caches loaded'. Status 'Map · <device> · <coords>' or 'Map · <cache code>'.
   - src: `src/glasses/panes/map.ts`
47. **Notes pane mirror: cursor-follow 4-row window with line numbers**
   - Reads live CM6 state; each logical line prefixed by right-aligned line number, wrapped; cursor line shows a '|' glyph at cursor column. Cursor placed on row 3 with next line on row 4 when content exists below, else cursor on row 4. Status 'Notes · <basename>'; no editor → 'Notes · no file open'.
   - src: `src/glasses/panes/notes.ts`
48. **Home pane mirror: dashboard alerts or all-clear heartbeat**
   - No alerts → 'Home · all clear' + 'hub up · N session(s)'. Otherwise up to 4 alerts: '? session: question' (agent approvals), '@ Nm summary' (calendar events with minutes-until), '! message' (errors). Status counts alerts with singular/plural.
   - src: `src/glasses/panes/home.ts`
49. **BLE scan for glasses with 15s default duration**
   - startScan clears candidates, sets scanning=true, triggers native scan, then re-reads candidates after duration+500ms; stopScan cancels early. Store also exposes connect (reconnect saved pair), disconnect (sever BLE keeping pair, DND-style), pair(leftMac,rightMac,channel), unpair (forget pair), and refresh (re-read snapshot + candidates). All no-ops when bridge unsupported (browser).
   - src: `src/glasses/store.ts:72-101`
50. **Composer text mirrored to lenses per keystroke**
   - setComposerText(pane,text) for 'chat'/'agents' updates store only on change; uncontrolled textareas push on every keystroke so the lens row-5 echo tracks live typing without React re-renders.
   - src: `src/glasses/store.ts:34-37,108-112`

## home (36)

1. **Home dashboard auto-refreshes: snapshot every 30s, alerts every 15s**
   - Also wires the dashboard SyncBus and refreshes canvas meta once on mount.
   - src: `src/components/HomeTab.tsx:10-38`
2. **Desktop layout: 2×2 grid (Alerts, Servers, Blog drafts, Projects) plus a larger Agent Canvas column (flex 2:3)**
   - src: `src/components/HomeTab.tsx:67-79`
3. **Mobile: sub-tab bar (Alerts | Servers | Blog | Canvas) showing one full-viewport section at a time**
   - Avoids scroll-fighting with the sandboxed canvas iframe; Blog tab stacks BlogDraftsCard + ProjectsCard. All sections stay mounted, hidden via CSS.
   - src: `src/components/HomeTab.tsx:44-65`
4. **Mobile Home sub-tab choice persists to localStorage 'console:home:subtab', default 'alerts'**
   - src: `src/components/HomeTab.tsx:12-29`
5. **Alerts sub-tab shows a live count badge (blue pill) from dashboard alert count**
   - Badge hidden when 0.
   - src: `src/components/HomeTab.tsx:83-107`
6. **Agent canvas card renders hub canvas in sandboxed iframe (allow-scripts allow-popups only)**
   - Loads ${hub}/canvas/index.html; auto-reloads when hub fs.watch fires WS canvas_changed (contentWindow.reload, falling back to cache-buster src bump for cross-origin)
   - src: `src/components/home/AgentCanvasCard.tsx:17-26,90-96`
7. **Canvas header status shows 'empty' (placeholder) or 'updated Xs/m/h/d ago'**
   - From canvasMeta refreshed on mount
   - src: `src/components/home/AgentCanvasCard.tsx:56-58,109-117`
8. **Canvas Share button (Share2 icon) opens CanvasShareMenu modal**
   - Tooltip 'Share a tab or island via public URL'
   - src: `src/components/home/AgentCanvasCard.tsx:59-65,97`
9. **Canvas open-in-new-tab button**
   - window.open of hub canvas URL with noopener,noreferrer
   - src: `src/components/home/AgentCanvasCard.tsx:43,66-72`
10. **Canvas maximize/restore toggle; Esc exits fullscreen**
   - Maximized = fixed inset-0 z-50 overlay; keydown Escape listener only while maximized
   - src: `src/components/home/AgentCanvasCard.tsx:30-36,73-79`
11. **Canvas clear button (Trash) with confirm dialog, disabled when canvas already placeholder**
   - showConfirm('Clear the canvas?', danger) then clearCanvas()
   - src: `src/components/home/AgentCanvasCard.tsx:38-41,80-87`
12. **Canvas share menu lists every tab and island with kind badge, title, 'by <agent>' attribution, and per-row Publish/Unpublish toggle**
   - POST/DELETE /dashboard/canvas/{tabs|islands}/<slug>/publish; button shows '…' while busy; Unpublish styled red; errors shown in footer; loading and 'No tabs or islands yet.' states; click-outside/X closes
   - src: `src/components/home/CanvasShareMenu.tsx:22-152`
13. **Published canvas row shows read-only public URL input (select-all on focus) with Copy button showing check for 1.5s**
   - Footer note: 'Published URLs need no login — anyone with the link can view that single tab/island.'
   - src: `src/components/home/CanvasShareMenu.tsx:124-149`
14. **Alerts card lists dashboard alerts with count in header**
   - Empty state 'Loading…' while loading else 'Nothing pressing.'
   - src: `src/components/home/AlertsCard.tsx:7-26`
15. **Agent-approval alert (yellow shield) click jumps to Agents pane and selects that session**
   - Title 'Agent needs your input' for AskUserQuestion vs 'Agent needs approval'; subtitle sessionName (fallback first 12 chars of id) · question/toolName
   - src: `src/components/home/AlertsCard.tsx:30-51`
16. **Upcoming-calendar alert (blue clock) click switches to Calendar pane**
   - Shows event summary + 'in Nm' / 'in Nh Mm' countdown ('now' when <1m)
   - src: `src/components/home/AlertsCard.tsx:52-68,83-90`
17. **Error alert (red triangle) shows message, source, and Xm/h/d-ago age; not clickable**
   - fmtAgo: <1m 'just now'
   - src: `src/components/home/AlertsCard.tsx:70-99`
18. **Blog Drafts card auto-refreshes every 60s; count in header**
   - Empty state 'No drafts. Write something.'
   - src: `src/components/home/BlogDraftsCard.tsx:15-52`
19. **Draft row click opens the file in the Notes pane**
   - setActivePane('notes') + notes openFile(path)
   - src: `src/components/home/BlogDraftsCard.tsx:21-24`
20. **New draft (+) button prompts for a title via showPrompt then creates the draft; failure shows alert dialog**
   - Cancels silently on empty/blank title
   - src: `src/components/home/BlogDraftsCard.tsx:26-47`
21. **Draft age color-coded: >30d red, >7d yellow, else tertiary**
   - Age formatted 'just now'/Xh/Xd/Xmo/X.Xy ago
   - src: `src/components/home/BlogDraftsCard.tsx:55-56,78-87`
22. **Active-projects card shows only status==='active' projects, auto-refreshes every 5min**
   - Empty state 'No active projects.'; count in header
   - src: `src/components/home/ProjectsCard.tsx:16-62`
23. **Project row click opens the project file in Notes; last-post staleness colored >90d red, >30d yellow**
   - 'no posts yet' when no lastPostMtime; age formatted today/Xd/Xmo/X.Xy ago
   - src: `src/components/home/ProjectsCard.tsx:25-28,66-80,99-104`
24. **Hover-revealed per-project '+' button creates a new post draft attached to that project**
   - Prompts 'Title for the post about <project>'; opacity-0 until row hover; stopPropagation so row click doesn't fire
   - src: `src/components/home/ProjectsCard.tsx:30-35,82-89`
25. **New project (+) header button prompts for title and creates project; error alert on failure**
   - showPrompt with placeholder 'e.g. Cura'
   - src: `src/components/home/ProjectsCard.tsx:37-57`
26. **Pull-to-refresh (mobile only) on any Home sub-tab refreshes snapshot, alerts, canvas meta, blog drafts, and projects in parallel**
   - HomeScrollPane wraps all home cards; gesture works regardless of visible sub-tab
   - src: `src/components/home/HomeScrollPane.tsx:11-31`
27. **Servers card header shows snapshot generation time and manual ↻ refresh button**
   - toLocaleTimeString of generatedAt
   - src: `src/components/home/ServersCard.tsx:26-40`
28. **Add external server: + toggles inline name+URL form (name autofocused), submit requires both fields**
   - addServer(name,url) then clears + closes form
   - src: `src/components/home/ServersCard.tsx:41-68`
29. **Server rows: hub (session count + uptime), Tailscale peers (self/os labels, online/offline), pm2 processes (memory + restart-count↻, uptime or status), external URLs (probe latency in ms or error text)**
   - Green check vs red X status icon per row; uptime formatted d/h/m/s; memory B/K/M
   - src: `src/components/home/ServersCard.tsx:83-169`
30. **External server row hover-reveals Remove (Trash) button**
   - removeServer(id), no confirm
   - src: `src/components/home/ServersCard.tsx:110-143`
31. **Servers card loading and error states before first snapshot**
   - 'Loading…' or red error text
   - src: `src/components/home/ServersCard.tsx:71-76`
32. **Server snapshot poll with loading/error state**
   - refreshSnapshot GETs /dashboard/snapshot (8s timeout) — hub uptime/session count, Tailscale peers (online/self), pm2 processes (status, uptime, restarts, memory, cpu), external URLs with probe latency/status/error; called on a 30s cadence by the pane.
   - src: `src/store/dashboard.ts:85-93`
33. **Alerts poll (agent approvals, upcoming calendar, errors)**
   - refreshAlerts GETs /dashboard/alerts (5s timeout, 15s cadence); alert kinds: agent-approval (session/tool/question), cal-upcoming (summary + start), error (source + message); fetch failure silently keeps old alerts.
   - src: `src/store/dashboard.ts:95-103`
34. **Canvas iframe live-reloads on hub file change**
   - wireDashboardBus subscribes SyncBus dashboard.canvas_changed and bumps canvasReloadKey (iframe src cache-buster) + updates canvas meta — ~200ms live reload, no polling.
   - src: `src/store/dashboard.ts:136-146`
35. **Clear canvas button**
   - clearCanvas DELETEs /canvas (resets to placeholder), force-reloads the iframe, refreshes meta (updatedAt/sizeBytes/isPlaceholder).
   - src: `src/store/dashboard.ts:112-116`
36. **Add/remove external monitored server URLs**
   - addServer POSTs {name,url} to /dashboard/servers; removeServer DELETEs by id; both re-fetch the snapshot so the Servers section updates immediately.
   - src: `src/store/dashboard.ts:118-130`

## mail (118)

1. **Attachment chips under email: icon by type, filename (150px truncate), human file size**
   - ImageIcon for image/*, FileText for PDF, File otherwise; inline CID attachments filtered out (rendered in body); bar hidden if none
   - src: `src/components/AttachmentBar.tsx:11-59`
2. **Attachment preview (Eye button) for images and PDFs in a modal overlay**
   - Only shown when mimeType is image/* or application/pdf; overlay shows filename header + close X; click backdrop closes; image rendered inline, PDF via iframe (80vh)
   - src: `src/components/AttachmentBar.tsx:17-19,60-68,82-104`
3. **Attachment download button**
   - Fetches blob from attachment cache, triggers browser download with original filename via object URL (revoked after)
   - src: `src/components/AttachmentBar.tsx:26-36,69-75`
4. **Calendar-invite card in email view: title with cancelled strikethrough + red 'Cancelled' label**
   - Cancelled when status CANCELLED or method CANCEL; color bar red vs accent
   - src: `src/components/CalendarEventCard.tsx:9-31`
5. **Invite card date/time formatting adapts to all-day and multi-day**
   - All-day detected by 00:00 start+end; same-day shows 'Ddd Mon N, HH:MM – HH:MM' (24h); multi-day shows both day+time; all-day shows day(s) only
   - src: `src/components/CalendarEventCard.tsx:11-46,87-101`
6. **Invite card shows location row and attendee list with RSVP status dots**
   - Dot colors: accepted green, declined red, tentative amber, else gray; attendee name falls back to email
   - src: `src/components/CalendarEventCard.tsx:48-85`
7. **Inbox-zero empty state: sun icon + 'You're all done' + 'Nothing in your inbox. Go enjoy your day.'**
   - src: `src/components/InboxZero.tsx:3-12`
8. **Snoozed threads bar above the list: '<N> snoozed' toggles showing snoozed threads, becomes 'hide snoozed' when active**
   - Count is a Dexie live query on threads with snoozedUntil; bar hidden when count 0.
   - src: `src/components/Layout.tsx:95-105`
9. **Mobile swipe-right on an open thread archives it; swipe-left snoozes to 'tomorrow'**
   - Green Check icon revealed on left edge, amber Clock on right edge during swipe.
   - src: `src/components/Layout.tsx:75-80`
10. **Mail pane mobile master/detail: list shown only when no thread selected, detail only when selected**
   - src: `src/components/Layout.tsx:61-62`
11. **Gmail connect screen suppressed while hub auth answer is in flight (renders nothing until hydrated)**
   - Prevents flashing the connect screen when hub-login OAuth already connected mail.
   - src: `src/components/Layout.tsx:85-89`
12. **Gmail connect screen: 'Sign in with Google' opens a 500×600 popup synchronously (preserves user gesture), reloads page on success, shows 'Sign-in cancelled or failed' error**
   - Button label 'Connecting...' + disabled while loading.
   - src: `src/components/Layout.tsx:757-797`
13. **Messages in a thread start collapsed except the last; collapsed row shows sender, snippet (entity-decoded), date — click to expand; clicking an expanded header re-collapses (except the last message)**
   - src: `src/components/MessageView.tsx:19,27-48`
14. **Expanded message header shows From name + <email>, To list, Cc list (name-or-email joined by commas), formatted date**
   - src: `src/components/MessageView.tsx:49-67`
15. **Per-message ⋯ menu with Reply / Reply all / Forward, closing on outside click**
   - Each sets inbox store replyMode for that specific message.
   - src: `src/components/MessageView.tsx:69-101`
16. **Calendar invite card rendered above the body when the message carries a text/calendar event (expanded only)**
   - src: `src/components/MessageView.tsx:107-110`
17. **Email body iframe stays mounted while collapsed (h-0 hidden) so re-expanding is instant; render suspended when message not visible**
   - src: `src/components/MessageView.tsx:112-115`
18. **Attachment bar below body when the message has attachments (expanded only)**
   - src: `src/components/MessageView.tsx:117-120`
19. **From-address picker shown only when >1 send-as alias**
   - Chevron dropdown lists aliases (email + optional name); current selection highlighted in accent; clicking sets from and closes
   - src: `src/components/ComposeEditor.tsx:325`
20. **Aliases sorted by recency of use, cached 10 min**
   - Recency derived from last 500 messages' To/Cc containing the alias; ALIAS_CACHE_TTL=10min module-level cache to avoid rescanning on every compose mount
   - src: `src/components/ComposeEditor.tsx:27`
21. **Smart from-address auto-pick for replies**
   - pickFromAddress: (1) exact alias present in original To/Cc, (2) same-domain alias as any recipient, (3) default alias, else first alias / userEmail
   - src: `src/components/ComposeEditor.tsx:63`
22. **Reply mode prefills To with original sender (or original To if I sent it) and 'Re:' subject**
   - If lastMessage.fromEmail===userEmail uses lastMessage.to; subject prefixed 'Re: ' unless already starting with 'Re:'
   - src: `src/components/ComposeEditor.tsx:140`
23. **Reply-all prefills To=sender, Cc=all recipients minus my own aliases**
   - Filters out the from-address and every alias email from the Cc list; 'Re:' subject rule same as reply
   - src: `src/components/ComposeEditor.tsx:145`
24. **Forward prefills 'Fwd:' subject, empty To, and carries over non-inline attachments**
   - Attachments without contentId loaded from local attachment cache as base64 and added all at once; 'Fwd:' not duplicated if already present
   - src: `src/components/ComposeEditor.tsx:163`
25. **To field auto-focused (100ms delay) in forward/compose modes; editor autofocused at end for reply/replyAll**
   - setTimeout 100ms focus on To input for forward/compose; Tiptap autofocus 'end' for reply modes
   - src: `src/components/ComposeEditor.tsx:177`
26. **Gmail-style quoted original appended below reply/forward**
   - Forward: '---------- Forwarded message ---------' block with From/Date/Subject/To. Reply: 'On <date> <sender> wrote:' + blockquote. Date format 'Wkd, Mon D, YYYY at H:MM'. User text wrapped in its own div at send so Gmail collapses quote under ⋯
   - src: `src/components/ComposeEditor.tsx:219`
27. **Rich Tiptap editor with markdown paste/copy transform, headings 1-3, placeholder 'Write your message...'**
   - tiptap-markdown transformPastedText+transformCopiedText; onUpdate stores both markdown and HTML
   - src: `src/components/ComposeEditor.tsx:182`
28. **Cmd/Ctrl+Enter sends the email (global keydown while composer open)**
   - window-level listener; Send button also shows platform-aware hint '⌘+↵' (Mac) or 'Ctrl+↵'
   - src: `src/components/ComposeEditor.tsx:289`
29. **Send guarded against double-fire; sets In-Reply-To/References threading headers**
   - sendingRef prevents concurrent sends; references = original references + message-id; HTML read directly from editor to avoid stale state; nothing sent if no body and no To; on success resets compose store, clears editor, closes
   - src: `src/components/ComposeEditor.tsx:242`
30. **Attach files via paperclip button (multi-select) or drag-and-drop onto editor area**
   - Hidden file input with multiple; input value reset after select so same file re-attachable; onDrop/onDragOver on editor div accepts dropped files
   - src: `src/components/ComposeEditor.tsx:432`
31. **Attachment chips show filename (truncated 150px), size, and X-to-remove**
   - formatFileSize for size; X button calls removeAttachment(id)
   - src: `src/components/ComposeEditor.tsx:398`
32. **Discard button resets composer and closes without sending**
   - reset() store + clearContent + onClose
   - src: `src/components/ComposeEditor.tsx:446`
33. **Cc field shown only for replyAll/compose modes or when cc already has value; Subject field only for compose/forward**
   - Conditional field rendering per mode
   - src: `src/components/ComposeEditor.tsx:366`
34. **Contact autocomplete on To/Cc: local results instantly, remote (Google People) merged after**
   - Debounce 100ms on last comma-separated token; local contacts built from every message's from/to/cc via cursor scan (constant memory), sorted by recency, cached 10min; local top 8 shown immediately; remote search only for queries ≥2 chars, deduped against local, merged list capped at 10; stale remote responses discarded via reqId; remote failure silently keeps local
   - src: `src/components/ContactAutocomplete.tsx:108`
35. **Autocomplete keyboard nav: ArrowUp/Down move selection, Enter/Tab select, Escape closes**
   - Selected row scrolled into view; Escape stopPropagation so it doesn't close the composer; selection inserts 'Name <email>, ' replacing the current token; suppressed when token contains '>' (already completed)
   - src: `src/components/ContactAutocomplete.tsx:171`
36. **Autocomplete dropdown closes 150ms after blur; mousedown-select prevents blur race**
   - onBlur setTimeout 150ms; suggestion buttons use onMouseDown+preventDefault
   - src: `src/components/ContactAutocomplete.tsx:199`
37. **Snooze date-time picker: Monday-based month calendar with prev/next month navigation**
   - Chevron buttons change month (year wraps); month label localized 'Month YYYY'; changing month clears selected day
   - src: `src/components/DateTimePicker.tsx:46`
38. **Past days disabled (40% opacity, unclickable); today highlighted in accent; selected day filled accent**
   - isPast compares end-of-day vs now; today bold accent text unless selected
   - src: `src/components/DateTimePicker.tsx:104`
39. **Time selectors: hour dropdown 00-23 (default 08), minute dropdown 00/15/30/45 (default 00)**
   - Zero-padded labels; 15-minute granularity only
   - src: `src/components/DateTimePicker.tsx:131`
40. **'Snooze' confirm button disabled until a day is selected**
   - onSelect(new Date(y,m,day,hour,minute)) fired on confirm
   - src: `src/components/DateTimePicker.tsx:157`
41. **Email bodies render in sandboxed iframe (allow-same-origin allow-popups) with sanitized HTML and light-mode base styling**
   - cid: URLs replaced with transparent GIF pixel until preload caches blob URLs; blob URL revoked after load; cached documents load from email-cache lightUrl
   - src: `src/components/EmailFrame.tsx:52`
42. **All links inside an email open in a new tab; clicking/focusing the email returns focus to the app so keybindings keep working**
   - Click handler intercepts closest <a>, window.open(_blank noopener); focusin on body re-focuses parent window
   - src: `src/components/EmailFrame.tsx:71`
43. **Email dark mode toggled by DOM style injection without iframe reload**
   - Applied only when emailDarkMode AND global darkMode are both on; injects/removes a style element (buildDarkModeEmailCss)
   - src: `src/components/EmailFrame.tsx:97`
44. **Fixed-width marketing emails force-linearized to fit viewport width**
   - Injected style makes all table elements display:block width:100%, word-break, images height:auto, pre wraps — text wraps instead of clipping
   - src: `src/components/EmailFrame.tsx:152`
45. **Email iframe auto-measures its height (body height +16px) and re-measures on resize/orientation via ResizeObserver**
   - Height cached per messageId in email-cache; unmeasured emails default to 80vh; measurement double-rAF'd on becoming visible
   - src: `src/components/EmailFrame.tsx:24`
46. **Hidden emails render a height-preserving placeholder div instead of a live iframe**
   - Prevents dozens of live hidden email documents starving input in other panes (~500ms long tasks); cached height means zero layout shift when the real iframe swaps back in
   - src: `src/components/EmailFrame.tsx:135`
47. **'/' search overlay searches email threads by subject, sender, or snippet**
   - Case-insensitive substring over Dexie threads, limit 20, sorted newest first, 150ms debounce; rows show sender, relative time, subject; 'No results' empty state
   - src: `src/components/SearchOverlay.tsx:32`
48. **Email search keyboard: ArrowUp/Down navigate, Enter opens thread, Esc closes**
   - Enter/click selects thread and closes overlay; backdrop click also closes
   - src: `src/components/SearchOverlay.tsx:57`
49. **Snooze option 'Later today' with computed time label and shortcut key 1**
   - Description shows the actual target time (getSnoozeTime('laterToday') formatted h:mm AM/PM); click snoozes selected thread and closes picker
   - src: `src/components/SnoozePicker.tsx:52`
50. **Snooze option 'Tomorrow' at 8:00 AM with shortcut key 2**
   - snoozeThread('tomorrow')
   - src: `src/components/SnoozePicker.tsx:58`
51. **Snooze option 'Next week' Mon 8:00 AM with shortcut key 3**
   - snoozeThread('nextWeek')
   - src: `src/components/SnoozePicker.tsx:64`
52. **Custom snooze: inline DateTimePicker on desktop, native datetime-local picker on mobile**
   - Mobile 'Pick date & time' button calls showPicker() on a hidden input; chosen date → snoozeThread('custom', date); picker closes after. Modal is bottom sheet on mobile, centered on desktop; backdrop click dismisses
   - src: `src/components/SnoozePicker.tsx:73`
53. **Thread list live-driven from IndexedDB: INBOX, unsnoozed, newest first**
   - useLiveQuery filter labelIds includes INBOX && !snoozedUntil, reverse-sorted by date; feeds the inbox store
   - src: `src/components/ThreadList.tsx:27`
54. **Snoozed threads section shown above inbox when toggled, sorted by wake time**
   - showSnoozed prop; snoozed rows render at 50% opacity with clock icon and relative time of snoozedUntil; an 'INBOX' divider separates them from live threads
   - src: `src/components/ThreadList.tsx:42`
55. **Pull-to-refresh on mobile thread list triggers incremental Gmail sync**
   - usePullToRefresh(listRef, incrementalSync, isMobile)
   - src: `src/components/ThreadList.tsx:24`
56. **Desktop auto-selects the first thread when none selected**
   - Mobile never auto-selects (list-first UX)
   - src: `src/components/ThreadList.tsx:56`
57. **Selected thread auto-scrolls into view on selection or reorder**
   - scrollIntoView({block:'nearest'}) keyed by data-thread-id
   - src: `src/components/ThreadList.tsx:63`
58. **Mobile swipe-right on a thread archives it (green check)**
   - SwipeableRow right action → archiveThread(id); green background tint while swiping
   - src: `src/components/ThreadList.tsx:133`
59. **Mobile swipe-left on a thread snoozes it to tomorrow 8AM (amber clock)**
   - snoozeThread('tomorrow', undefined, thread.id) — fixed preset, no picker
   - src: `src/components/ThreadList.tsx:134`
60. **'No threads' empty state when inbox empty and snoozed hidden**
   - Centered tertiary text
   - src: `src/components/ThreadList.tsx:69`
61. **Thread row shows sender, subject, decoded snippet, relative time**
   - Sender + subject bold/primary when unread, secondary otherwise; snippet HTML entities decoded; all truncated to one line
   - src: `src/components/ThreadListItem.tsx:33`
62. **Thread row shows user Gmail labels as tiny 9px tags**
   - labelIds starting with 'Label_' mapped to names via labelMap from Dexie meta; unmapped ids shown raw
   - src: `src/components/ThreadListItem.tsx:38`
63. **Thread row paperclip icon when the thread has attachments**
   - thread.hasAttachments
   - src: `src/components/ThreadListItem.tsx:41`
64. **Thread row 'N messages' count line when thread has >1 message**
   - messageCount > 1
   - src: `src/components/ThreadListItem.tsx:52`
65. **Thread view header shows subject + per-email dark-mode toggle**
   - Button labeled 'Dark'/'Original' toggles emailDarkMode (applies dark styling to email iframes); works for snoozed threads too via a direct Dexie lookup when the thread isn't in the inbox list
   - src: `src/components/ThreadView.tsx:41`
66. **All inbox threads' messages stay mounted; only the selected one is visible**
   - Pre-render architecture: messages for every INBOX thread loaded and rendered display:none; selection flips display for instant switching; non-inbox (snoozed/archived) threads render from selectedMessages with a 'Loading...' fallback
   - src: `src/components/ThreadView.tsx:64`
67. **Inbox-zero screen when there are no threads and nothing selected**
   - Renders <InboxZero /> celebration component; 'Select a thread' placeholder when threads exist but none selected
   - src: `src/components/ThreadView.tsx:80`
68. **Reply / Reply all / Forward buttons under the thread with r / R / f hints**
   - Keyboard-hint prefixes hidden on mobile; clicking opens ComposeEditor in that mode targeting replyToMessage or the last message; closing returns to the button bar
   - src: `src/components/ThreadView.tsx:163`
69. **Gmail API 401 triggers auth-expired flow**
   - Any hub /mail/* 401 clears persisted signed-in state and fires auth-expired listeners so the shell shows a sign-in prompt; error thrown is 'Session expired. Please sign in again.'
   - src: `src/gmail/api.ts:49-53`
70. **Contact autocomplete search via hub People proxy**
   - searchContacts(q) hits /mail/contacts?q=…; empty query returns [] and any error is swallowed to [] so autocomplete never surfaces failures.
   - src: `src/gmail/api.ts:168-177`
71. **Gmail signed-in state cached in localStorage for offline boot**
   - 'gmail_signed_in'/'gmail_user_email' persist across reloads so a slow/offline boot shows the cached inbox instead of the connect screen; initAuth() re-verifies against hub /auth/status (4s abort timeout) and keeps cached state if hub unreachable. isAuthHydrated() gates the connect screen so a fresh device doesn't flash it.
   - src: `src/gmail/auth.ts:16-119`
72. **Google sign-in popup with 1s completion polling and 5min timeout**
   - signIn opens hub /auth/google/start in a 500x600 popup (rejects 'Popup blocked' if blocked, non-native); polls /auth/google/poll every 1s; closing the popup rejects 'Sign-in cancelled'; 5-minute overall timeout rejects 'Sign-in timed out'. Native APK adds '?callback=app', listens for console://auth/done deep-link event, and keeps the poll as a safety net.
   - src: `src/gmail/auth.ts:127-212`
73. **Sign out clears hub tokens then local cache**
   - POST /auth/logout/google (best-effort), then clears localStorage signed-in cache and notifies listeners regardless of hub reachability.
   - src: `src/gmail/auth.ts:214-226`
74. **Full sync prioritizes first 3 threads for instant reading**
   - Fetches first 100 thread IDs, saves the first 3 threads immediately (status 'Synced 3/N+ threads'), then paginates all IDs and back-fills in batches of 10 with progress status updates.
   - src: `src/gmail/sync.ts:157-183`
75. **Sync skips draft messages and preserves local snooze on re-fetch**
   - DRAFT-labelled messages are excluded from thread/message conversion; thread rows re-fetched from Gmail keep an existing local snoozedUntil.
   - src: `src/gmail/sync.ts:35-37,144-148`
76. **Full sync prunes threads gone from inbox but never snoozed ones**
   - Local threads absent from the fetched inbox set are deleted (thread + messages) unless snoozedUntil>0 — snooze is local-only so archived-on-Gmail snoozed threads must survive.
   - src: `src/gmail/sync.ts:186-201`
77. **Sync fetches send-as aliases and label map in parallel**
   - Aliases stored in meta 'sendAsAliases' for compose From picker; label id→name map stored as 'labelMap'. Failures are independent (allSettled).
   - src: `src/gmail/sync.ts:116-127`
78. **Calendar invites parsed from text/calendar parts, fetching attachment body if needed**
   - Each message's calendar part is parsed into a CalendarEvent (summary/start/end/attendees/status/method); if the ICS body is an attachment it's fetched via /mail/…/attachments; parse errors silently skipped.
   - src: `src/gmail/sync.ts:66-76`
79. **Offline gate: syncs no-op with 'Hub unreachable' when WS is down**
   - Both fullSync and incrementalSync check hubBus.connected first and set status 'offline' instead of burning a connect timeout.
   - src: `src/gmail/sync.ts:104-108,220-224`
80. **Incremental sync falls back to full sync on expired history ID**
   - listHistory 404/400 → fullSync(); no stored historyId → fullSync(). Zero history records → status idle with no fetches.
   - src: `src/gmail/sync.ts:225-257`
81. **Desktop notification on new unread thread from incremental sync**
   - A thread newly appearing (no existing Dexie row) with isUnread fires notify(title=sender, body=subject, tag='mail-<id>', deep-link data {pane:'email', itemId:threadId}).
   - src: `src/gmail/sync.ts:320-330`
82. **Incremental sync respects pending unarchive/unsnooze to avoid races**
   - Threads with a queued unarchive/unsnooze action are never deleted locally even if Gmail reports them out of inbox; snoozed threads likewise preserved on removal/fetch-error paths.
   - src: `src/gmail/sync.ts:287-347`
83. **Queued send performs conflict detection before sending**
   - For a reply into an existing thread, the queue processor re-fetches the thread; if remote message count exceeds local, action is marked 'conflict' with message 'New messages arrived in this thread. Please review before sending.' instead of sending.
   - src: `src/gmail/sync.ts:406-424`
84. **Offline queue processor maps actions to Gmail ops; failures marked with error**
   - archive/unarchive/trash/markRead/markUnread/send/snooze(=archive)/unsnooze(=unarchive) executed in order; chat-prefixed actions skipped (handled elsewhere); each failure marked failed with error message (retry counting in queue layer).
   - src: `src/gmail/sync.ts:367-446`
85. **Snooze wake-up: expired snoozes return to inbox automatically**
   - checkSnoozes finds threads with snoozedUntil ≤ now, clears the snooze, re-adds INBOX label locally, and enqueues an 'unsnooze' (server-side unarchive).
   - src: `src/gmail/sync.ts:449-465`
86. **Queue flush debounced 500ms after each enqueue**
   - onEnqueue schedules flushQueue after 500ms, resetting on rapid actions so a burst coalesces into one flush pass.
   - src: `src/gmail/sync.ts:499-506`
87. **Mail sync loop: initial sync on boot, hub 'mail.delta' pushes (300ms debounce), 5-min fallback timer**
   - doSync = processQueue + incrementalSync + checkSnoozes. Hub delta events debounce 300ms into one pass; interval fallback (default 300s) covers a dead WS.
   - src: `src/gmail/sync.ts:496-531`
88. **Email reply keys: r reply, R/Shift+r reply-all, f forward**
   - Set inbox replyMode accordingly; email pane only.
   - src: `src/hooks/useKeybindings.ts:595-611`
89. **Email compose draft state with attachments**
   - Compose store holds from/to/cc/subject/body (markdown+html) and quotedHtml (forwarded original preserved raw, never passed through Tiptap); addAttachment base64-encodes a File (unknown MIME → application/octet-stream); removeAttachment deletes by id; reset clears everything.
   - src: `src/store/compose.ts:48-101`
90. **Selecting a thread loads messages and auto-marks read**
   - selectThread resets reply mode and compose store, loads messages sorted by date, and marks the thread read if it was unread; stale async loads guarded by re-checking selection.
   - src: `src/store/inbox.ts:80-94,122-131`
91. **Next/previous thread keyboard navigation**
   - selectNextThread/selectPrevThread move within the list; no selection → next picks first, prev picks last; no wrap at ends.
   - src: `src/store/inbox.ts:96-120`
92. **Archive thread — instant optimistic removal, 5s undo, attachment eviction**
   - archiveThread synchronously removes the thread (optimisticallyRemoved guard vs live query), advances selection to the same index, shows 'Archived' undo toast (5000ms); background: deletes the thread row (messages kept), enqueues 'archive' to the sync queue, evicts cached attachments; newly-selected thread auto-marks read.
   - src: `src/store/inbox.ts:133-181`
93. **Delete thread — optimistic with undo restoring messages**
   - deleteThread removes thread + all messages from IDB and enqueues 'trash'; the 5s 'Deleted' undo saves the messages first and restores them plus the thread on undo.
   - src: `src/store/inbox.ts:183-233`
94. **Snooze thread (later today / tomorrow / next week / custom)**
   - snoozeThread sets snoozedUntil via getSnoozeTime, optimistically removes from list with selection advance, enqueues 'snooze' (local-only — Gmail has no snooze API), closes the snooze picker; no undo toast for snooze.
   - src: `src/store/inbox.ts:235-273`
95. **Mark thread read**
   - markRead flips isUnread in IDB + store and enqueues 'markRead' for Gmail.
   - src: `src/store/inbox.ts:275-285`
96. **Reply / reply-all / forward mode**
   - setReplyMode stores mode + the specific message being replied to; cleared on thread switch.
   - src: `src/store/inbox.ts:287`
97. **Send reply auto-archives the thread**
   - sendReply enqueues 'send' (from/html/to/cc/subject/inReplyTo/references/attachments) to the offline queue, exits reply mode, then archives the thread (inbox-zero: dealt with = done).
   - src: `src/store/inbox.ts:289-303`
98. **Undo archive re-inserts thread and enqueues unarchive**
   - undoArchive restores the thread row, removes the pending 'archive' queue action, enqueues 'unarchive' (covers the case the archive already flushed), rebuilds the inbox list (INBOX label, not snoozed, newest first) and re-selects the thread.
   - src: `src/store/inbox.ts:305-321`
99. **Undo delete restores thread and messages**
   - undoDelete puts the thread back, removes the pending 'trash' queue action, rebuilds the list and re-selects.
   - src: `src/store/inbox.ts:323-335`
100. **Deselected/vanished thread clears selection**
   - setThreads clears selectedThreadId + messages if the selected thread disappeared from a non-empty incoming list.
   - src: `src/store/inbox.ts:62-78`
101. **Attachments cached in IndexedDB + in-memory blob URLs**
   - getAttachmentBlobUrl checks in-memory cache, then IDB attachmentData, then fetches from hub and persists — attachments open instantly and offline after first view.
   - src: `src/utils/attachment-cache.ts:19`
102. **Background preload of all inbox attachments**
   - preloadAttachments walks every non-snoozed INBOX thread's messages, fetching+caching each uncached attachment; abortable (new run cancels previous); yields to main thread between threads; failed attachments skipped silently.
   - src: `src/utils/attachment-cache.ts:89`
103. **Attachment eviction on thread removal**
   - evictThreadAttachments revokes blob URLs and deletes IDB rows for all a thread's message attachments — keeps offline storage bounded to inbox.
   - src: `src/utils/attachment-cache.ts:135`
104. **Inline CID images resolve to cached blobs**
   - resolveCidReferences replaces every cid:<contentId> in the HTML with the attachment's blob URL (regex-escaped, global) so embedded images render offline.
   - src: `src/utils/attachment-cache.ts:159`
105. **File size formatting B/KB/MB**
   - <1024 → 'N B'; <1MB → one-decimal KB; else one-decimal MB.
   - src: `src/utils/attachment-cache.ts:181`
106. **Snooze option Later today = max(now+3h, 6pm)**
   - getSnoozeTime('laterToday') returns 3 hours from now or 18:00 today, whichever is later.
   - src: `src/utils/date.ts:65`
107. **Snooze option Tomorrow = 8am next day**
   - getSnoozeTime('tomorrow') = tomorrow 08:00:00.
   - src: `src/utils/date.ts:72`
108. **Snooze option Next week = next Monday 8am**
   - getSnoozeTime('nextWeek') computes the next Monday (always ≥1 day ahead) at 08:00.
   - src: `src/utils/date.ts:78`
109. **Custom snooze via datetime picker**
   - getSnoozeTime('custom', date) uses the user-picked Date; falls back to now if absent.
   - src: `src/utils/date.ts:84`
110. **Pre-rendered email iframes with per-message light+dark blob docs**
   - Each message gets both a light and a dark sanitized HTML blob URL (CID images resolved first) plus a remembered iframe height — instant open and instant dark-mode flip.
   - src: `src/utils/email-cache.ts:65`
111. **Whole-inbox email body preload in background**
   - preloadAllInbox caches docs for every non-snoozed INBOX thread's messages; abortable; yields between threads to keep typing smooth; evictAll/evictMessage revoke blob URLs.
   - src: `src/utils/email-cache.ts:91`
112. **Email dark mode via CSS invert+hue-rotate**
   - buildDarkModeEmailCss inverts the whole email doc and re-inverts images/videos/SVG/background-image elements so photos stay natural.
   - src: `src/utils/email.ts:249`
113. **Email HTML sanitized before render**
   - DOMPurify with script/iframe/object/embed/form/input forbidden; style tags and target attr allowed; data attributes stripped.
   - src: `src/utils/email.ts:100`
114. **Plain-text-only emails rendered as wrapped <pre>**
   - getBodyHtml prefers text/html part; falls back to text/plain escaped in a pre-wrap block; empty messages show grey 'No content'.
   - src: `src/utils/email.ts:60`
115. **Attachment list excludes multipart/alternative inline parts**
   - getAttachments walks MIME parts, skipping parts inside multipart/alternative (avoids listing inline HTML twins), captures contentId for CID images.
   - src: `src/utils/email.ts:109`
116. **Calendar invites parsed from text/calendar parts**
   - parseIcs extracts summary, location, description (unescaping \n and \,), start/end (UTC vs local vs all-day formats), organizer, attendees with CN + PARTSTAT status (default needs-action), METHOD — rendered as an invite card with RSVP.
   - src: `src/utils/email.ts:136`
117. **Compose builds RFC822 raw email with attachments**
   - buildRawEmail emits multipart/alternative (no attachments) or multipart/mixed with base64 attachment parts (76-char line wrap), From/To/Cc/Subject/In-Reply-To/References headers — powers send, reply, reply-all, forward.
   - src: `src/utils/email.ts:302`
118. **Sender display name parsing strips quotes**
   - parseFrom splits 'Name <email>' and strips surrounding quotes from the name; parseAddressList splits comma lists respecting quoted names.
   - src: `src/utils/email.ts:19`

## map (45)

1. **Map initializes on CARTO dark raster basemap centered [-2,54] zoom 5, with zoom-only navigation control (no compass); tile errors tolerated silently**
   - src: `src/components/MapTab.tsx:151-162`
2. **Map auto-centers once on your latest OwnTracks fix (flyTo zoom 11) the first time a current position arrives**
   - centeredRef guards to once per mount.
   - src: `src/components/MapTab.tsx:229-235`
3. **Geocache pins are emoji glyphs: 😀 found beats 😟 DNF beats per-type emoji (📦 Traditional, 🧩 Multi, ❓ Mystery, ✉️ Letterbox, 🌍 EarthCache, 🎉 events, ♻️ CITO, 📷 Webcam, 🔮 Virtual, 🕹️ Wherigo, 🧭 GPS Adventures, 🏢 HQ, 🌐 Locationless, 🦍 Project APE, 📍 default)**
   - Colour emoji achieved by rasterizing to canvas images registered on demand via styleimagemissing (works for arbitrary agent-layer _icon emoji too).
   - src: `src/components/MapTab.tsx:37-65`
4. **Click a geocache pin to select it (loads lazy detail); cursor becomes pointer on hover; selected pin gets a white-stroked translucent blue ring**
   - src: `src/components/MapTab.tsx:181-186,425-429`
5. **Meetup events render as 📅 pins; click selects (lazy detail); selected gets pink ring; online events have no coords → no pin**
   - src: `src/components/MapTab.tsx:82-95,188-193,443-445`
6. **OwnTracks history track drawn as a light-blue 3px line; current position as blue circle with white stroke**
   - src: `src/components/MapTab.tsx:418-421,457-463`
7. **Layers toolbar button shows total layer count (agent layers + 3 built-ins) and toggles the Layers panel**
   - src: `src/components/MapTab.tsx:278-281`
8. **Location time-range dropdown: Last 24h/48h/7/30/90 days/year/Custom…; non-custom selection immediately loads history for now−N days**
   - Clock icon becomes a spinner while history loads. Whole control cluster only visible while the Location built-in layer is on.
   - src: `src/components/MapTab.tsx:288-296`
9. **Custom range: two date pickers (from → to), each change reloads history**
   - src: `src/components/MapTab.tsx:297-303`
10. **Device selector dropdown appears only when >1 OwnTracks device; changing it reloads history for that device**
   - src: `src/components/MapTab.tsx:304-308`
11. **Crosshair button centres map on my latest location (flyTo zoom 14); also bound to 'g' key via mapController**
   - src: `src/components/MapTab.tsx:195-197,310-314`
12. **Geocaching toolbar: key button shows 'Sign in' or the logged-in username and opens the credentials panel**
   - Cluster only visible while Geocaches layer is on.
   - src: `src/components/MapTab.tsx:318-323`
13. **'Fetch geocaches in view' download button (only when logged in): fetches current bounds, shows remaining daily request budget as number + in tooltip, spinner while fetching, disabled during fetch**
   - Also bound to 'f' key via mapController.fetchHere.
   - src: `src/components/MapTab.tsx:324-331`
14. **Meetup toolbar: time-window select (Upcoming/7/30/90 days) + fetch-in-view button with remaining daily budget and spinner; wildcard search (no keyword box)**
   - Cluster only while Meetup layer visible; disabled while fetchingMeetup.
   - src: `src/components/MapTab.tsx:336-352`
15. **Store error surfaced as a red pill in the toolbar**
   - src: `src/components/MapTab.tsx:355`
16. **Layers panel: checkboxes for 3 built-ins (Location history 🔵, Geocaches 📦 with coord'd pin count, Meetup 📅 with coord'd event count) then 'Agent layers' grouped with per-group all-on checkbox and per-layer toggle + featureCount**
   - Toggling a built-in flips MapLibre visibility of its sublayers (ot-track/ot-current, gc-selected/gc-pins, meetup-selected/meetup-pins); persisted via store (localStorage console:map:builtinVisible).
   - src: `src/components/MapTab.tsx:651-711`
17. **Agent layers with fit:true auto-fitBounds once per slug (padding 40, 600ms) when first visible with data**
   - src: `src/components/MapTab.tsx:256-262`
18. **Agent-layer rendering: fill (Polygon-only guard), line (per-feature _color, animated marching-ants dashes when style.animated), circle (Point-only, _color/_size), emoji symbol (_icon), text label (_label, offset below point, halo)**
   - Animated dashes: shared rAF loop, 14-step constant-period sequence, 130ms dwell per step, butt caps, paused while the Map pane is display:none.
   - src: `src/components/MapTab.tsx:545-612`
19. **Clicking any agent-layer feature opens a styled popup (bold name/_label title + key→value rows from style.popup or all non-underscore props); empty content → no popup**
   - Popup max width 260px with close button; pointer cursor on hover.
   - src: `src/components/MapTab.tsx:531-543,614-628`
20. **geocaching.com credentials panel: Password vs Cookie mode tabs; cookie mode is the CAPTCHA fallback (paste gspkauth); shows 'Signed in as <user>. Re-enter to switch.'; Sign in button disabled/busy state; errors in red**
   - src: `src/components/MapTab.tsx:713-757`
21. **Cache detail panel: name, code · type · size, D/T ratings, ★ favorites, found (green)/DNF (red)/premium (amber) badges, owner + hidden date, hint, enabled attribute chips, up to 8 recent logs colour-coded by type (green found/attended, red DNF, amber maintenance) with HTML-stripped text clamped to 3 lines, 'open on geocaching.com' external link**
   - Spinner 'loading detail…' until lazy detail arrives; close X deselects.
   - src: `src/components/MapTab.tsx:759-815`
22. **Meetup event detail panel: title, group name, formatted local time (Ddd Mmm D, HH:MM), '<n> going', online/hybrid badges, venue line with address, lazy description clamped 12 lines, 'open on meetup.com' link**
   - src: `src/components/MapTab.tsx:817-865`
23. **Initial map data load on mount: refresh() then loadHistory(); loadLayers() over plain HTTP**
   - src: `src/components/MapTab.tsx:219-223`
24. **Geocache mirror hydrates map pins from Dexie on boot (offline), applies live 'delta' broadcasts from the hub, and re-fetches the full snapshot on every hub reconnect — cross-device: a fetch-area on PC appears on the phone's map**
   - detail field stripped before Dexie write (summaries only)
   - src: `src/geocaching/subscribe.ts:22-51`
25. **Map keys: j/k select adjacent geocache pin, f fetch caches in view, g fly to my location**
   - f/g dispatch through the mapController bridge populated by MapTab on mount (imperative MapLibre access without refs).
   - src: `src/hooks/useKeybindings.ts:353-385; src/map/controller.ts`
26. **Dark basemap: on-demand CARTO raster tiles with retina support**
   - 4 CDN subdomains, dark_all style, @2x tiles when devicePixelRatio>1, OSM/CARTO attribution, #0a0a0a background beneath; browser HTTP-caches revisited tiles; offline shows no streets but data layers still render. Keyless maplibre demotiles glyph server enables text labels (e.g. flight-arc prices).
   - src: `src/map/basemap-style.ts`
27. **Agent map-layers mirrored to Dexie for offline rendering**
   - Hydrates layer index from meta 'console:mapLayerIndex:v1' + cached GeoJSON on boot; live 'map-layers' delta events and HTTP snapshot on WS connect apply the new index; layers absent from the index are deleted from Dexie; per-layer GeoJSON re-fetched over HTTP only when updatedAt changed (else served from cache); fetch failures keep last-known data.
   - src: `src/map/layers-subscribe.ts`
28. **Meetup events sync cross-device and render offline**
   - Dexie meetupEvents hydrated on boot for offline map pins; live 'delta' broadcasts merge new rows; on every hub connect the snapshot is AUTHORITATIVE — client deletes rows absent from it (hub prune/cleanup propagates) while preserving already-loaded event detail on survivors
   - src: `src/meetup/subscribe.ts:28-70`
29. **Location history date range defaults to last 24h**
   - rangeFrom initialises to now-1day, rangeTo to now; setRange updates both.
   - src: `src/store/map.ts:238-239,301`
30. **History track decimated to 4000 points**
   - loadHistory fetches OwnTracks locations for user 'amar' between the range's dates (end day inclusive), sorts chronologically, and even-samples down to MAX_TRACK_POINTS=4000 (always keeping the last fix) so the polyline stays fast; loading flag shown while fetching.
   - src: `src/store/map.ts:150-171,276-299`
31. **Device picker from latest fixes**
   - refresh derives the device list from /owntracks/last; keeps the current selection if still present else falls back to the first device.
   - src: `src/store/map.ts:255-269`
32. **Combined status refresh (owntracks + geocaching + meetup)**
   - refresh fetches last fixes, gc status (login/username/budget/cacheCount), meetup status (budget/eventCount/lastFetch) in parallel with per-source failure tolerance, then reloads pins and events.
   - src: `src/store/map.ts:255-274`
33. **Fetch caches in current view with budget update**
   - fetchArea POSTs the bbox to /geocaching/fetch-area, updates the daily-budget counter from the response, reloads pins; fetching flag drives a spinner; errors surface in store.error and rethrow.
   - src: `src/store/map.ts:313-328`
34. **Cache pin merge preserves loaded detail**
   - mergePins merges by code and keeps a pin's locally-fetched detail (hint/logs/attributes/waypoints) when the incoming summary lacks it.
   - src: `src/store/map.ts:330-339`
35. **Selecting a cache lazily fetches its detail (once)**
   - selectCache sets selection (clearing any selected Meetup event), and if the pin has no detail yet, GETs /geocaching/cache/:code and merges — hint/attributes/logs fetched only on open.
   - src: `src/store/map.ts:341-352`
36. **j/k adjacent-cache cycling wraps around**
   - selectAdjacentPin cycles through pins that have coordinates, modulo-wrapping at either end.
   - src: `src/store/map.ts:479-486`
37. **Geocaching credentials entry**
   - setCredentials POSTs username/password or browser cookie (CAPTCHA fallback) and updates status immediately.
   - src: `src/store/map.ts:354-361`
38. **Fetch Meetup events in view honoring query/time-window settings**
   - fetchMeetupArea POSTs bbox + optional keyword query + days window (0 = all upcoming) to /meetup/fetch-area, updates the Meetup daily-budget counter, reloads events; fetchingMeetup drives its spinner.
   - src: `src/store/map.ts:373-396`
39. **Meetup keyword and days-window controls**
   - setMeetupQuery / setMeetupDays store the fetch filters (meetupDays 0 = upcoming with no end bound, else next N days).
   - src: `src/store/map.ts:433-434`
40. **Selecting a Meetup event lazily fetches description**
   - selectEvent sets selection (clearing any selected cache), fetches /meetup/event/:id only when detail not already loaded.
   - src: `src/store/map.ts:409-420`
41. **Adjacent Meetup event cycling sorted by date**
   - selectAdjacentEvent cycles events that have coordinates, sorted by dateTime ascending, wrapping around.
   - src: `src/store/map.ts:422-431`
42. **Built-in layer visibility toggles persisted**
   - Location/Geocaches/Meetup layers each have a Layers-panel toggle; state persists in localStorage console:map:builtinVisible, default all visible.
   - src: `src/store/map.ts:132-148,436-442`
43. **Agent layer visibility per-slug and per-group, persisted**
   - toggleLayer flips one slug (undefined = visible), setGroupVisible flips a whole group; persisted in localStorage console:map:layerVisible.
   - src: `src/store/map.ts:112-126,464-477`
44. **Agent layers loaded via HTTP index + per-layer GeoJSON**
   - loadLayers GETs /map/layers then each layer's GeoJSON individually; a failing layer is skipped; offline falls back to Dexie-hydrated layers.
   - src: `src/store/map.ts:447-461`
45. **Offline pins/events survive hub outage**
   - loadPins/loadEvents failures keep the Dexie-hydrated data on screen, only setting an error message.
   - src: `src/store/map.ts:303-311,363-371`

## money (83)

1. **Money sub-tab bar: Cashflow | Net worth | Budgets | Scenarios | Categories | Transactions, each with icon; active tab underlined; horizontally scrollable**
   - Sub-tab persisted via finance store (localStorage console:money:subtab).
   - src: `src/components/MoneyTab.tsx:27-93`
2. **On mount fetch Monzo status; if connected, fetch transactions + all finance data**
   - src: `src/components/MoneyTab.tsx:46-54`
3. **Loading spinner 'Loading…' shown only when loading with zero cached transactions**
   - src: `src/components/MoneyTab.tsx:60-67`
4. **Monzo connect flow step 1 (no credentials): explainer + 'Set Up Monzo' button**
   - src: `src/components/MoneyTab.tsx:125-139`
5. **Monzo credentials form: Client ID + Client Secret inputs (link to developers.monzo.com), Save disabled until both filled, Cancel returns**
   - Save POSTs /auth/monzo/credentials then refetches status.
   - src: `src/components/MoneyTab.tsx:140-163`
6. **Monzo OAuth connect: 'Connect Monzo' opens /auth/monzo/start in a new tab and polls status every 3s until connected, then triggers refreshSync**
   - Copy notes approval needed in the Monzo app (SCA).
   - src: `src/components/MoneyTab.tsx:113-123,164-176`
7. **Pull-to-refresh (mobile) on any Money sub-view triggers Monzo refreshSync + finance fetchAll**
   - MoneyScrollPane shared wrapper across all money sub-views
   - src: `src/components/money/MoneyScrollPane.tsx:10-24`
8. **Budgets summary strip: Total target / Spent so far / Projected end-of-month tiles; projected tile turns red when over target**
   - Sums across all budgets
   - src: `src/components/money/BudgetsView.tsx:20-32,117-124`
9. **Add budget: pick an expense category (system/archived and already-budgeted excluded) + monthly £, Save creates via upsertBudget**
   - Requires category picked and pence>0; Cancel closes form
   - src: `src/components/money/BudgetsView.tsx:36-66`
10. **Per-budget progress bar: spent fill in category color (yellow at ≥100%, red when projected overspends), faded projected fill behind, red overflow segment past 100% capped at +50%**
   - Row shows 'spent / target' and 'proj. X' (red when overspending)
   - src: `src/components/money/BudgetsView.tsx:74-107`
11. **Delete budget via Trash icon with confirm dialog**
   - showConfirm danger 'Delete budget?'
   - src: `src/components/money/BudgetsView.tsx:92-95`
12. **Budgets empty state prompting to add one**
   - Dashed-border box
   - src: `src/components/money/BudgetsView.tsx:68-71`
13. **Cashflow projection horizon selector (6/12/24/36/60 months) persisted to hub finance settings**
   - updateSettings({projectionHorizonMonths})
   - src: `src/components/money/CashflowView.tsx:32-39`
14. **Active-scenario picker on Cashflow (shown only when scenarios exist; 'None' option)**
   - setActiveScenario(id|null)
   - src: `src/components/money/CashflowView.tsx:40-52`
15. **Recurring streams panel: Income and Expenses columns; row shows category emoji (fallback 💰/💸), name, cadence label ('Monthly · day N' / 'Yearly · <Mon>' / 'Weekly'), ± amount (income green); click opens editor**
   - Empty column text 'No income/expenses streams yet.'
   - src: `src/components/money/CashflowView.tsx:69-135`
16. **Stream editor modal: name, kind, £ amount, cadence with conditional day-of-month/month-of-year, start/end dates, category (filtered by kind), account, annual growth %, notes**
   - Save requires name + nonzero amount; click-outside or Cancel dismisses; Trash deletes with confirm
   - src: `src/components/money/CashflowView.tsx:137-227`
17. **'Detected recurring' suggestions panel (max 8) from Monzo clustering with 'Add as stream' and 'Dismiss' per row**
   - Shows occurrences× and last-seen date; Add creates a monthly stream starting today; hidden if a stream with same name (case-insensitive) exists; Dismiss is session-only local state; panel hidden when nothing visible
   - src: `src/components/money/CashflowView.tsx:232-279`
18. **Emergency fund editor: mode select 'Months of burn' vs 'Fixed amount' with numeric input, persisted to settings**
   - Switching mode seeds defaults £5,000 fixed / 3 months
   - src: `src/components/money/CashflowView.tsx:284-318`
19. **Categories/Rules sub-tab bar inside Categories view**
   - Underline-style active tab
   - src: `src/components/money/CategoriesView.tsx:11-29`
20. **Category grid grouped by kind (income/expense/transfer); each chip shows color dot, emoji, name, and 'sys' badge for system categories; click opens editor**
   - 'New category' button top-right
   - src: `src/components/money/CategoriesView.tsx:34-84`
21. **Category editor modal: name, emoji, color picker, kind select, and 'Variable spend' checkbox (trailing-3-mo avg in projections)**
   - Helper text warns to uncheck stream-backed categories to avoid double-counting; delete (with confirm noting rules/budgets removal) hidden for system categories and new
   - src: `src/components/money/CategoriesView.tsx:87-151`
22. **Rules list ordered by priority with human-readable match description when unlabeled**
   - describeMatch renders conditions joined with AND (merchant~/description~/counterparty~/amount sign/monzo cat), '(empty)' fallback; header text explains lower priority runs first, first match wins
   - src: `src/components/money/CategoriesView.tsx:156-213`
23. **Rule editor modal: label, priority (default 50), match fields (merchant/description/counterparty contains, amount sign Either/Income/Expense, monzo category equals), target category, 'Mark as ignored' and 'Treat as transfer' checkboxes**
   - Save disabled until a category picked; delete with confirm
   - src: `src/components/money/CategoriesView.tsx:215-344`
24. **Rule shared-expense fields: your share fraction (0..1, clamped) + counterparty name for netting reimbursements**
   - Helper: '0.5 = 50/50 split…' — feeds shared-tab balances
   - src: `src/components/money/CategoriesView.tsx:304-320,340-341`
25. **Monthly spend stacked area chart of user categories with £-absolute vs %-of-total mode toggle and 6/12/24/36-month window select**
   - Categories with any outflow in window, stacked ordered by total desc; category color/emoji labels in legend+tooltip; percent mode Y domain 0-100; Brush scrubber; empty state 'No spend history yet.'
   - src: `src/components/money/MonthlySpendChart.tsx:16-123`
26. **Trailing 3-mo average panel under the spend chart listing per-category baselines feeding the projection forecast, sorted desc with total/mo**
   - Hidden when no positive entries
   - src: `src/components/money/MonthlySpendChart.tsx:126-149`
27. **Net worth headline tiles: Liquid (blue), Investments (purple), Total (emphasised)**
   - From /finance/networth store state
   - src: `src/components/money/NetWorthView.tsx:29-35,101-111`
28. **Net worth 12-mo stacked area history chart (liquid + investment) with gradient fills and Brush scrubber**
   - Empty state 'No history yet — add balance entries.'
   - src: `src/components/money/NetWorthView.tsx:38-80`
29. **Accounts list grouped Liquid / Investments / Illiquid-external with per-account balance and '(held externally)' tag**
   - Emoji fallback 🟧 for monzo, 💳 otherwise; sections hidden when empty; account name click opens editor
   - src: `src/components/money/NetWorthView.tsx:83-152`
30. **Manual-account ledger expander (chevron) with add-entry form (date defaults today, £ balance, optional note) and per-entry delete**
   - Entries sorted date desc; delete has no confirm; empty state 'No entries yet — add today's balance to start.'; monzo accounts have no expander
   - src: `src/components/money/NetWorthView.tsx:132-208`
31. **Account editor modal: name, type (manual vs monzo auto-sync), liquidity (liquid=runway / investment / illiquid info-only), emoji, 'Held externally' checkbox, per-account annual growth % override, notes**
   - Growth blank = global default; delete with confirm warning balance history loss; currency hardcoded GBP
   - src: `src/components/money/NetWorthView.tsx:211-313`
32. **Projection chart: liquid line (solid blue) + total (dashed purple) with red dashed emergency-fund reference line and grey zero line, Brush scrubber**
   - Empty state 'Add accounts and streams to see the projection.'
   - src: `src/components/money/ProjectionChart.tsx:20-104`
33. **Projection chart overlays every saved scenario's liquid trajectory; active scenario drawn solid width 2, others dashed 1.2**
   - Overlays pre-fetched per scenario via /finance/projection?scenario=; tooltip/legend names prettified 'Scenario: <name>'
   - src: `src/components/money/ProjectionChart.tsx:28-118`
34. **Runway 5-tile metric strip: Liquid, Investments, Monthly net (red/green with arrow icon), Emergency fund (hint shows months-of-burn or fixed), Runway months**
   - Runway '∞' with 'never (positive cashflow)' when floor never breached; <6mo red, <12mo yellow with warning triangle; floor date formatted 'Mon YYYY'; empty state prompts adding an account
   - src: `src/components/money/RunwayCard.tsx:7-53`
35. **Scenarios comparison chart overlaying baseline + every scenario liquid trajectory with emergency reference line**
   - Fixed 7-color palette; empty state 'No projection data yet.'
   - src: `src/components/money/ScenariosView.tsx:97-145`
36. **New scenario button creates 'New scenario' with no deltas and auto-expands its editor**
   - upsertScenario then setOpenId
   - src: `src/components/money/ScenariosView.tsx:52-60`
37. **Scenario accordion row: chevron expand, color dot, name, delta count, and final-month projected liquid '@ <Mon YY> → £X'**
   - Empty state suggests example what-ifs
   - src: `src/components/money/ScenariosView.tsx:66-91`
38. **Scenario editor: name/description inputs auto-save on blur; Clone button duplicates as '<name> (copy)'; Delete with confirm; explicit 'Save scenario' button persists delta edits**
   - Delta edits are local until Save
   - src: `src/components/money/ScenariosView.tsx:154-208`
39. **Scenario delta rows editable inline per kind: one-off (date/£ signed/note), modify stream (amount + start date, blank=unchanged), end stream on date, add stream (name/kind/£/start), category multiplier (0.7=-30%), investment growth %/yr**
   - Each row has a Trash remove button
   - src: `src/components/money/ScenariosView.tsx:211-313`
40. **Delta adder buttons: + One-off / + Modify stream / + End stream / + New stream / + Category multiplier / + Investment growth**
   - Modify/End disabled when no streams exist; defaults today's date, first stream/expense category, 5%/yr growth
   - src: `src/components/money/ScenariosView.tsx:315-352`
41. **Shared tabs panel: per-counterparty net balance badge 'owes you £X' (green) / 'you owe £X' (red) / 'settled'**
   - Empty state explains setting sharedFraction on a rule
   - src: `src/components/money/SharedTabPanel.tsx:11-53`
42. **Shared tab expander shows tiles (their share you covered / their reimbursements / net), activity date range, and collapsible details lists of recent shared expenses (gross + their share) and reimbursements**
   - native <details>/<summary> disclosure elements
   - src: `src/components/money/SharedTabPanel.tsx:55-97`
43. **Transactions view: mobile shows list OR detail (detail replaces list when a tx selected); desktop 3-pane sidebar/list/detail**
   - 52/80-width fixed columns
   - src: `src/components/money/TransactionsView.tsx:34-58`
44. **Sidebar shows Monzo balance headline plus total balance**
   - formatAmountAbs
   - src: `src/components/money/TransactionsView.tsx:75-81`
45. **Pot rows expandable to inline deposit/withdraw: £ input + down-arrow deposit / up-arrow withdraw buttons, input cleared on success**
   - Amount converted to pence rounding
   - src: `src/components/money/TransactionsView.tsx:155-191`
46. **Monzo-category filter list in sidebar with icons; clicking active category again clears filter; 'All' option**
   - Each Monzo category has a dedicated lucide icon
   - src: `src/components/money/TransactionsView.tsx:92-116,21-32`
47. **'This month (your categories)' sidebar breakdown: total spend + per-category percentage bars in category colors sorted desc**
   - Only categories with positive outflow; percent rounded to integer
   - src: `src/components/money/TransactionsView.tsx:118-143`
48. **Sidebar shows spinner 'Syncing…' while Monzo sync in flight**
   - Loader2 animate-spin
   - src: `src/components/money/TransactionsView.tsx:145-150`
49. **Transaction search box with clear-X button; empty states differ ('No matching transactions' vs 'No transactions')**
   - setSearchQuery store action; data-money-search attribute for keybinding focus
   - src: `src/components/money/TransactionsView.tsx:205-231`
50. **Transactions grouped by date with sticky headers 'Today'/'Yesterday'/'Wed 3 Jun'**
   - groupByDate on created date; en-GB weekday short format
   - src: `src/components/money/TransactionsView.tsx:232-244,518-536`
51. **Transaction row: merchant emoji (fallback user-category emoji in its color, then Monzo-category icon), name, reference or category name subtitle, Pending/Declined labels, ±amount (income green)**
   - Declined, ignored, or transfer-classified rows render at 50% opacity; selected row highlighted
   - src: `src/components/money/TransactionsView.tsx:250-278`
52. **Transaction detail header: merchant logo (hidden on img error) or emoji, name, reference, large signed amount**
   - 'Select a transaction' placeholder when none selected
   - src: `src/components/money/TransactionsView.tsx:296-351`
53. **Detail time block: created date+time and status — Pending (yellow) / 'Declined — <reason>' (red) / 'Settled <date>'**
   - en-GB locale formats
   - src: `src/components/money/TransactionsView.tsx:354-363`
54. **Category picker in detail: click category label to open grid of all non-archived categories; also 'Ignore (don't count toward spend)' and 'Clear override' options**
   - setOverride({txId,categoryId,ignore:false}) / setOverride({ignore:true}) / clearOverride; '(ignored)'/'(transfer)' badge shown; scheme label (Card/Faster payment/Direct debit/Monzo) and subscription recurring icon alongside
   - src: `src/components/money/TransactionsView.tsx:365-399`
55. **Detail conditional blocks: merchant address (non-approximate only), counterparty with formatted sort-code XX-XX-XX · account number, foreign local-currency amount, Monzo shared-tab participants+item count, ATM fee allowance explainer, merchant website link (protocol stripped for display, opens new tab)**
   - Each block hidden when data absent
   - src: `src/components/money/TransactionsView.tsx:401-470`
56. **Inline transaction note editing: click note (or 'Add a note…') to edit; Enter saves via Monzo annotate API, Escape cancels; Save button too**
   - Input auto-focused after 50ms
   - src: `src/components/money/TransactionsView.tsx:323-331,443-460`
57. **'Make a rule from this transaction' one-click rule creation**
   - Match preference merchant name → counterparty name → description; category = current effective (fallback cat_uncat); priority 50, label 'From: <name>'; POSTs /finance/rules then re-fetches finance state
   - src: `src/components/money/TransactionsView.tsx:472-491`
58. **Raw-data toggle shows the full transaction JSON pretty-printed in a scrollable pre (max-h-96)**
   - 'Raw data' / 'Hide raw data' toggle
   - src: `src/components/money/TransactionsView.tsx:494-504`
59. **Money keys: j/k next/prev transaction, '/' focus search, 'c' cycles category filter**
   - 'c' walks the spendingByCategory keys in order: none→first→next→…→last→none (clears).
   - src: `src/hooks/useKeybindings.ts:305-350`
60. **Money sub-tab persisted to localStorage, default Cashflow**
   - activeSubTab (cashflow|networth|transactions|budgets|scenarios|categories) loads/saves via localStorage key console:money:subtab; falls back to 'cashflow'.
   - src: `src/store/finance.ts:305-320`
61. **Currency formatting rule — pennies to £**
   - fmtPence: values ≥£1000 render with no decimals + thousands separators (en-GB), smaller values with 2 decimals; optional + sign for positives and abs mode.
   - src: `src/store/finance.ts:213-221`
62. **Month label format 'Mon YY'**
   - fmtMonth renders 'YYYY-MM' as en-GB short month + 2-digit year (e.g. 'Jul 26').
   - src: `src/store/finance.ts:223-226`
63. **Active scenario selection recomputes projection**
   - setActiveScenario stores the scenario id and immediately re-fetches the projection with &scenario=<id> so the Cashflow charts switch to the what-if trajectory.
   - src: `src/store/finance.ts:343-347`
64. **Finance recompute fetches 8 computed datasets in parallel**
   - recompute pulls classifications (limit 2000), monthly spend, 3-month variable forecast, current net worth, projection (horizon from settings, default 24 months) with runway + emergency floor, budget status, recurring candidates, shared-tab balances; 12-month net-worth history fetched separately without blocking first paint.
   - src: `src/store/finance.ts:379-405`
65. **Category CRUD**
   - upsertCategory POST/PATCHes then full refetch; deleteCategory DELETEs then refetch.
   - src: `src/store/finance.ts:407-418`
66. **Auto-categorisation rule CRUD**
   - upsertRule/deleteRule mirror category CRUD; rules support match conditions, ignore, asTransfer, sharedFraction (e.g. 0.5 = 50/50 split), sharedWithCounterparty.
   - src: `src/store/finance.ts:420-431`
67. **Account CRUD + manual balance ledger entries**
   - upsertAccount/deleteAccount; addBalanceEntry POSTs {date, balancePence, note} to an account's ledger, deleteBalanceEntry removes one — the manual-account net-worth data entry path.
   - src: `src/store/finance.ts:433-458`
68. **Recurring stream CRUD**
   - upsertStream/deleteStream manage income/expense streams (cadence monthly|yearly|weekly, dayOfMonth, growthPctYoy, start/end dates).
   - src: `src/store/finance.ts:460-471`
69. **Budget CRUD**
   - upsertBudget POSTs per-category monthly targets; deleteBudget removes.
   - src: `src/store/finance.ts:473-482`
70. **Scenario CRUD; deleting the active scenario resets to baseline**
   - upsertScenario POST/PATCH; deleteScenario clears activeScenarioId if it was the deleted one before refetching.
   - src: `src/store/finance.ts:484-496`
71. **Per-transaction category override / ignore / transfer marking**
   - setOverride POSTs a TxOverride then recomputes and merges into local list; clearOverride DELETEs and removes locally; bulkSetOverrides POSTs an array then full refetch.
   - src: `src/store/finance.ts:498-519`
72. **Finance settings edit triggers recompute**
   - updateSettings PATCHes emergency fund (fixed amount or months mode), projectionHorizonMonths, investmentGrowthPct etc., then recomputes projections.
   - src: `src/store/finance.ts:521-528`
73. **Transactions fetched with server-side search + category filter**
   - fetchTransactions passes searchQuery and categoryFilter as query params (default limit 500); setSearchQuery/setCategoryFilter each immediately refetch.
   - src: `src/store/money.ts:278-292,355-363`
74. **Transaction amount formatting with sign**
   - formatAmount renders pennies as ±£X.XX (+ for credits, - for debits, none for zero); formatAmountAbs drops the sign.
   - src: `src/store/money.ts:145-154`
75. **Transaction display name prefers merchant then counterparty then description**
   - getDisplayName: merchant object name > counterparty.name > raw description; getReference shows the description as reference only for bank transfers; merchant emoji shown when available.
   - src: `src/store/money.ts:157-179`
76. **Monzo connection status display**
   - fetchStatus GETs /money/status (connected, hasCredentials, lastSync, transactionCount, fullSyncComplete); failure renders a disconnected default.
   - src: `src/store/money.ts:237-244`
77. **Money pane initial load**
   - fetchAll loads balance + pots in parallel, then 500 transactions, then per-category spending; loading flag drives the spinner.
   - src: `src/store/money.ts:246-267`
78. **Manual Monzo re-sync button**
   - refreshSync POSTs /money/sync then refetches all data + status; syncing flag shows progress.
   - src: `src/store/money.ts:313-325`
79. **Next/previous transaction keyboard navigation**
   - selectNext/PrevTransaction move within the filtered list; with no selection both pick the first transaction; no wrap.
   - src: `src/store/money.ts:329-353`
80. **Annotate transaction (metadata notes)**
   - annotateTransaction PATCHes a single metadata key/value on the transaction and swaps in the updated row.
   - src: `src/store/money.ts:365-378`
81. **Pot deposit and withdraw**
   - depositToPot/withdrawFromPot POST the amount then refresh balance + pots so the numbers update immediately.
   - src: `src/store/money.ts:380-405`
82. **Real-time webhook transactions appear at top of list**
   - handleWebhookTransaction upserts an incoming Monzo webhook transaction — replacing an existing row by id or prepending it.
   - src: `src/store/money.ts:407-417`
83. **Monthly spending by category (optionally for a chosen month)**
   - fetchSpending GETs /money/spending with optional ?month=YYYY-MM for the category breakdown view.
   - src: `src/store/money.ts:303-311`

## music (39)

1. **Music drawer closes on Escape key (capture-phase listener wins over other handlers)**
   - keydown Escape → stopPropagation + onClose; also X button in header with tooltip 'Close (Esc)'
   - src: `src/components/music/MusicDrawer.tsx:30-39`
2. **Drawer mounts live music subscription only while open — hub Spotify poller runs only while drawer visible**
   - subscribeMusicLive() on mount, unsubscribe on unmount
   - src: `src/components/music/MusicDrawer.tsx:27`
3. **Progress bar interpolates smoothly between hub snapshots via 1s ticker while playing**
   - elapsed = snapshot.progressMs + (Date.now() - fetchedAt) when isPlaying; clamped to track duration; times formatted m:ss with zero-padded seconds
   - src: `src/components/music/MusicDrawer.tsx:42-57`
4. **Search input auto-focuses when drawer opens**
   - src: `src/components/music/MusicDrawer.tsx:48`
5. **Playlists load once on drawer open; liked-state re-checked whenever the current track id changes**
   - src: `src/components/music/MusicDrawer.tsx:51-52`
6. **Not-linked empty state: music icon + 'Spotify isn't linked yet' + 'Connect Spotify' button opening hub OAuth /auth/spotify/start in a new tab**
   - src: `src/components/music/MusicDrawer.tsx:82-94`
7. **Amber warning banner when zero playback devices: instructs to open Spotify, pick amarhp-spotifyd in Connect menu, press play**
   - src: `src/components/music/MusicDrawer.tsx:97-101`
8. **Now-playing card: 176px square album art (music-note placeholder if none), truncated track name (title tooltip = full name) and artists line**
   - 'Nothing playing' shown when no item
   - src: `src/components/music/MusicDrawer.tsx:103-121`
9. **Heart button toggles Liked Songs for current track; filled+accent when liked, disabled when nothing playing**
   - tooltip flips between 'Save to Liked Songs' / 'Remove from Liked Songs'
   - src: `src/components/music/MusicDrawer.tsx:122-129`
10. **Click anywhere on the progress bar seeks to that fraction of the track**
   - clientX fraction of bar width × durationMs → store.seek
   - src: `src/components/music/MusicDrawer.tsx:59-64,135`
11. **Shuffle button toggles shuffle; accent-colored when on; disabled with 'Shuffle not supported by this device' tooltip when snapshot disallows toggling_shuffle**
   - driven by Spotify actions.disallows, adapts per device
   - src: `src/components/music/MusicDrawer.tsx:146-153`
12. **Previous / Next track buttons**
   - src: `src/components/music/MusicDrawer.tsx:154,164`
13. **Large round play/pause toggle button; icon flips between Play and Pause based on isPlaying**
   - src: `src/components/music/MusicDrawer.tsx:157-163`
14. **Repeat button cycles repeat mode; Repeat1 icon when mode=track, accent when not 'off'; disabled with tooltip when device disallows both repeat toggles; tooltip shows current mode**
   - src: `src/components/music/MusicDrawer.tsx:167-174`
15. **Volume slider 0-100 sets device volume, reflects device.volumePercent**
   - src: `src/components/music/MusicDrawer.tsx:180-187`
16. **Device row shows active device name (or 'No active device'); '→ spotifyd' transfer button appears only when playing on a different device than spotifyd**
   - clicking transfers playback to spotifydDeviceId
   - src: `src/components/music/MusicDrawer.tsx:190-203`
17. **Search-as-you-type track search ('Search & play…'); each result row: album art thumb (or placeholder), name+artists truncated; clicking plays the track URI**
   - src: `src/components/music/MusicDrawer.tsx:206-239`
18. **Hover-revealed 'Add to queue' button (ListPlus) on each search result row**
   - opacity-0 until row hover
   - src: `src/components/music/MusicDrawer.tsx:240-246`
19. **Library section: 'Liked Songs' row (heart gradient tile) plays the liked-songs collection**
   - src: `src/components/music/MusicDrawer.tsx:257-266`
20. **Playlist rows (cover image or placeholder, name, 'N tracks'); click plays the playlist**
   - 'Playlists' subheading only rendered when ≥1 playlist
   - src: `src/components/music/MusicDrawer.tsx:272-290`
21. **Hover-revealed '+' button per playlist adds the CURRENT track to that playlist; disabled when nothing playing**
   - src: `src/components/music/MusicDrawer.tsx:291-298`
22. **Now-playing updates live only while the music drawer is open**
   - subscribeMusicLive wires spotify 'delta' + refresh-on-connect and does an immediate HTTP refresh; subscription existence is what makes the hub poll Spotify at all — closing the drawer stops polling
   - src: `src/music/live.ts:22-38`
23. **Music drawer open/close toggle**
   - setOpen/toggleOpen flip the global right-side drawer state; Esc closes (handled in Layout).
   - src: `src/store/music.ts:140`
24. **Spotify control errors surface as toasts, never silent**
   - Any failed control POST maps to a friendly error toast: 'No playback device' (device not found/no_active_device, with instruction to pick amarhp-spotifyd), 'Not supported by this device' (403/restriction), 'Spotify not linked' (401/not linked, tells user to reconnect from drawer); otherwise generic 'Spotify control failed'. After any failure the store re-fetches /spotify/player so optimistic UI stops lying.
   - src: `src/store/music.ts:97`
25. **Play/pause toggle with optimistic icon flip**
   - togglePlay immediately flips isPlaying in the snapshot (and fetchedAt) before POST /spotify/toggle.
   - src: `src/store/music.ts:200`
26. **Next/previous track buttons**
   - POST /spotify/next and /spotify/previous, no optimistic change.
   - src: `src/store/music.ts:207`
27. **Seek with optimistic progress update**
   - seek(positionMs) optimistically sets progressMs+fetchedAt then POST /spotify/seek with rounded ms.
   - src: `src/store/music.ts:210`
28. **Volume set clamped 0–100 with optimistic device volume**
   - setVolume rounds and clamps percent to [0,100], optimistically updates device.volumePercent, POST /spotify/volume.
   - src: `src/store/music.ts:216`
29. **Shuffle toggle, optimistic**
   - Flips shuffle in snapshot immediately then POST /spotify/shuffle {state}.
   - src: `src/store/music.ts:223`
30. **Repeat mode cycles off → context → track → off**
   - cycleRepeat computes next mode from current (default 'off'), optimistic snapshot update, POST /spotify/repeat.
   - src: `src/store/music.ts:230`
31. **Play a track or context by URI**
   - playUri: URIs containing ':track:' send {uris:[uri]}, anything else (playlist/album/artist) sends {contextUri}.
   - src: `src/store/music.ts:238`
32. **Queue a track**
   - queueUri POSTs /spotify/queue {uri}.
   - src: `src/store/music.ts:243`
33. **Transfer playback to another device and auto-play**
   - transfer(deviceId) POSTs /spotify/transfer with play:true, so playback resumes on the target device immediately.
   - src: `src/store/music.ts:245`
34. **Track search with stale-response guard**
   - search sets searching spinner, empty/whitespace query clears results instantly; otherwise GET /spotify/search limit=12 and results applied only if the query hasn't changed while in flight; clearSearch resets query+results.
   - src: `src/store/music.ts:247`
35. **Play Liked Songs**
   - playLiked fetches first 50 saved tracks and plays them as an explicit uris list; no-op when empty.
   - src: `src/store/music.ts:153`
36. **Like/unlike current track with heart state**
   - checkLiked queries /spotify/saved?ids=<current track id> (heart off when no track); toggleLike optimistically flips currentLiked then POSTs /spotify/save or /spotify/unsave.
   - src: `src/store/music.ts:163`
37. **Add current track to a playlist**
   - addCurrentToPlaylist POSTs the now-playing item's uri to /spotify/playlist/<id>/add; no-op if nothing playing.
   - src: `src/store/music.ts:185`
38. **Playlist list load resilient to failure**
   - loadPlaylists GET /spotify/playlists; on error keeps previous list (no blanking).
   - src: `src/store/music.ts:144`
39. **Now-playing refresh keeps last snapshot on error**
   - refresh GET /spotify/player; failures leave the previous snapshot displayed rather than clearing the drawer.
   - src: `src/store/music.ts:191`

## notes (195)

1. **New Note modal: title input (autofocused) + directory input with fuzzy autocomplete of existing dirs sorted by recency; live path preview '<dir>/<slug>.md'**
   - Title slugified; empty dir → root. 'scratch' suggestion labelled 'default'.
   - src: `src/components/NewNoteModal.tsx:26-135,110-116`
2. **New Note keyboard flow: Enter on title jumps to dir field and opens suggestions; in dir field Enter accepts highlighted suggestion or creates the file; Tab accepts suggestion; ↑/↓ or Ctrl+p/Ctrl+n move selection; Esc closes suggestions first, then modal; backdrop click closes**
   - Created file seeded with '# <title>\n\n'; selection auto-scrolls into view; blur hides suggestions after 150ms so clicks land.
   - src: `src/components/NewNoteModal.tsx:56-108,119-121`
3. **Notes command palette (Ctrl+Shift+P): fuzzy-filterable command list with ↑↓/Ctrl+n/Ctrl+p navigation, Enter run, Esc close (or back from a prompt sub-input), click to run, backdrop click closes**
   - Footer shows contextual key hints; selection auto-scrolls; empty state 'No commands found'.
   - src: `src/components/NotesCommandPalette.tsx:294-320,322-399`
4. **Palette command: Rename File — prompt pre-filled with current name (sans .md), renames within the same directory**
   - src: `src/components/NotesCommandPalette.tsx:48-57,274-277`
5. **Palette command: Delete File — confirm dialog then deleteFile**
   - src: `src/components/NotesCommandPalette.tsx:58-69`
6. **Palette commands: Save File, Close File, New File (opens New Note modal)**
   - Active-file commands only shown when a file is open.
   - src: `src/components/NotesCommandPalette.tsx:71-99`
7. **Palette command: New Blog Draft — prompts for title; inherits project when active file is a project page (label shows 'project: <slug>'); error alert on failure**
   - src: `src/components/NotesCommandPalette.tsx:102-111,278-283`
8. **Palette command: New Project — prompts for title, creates blog project**
   - src: `src/components/NotesCommandPalette.tsx:113-119,284-288`
9. **Palette: 'Jump to agent: <name>' entries for each live agent session whose cwd matches the enclosing project directory — selects the session and switches to the Agents pane**
   - Matches cwd equal/endsWith/contains '/projects/<slug>'; ended sessions excluded.
   - src: `src/components/NotesCommandPalette.tsx:132-149`
10. **Palette: 'Start Agent in <Project>' — prompts for first message, spawns a Claude session cwd'd at <vault>/projects/<slug> named after the project, switches to Agents pane**
   - Untracked project dirs get a humanised slug title; alerts if vault path not loaded yet.
   - src: `src/components/NotesCommandPalette.tsx:150-171`
11. **Palette command: Publish Draft (only for files under scratch/blog-drafts/) — saves, toasts 'Publishing…', publishes, closes tab, rescans vault + refreshes drafts/recent/projects; success toast links to the permalink, distinct error toasts for publish-failed vs moved-but-rebuild-failed**
   - src: `src/components/NotesCommandPalette.tsx:174-211`
12. **Palette command: Reopen Closed Tab (only when a recently-closed path exists)**
   - src: `src/components/NotesCommandPalette.tsx:213-223`
13. **Palette command: Close All Files (only when >1 file open)**
   - src: `src/components/NotesCommandPalette.tsx:225-238`
14. **Notes editor empty state: 'No file open' with mobile ('Tap a file to open') vs desktop ('Select a file from the tree or press Ctrl+P') hint**
   - src: `src/components/NotesEditor.tsx:73-84`
15. **Editor tab bar: click switches file, middle-click closes a clean (non-dirty) tab, X button closes with unsaved-changes confirm, dirty files show an accent dot, names truncated at 8rem sans .md**
   - src: `src/components/NotesEditor.tsx:201-227,86-93`
16. **Mobile back chevron in tab bar clears activeFilePath (returns to file list)**
   - src: `src/components/NotesEditor.tsx:193-199`
17. **Pen pages (scratch/pen/**.svg) render via PenPageRenderer (handwriting SVG + live stroke overlay) instead of the text editor**
   - src: `src/components/NotesEditor.tsx:235-237`
18. **'Writing files' (drafts under scratch/blog-drafts/ or published under log/) get focused-writing chrome: WriteMetaBar (title/tags/project), WriteActionBar (photo/mic/format/publish), gutterless editor**
   - src: `src/components/NotesEditor.tsx:70,231,242,250-253`
19. **Publish flow from status bar: confirms (offering 'Save & publish' if dirty), toasts 'Publishing…', on success closes draft, rescans vault, opens the published post, refreshes drafts/recent/projects, then background-verifies via ETag polling — live-status chip set to 'building' and final toast 'Post is live' (link) or 'Build still not live after 3min'**
   - 'publish' button only on draft paths; mtime re-check afterwards can land the chip on 'stale' if more edits were saved mid-build.
   - src: `src/components/NotesEditor.tsx:95-149`
20. **Re-publish for published posts: saves dirty edits, captures page ETag baseline BEFORE triggering rebuild, toasts 'Re-publish queued…', polls until page changes; success 'Edit is live' / timeout error after 3min**
   - src: `src/components/NotesEditor.tsx:155-182,274-283`
21. **'live' external-link button on published posts opens the permalink (yousefamar.com/memo/log/…) in a new tab; LiveStatusChip shows build/live/stale state**
   - src: `src/components/NotesEditor.tsx:271-295`
22. **Project panel: for files under projects/<slug>/ a ProjectPill in the status bar toggles a side ProjectPanel (desktop only); open state persists to localStorage 'console:notes:projectPanelOpen', first-run default open on desktop / closed on mobile**
   - src: `src/components/NotesEditor.tsx:32-43,245-247,296-298`
23. **Status bar shows full active file path (truncated), 'modified' accent label when dirty, and 'vim' indicator**
   - src: `src/components/NotesEditor.tsx:256-312`
24. **Mobile vim mode: off by default, auto-enables on hardware-keyboard heuristic (real Escape or Ctrl/Cmd chord, excluding keyCode 229/'Unidentified') with a toast; manual toggle via tappable 'vim'/'vim off' chip in the status bar; persists to localStorage 'console:notes:mobileVim'**
   - Mobile editor also drops gutters.
   - src: `src/components/NotesEditor.tsx:50-63,302-309`
25. **Vim ex command :w saves the active file**
   - Vim.defineEx('w') → useNotesStore.saveFile()
   - src: `src/components/NotesEditorCore.tsx:176`
26. **Vim ex command :q closes the active tab, refusing if unsaved**
   - closeFile(path,false); if refused, console.warn 'File has unsaved changes. Use :q! to force close.'
   - src: `src/components/NotesEditorCore.tsx:179`
27. **Vim ex command :q! force-closes the active tab discarding changes**
   - closeFile(path,true)
   - src: `src/components/NotesEditorCore.tsx:188`
28. **Vim ex command :wq saves then closes the active tab**
   - await saveFile() then closeFile(path,true)
   - src: `src/components/NotesEditorCore.tsx:192`
29. **Ctrl/Cmd+J and Ctrl/Cmd+K scroll editor half a page down/up**
   - Moves cursor by half the visible line count, clamped to doc bounds (no wrap), scrollIntoView; intercepted at highest precedence before vim
   - src: `src/components/NotesEditorCore.tsx:211`
30. **Ctrl/Cmd+B toggles bold (**) around selection**
   - wrapSelection: unwraps if selection already wrapped or markers just outside selection; with empty selection inserts ** ** with cursor between
   - src: `src/components/NotesEditorCore.tsx:225`
31. **Ctrl/Cmd+I toggles italic (*) around selection**
   - Same wrap/unwrap/empty-cursor semantics as bold
   - src: `src/components/NotesEditorCore.tsx:231`
32. **Ctrl/Cmd+Shift+X toggles strikethrough (~~) around selection**
   - Same wrap/unwrap semantics
   - src: `src/components/NotesEditorCore.tsx:237`
33. **Ctrl/Cmd+` toggles inline code (`) around selection**
   - Same wrap/unwrap semantics
   - src: `src/components/NotesEditorCore.tsx:243`
34. **Ctrl/Cmd+Shift+K opens link picker for the current selection**
   - openLinkPicker with mode 'both' (wiki + URL tabs), pre-fills display text from selection
   - src: `src/components/NotesEditorCore.tsx:249`
35. **Ctrl/Cmd+Shift+6 (or ^) inserts a markdown footnote**
   - insertFootnote(editorView); matches key '6', '^', or code Digit6 for non-QWERTY layouts
   - src: `src/components/NotesEditorCore.tsx:263`
36. **Vim mode enabled by default; toggleable via editor options**
   - options.vim ?? true; vimEnabled also flips content attributes: vim → autocorrect/autocapitalize off; plain mode → autocorrect on, autocapitalize 'sentences'. Spellcheck always on (red squiggles + right-click suggestions)
   - src: `src/components/NotesEditorCore.tsx:169`
37. **Line numbers + fold gutter toggleable via editor options**
   - options.gutters ?? true; controls lineNumbers() and foldGutter() extensions
   - src: `src/components/NotesEditorCore.tsx:170`
38. **Active-line highlight suppressed while a selection exists**
   - Custom ViewPlugin adds .cm-activeLine decoration only when selection is empty, so visual-mode/mouse selections show clearly
   - src: `src/components/NotesEditorCore.tsx:28`
39. **YAML frontmatter tag autocompletion**
   - Triggers on '- <prefix>' list lines inside frontmatter whose nearest preceding key is 'tags:'; suggestions from useBlogStore.tags (hub scan of log/*.md, most-used first), max 30 options, case-insensitive substring filter
   - src: `src/components/NotesEditorCore.tsx:112`
40. **Typing [[ in insert mode opens the wiki link picker**
   - inputHandler detects second '[' after existing '['; opens picker at that position in mode 'wiki'; cancelling removes the [[ if still present
   - src: `src/components/NotesEditorCore.tsx:292`
41. **Tab/Shift-Tab indent/dedent; Mod-s saves; default+history+search keymaps active**
   - keymap: Tab=indentMore, Shift-Tab=indentLess, Mod-s=saveFile; CM search keymap included
   - src: `src/components/NotesEditorCore.tsx:306`
42. **Editor edits sync to store per animation frame (rAF-coalesced)**
   - docChanged → updateFileContent batched once per requestAnimationFrame; no auto-save (explicit save only)
   - src: `src/components/NotesEditorCore.tsx:320`
43. **Editor doc/selection changes mirror to G1 glasses**
   - pushFromEditor on docChanged or selectionSet; no-op when mirror toggle off; initial window pushed on editor mount if mirror already enabled
   - src: `src/components/NotesEditorCore.tsx:338`
44. **Pasting an image into the editor saves it and inserts an embed**
   - Clipboard image → filename pasted-<ISO-timestamp>.<ext>; pasteImage saves to sibling assets dir → inserts ![[name]] wiki-embed, or vault path (offline fallback) → ![](path) markdown embed; cursor placed after
   - src: `src/components/NotesEditorCore.tsx:344`
45. **Pasting a bare URL over a selection wraps it as a markdown link**
   - If clipboard is a single http(s) URL with no whitespace and selection non-empty → [selected](url), cursor after link; applies to DOM Ctrl+V in any editor mode
   - src: `src/components/NotesEditorCore.tsx:382`
46. **Vim y/d/p use the system clipboard by default**
   - y/Y/d/D/p/P noremapped to "+ register in normal (and y/d in visual) — clipboard=unnamedplus equivalent
   - src: `src/components/NotesEditorCore.tsx:404`
47. **Visual-mode p/P linkifies when the clipboard holds a bare URL**
   - Custom vim action: reads navigator.clipboard (fallback to vim '+' register); bare URL → [selection](url); otherwise ordinary characterwise visual-paste; exits visual mode after
   - src: `src/components/NotesEditorCore.tsx:419`
48. **Vim j/k move by display (wrapped) lines**
   - noremapped to gj/gk; plus a moveByDisplayLines override fixing an upstream bug where j past the last line snapped the cursor to offset 0 (clamped via findPosV, preserves goal column)
   - src: `src/components/NotesEditorCore.tsx:447`
49. **Vim ex command :link opens the link picker for current selection**
   - mode 'both'
   - src: `src/components/NotesEditorCore.tsx:472`
50. **Vim ex command :publish publishes the active draft to the blog**
   - Saves first, shows 'Publishing…' toast, blog.publish(path); on success closes the (moved) draft tab, refreshes tree/drafts/projects and shows success toast linking to the live permalink; rebuild failure → error toast with first 200 chars of rebuild body; no file open → error toast
   - src: `src/components/NotesEditorCore.tsx:483`
51. **Editor view creation deferred one animation frame**
   - Prevents vim BlockCursorPlugin coordsAt errors from measuring pre-layout; editor recreated when filePath or vim/gutter options change
   - src: `src/components/NotesEditorCore.tsx:524`
52. **File-browser header 'Find file...' button opens the quick switcher**
   - Full-width text button in tree header
   - src: `src/components/NotesFileBrowser.tsx:88`
53. **NotebookPen icon switches sidebar to blog view**
   - setViewMode('blog'); tooltip 'Switch to blog view'
   - src: `src/components/NotesFileBrowser.tsx:95`
54. **Circle icon switches sidebar to circles view**
   - setViewMode('circles')
   - src: `src/components/NotesFileBrowser.tsx:102`
55. **RefreshCw icon rescans the vault file tree**
   - loadVaultFiles()
   - src: `src/components/NotesFileBrowser.tsx:109`
56. **Search icon opens quick switcher in content-search mode**
   - openQuickSwitcher('content'); tooltip mentions Ctrl+Shift+F
   - src: `src/components/NotesFileBrowser.tsx:116`
57. **Plus icon opens the new-note form**
   - openNewFileForm(); tooltip mentions Ctrl+N
   - src: `src/components/NotesFileBrowser.tsx:123`
58. **Active file auto-expands ancestor folders and scrolls into view**
   - On activeFilePath change: toggles open every ancestor dir then scrollIntoView({block:'nearest'}) after rAF
   - src: `src/components/NotesFileBrowser.tsx:30`
59. **Tree shows 'Scanning vault...' while loading and 'No files found' when empty**
   - Loading/empty states in tree body
   - src: `src/components/NotesFileBrowser.tsx:133`
60. **Right-click a file shows Rename / Delete context menu**
   - Fixed-position menu at cursor; Delete is red; closes on any window click
   - src: `src/components/NotesFileBrowser.tsx:160`
61. **Right-click a folder shows 'New Note' context menu item**
   - Opens new-note form pre-scoped to that folder path
   - src: `src/components/NotesFileBrowser.tsx:165`
62. **Delete file requires confirm dialog**
   - showConfirm('Delete "<name>"?') with danger styling, .md extension stripped from label; then deleteFile(path)
   - src: `src/components/NotesFileBrowser.tsx:54`
63. **Inline rename of a file in the tree**
   - Rename swaps the row for an autofocused input pre-filled without .md; Enter or blur commits (renameFile to <dir>/<value>.md, no-op if unchanged/empty), Escape cancels
   - src: `src/components/NotesFileBrowser.tsx:61`
64. **Click folder row toggles expand/collapse with rotating chevron**
   - ChevronRight rotates 90° when expanded; mousedown also sets selectedPath (highlight); indent 8+depth*14 px
   - src: `src/components/NotesFileBrowser.tsx:235`
65. **Click file row opens it in the editor**
   - openFile(path); active file gets bg-surface-2 highlight, selected (mousedown) gets bg-surface-1; names shown without .md, truncated
   - src: `src/components/NotesFileBrowser.tsx:303`
66. **Link picker: Wiki Link / URL mode tabs (Tab key or click toggles)**
   - Only when context mode is 'both' (Ctrl+Shift+K / :link); [[-triggered picker is wiki-only. Tab resets selection to 0; focus moves to the relevant input
   - src: `src/components/NotesLinkPicker.tsx:132`
67. **Link picker wiki mode: empty query shows 30 most-recently-modified files**
   - files sorted by mtime desc, sliced to 30; non-empty query → searchFilenames fuzzy results
   - src: `src/components/NotesLinkPicker.tsx:40`
68. **Link picker wiki navigation: ArrowUp/Down or Ctrl+N/P, Enter inserts, Esc cancels**
   - Selection clamped to result count; selected row auto-scrolls into view; footer shows keyboard hints
   - src: `src/components/NotesLinkPicker.tsx:136`
69. **Wiki link insertion uses selected text as alias**
   - With selection → [[Target|selected text]]; without → [[Target]]; .md stripped from target; cursor after insert, editor refocused
   - src: `src/components/NotesLinkPicker.tsx:72`
70. **URL link insertion with optional display text**
   - Two inputs (URL 'https://...' + 'Display text (optional)', pre-filled from selection); Enter inserts [text](url), text falls back to the URL; requires non-empty URL
   - src: `src/components/NotesLinkPicker.tsx:90`
71. **Cancelling a [[-triggered picker removes the typed [[**
   - On Esc/backdrop-click, if mode was 'wiki' with no selection and '[[' is still at the trigger position, it is deleted; editor refocused either way
   - src: `src/components/NotesLinkPicker.tsx:106`
72. **Link picker wiki results show file name and parent dir; 'No files found' empty state**
   - Rows clickable to insert; list capped at max-h-72 with scroll
   - src: `src/components/NotesLinkPicker.tsx:204`
73. **Quick switcher: Files / Content mode tabs, Tab key toggles**
   - Opens in mode from store (openQuickSwitcher('content') for search-in-files); toggling clears snippets and refocuses input; placeholder switches 'Find file...' / 'Search in files...'
   - src: `src/components/NotesQuickSwitcher.tsx:127`
74. **Quick switcher filename mode: empty query lists 30 most-recent files by mtime**
   - Typed query → searchFilenames (fzf-style fuzzy); rows show name without .md + dir subtitle
   - src: `src/components/NotesQuickSwitcher.tsx:28`
75. **Quick switcher content mode: full-text search with 2-line highlighted snippets**
   - searchContent(query); snippets loaded async for top 20 results by reading each file, showing the first matching line ±1 line of context (200-char cap, monospace, line-clamp-2); query terms highlighted with accent background; falls back to first 3 lines if no line matches; empty query shows 'Type to search across all files'
   - src: `src/components/NotesQuickSwitcher.tsx:46`
76. **Quick switcher keyboard: ArrowUp/Down or Ctrl+N/P navigate, Enter opens, Esc closes**
   - Selected row scrolls into view; backdrop click also closes; Enter opens the file and closes the switcher
   - src: `src/components/NotesQuickSwitcher.tsx:113`
77. **Notes pane shows vault-connect empty state with 'Open Vault' button**
   - When not connected: FolderOpen icon + prompt to select the Obsidian vault directory; connectVault() launches FSA/hub connect. 'Loading vault...' shown while loading before connection
   - src: `src/components/NotesTab.tsx:77`
78. **Vault auto-reconnects on mount (persisted handle or hub)**
   - reconnectVault() on first mount; also refreshes blog tags and projects (needed for the project pill), and retries failed live-preview images on every hub reconnect
   - src: `src/components/NotesTab.tsx:30`
79. **Switching to the Notes pane rescans the vault and auto-opens the pen's live page**
   - On pane transition to 'notes': loadVaultFiles() if connected; if penActivePagePath exists and last pen stroke <60s ago, that pen page file auto-opens; clears the pen red-dot marker
   - src: `src/components/NotesTab.tsx:54`
80. **Sidebar swaps between tree / circles / blog views with different widths**
   - viewMode: tree → NotesFileBrowser (w-56), circles → CirclesView (40% width, 320–640px), blog → BlogView (w-64); mobile shows editor OR sidebar, never both (editor when a file is active)
   - src: `src/components/NotesTab.tsx:95`
81. **Quick switcher / link picker / command palette / new-note modal render as overlays**
   - Each mounts conditionally on its store open flag, on both mobile and desktop layouts
   - src: `src/components/NotesTab.tsx:120`
82. **Blog view auto-refreshes drafts, projects, and recent posts on mount**
   - src: `src/components/notes/BlogView.tsx:24-29`
83. **Blog view Refresh button re-fetches drafts+projects+recent in parallel; icon spins while refreshing**
   - src: `src/components/notes/BlogView.tsx:31-36,74-80`
84. **Blog view header buttons to switch Notes view mode to circles or tree**
   - src: `src/components/notes/BlogView.tsx:81-94`
85. **Prominent 'New post' button: prompts for title via project dialog, creates draft; error alert on failure; empty/whitespace title cancels**
   - src: `src/components/notes/BlogView.tsx:38-50,100-106`
86. **Drafts list with age-coloured timestamps: red >30 days, yellow >7 days, else tertiary; age formatted 'just now'/'Nh ago'/'Nd ago'/'Nmo ago'/'N.Ny ago'**
   - click a draft opens it in the editor; empty state 'No drafts. Write something.'
   - src: `src/components/notes/BlogView.tsx:116-133,249-258`
87. **Projects list sorted active-first; each row: chevron (rotates 90° when expanded), folder icon, title, per-project '+' new-post button (stopPropagation), status dot (green=active, yellow=dormant, faded=other)**
   - src: `src/components/notes/BlogView.tsx:136-167`
88. **Clicking a project row toggles expansion; expanding lazily fetches that project's devlog posts; shows 'Loading…' then 'No posts yet' or post rows**
   - src: `src/components/notes/BlogView.tsx:52-63,168-176`
89. **Post rows show title + date (date truncated to first space-separated token, '(no date)' fallback) + optional '· project' suffix; click opens file**
   - src: `src/components/notes/BlogView.tsx:210-231`
90. **Hover-revealed external-link icon on published post rows opens the live permalink (yousefamar.com/memo/log/...) in a new tab without opening the file**
   - src: `src/components/notes/BlogView.tsx:232-244`
91. **Section headers (Drafts/Projects/Recent) show item counts on the right**
   - src: `src/components/notes/BlogView.tsx:201-208`
92. **Circles view: canvas circle-pack of the vault, file circle area weighted by file size; folders synthesized; sorted largest-first**
   - src: `src/components/notes/circles-view-helpers.ts:36-71`
93. **Circles view pan/wheel/pinch zoom via d3-zoom, zoom range 0.5×–200×; gestures starting on a file circle are rejected so they don't fight file drag**
   - ctrl+click and non-left mouse buttons rejected; double-click zoom disabled
   - src: `src/components/notes/CirclesView.tsx:236-276`
94. **Quick tap/click on a file circle opens the file in the editor**
   - src: `src/components/notes/CirclesView.tsx:443-453`
95. **Click a folder circle focuses/zooms to it (550ms cubic-out animated d3 transition; user input cancels the animation)**
   - src: `src/components/notes/CirclesView.tsx:451-452,501-517`
96. **Click on empty background pops focus up one level; right-click (contextmenu) also pops a level**
   - src: `src/components/notes/CirclesView.tsx:450,455-458,182-188`
97. **Long-press 400ms on a file lifts it into drag-to-move mode (mobile+desktop); >6px movement before timer cancels; haptic vibrate 15ms on lift; cursor becomes 'grabbing'**
   - src: `src/components/notes/CirclesView.tsx:51-52,321-372`
98. **Dropping a dragged file over a folder prompts 'Move "name.md" to <folder>?' confirm dialog, then renames/moves the file; success toast 'Moved to X', error toast 'Move failed: …'; drop on same parent is a no-op; 500ms click-guard after drop prevents accidental open**
   - src: `src/components/notes/CirclesView.tsx:329-351,190-201`
99. **Dragged file renders on top with accent outline + its label following the pointer**
   - src: `src/components/notes/CirclesView.tsx:639-658`
100. **Hover tooltip (desktop only, bottom strip): full path plus, for files, '· size · age' (size formatted B/KB/MB, age just now/h/d/mo/y)**
   - DOM mutated directly, no React re-render; hidden on mobile and on pointer leave
   - src: `src/components/notes/CirclesView.tsx:299-311,79-95`
101. **Cursor changes by hover target: pointer over files, zoom-in over folders, grab elsewhere**
   - src: `src/components/notes/CirclesView.tsx:406`
102. **Machete-style folder level-of-detail: a folder's opaque cover fades once its apparent radius exceeds 0.4×min(viewport W,H), revealing children; labels and hit-testing respect cover visibility**
   - src: `src/components/notes/circles-view-helpers.ts:18-20,110-152`
103. **Active file circle drawn with 2.4px accent stroke; files modified in the last 5 minutes get a semi-transparent accent ring**
   - src: `src/components/notes/CirclesView.tsx:585-603,46`
104. **Circle labels rendered at fixed 13px screen size only when apparent radius ≥22px; truncated with ellipsis via binary search to fit 1.7×radius**
   - src: `src/components/notes/CirclesView.tsx:607-637; circles-view-helpers.ts:185-201`
105. **Circles search: '/' key opens the filter bar (when notes pane active and not typing in an input); Escape closes and clears**
   - src: `src/components/notes/CirclesView.tsx:522-537`
106. **Search filter dims non-matching circles/labels to 20-25% opacity and outlines matching files in accent; matches are path-substring, case-insensitive, ancestors included**
   - src: `src/components/notes/CirclesView.tsx:166-179,580-587,634`
107. **Enter in circles search zooms to the first match (file → its parent folder; folder → itself); X button or Escape closes and clears**
   - src: `src/components/notes/CirclesView.tsx:732-752`
108. **Circles breadcrumb bar: 'vault' root + ancestor chain, each crumb clickable to refocus; ArrowUp button zooms to root (disabled when already at root)**
   - src: `src/components/notes/CirclesView.tsx:675-698`
109. **Circles toolbar buttons switch view to blog (NotebookPen icon) or tree (FolderTree icon); Search icon toggles search bar**
   - src: `src/components/notes/CirclesView.tsx:699-719`
110. **Circles empty state 'No notes in vault' when file list is empty**
   - src: `src/components/notes/CirclesView.tsx:665-671`
111. **Focus snaps back to root if the focused folder disappears from the vault**
   - src: `src/components/notes/CirclesView.tsx:145-148`
112. **Live-status chip in editor status bar for published posts: green dot=live, yellow=stale (local edits not deployed), pulsing blue=building, grey ?=unknown; tooltips explain each state**
   - src: `src/components/notes/LiveStatusChip.tsx:40-66`
113. **Clicking the live-status chip forces a re-probe of deploy status; probe also runs automatically on mount/path change**
   - src: `src/components/notes/LiveStatusChip.tsx:19-23,59-60`
114. **Saving a published post immediately flips its live-status to 'stale' without a network probe (unless a build is in flight)**
   - reacts only to savedContent CHANGES, never the mount-time value; never clobbers 'building'
   - src: `src/components/notes/LiveStatusChip.tsx:29-38`
115. **Project panel (right-side, 320px): header with project title, slug (+' · untracked' badge), refresh-posts button (spins while loading), close button**
   - src: `src/components/notes/ProjectPanel.tsx:130-156`
116. **Project status dropdown (tracked projects only): active/dormant/complete with colour dots (green/yellow/grey); current option checkmarked; selecting persists via setProjectStatus, error alert on failure**
   - src: `src/components/notes/ProjectPanel.tsx:158-196,76-85`
117. **Project panel chronological posts list; click opens the post; empty state 'No posts yet — write one ↓'; posts refresh on slug change and manual refresh only (not per keystroke)**
   - src: `src/components/notes/ProjectPanel.tsx:198-223,59-61`
118. **Untracked project directories still get the panel: explains adding index.md with 'log: true' frontmatter to track; title humanised from slug**
   - src: `src/components/notes/ProjectPanel.tsx:224-230,63-74`
119. **Project panel lists live agent sessions whose cwd is under projects/<slug>/ (ended sessions excluded), with status dot (green running / grey idle / faded ended) and accent unread dot; clicking jumps to that session in the Agents pane**
   - src: `src/components/notes/ProjectPanel.tsx:50-57,113-116,232-263`
120. **'Start agent in <project>' button: prompts for a first message, spawns a new agent session with cwd <vault>/projects/<slug> named after the project, switches to Agents pane; alerts if vault path not yet loaded**
   - src: `src/components/notes/ProjectPanel.tsx:97-111,267-274`
121. **'New post about <project>' footer button (tracked only): title prompt → createDraft with project slug; error alert on failure**
   - src: `src/components/notes/ProjectPanel.tsx:87-95,275-283`
122. **Project pill in editor status bar toggles the project panel; shows folder icon, project title, '· N post(s)', green bot icon + count of active agent sessions in the project, '· status' colour-coded, or '· untracked' italic**
   - highlighted background when panel open; tooltip 'Show/Hide project panel'; auto-refreshes the project's post list on mount
   - src: `src/components/notes/ProjectPill.tsx:46-67`
123. **Write action bar 'Insert image' button opens a file picker; images downscaled to max 2000px long edge as JPEG q0.85 (GIFs and small images pass through); saved via pasteImage as photo-<ISO-timestamp>.<ext>**
   - bare filename → Obsidian wiki-embed ![[..]]; path result → markdown ![](path); error toast 'Image upload failed'; spinner while uploading
   - src: `src/components/notes/WriteActionBar.tsx:21-42,78-96,153-161`
124. **'Take photo' camera button (mobile only) opens rear-camera capture, same downscale/insert pipeline**
   - src: `src/components/notes/WriteActionBar.tsx:162-172`
125. **Dictation mic button toggles STT; while recording icon pulses red; each transcript chunk inserted at cursor with smart spacing (space only when gluing two word chars)**
   - src: `src/components/notes/WriteActionBar.tsx:47-60,73-76,173-180`
126. **'Insert footnote' button (Superscript icon) inserts a footnote at the cursor**
   - src: `src/components/notes/WriteActionBar.tsx:181-188`
127. **'Format dictation' AI button: formats current selection, or whole body minus frontmatter if no selection, via hub /blog/format (punctuation+paragraphs only); single undo step when buffer unchanged; success toast 'Formatted', error toast on failure; spinner while formatting**
   - src: `src/components/notes/WriteActionBar.tsx:98-130,189-197`
128. **Publish button (unpublished drafts) / Re-publish button (published posts); label gains '*' suffix when file has unsaved edits; published posts also get a 'View live' external-link to the permalink**
   - src: `src/components/notes/WriteActionBar.tsx:201-233`
129. **Write meta bar collapsible; collapsed strip shows title (or '(untitled)'), tags joined with ' · ', and '@project'; collapse state persisted in localStorage console:notes:metaBarCollapsed**
   - src: `src/components/notes/WriteMetaBar.tsx:16-24,98-113,127-133`
130. **Title input stamps frontmatter title on 800ms debounce or on blur; edits round-trip through the CM6 buffer (preserves undo + cursor), falling back to updateFileContent if the view is out of sync**
   - src: `src/components/notes/WriteMetaBar.tsx:30-32,42-70,119-125`
131. **Tag chips with X-to-remove; tag input adds on Enter; Backspace in empty tag input removes the last tag; duplicate tags silently ignored**
   - src: `src/components/notes/WriteMetaBar.tsx:74-83,139-171`
132. **Tag autocomplete dropdown while input focused: up to 8 vault-wide tag suggestions filtered by substring, excluding already-applied tags; mousedown selects (150ms blur delay keeps it clickable)**
   - src: `src/components/notes/WriteMetaBar.tsx:89-96,160,172-184`
133. **Project select dropdown in meta bar assigns the post to a project ('no project' option); stamps frontmatter project field**
   - src: `src/components/notes/WriteMetaBar.tsx:85-87,189-199`
134. **Notes keyboard shortcuts: Ctrl+Shift+T reopen closed tab, Ctrl+Shift+P command palette, Ctrl+P quick switcher (filename), Ctrl+Shift+F content search, Ctrl+N new file, Ctrl+W close tab**
   - Ctrl+W with unsaved changes shows a showConfirm dialog 'Save changes before closing?' with 'Save & close' / 'Discard'; save path saves then closes. All work while editing (checked before isEditing bail).
   - src: `src/hooks/useKeybindings.ts:119-164`
135. **Notes non-editor keys: '?' help, Shift+T dark mode, 'i' focus editor, '/' quick switcher, 'e' close active file**
   - Apply only when CodeMirror isn't focused; bare j/k deliberately NOT bound (conflict with editor line motion).
   - src: `src/hooks/useKeybindings.ts:525-559`
136. **Insert-footnote action (desktop keybinding + mobile WriteActionBar button)**
   - Inserts [^N] at cursor and appends '[^N]: ' definition at document end (blank-line separated), auto-incrementing N past the highest existing footnote; cursor jumps to the definition ready to type
   - src: `src/notes/editor-actions.ts:14-42`
137. **Editor visual theme: 13px mono, themed selection/panels/tooltips, vim fat-cursor becomes hollow outline when unfocused**
   - Dark + light variants; line-number gutter 10px; search panel inputs/buttons styled to design tokens
   - src: `src/notes/editor-theme.ts:4-140`
138. **Live markdown preview: cursor line reveals raw syntax, everything else renders**
   - Headings (# hidden, sized h1 1.6em…h6), bold/italic/strikethrough markers hidden, inline code chips, blockquote left-border italic, fenced-code background, HR rendered as <hr>; full decoration set rebuilt on doc/viewport change, cursor moves only re-filter (cheap O(log n))
   - src: `src/notes/live-preview.ts:189-395,438-486`
139. **Clickable [text](url) links in the editor open in a new tab**
   - Link widget replaces the raw markdown; click → window.open(url, '_blank', 'noopener'); hover shows URL as title tooltip
   - src: `src/notes/live-preview.ts:69-84`
140. **Clickable [[wiki-links]] open the target vault note**
   - Rendered as a pill; supports [[target|alias]] display text; click resolves against file list by basename or path (+.md) and opens the match
   - src: `src/notes/live-preview.ts:44-67,348-357`
141. **Inline images render in the editor: ![alt](src) and ![[image.png]] embeds**
   - Max 300px tall / 100% width, lazy-loaded; vault-relative paths resolved to blob URLs via the active adapter; external http/data URLs used directly; 'Loading: <src>' placeholder while resolving, 'Image not found: <src>' on failure
   - src: `src/notes/live-preview.ts:148-181,334-345`
142. **Failed image loads self-heal: 20s negative cache + retry-on-reconnect**
   - Misses cached only 20s so a hub blip retries on next render instead of poisoning until reload; retryFailedImages() clears all negatives and re-renders (used on hub reconnect)
   - src: `src/notes/live-preview.ts:91-117`
143. **Task-list checkboxes render as real checkboxes**
   - - [ ]/- [x] replaced with a checkbox widget (checked state reflected, aria-labelled); accent-colored
   - src: `src/notes/live-preview.ts:31-41,359-370`
144. **YAML frontmatter dimmed italic, never collapsed**
   - Styled via StateField (grey italic) but intentionally not hidden — collapsing caused layout shifts breaking vim cursor tracking
   - src: `src/notes/live-preview.ts:406-432`
145. **List hanging indent — wrapped list lines align with text, not the bullet**
   - Per-line padding-left/text-indent computed from marker width for -,*,+ and numbered lists
   - src: `src/notes/live-preview.ts:601-633`
146. **Quick Switcher fuzzy filename search (fzf), capped at 50 results with match-position highlighting**
   - searchFilenames returns path/name/dir/score/positions; empty query returns []
   - src: `src/notes/search-index.ts:89-105`
147. **Full-text note search (MiniSearch) — title boosted 3x, path 1.5x, fuzzy 0.2, prefix matching, top 50**
   - Content indexed to first 10,000 chars per note; index built in batches of 50 files yielding to the main thread so typing stays responsive during indexing; per-file title from frontmatter title > first H1 > filename
   - src: `src/notes/search-index.ts:27-117,159-170`
148. **Index kept live on edit/delete**
   - updateDocument re-indexes a saved file (and adds new paths to the fzf list); removeDocument drops deleted files from both indexes
   - src: `src/notes/search-index.ts:120-155`
149. **Two vault backends: local File System Access API (offline, Chrome/Edge) or hub REST**
   - FSA directory handle persisted in a dedicated IDB so vault survives reload without re-picking; file list includes .md everywhere + .svg only under scratch/pen/ (pen pages); hidden dotfiles and .obsidian/.trash/bookmarks/.git/node_modules/etc dirs skipped; files sorted by path
   - src: `src/notes/vault-adapter.ts:29-107,186-256`
150. **FSA rename is copy+delete (no native rename)**
   - Rename reads old content, writes new path, deletes old — a mid-failure could leave both copies
   - src: `src/notes/vault-adapter.ts:146-151`
151. **Hub vault root path fetched once and cached for agent-session creation from Notes**
   - getVaultPath GET /notes/vault-path, cached forever with in-flight dedupe; null on failure
   - src: `src/notes/vault-info.ts:10-18`
152. **Blog drafts list refresh**
   - refreshDrafts GETs /blog/drafts (8s timeout) with a draftsLoading flag; failure keeps last known list silently.
   - src: `src/store/blog.ts:134-142`
153. **Blog projects list refresh**
   - refreshProjects GETs /blog/projects (12s timeout) with projectsLoading flag; projects carry status active|dormant|complete + lastPostMtime/path.
   - src: `src/store/blog.ts:144-152`
154. **Blog tags list refresh**
   - refreshTags GETs /blog/tags (8s timeout); on failure keeps last known tags.
   - src: `src/store/blog.ts:154-161`
155. **Per-project post list (devlog expansion)**
   - refreshProjectPosts(slug) GETs /blog/project/<slug>/posts; stored in postsByProject keyed by slug; failure keeps last known.
   - src: `src/store/blog.ts:163-170`
156. **Recent published posts list**
   - refreshRecentPosts(limit=20) GETs /blog/posts?limit=N (12s timeout) with recentPostsLoading flag; posts carry title/date/project/tags.
   - src: `src/store/blog.ts:172-180`
157. **Dictation formatting via hub LLM**
   - formatDictation POSTs raw dictated text to /blog/format with a 95-second timeout (claude -p one-shot); returns {ok,text} or {ok:false,error} — no throw to caller.
   - src: `src/store/blog.ts:182-192`
158. **Project status setter (active/dormant/complete)**
   - setProjectStatus PATCHes /blog/project/<slug> {status}; on ok optimistically updates the local projects list (null status maps to 'active' locally).
   - src: `src/store/blog.ts:194-213`
159. **Publish a draft to the blog**
   - publish(path) POSTs /blog/publish (30s timeout); result carries newPath (draft moved into log/), rebuildOk/rebuildBody from the Eleventy rebuild trigger.
   - src: `src/store/blog.ts:215-226`
160. **Republish an already-published post**
   - republish(path) POSTs /blog/republish (30s timeout) to re-queue the Eleventy build for a log/ post without moving files.
   - src: `src/store/blog.ts:228-238`
161. **Live/stale/building status per published post**
   - checkLiveStatus(path) computes the permalink, GETs /blog/page-etag?url= via the hub (SPA can't HEAD cross-origin), compares page Last-Modified vs local file mtime: pageMs >= mtime → 'live', else 'stale'; unparsable/unreachable → 'unknown'. Drives the Publish/View-live morphing button state.
   - src: `src/store/blog.ts:250-276`
162. **Wait-for-site-update polling after publish**
   - waitForSiteUpdate polls the permalink's ETag every 5s, up to 36 tries (~3 min); resolves true when ETag moves off the pre-publish baseline (build landed), false on timeout.
   - src: `src/store/blog.ts:278-292`
163. **Create new blog draft (opens in Notes)**
   - createDraft({title,project}) requires non-empty trimmed title; POSTs /blog/draft (12s timeout, hub seeds frontmatter incl. tags inherited from project's latest post, public:false). On success switches active pane to Notes, rescans vault files if the file is new (skipped when alreadyExists — same slug just opens the existing draft), opens the file, and refreshes the drafts list.
   - src: `src/store/blog.ts:294-322`
164. **Create new blog project (opens in Notes)**
   - createProject({title,slug?}) POSTs /blog/project (hub writes projects/<slug>.md with log:true, status:active); on success switches to Notes pane, reloads file list, opens the stub, refreshes projects.
   - src: `src/store/blog.ts:324-343`
165. **File tree sorted directories-first then alphabetical**
   - buildFileTree sorts every level: dirs before files, then localeCompare by name.
   - src: `src/store/notes.ts:69`
166. **Sidebar directory ordering by recency with scratch pinned first**
   - getDirectoriesByRecency sorts dirs by most-recent file mtime descending; 'scratch' is always included (even if empty) and always first.
   - src: `src/store/notes.ts:96`
167. **Connect vault via directory picker (FSA)**
   - connectVault opens showDirectoryPicker readwrite, persists the handle for future sessions, loads files; user-cancel (AbortError) is silent.
   - src: `src/store/notes.ts:278`
168. **Auto-reconnect vault on boot: FSA handle first, hub fallback**
   - reconnectVault tries the persisted FSA handle (requestPermission readwrite); if denied/invalid falls back to HubVaultAdapter; if both fail the pane shows disconnected state.
   - src: `src/store/notes.ts:292`
169. **Top-level directories auto-expand on first load**
   - When no expandedDirs pref persisted, all top-level dirs start expanded; otherwise the persisted set wins.
   - src: `src/store/notes.ts:336`
170. **Open tabs + active tab persist across reload**
   - Tab set and active path saved to localStorage 'notesOpenTabs' on every open/close/switch; restored (each file re-read) after vault files load.
   - src: `src/store/notes.ts:227`
171. **Directory expand/collapse persists as hub pref**
   - toggleDir flips a dir in expandedDirs and persists via setPref('notesExpandedDirs').
   - src: `src/store/notes.ts:560`
172. **Notes view mode tree | circles | blog persisted**
   - setViewMode persists to hub pref 'notesViewMode'; default 'tree'.
   - src: `src/store/notes.ts:575`
173. **Open file switches to existing tab if already open**
   - openFile on an already-open path just activates its tab; otherwise reads content and opens a new tab, persisting tabs.
   - src: `src/store/notes.ts:362`
174. **Close tab blocked when dirty unless forced**
   - closeFile returns false for a dirty file (content !== savedContent) so the caller shows a confirmation; force=true skips. Next active tab: same index, else previous, else first remaining, else none.
   - src: `src/store/notes.ts:388`
175. **Reopen last closed tab (up to 20 remembered)**
   - recentlyClosedPaths keeps the last 20 closed paths; reopenLastClosedTab reopens the most recent one not already open.
   - src: `src/store/notes.ts:580`
176. **Save file (no auto-save) updates search index and mtime**
   - saveFile writes via adapter, marks tab clean, bumps in-memory mtime so recency sorts/blog status chip update without rescan, and updates the full-text search index.
   - src: `src/store/notes.ts:422`
177. **Create file: writes, refreshes tree, indexes, opens it**
   - createFile writes empty-or-given content, refreshes file list/tree, adds to search index, opens as active tab.
   - src: `src/store/notes.ts:464`
178. **Delete file closes its tab and removes from index**
   - deleteFile removes via adapter, force-closes any open tab for it, refreshes tree, removes from search index.
   - src: `src/store/notes.ts:481`
179. **Rename file migrates the open tab and active state**
   - renameFile updates the open tab to the new path (keeping unsaved content), keeps it active if it was, refreshes tree, reindexes under the new path.
   - src: `src/store/notes.ts:498`
180. **Tab cycling next/prev wraps around**
   - nextTab/prevTab cycle open tabs modulo length; no-op with ≤1 tab. Bound to Ctrl+L/Ctrl+H in useKeybindings.
   - src: `src/store/notes.ts:530`
181. **Pen-page prev/next navigation ordered by page number**
   - nextPageInFolder/prevPageInFolder step among sibling scratch/pen/<note>/page-N.svg files in the same folder, sorted numerically by page number.
   - src: `src/store/notes.ts:127`
182. **New pen pages appear in the file tree live without rescan**
   - notePageSaved (fired by pen.page_saved SyncBus events) inserts the new page file (path-sorted) into files+tree if absent.
   - src: `src/store/notes.ts:549`
183. **Live pen activity tracking for red dot + auto-open**
   - pen page_open/stroke_delta/page_saved events set penActivePagePath/penActiveAt (stroke_delta writes throttled to 1/s unless the page changed) — drives Notes-tab red dot and auto-open-on-switch.
   - src: `src/store/notes.ts:746`
184. **Notes-tab red dot reflects pen live-streaming state**
   - penStreaming set by 'pen.streaming' broadcast and fetched once from GET /pen/stream on module load (broadcasts aren't replayed).
   - src: `src/store/notes.ts:766`
185. **Quick Switcher with filename and content modes**
   - openQuickSwitcher(mode='filename'|'content') / close; searchFilenames = fuzzy filename search, searchContent = full-text search via NotesSearchIndex (built in background after file load).
   - src: `src/store/notes.ts:589`
186. **Command palette open/close**
   - commandPaletteOpen state toggled by openCommandPalette/closeCommandPalette.
   - src: `src/store/notes.ts:592`
187. **New-file form pre-filled with directory**
   - openNewFileForm(dir) opens the create form pre-filled (default 'scratch'); triggered from Ctrl+N, context menu, sidebar button.
   - src: `src/store/notes.ts:595`
188. **Link picker over editor selection**
   - openLinkPicker carries {from,to,selectedText,mode:'wiki'|'both'} — insert wiki/markdown link at the selection.
   - src: `src/store/notes.ts:598`
189. **Obsidian-style image resolution with multiple fallbacks**
   - resolveImageUrl tries: relative-to-file path, vault-root path, bare-filename in current dir / assets / assets/images / al/assets, then the hub-served sibling assets dir (/notes/asset/images/<name> then /notes/asset/<name>); returns a blob URL or null (broken image).
   - src: `src/store/notes.ts:616`
190. **Paste image uploads to blog assets dir, vault-local fallback offline**
   - pasteImage PUTs the blob to hub /notes/asset/images/<filename> (Obsidian attachment folder + published site); if the hub is unreachable it writes assets/images/<filename> inside the vault via the adapter so content isn't lost (won't publish).
   - src: `src/store/notes.ts:701`
191. **Dirty indicator per tab**
   - isFileDirty(path) = content !== savedContent; drives the unsaved dot on tabs.
   - src: `src/store/notes.ts:610`
192. **Title slugified into filename on new-post creation**
   - slugify lowercases, strips non-word chars, collapses spaces/underscores to single hyphens, trims edge hyphens.
   - src: `src/store/notes.ts:85`
193. **Blog frontmatter structured editing round-trips through the buffer**
   - stampFrontmatter replaces/appends keys in place (tags serialize as a YAML block list, replacing scalar/inline/block forms); frontmatterRange enables surgical CM6 replacement that preserves cursor + undo history.
   - src: `src/utils/frontmatter.ts:70`
194. **Blog tags parse from scalar, inline-array, or block-list YAML**
   - parseFrontmatter handles tags: foo, tags: [a, b], and block lists; quotes stripped; comma or whitespace-separated scalars split.
   - src: `src/utils/frontmatter.ts:34`
195. **View-live permalink for published posts**
   - permalinkForLogPath maps log/<name>.md → https://yousefamar.com/memo/log/<name>/; draft detection = under scratch/blog-drafts/, published = log/<name>.md.
   - src: `src/utils/frontmatter.ts:115`

## pen (25)

1. **Pen settings poll status every 3 seconds while panel is open**
   - refresh() on 3s interval + refreshStream() on mount; makes live dot readout responsive ('first light')
   - src: `src/components/PenSettings.tsx:37`
2. **Pen status line: Phone not reachable / connected (+name, firmware) / Connecting… / No pen connected**
   - apkOffline overrides all; connected shows '<name> connected · fw <version>'
   - src: `src/components/PenSettings.tsx:53`
3. **Connect button reconnects the saved pen; Disconnect keeps pairing**
   - Connect disabled while connecting or APK offline, plug icon pulses while connecting; Disconnect (EyeOff icon) only shown when connected
   - src: `src/components/PenSettings.tsx:66`
4. **Connected pen shows battery %, storage-used %, and offline-save on/off**
   - '…' placeholders while values unknown; offline-save row only when reported
   - src: `src/components/PenSettings.tsx:89`
5. **'live → Notes' toggle streams pen pages into the Notes tab**
   - setStreaming(!streaming); Radio icon green when on; off leaves pen in normal offline-save mode; persisted hub-side in pen-auth.json (default off)
   - src: `src/components/PenSettings.tsx:109`
6. **Live dot coordinate readout while writing**
   - Monospace 'dot (x, y)' from lastDotX/Y, shown only when connected and a dot has been seen
   - src: `src/components/PenSettings.tsx:121`
7. **Pen unlock: password field + Unlock button when pen locked and unauthorized**
   - unlock(password); field cleared after attempt
   - src: `src/components/PenSettings.tsx:128`
8. **Pen last error shown in red, truncated with full text in tooltip**
   - snap.lastError
   - src: `src/components/PenSettings.tsx:147`
9. **'Pair a new pen' expands a scan panel listing up to 6 BLE observations**
   - Only when disconnected; expanding triggers scan(); rows show name (fallback 'Smart Pen'), last-two-octet MAC, RSSI dBm; clicking a row connects to that MAC; empty state 'Scanning… make a mark with the pen to wake it.' or 'No pens found.'; Radar icon pulses while scanning; button relabels 'Re-scan'
   - src: `src/components/PenSettings.tsx:155`
10. **Pen-page viewer renders handwriting from strokes embedded in the saved SVG, as pressure-weighted variable-width ribbon paths (width 0.06–0.18 Ncode units, force ref 480) on a cream #faf9f5 page**
   - src: `src/components/notes/PenPageRenderer.tsx:51-112,237-250`
11. **Fixed notebook page viewBox (Ncode ~37.96×59.06 anchored at 6,5) so the canvas doesn't grow while writing; only expands if strokes exceed the page rect (0.5u pad)**
   - src: `src/components/notes/PenPageRenderer.tsx:64-81`
12. **Live handwriting overlay: subscribes SyncBus 'pen' stroke_delta/stroke_end events filtered to the open note+page; deltas batched per requestAnimationFrame**
   - src: `src/components/notes/PenPageRenderer.tsx:151-181`
13. **On pen 'page_saved' event the durable SVG is re-read and the live overlay cleared seamlessly; 'page_open' replaces base strokes from event payload**
   - src: `src/components/notes/PenPageRenderer.tsx:175-192`
14. **On opening/switching a pen page: cached tab content shown instantly (no flash), then the freshest durable SVG is fetched from the vault adapter**
   - src: `src/components/notes/PenPageRenderer.tsx:131-146`
15. **Prev/next chevron buttons walk sibling pages by page number; header label '<notebook> · page <n>' with pen icon**
   - src: `src/components/notes/PenPageRenderer.tsx:207-226,34-38`
16. **Foreign pen SVGs (no embedded penpage strokes, e.g. official Moleskine app exports) render verbatim inside a white card so black ink reads in dark mode**
   - src: `src/components/notes/PenPageRenderer.tsx:40-44,228-233`
17. **Empty pen page shows 'Waiting for strokes — start writing on this page.'**
   - src: `src/components/notes/PenPageRenderer.tsx:234-235`
18. **Live streaming only works for numeric notebook folders (scratch/pen/<digits>/page-<n>.svg); named notebooks render but get no live overlay**
   - src: `src/components/notes/PenPageRenderer.tsx:27-32,115,152`
19. **Pen status panel survives APK offline with greyed cached snapshot**
   - refresh GET /pen/status; on hub 503 (APK not connected on /push) shows the last cached snapshot with apkOffline=true instead of wiping the UI; other errors keep the previous snapshot.
   - src: `src/store/pen.ts:68`
20. **BLE scan with 2s observation polling**
   - scan(durationMs=15s) clears observations, POST /pen/scan, polls /pen/scan/observations every 2s while scanning, does a final poll and clears the scanning flag at duration+500ms; scan-start failure resets scanning immediately.
   - src: `src/store/pen.ts:119`
21. **Connect pen: saved pen reconnect or specific MAC**
   - connect() with no mac reconnects the phone's saved pen (no scan needed); with mac connects that device; errors surface via lastError on the follow-up refresh.
   - src: `src/store/pen.ts:136`
22. **Disconnect pen**
   - POST /pen/disconnect then refresh; errors ignored.
   - src: `src/store/pen.ts:145`
23. **Unlock pen with password**
   - unlock(password) POST /pen/unlock; failure shown via lastError on next refresh (seeded PIN 1551 handled hub-side).
   - src: `src/store/pen.ts:152`
24. **Live-stream-to-Notes toggle, optimistic with hub-truth revert**
   - setStreaming optimistically flips the toggle, POST /pen/stream {enabled}; on failure re-fetches GET /pen/stream to revert to hub truth. Persisted hub-side in pen-auth.json, default off.
   - src: `src/store/pen.ts:106`
25. **Pen snapshot displays battery/firmware/memory/lock/last-dot**
   - PenSnapshot fields shown in settings: status, mac, name, firmware, battery %, usedMemPct, locked, authorized, offlineSaveOn, lastError, last dot X/Y coords, lastUpdatedMs.
   - src: `src/store/pen.ts:11`

## settings (15)

1. **Settings modal: Do Not Disturb toggle switch**
   - Toggle flips uiStore doNotDisturb (persisted as hub 'dnd' pref, re-applied on boot); icon swaps Bell/BellOff; suppresses notifications app-wide.
   - src: `src/components/AccountModal.tsx:69-81`
2. **Settings modal: Gmail row shows signed-in email and Sign out button**
   - Shows userEmail (fallback 'Gmail'); Sign out shows 'Signing out...', calls signOut() then full page reload; disabled while any sign-out in flight.
   - src: `src/components/AccountModal.tsx:86-101`
3. **Settings modal: Matrix row — Disconnect (when connected) or Connect (opens Matrix login modal)**
   - Connected shows matrixUserId; Disconnect logs out, clears db.chatRooms + db.chatMessages, deletes legacy 'console-crypto-store' IndexedDB, then reloads page. Not connected shows italic 'Not connected' + Connect button which closes settings and opens MatrixLoginModal.
   - src: `src/components/AccountModal.tsx:31-49,103-132`
4. **Glasses settings section shown only when glasses bridge supported (APK)**
   - glassesSupported() gates GlassesSettings render inside the modal.
   - src: `src/components/AccountModal.tsx:134-139`
5. **Pen settings section shown only on native APK**
   - isNative() gates PenSettings inside the modal.
   - src: `src/components/AccountModal.tsx:141-146`
6. **APK pairing section always present in settings modal**
   - ApkPairSection: QR + one-shot token for pairing the native app from any browser (legacy WebView bridge when native).
   - src: `src/components/AccountModal.tsx:148-151`
7. **Cross-origin IDB+localStorage import tool**
   - URL input (empty by default post-cutover, user types prior origin), Import button ('Importing…' while busy, disabled when empty/busy); trailing slashes stripped; success shows 'Imported N rows + M prefs in Xms. Reload to apply.'; failure shows error text.
   - src: `src/components/AccountModal.tsx:168-228`
8. **Build age footer in settings modal**
   - Shows 'Built <age>' from __BUILD_TIME__: just now / Nm ago / Nh ago / Nd ago.
   - src: `src/components/AccountModal.tsx:157-162,235-245`
9. **Settings modal closes via X button or backdrop click**
   - Both call setShowAccountModal(false).
   - src: `src/components/AccountModal.tsx:53-64`
10. **'Pair this APK' mints an apk-scoped hub bearer token**
   - POST /auth/hub/tokens with name 'APK <ISO minute>'; plaintext shown exactly once
   - src: `src/components/ApkPairSection.tsx:47-53`
11. **In-WebView (legacy APK): token handed to native shell via ConsoleNative.setHubToken with retry**
   - Bridge called as member (unbound call throws); retries up to 5 times at 200ms if bridge not yet injected; error shown if unavailable
   - src: `src/components/ApkPairSection.tsx:61-87`
12. **Browser: pairing QR of console://pair?hub=<url>&token=<plaintext> rendered (220px, light-on-dark)**
   - Scanning with phone camera deep-links into the native app; plaintext also shown below as select-all code for manual paste; dismiss (X) clears QR + plaintext
   - src: `src/components/ApkPairSection.tsx:89-98,153-171`
13. **Paired state polled every 1s from ConsoleNative.hasHubToken (native only)**
   - Shows 'This APK is paired' + Unpair button (clears token via clearHubToken); browser shows 'Pair the Console app' + 'Show pairing QR'
   - src: `src/components/ApkPairSection.tsx:39-45,106-146`
14. **Pairing busy/error states**
   - Button reads 'Pairing…' while minting and is disabled; inline red error with AlertCircle on failure
   - src: `src/components/ApkPairSection.tsx:139-151`
15. **Prefs sync via hub, not localStorage**
   - initPrefs() GETs /config once at boot (4s timeout; hub offline → empty cache, callers get defaults). setPref updates in-memory cache immediately (snappy UI) then fire-and-forget PUT /config with {key:value}; failed writes stay in memory and are effectively retried by the next successful write. onPrefChange lets components live-react to a pref key.
   - src: `src/prefs.ts:23-53`
