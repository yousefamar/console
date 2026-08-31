// Folders whose feeds never appear in aggregated views by default — the
// legacy Feeds pane's "All" list + unread badge (store/feeds.ts) and the
// unified Inbox pane's Feed column (which gets an opt-in "only these" mode).
// They still surface when the folder or one of its feeds is opened directly.
// Pure module: the Inbox route adapter is unit-tested in a node env and must
// not drag the Dexie-backed feeds store in.

const HIDDEN_FOLDERS = new Set(['x'])

export function isHiddenFolder(folder: string | null | undefined): boolean {
  return !!folder && HIDDEN_FOLDERS.has(folder.toLowerCase())
}
