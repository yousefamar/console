# Agent Architecture

Console integrates Claude Code as an embedded agent via the **Agents** tab. This document describes the architecture, protocol, and implementation.

## Overview

The agent system has three layers:

```
┌──────────────────────────────────────────────┐
│  Console App (Browser)                        │
│  "Agents" tab                                 │
│  - Zustand store (src/store/agent.ts)         │
│  - Components (src/components/Agent*.tsx)      │
│  - Keybindings (y/n/a for tool approval)      │
└──────────────┬───────────────────────────────┘
               │ WebSocket (ws://localhost:9877)
               ▼
┌──────────────────────────────────────────────┐
│  Agent Hub (agent-hub/)                       │
│  Local Node.js server                         │
│  - Spawns claude CLI subprocesses             │
│  - Manages sessions (create/resume/list)      │
│  - Translates NDJSON ↔ WebSocket messages     │
└──────────────┬───────────────────────────────┘
               │ stdin/stdout NDJSON
               ▼
┌──────────────────────────────────────────────┐
│  Claude CLI (child process)                   │
│  --output-format stream-json                  │
│  --input-format stream-json                   │
│  --permission-prompt-tool stdio               │
│  Executes tools locally on your machine       │
└──────────────────────────────────────────────┘
```

## Why This Approach

