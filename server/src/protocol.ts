// ============================================================================
// Console Agent Hub ↔ Browser Protocol
//
// All messages between the hub's WebSocket server and the Console frontend
// are JSON-encoded instances of these types.
// ============================================================================

import type { AgentRole, OrgNode } from './agents/registry.js'

// --------------------------------------------------------------------------
// Browser → Hub
// --------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'create_session'; prompt: string; images?: Array<{ media_type: string; data: string }>; cwd?: string; name?: string; asAgent?: boolean }
  | { type: 'send_message'; sessionId: string; content: string; images?: Array<{ media_type: string; data: string }> }
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
  | { type: 'fork_session'; sessionId: string; cwd?: string; seedRole?: boolean }
  | { type: 'get_older_messages'; sessionId: string; beforeIndex: number; limit?: number }
  | { type: 'reorder_sessions'; order: string[] }
  | { type: 'set_collapsed_groups'; collapsed: string[] }
  | { type: 'mark_session_read'; sessionId: string }
  | { type: 'mark_session_unread'; sessionId: string }
  | { type: 'clear_attention'; sessionId: string }
  | { type: 'get_model' }
  | { type: 'set_model'; model: string }
  | { type: 'list_agents' }
  | { type: 'set_manager'; agentKey: string; manager: string | null }
  | { type: 'get_agent_role'; agentKey: string }
  | { type: 'revive_agent'; agentKey: string }
  | { type: 'delete_role'; agentKey: string }

// --------------------------------------------------------------------------
// Hub → Browser
// --------------------------------------------------------------------------

export type HubMessage =
  | { type: 'session_created'; sessionId: string; cwd: string; prompt: string; name?: string }
  | { type: 'session_init'; sessionId: string; claudeSessionId: string; model: string; slashCommands: string[]; contextWindow: number; permissionMode?: string }
  | { type: 'context_update'; sessionId: string; used: number; total: number }
  | { type: 'sessions_list'; sessions: SessionInfo[] }
  | { type: 'project_dirs'; dirs: string[] }
  | { type: 'text'; sessionId: string; content: string }
  | { type: 'text_delta'; sessionId: string; content: string }
  | { type: 'thinking'; sessionId: string; content: string }
  | { type: 'thinking_delta'; sessionId: string; content: string }
  | { type: 'tool_use'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; content: string; isError: boolean }
  | { type: 'approval_required'; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'result'; sessionId: string; cost: number; tokens: TokenUsage; duration: number; sessionIdClaude: string }
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
  | { type: 'model_state'; model: string; chain: string[]; lockedByEnv: boolean; autoFellBack?: boolean; failedModel?: string }
  /** Org-chart roles + derived manager tree. Pushed on connect and on every
   *  registry change (an agent editing its file, a reparent, create/delete). */
  | { type: 'agents_list'; roles: AgentRole[]; tree: OrgNode[] }
  | { type: 'agent_role'; role: AgentRole }
  | { type: 'hub_error'; message: string }

/** Messages that are stored in the per-session log for replay (excludes ephemeral status, deltas, list responses) */
export type LoggableHubMessage = Extract<HubMessage,
  | { type: 'session_created' }
  | { type: 'session_init' }
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use' }
  | { type: 'tool_result' }
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
  messageLogLength?: number
  /** Present when the session is flagged for Yousef's attention (`@amar`). */
  needsAttention?: AttentionState | null
  /** Hub-persisted: index of the last message the user has marked read.
   *  Client derives `hasUnread = (messageLogLength ?? 0) > (lastReadIndex ?? 0)`. */
  lastReadIndex?: number
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
  subtype: 'init'
  session_id: string
  tools?: string[]
  model?: string
  slash_commands?: string[]
  permissionMode?: string
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
    delta?: {
      type: string
      text?: string
      thinking?: string
    }
  }
}

export type ClaudeStdoutMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultMessage
  | ClaudeControlRequest
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
