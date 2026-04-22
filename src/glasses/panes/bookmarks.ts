// Bookmarks pane renderer.
//
// Selected bookmark: title + url + tags. Otherwise top filtered results.

import { useBookmarkStore, filterBookmarks } from '@/store/bookmarks'
import { buildStatus, clipRow, wrapLine, type MirrorFrame, DISPLAY_COLS, BODY_ROWS } from '../mirror'

export function renderBookmarks(): MirrorFrame | null {
  const {
    bookmarks,
    selectedBookmarkId,
    searchQuery,
    selectedTag,
    triageMode,
    triageIndex,
  } = useBookmarkStore.getState()

  const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)

  if (selectedBookmarkId) {
    const bm = bookmarks.find((b) => b.filename === selectedBookmarkId)
    if (bm) {
      const titleRows = wrapLine(bm.title, '', '', DISPLAY_COLS).slice(0, 2)
      const urlRow = clipRow(bm.url)
      const tagsRow = bm.tags.length > 0 ? clipRow(`# ${bm.tags.slice(0, 5).join(' ')}`) : ''
      const body = [
        ...titleRows,
        urlRow,
        ...(tagsRow ? [tagsRow] : []),
      ].slice(0, BODY_ROWS)
      return {
        status: buildStatus([
          'Bookmarks',
          triageMode ? `triage ${triageIndex + 1}/${filtered.length}` : 'open',
        ]),
        body,
      }
    }
  }

  const top = filtered.slice(0, BODY_ROWS)
  const body = top.map((bm) => clipRow(bm.title))

  return {
    status: buildStatus([
      'Bookmarks',
      selectedTag ? `#${selectedTag}` : null,
      `${filtered.length}`,
    ]),
    body,
  }
}
