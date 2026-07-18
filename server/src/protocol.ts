// ============================================================================
// Console Agent Hub ↔ Browser Protocol
//
// All messages between the hub's WebSocket server and the Console frontend
// are JSON-encoded instances of these types.
// ============================================================================

import type { AgentRole, OrgNode } from './agents/registry.js'
import type { AgentTask } from './agents/tasks.js'

// --------------------------------------------------------------------------
// Browser → Hub
// --------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'create_session'; prompt: string; images?: Array<{ media_type: string; data: string }>; cwd?: string; name?: string; asAgent?: boolean }
  | { type: 'send_message'; sessionId: string; content: string; images?: Array<{ media_type: string; data: string }>; dedupeKey?: string }
  | { type: 'approve_tool'; sessionId: string; requestId: string; modifiedInput?: Record<string, unknown> }
  | { type: 'deny_tool'; sessionId: string; requestId: string; reason?: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'kill_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'reload_session'; sessionId: string }
  | { type: 'reload_al' }
  | { type: 'list_sessions' }
  | { type: 'resume_session'; sessionId: string; prompt: string; cwd?: string }
  | { type: 'list_past_sessions'; cwd: string }
  | { type: 'get_session_history'; sessionId: string }
  | { type: 'rename_session'; sessionId: string; name: string }
  | { type: 'generate_title'; sessionId: string }
  | { type: 'fork_session'; sessionId: string; cwd?: string; seedRole?: boolean; seed?: boolean }
  | { type: 'get_older_messages'; sessionId: string; beforeIndex: number; limit?: number }
  | { type: 'reorder_sessions'; order: string[] }
  | { type: 'set_collapsed_groups'; collapsed: string[] }
  | { type: 'mark_session_read'; sessionId: string }
  | { type: 'mark_session_unread'; sessionId: string }
  | { type: 'clear_attention'; sessionId: string }
  | { type: 'get_model' }
  | { type: 'set_model'; model: string }
  /** Pin ONE session to a model (mid-session; fast set_model path with respawn
   *  fallback). `model: null` clears the pin — back to the hub-wide model. */
  | { type: 'set_session_model'; sessionId: string; model: string | null }
  | { type: 'list_agents' }
  | { type: 'set_manager'; agentKey: string; manager: string | null }
  | { type: 'get_agent_role'; agentKey: string }
  | { type: 'revive_agent'; agentKey: string }
  | { type: 'delete_role'; agentKey: string }
  | { type: 'create_folder'; title: string; manager?: string | null }
  | { type: 'rename_role'; agentKey: string; title: string }
  // --- Delegation (org-aware task routing) ---
  /** Delegate work to a role. `toKey` OR a `newRole` spec (mints a role first).
   *  `fromKey` defaults to 'al' (top of a human chain) when omitted. */
  | { type: 'delegate'; toKey?: string; newRole?: { title: string; cwd?: string; manager?: string | null }; title?: string; brief: string; fromKey?: string; parentTaskId?: string | null; ephemeral?: boolean }
  /** Report a task result back to its delegator. */
  | { type: 'report'; taskId: string; result: string; status?: 'done' | 'blocked' | 'failed' }
  | { type: 'cancel_task'; taskId: string }
  | { type: 'tasks_list' }
  /** Merge a fork back into its parent: the fork summarises, the digest is
   *  injected into the parent, then the fork is killed. */
  | { type: 'merge_session'; sessionId: string }

// --------------------------------------------------------------------------
// Hub → Browser
// --------------------------------------------------------------------------

export type HubMessage =
  | { type: 'session_created'; sessionId: string; cwd: string; prompt: string; name?: string }
  | { type: 'session_init'; sessionId: string; claudeSessionId: string; model: string; slashCommands: string[]; contextWindow: number; permissionMode?: string }
  | { type: 'context_update'; sessionId: string; used: number; total: number; breakdown?: ContextBreakdownEntry[] }
  | { type: 'sessions_list'; sessions: SessionInfo[] }
  | { type: 'project_dirs'; dirs: string[] }
  | { type: 'text'; sessionId: string; content: string }
  | { type: 'text_delta'; sessionId: string; content: string }
  | { type: 'thinking'; sessionId: string; content: string }
  | { type: 'thinking_delta'; sessionId: string; content: string }
  | { type: 'tool_use'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; content: string; isError: boolean }
  /** The tool call's arguments streaming in (input_json_delta) — lets the UI
   *  show an Edit/Write being typed live, terminal-style. Ephemeral. */
  | { type: 'tool_input_delta'; sessionId: string; toolUseId: string; toolName: string; content: string }
  /** A ready-made unified diff for an Edit/Write, mined from the CLI's
   *  tool_use_result.structuredPatch. Paired to the tool call by toolUseId. */
  | { type: 'tool_diff'; sessionId: string; toolUseId: string; filePath: string; hunks: StructuredPatchHunk[] }
  /** Background bash / Task subagent lifecycle (system/task_* events). */
  | { type: 'bg_task'; sessionId: string; taskId: string; toolUseId?: string; status: 'started' | 'completed' | 'failed'; description?: string; taskType?: string; summary?: string }
  | { type: 'approval_required'; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'result'; sessionId: string; cost: number; tokens: TokenUsage; duration: number; sessionIdClaude: string; ttftMs?: number; stopReason?: string | null; numTurns?: number; modelUsage?: ResultModelUsage[] }
  | { type: 'user_prompt'; sessionId: string; content: string; images?: string[] }
  | { type: 'tool_approved'; sessionId: string; requestId: string; toolName: string }
  | { type: 'tool_denied'; sessionId: string; requestId: string; toolName: string; reason?: string }
  | { type: 'status'; sessionId: string; text: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'past_sessions'; sessions: PastSession[] }
  | { type: 'session_history'; sessionId: string; messages: SessionHistoryMessage[] }
  | { type: 'session_renamed'; sessionId: string; name: string }
  | { type: 'session_order'; order: string[] }
  | { type: 'collapsed_groups'; collapsed: string[] }
  | { type: 'session_read_state'; sessionId: string; lastReadIndex: number; messageLogLength: number }
  | { type: 'older_messages'; sessionId: string; messages: HubMessage[]; hasMore: boolean }
  /** A session emitted `@amar` and wants Yousef's eyes. `needsAttention: null`
   *  clears the marker. `push` is a transport-only hint (not persisted) telling
   *  the hub whether to also fire a push notification this time (dedup/anti-noise
   *  gated in Session). */
  | { type: 'session_attention'; sessionId: string; sessionName?: string; needsAttention: AttentionState | null; push?: boolean }
  /** Active agent model + fallback chain. Broadcast on change (manual set or
   *  auto-fallback). `autoFellBack` + `failedModel` are set only when the hub
   *  advanced the model itself after a model-unavailable failure. */
  | { type: 'model_state'; model: string; chain: string[]; lockedByEnv: boolean; backend?: 'first_party' | 'bedrock'; autoFellBack?: boolean; failedModel?: string }
  /** Org-chart roles + derived manager tree. Pushed on connect and on every
   *  registry change (an agent editing its file, a reparent, create/delete). */
  | { type: 'agents_list'; roles: AgentRole[]; tree: OrgNode[] }
  | { type: 'agent_role'; role: AgentRole }
  /** Delegation tasks. Pushed on connect and on every task change. */
  | { type: 'tasks'; tasks: AgentTask[] }
  /** An agent emitted `@handoff(<agentKey>)` — Al wants to put Yousef in direct
   *  contact with that agent. The SPA renders an opt-in "Talk to X" affordance. */
  | { type: 'session_handoff'; sessionId: string; targetAgentKey: string }
  /** A fork was merged into its parent (summary folded in, fork closed). */
  | { type: 'session_merged'; forkId: string; parentId: string; summary: string }
  | { type: 'hub_error'; message: string }

/** Messages that are stored in the per-session log for replay (excludes ephemeral status, deltas, list responses) */
export type LoggableHubMessage = Extract<HubMessage,
  | { type: 'session_created' }
  | { type: 'session_init' }
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use' }
  | { type: 'tool_result' }
  | { type: 'tool_diff' }
  | { type: 'bg_task' }
  | { type: 'approval_required' }
  | { type: 'result' }
  | { type: 'user_prompt' }
  | { type: 'tool_approved' }
  | { type: 'tool_denied' }
  | { type: 'error' }
  | { type: 'session_ended' }
  | { type: 'session_renamed' }
  | { type: 'context_update' }
>

export interface SessionHistoryMessage {
  type: 'user_prompt' | 'text' | 'thinking' | 'tool_use' | 'tool_result'
  content?: string
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  isError?: boolean
  images?: string[]
}

export interface PastSession {
  sessionId: string
  prompt: string
  date: number
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

/** One category from the CLI's get_context_usage breakdown (system prompt /
 *  tools / messages / free space …), forwarded on context_update. */
export interface ContextBreakdownEntry {
  name: string
  tokens: number
}

/** Per-model usage row on the result footer (from the CLI's modelUsage). */
export interface ResultModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

/** Set when a session emits `@amar` to pull Yousef's attention. Sticky until
 *  he opens the session (or marks it read). Persisted in the manifest. */
export interface AttentionState {
  ts: number
  /** Short excerpt of the assistant text around the `@amar` mention, for the
   *  push body + sidebar tooltip. */
  snippet: string
}

export interface SessionInfo {
  id: string
  claudeSessionId?: string
  name?: string
  /** claudeSessionId of the parent session if this is a fork — nests forks
   *  under their parent in the sidebar. */
  parentClaudeSessionId?: string
  /** Durable org-chart role key (agents/registry.ts) this session embodies, if
   *  any. The client joins to the role tree (agents_list) to find its manager. */
  agentKey?: string
  status: 'running' | 'idle' | 'ended'
  createdAt: number
  prompt: string
  cwd?: string
  totalCost: number
  totalTokens: TokenUsage
  /** Per-session model pin — set when this session is pinned to a model other
   *  than the hub-wide one (undefined = follows the hub model). */
  modelOverride?: string
  messageLogLength?: number
  /** Present when the session is flagged for Yousef's attention (`@amar`). */
  needsAttention?: AttentionState | null
  /** Hub-persisted: index of the last message the user has marked read.
   *  Client derives `hasUnread = (messageLogLength ?? 0) > (lastReadIndex ?? 0)`. */
  lastReadIndex?: number
  /** Idle subprocess was reaped to reclaim memory; session wakes (re-spawns
   *  with --resume) transparently on the next message. */
  hibernated?: boolean
  /** Live count of direct child processes of the claude subprocess —
   *  approximates background `Bash{run_in_background:true}` shells still
   *  alive. From `ps -eo pid,ppid` via `process-tree.ts`; refreshed on a
   *  3-sec cache. Undefined when the session isn't running. */
  backgroundProcessCount?: number
  gitBranch?: string
  gitDirty?: boolean
  gitStats?: { added: number; deleted: number }
}

// --------------------------------------------------------------------------
// Claude CLI stream-json protocol (stdout NDJSON)
// --------------------------------------------------------------------------

export interface ClaudeSystemMessage {
  type: 'system'
  /** `init` on spawn; the CLI also emits lifecycle subtypes we consume:
   *  `status` (model request started), `task_started`/`task_notification`/
   *  `task_updated` (background bash + Task subagents), `compact_boundary`
   *  (auto-compaction happened here). Unknown subtypes are ignored. */
  subtype: 'init' | 'status' | 'task_started' | 'task_notification' | 'task_updated' | 'compact_boundary' | (string & {})
  session_id: string
  tools?: string[]
  model?: string
  slash_commands?: string[]
  permissionMode?: string
  // -- subtype: 'status'
  status?: string
  // -- subtype: task_* (background bash / Task subagents)
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  subagent_type?: string
  summary?: string
  output_file?: string
  patch?: { status?: string; [k: string]: unknown }
}

export interface ClaudeAssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ClaudeContentBlock[]
  }
  parent_tool_use_id?: string
}

