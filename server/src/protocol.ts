// ============================================================================
// Console Agent Hub ↔ Browser Protocol
//
// All messages between the hub's WebSocket server and the Console frontend
// are JSON-encoded instances of these types.
// ============================================================================

// --------------------------------------------------------------------------
// Browser → Hub
// --------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'create_session'; prompt: string; images?: Array<{ media_type: string; data: string }>; cwd?: string; name?: string }
  | { type: 'send_message'; sessionId: string; content: string; images?: Array<{ media_type: string; data: string }> }
  | { type: 'approve_tool'; sessionId: string; requestId: string; modifiedInput?: Record<string, unknown> }
  | { type: 'deny_tool'; sessionId: string; requestId: string; reason?: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'kill_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'list_sessions' }
  | { type: 'resume_session'; sessionId: string; prompt: string; cwd?: string }
  | { type: 'list_past_sessions'; cwd: string }
  | { type: 'get_session_history'; sessionId: string }
  | { type: 'rename_session'; sessionId: string; name: string }
  | { type: 'generate_title'; sessionId: string }
  | { type: 'fork_session'; sessionId: string; cwd?: string }
  | { type: 'get_older_messages'; sessionId: string; beforeIndex: number; limit?: number }
  | { type: 'reorder_sessions'; order: string[] }
  | { type: 'set_collapsed_groups'; collapsed: string[] }
  | { type: 'mark_session_read'; sessionId: string }
  | { type: 'mark_session_unread'; sessionId: string }

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

export interface SessionInfo {
  id: string
  claudeSessionId?: string
  name?: string
  status: 'running' | 'idle' | 'ended'
  createdAt: number
  prompt: string
  cwd?: string
  totalCost: number
  totalTokens: TokenUsage
  messageLogLength?: number
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
