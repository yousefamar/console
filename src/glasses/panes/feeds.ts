// Feeds pane renderer.
//
// Shows the selected article's title + author + snippet. If no article
// selected, shows the top unread items.

import { useFeedStore } from '@/store/feeds'
import { buildStatus, clipRow, wrapLine, type MirrorFrame, DISPLAY_COLS, BODY_ROWS } from '../mirror'

export function renderFeeds(): MirrorFrame | null {
  const { items, feeds, selectedItemId, selectedFeedId, selectedFolderId, totalUnread } = useFeedStore.getState()

  if (selectedItemId) {
    const item = items.find((i) => i.id === selectedItemId)
    if (item) {
      const titleRows = wrapLine(item.title, '', '', DISPLAY_COLS).slice(0, 2)
      const authorRow = item.author ? clipRow(`↳ ${item.author}`) : ''
      const snippetBudget = BODY_ROWS - titleRows.length - (authorRow ? 1 : 0)
      const snippet = (item.contentSnippet || '').replace(/\s+/g, ' ').trim()
      const snippetRows = snippet ? wrapLine(snippet, '', '', DISPLAY_COLS).slice(0, snippetBudget) : []
      const body = [
        ...titleRows,
        ...(authorRow ? [authorRow] : []),
        ...snippetRows,
      ]
      return {
        status: buildStatus(['Feeds', 'read']),
        body,
      }
    }
  }

  const scope = selectedFeedId
    ? feeds.find((f) => f.id === selectedFeedId)?.title || 'feed'
    : selectedFolderId || 'all'

  const top = items.slice(0, BODY_ROWS)
  const body = top.map((i) => {
    const feed = feeds.find((f) => f.id === i.feedId)
    const label = feed?.title ? `${feed.title.slice(0, 14)}: ` : ''
    return clipRow(`${label}${i.title}`)
  })

  return {
    status: buildStatus(['Feeds', scope, totalUnread > 0 ? `${totalUnread}u` : null]),
    body,
  }
}