export interface ClaudeUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: ClaudeContentBlock[]
  }
  /** Rich tool result the CLI attaches alongside the text tool_result block.
   *  For Edit/Write it carries `structuredPatch` (a ready-made unified diff)
   *  + `originalFile`/`userModified` — the same data the terminal's diff view
   *  renders. Shape varies by tool; we only mine the diff fields. */
  tool_use_result?: {
    filePath?: string
    structuredPatch?: StructuredPatchHunk[]
    userModified?: boolean
    [k: string]: unknown
  }
  parent_tool_use_id?: string
}

/** One hunk of the CLI's `structuredPatch` (jsdiff format): `lines` carry
 *  their own `+`/`-`/` ` prefixes. */
export interface StructuredPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface ClaudeResultMessage {
  type: 'result'
  subtype: 'success' | 'error' | 'error_max_turns'
  duration_ms: number
  session_id: string
  total_cost_usd: number
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  result?: string
  // -- Rich metadata (present on current CLIs; all optional for back-compat)
  /** Time to first token, ms. */
  ttft_ms?: number
  stop_reason?: string | null
  /** Why the turn ended from the CLI's perspective (e.g. 'completed'). */
  terminal_reason?: string
  num_turns?: number
  /** Per-model usage/cost breakdown — keys are model ids (incl. Bedrock ARNs). */
  modelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    costUSD?: number
    contextWindow?: number
  }>
}

