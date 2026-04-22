// Mail pane renderer.
//
// Shows the currently-selected thread's subject + from + snippet. If no
// thread is selected, shows the top of the inbox (next 4 unread subjects).

import { useInboxStore } from '@/store/inbox'
import { buildStatus, clipRow, wrapLine, type MirrorFrame, DISPLAY_COLS, BODY_ROWS } from '../mirror'

function senderShort(from: string | undefined): string {
  if (!from) return ''
  // `"Name" <addr>` → Name; otherwise take local-part of addr.
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/)
  if (m) return m[1]!.trim()
  const at = from.indexOf('@')
  return at > 0 ? from.slice(0, at) : from
}

export function renderMail(): MirrorFrame | null {
  const { threads, selectedThreadId, selectedMessages } = useInboxStore.getState()
  const unread = threads.filter((t) => t.isUnread).length

  if (selectedThreadId) {
    const thread = threads.find((t) => t.id === selectedThreadId) || null
    const latest = selectedMessages[selectedMessages.length - 1]
    const subject = thread?.subject || '(no subject)'
    const from = senderShort(latest?.from || thread?.from)
    const snippet = (latest?.snippet || thread?.snippet || '').replace(/\s+/g, ' ').trim()

    const subjectRows = wrapLine(subject, '', '', DISPLAY_COLS).slice(0, 1)
    const fromRow = from ? clipRow(`↳ ${from}`) : ''
    const snippetBudget = BODY_ROWS - subjectRows.length - (fromRow ? 1 : 0)
    const snippetRows = snippet ? wrapLine(snippet, '', '', DISPLAY_COLS).slice(0, snippetBudget) : []
    const body: string[] = [
      ...subjectRows,
      ...(fromRow ? [fromRow] : []),
      ...snippetRows,
    ]
    return {
      status: buildStatus(['Mail', thread?.subject ? 'open' : null, unread > 0 ? `${unread}u` : null]),
      body,
    }
  }

  // Inbox list — top 4 unread subjects.
  const top = threads.filter((t) => t.isUnread).slice(0, BODY_ROWS)
  const body = top.map((t) => clipRow(`${senderShort(t.from) || '?'}: ${t.subject || '(no subject)'}`))
  return {
    status: buildStatus(['Mail', 'inbox', unread > 0 ? `${unread}u` : 'zero']),
    body,
  }
}
