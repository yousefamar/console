// Debug agent protocol types — browser ↔ hub ↔ Claude Code

// Browser → Hub
export type DebugClientMessage =
  | { type: 'debug_events'; events: DebugEvent[] }
  | { type: 'debug_eval_result'; id: string; result: string; error?: string }
  | { type: 'debug_state'; id: string; stores: Record<string, unknown> }
  | { type: 'debug_screenshot'; id: string; dataUrl: string; error?: string }

// Hub → Browser
export type DebugHubMessage =
  | { type: 'debug_eval'; id: string; code: string }
  | { type: 'debug_get_state'; id: string; stores?: string[] }
  | { type: 'debug_screenshot'; id: string }
  | { type: 'debug_toggle'; enabled: boolean }

// Individual debug event (batched in debug_events)
export interface DebugEvent {
  ts: number
  cat: 'console' | 'net' | 'error' | 'perf'

  // console
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug'
  args?: string[]

  // net (fetch)
  method?: string
  url?: string
  status?: number
  duration?: number
  reqBody?: string
  resBody?: string

  // error
  message?: string
  stack?: string
  filename?: string
  lineno?: number
  colno?: number
}