export interface ClaudeControlRequest {
  type: 'control_request'
  id: string
  subtype: 'can_use_tool'
  tool_name: string
  input: Record<string, unknown>
}

export interface ClaudeStreamEvent {
  type: 'stream_event'
  event: {
    type: string
    index?: number
    /** On content_block_start — lets us map a block index to its toolUseId so
     *  later input_json_delta events can be attributed to the right tool call. */
    content_block?: { type: string; id?: string; name?: string }
    delta?: {
      type: string
      text?: string
      thinking?: string
      /** input_json_delta — the tool call's arguments streaming in. */
      partial_json?: string
    }
  }
}

/** CLI's reply to a control_request we wrote to stdin (set_model,
 *  get_context_usage, …). `response.response` is verb-specific. */
export interface ClaudeControlResponseMessage {
  type: 'control_response'
  response: {
    subtype: 'success' | 'error'
    request_id: string
    response?: Record<string, unknown>
    error?: string
  }
}

export type ClaudeStdoutMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultMessage
  | ClaudeControlRequest
  | ClaudeControlResponseMessage
  | ClaudeStreamEvent

// Content blocks within assistant/user messages
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ClaudeToolResultContent[]; is_error?: boolean }

export interface ClaudeToolResultContent {
  type: 'text'
  text: string
}

// Messages written to Claude's stdin
export type ClaudeStdinContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export interface ClaudeStdinUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | ClaudeStdinContentBlock[]
  }
}

export interface ClaudeStdinControlResponse {
  type: 'control_response'
  id: string
  permission: {
    behavior: 'allow' | 'deny'
    updated_input?: Record<string, unknown>
    message?: string
  }
}

export type ClaudeStdinMessage = ClaudeStdinUserMessage | ClaudeStdinControlResponse
