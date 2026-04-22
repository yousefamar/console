// Agents pane renderer.
//
// Body:
//   row 2-3: last text/tool activity from the active session
//   row 4  : status line (approval pending? running? idle?)
//   row 5  : composer echo (prompt input)
//
// We keep this simple: the full agent transcript is far too dense for 40
// cols. We condense to "last assistant text" + "status glyph".

import { useAgentStore } from '@/store/agent'
import { useGlassesStore } from '../store'
import { buildStatus, clipRow, composerRow, wrapLine, type MirrorFrame, DISPLAY_COLS, BODY_ROWS } from '../mirror'

function lastAssistantText(messages: { block: { type: string; content?: string; text?: string; toolName?: string } }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const b = messages[i]!.block
    if (b.type === 'text' && b.content) return b.content
    if (b.type === 'tool_use' && b.toolName) return `⚙ ${b.toolName}`
    if (b.type === 'status' && b.text) return b.text
  }
  return ''
}

export function renderAgents(): MirrorFrame | null {
  const { sessions, activeSessionId, messagesBySession, pendingApproval } = useAgentStore.getState()
  const composer = useGlassesStore.getState().composerText.agents
  const session = sessions.find((s) => s.id === activeSessionId) || null

  if (!session) {
    return {
      status: buildStatus(['Agents', 'no session']),
      body: [composerRow(composer ?? '')],
    }
  }

  const name = session.name || session.prompt.slice(0, 30) || session.id.slice(0, 8)
  const statusGlyph =
    pendingApproval?.sessionId === session.id
      ? `approve ${pendingApproval.toolName}?`
      : session.status === 'running'
        ? session.statusText || 'running…'
        : session.status

  const messages = messagesBySession[session.id] ?? []
  const text = lastAssistantText(messages as never).replace(/\s+/g, ' ').trim()

  // Body budget: BODY_ROWS - 1 (last row is composer). Reserve 1 row for
  // status glyph, rest for last-text wrapped.
  const bodyBudget = BODY_ROWS - 1
  const textRows = bodyBudget - 1
  const wrapped = text ? wrapLine(text, '', '', DISPLAY_COLS).slice(-textRows) : []
  const padded: string[] = []
  while (padded.length + wrapped.length < textRows) padded.push('')
  const textBlock = [...padded, ...wrapped].map((r) => clipRow(r))

  return {
    status: buildStatus(['Agents', name]),
    body: [...textBlock, clipRow(`· ${statusGlyph}`), composerRow(composer ?? '')],
  }
}