We follow the same architecture as [Happy Coder](https://github.com/slopus/happy) and [HAPI](https://github.com/tiann/hapi) — two open-source mobile/web clients for Claude Code. Neither uses the undocumented Remote Control API. Instead, they:

1. Spawn `claude` as a subprocess with `--output-format stream-json --input-format stream-json`
2. Read NDJSON from stdout (assistant messages, tool calls, thinking, results)
3. Write NDJSON to stdin (user prompts, tool approvals/denials)
4. Relay messages to/from a web UI over WebSocket

**Advantages over Remote Control API:**
- Uses documented, stable CLI flags (not an internal beta API)
- No OAuth tokens or authentication required (local process)
- No CORS issues (local WebSocket)
- No dependency on Anthropic's relay infrastructure
- Full access to all message types (thinking, stream deltas, control requests)

## Claude CLI NDJSON Protocol

### stdout (Claude → Hub)

Each line is a JSON object with a `type` field:

| Type | Description |
|------|-------------|
| `system` | Session init: `{ type: 'system', subtype: 'init', session_id, tools, model }` |
| `assistant` | Model response: text blocks, thinking blocks, tool_use blocks |
| `user` | Tool results: `tool_result` blocks with content and error flag |
| `result` | Turn complete: cost, token usage, duration, session_id |
| `control_request` | Permission prompt: `{ subtype: 'can_use_tool', id, tool_name, input }` |
| `stream_event` | Token-level deltas: `content_block_delta` with text/thinking chunks |

### stdin (Hub → Claude)

| Type | Description |
|------|-------------|
| `user` | User prompt: `{ type: 'user', message: { role: 'user', content: '...' } }` |
| `control_response` | Tool approval: `{ type: 'control_response', id, permission: { behavior: 'allow'|'deny' } }` |

### Content Blocks (within assistant messages)

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
```

## Agent Hub

**Location:** `agent-hub/`

The hub is a minimal Node.js server (~200 lines) with:

- **HTTP health endpoint** (`GET /health`) — returns `{ ok, version, sessions, cwd }`
- **WebSocket server** — accepts connections from Console frontend
- **Session manager** — spawns/tracks/resumes Claude CLI subprocesses

### Starting the Hub

```bash
cd agent-hub
npm install
npm run dev               # Development (tsx watch)
npm run dev -- --port 9877  # Custom port
npm run dev -- --cwd /path  # Custom working directory
```

### Hub ↔ Browser Protocol

See `agent-hub/src/protocol.ts` for complete type definitions.

**Browser → Hub (ClientMessage):**

| Type | Fields | Purpose |
|------|--------|---------|
| `create_session` | `prompt`, `permissionMode?` | Start a new agent session |
| `send_message` | `sessionId`, `content` | Send follow-up prompt |
| `approve_tool` | `sessionId`, `requestId`, `modifiedInput?` | Allow a tool call |
| `deny_tool` | `sessionId`, `requestId`, `reason?` | Deny a tool call |
| `interrupt` | `sessionId` | Cancel current operation (SIGINT) |
| `list_sessions` | — | Get all sessions |
| `resume_session` | `sessionId`, `prompt` | Resume a previous Claude session |

**Hub → Browser (HubMessage):**

| Type | Fields | Purpose |
|------|--------|---------|
| `session_created` | `sessionId` | New session started |
| `sessions_list` | `sessions[]` | All sessions with metadata |
| `text` | `sessionId`, `content` | Complete text block |
| `text_delta` | `sessionId`, `content` | Streaming text chunk |
| `thinking` | `sessionId`, `content` | Complete thinking block |
| `thinking_delta` | `sessionId`, `content` | Streaming thinking chunk |
| `tool_use` | `sessionId`, `toolUseId`, `toolName`, `input` | Tool invocation |
| `tool_result` | `sessionId`, `toolUseId`, `content`, `isError` | Tool output |
| `approval_required` | `sessionId`, `requestId`, `toolName`, `input` | Permission needed |
| `result` | `sessionId`, `cost`, `tokens`, `duration` | Turn complete |
| `status` | `sessionId`, `text` | Status line update |
| `error` | `sessionId`, `message` | Error |
| `session_ended` | `sessionId` | Session terminated |

## Frontend

### Store (`src/store/agent.ts`)

Zustand store managing:
- **Connection state** — WebSocket lifecycle, auto-reconnect (3s interval, 10 max attempts)
- **Sessions** — list of all sessions with status/cost/tokens
- **Messages** — per-session ordered array of `AgentMessage` blocks
- **Streaming** — `pendingText`/`pendingThinking` accumulators for deltas
- **Tool approval** — single `pendingApproval` (requestId + toolName + input)
- **Auto-approve** — set of tool names to auto-approve (per page session)

### Components

| Component | Purpose |
|-----------|---------|
| `AgentTab` | Tab container with session sidebar + session view |
| `AgentSessionView` | Message stream + status bar + approval overlay + input |
| `AgentMessageBlock` | Renders one block: text (markdown), thinking (collapsible), tool_use (expandable), tool_result (truncatable), user_prompt, error, result |
| `AgentToolApproval` | Bottom sheet: tool name, input preview, Allow/Deny/Allow-all. Bash shows command, Edit shows diff. |
| `AgentPromptInput` | Textarea with Cmd+Enter send, Shift+Cmd+Enter new session, Esc interrupt |

### Keybindings (Agents pane)

| Key | Action |
|-----|--------|
| `y` | Allow pending tool |
| `n` | Deny pending tool |
| `a` | Allow all calls of this tool type |
| `Enter` | Focus prompt input |
| `Esc` | Interrupt running agent |
| `Tab` | Switch to next pane (mail/chat/agents) |
| `?` | Toggle keybinding help |
| `Shift+T` | Toggle dark mode |

### Layout Integration

- **Tab bar** in `Layout.tsx`: Mail | Chat | **Agents** (always visible)
- **Tab key** cycles through all three panes
- Agents pane replaces the list+detail layout with its own full-width view
- Footer action hints change based on active pane

### Auto-Discovery

On mount, `AgentTab` connects to `ws://localhost:9877`. If the hub is running, the tab shows sessions; if not, it shows setup instructions.

## Session Lifecycle

```
1. User types prompt → Cmd+Enter
2. Console sends create_session to hub
3. Hub spawns `claude -p "prompt" --output-format stream-json ...`
4. Claude streams: system(init) → thinking → text → tool_use → ...
5. Hub translates each line → HubMessage → WebSocket → Console
6. If control_request → Console shows approval UI
7. User presses y/n/a → Console sends approve/deny to hub
8. Hub writes control_response to Claude's stdin
9. Claude continues → more messages → eventually result
10. Console shows turn summary (cost, tokens, duration)
11. User can send follow-up → Hub writes user message to stdin
12. Process repeats from step 4
```

## Testing

### Frontend tests (`src/__tests__/agent-store.test.ts`)

Tests the Zustand store with a mock WebSocket:
- Connection lifecycle (connect, disconnect, reconnect)
- Session management (create, list, select)
- Message handling (text, thinking, tool_use, tool_result, error, result)
- Streaming deltas (accumulation and flushing)
- Tool approval flow (approve, deny, auto-approve)
- User actions (send message, interrupt)

```bash
npm test  # Runs all tests including agent store
```

### Hub tests (`agent-hub/src/__tests__/`)

Tests the Session class with a mock child_process:
- Spawn arguments (flags, permission mode, resume)
- stdin writes (user messages, tool approvals/denials)
- Process lifecycle (interrupt, kill, exit, error)

Protocol tests validate type shapes.

```bash
cd agent-hub && npm test
```

## Security Considerations

- The hub runs **locally** — only accepts connections from localhost
- Claude executes tools on **your machine** with your filesystem permissions
- Tool approvals go through the UI — dangerous tools (Bash, Edit, Write) require explicit approval
- Auto-approve is per-session and resets on page reload
- No credentials or API keys flow through the hub (Claude uses its own auth)

## Future Enhancements

- **Context injection** — "Ask about this email/chat" sends content to agent
- **Session persistence** — store session IDs in IndexedDB for resume across reloads
- **Diff viewer** — render Edit tool results as proper diffs
- **Terminal emulator** — render Bash output in a terminal-styled block
- **Remote control layer** — optionally connect to Claude's remote control for phone access
- **Voice input** — push-to-talk voice prompts (same pattern as HAPI)
- **Cost budgets** — per-session cost limits with warnings
