// Gmail user labels: id → display name.
//
// A thread's `labelIds` mixes Gmail's system ids (INBOX, UNREAD,
// CATEGORY_*) with the user's own, which are always `Label_*`. Only the
// user's are worth showing — the system ones are already the pane itself.
//
// An id with no entry in the map is DROPPED, never rendered raw: a badge
// reading `Label_32` is worse than no badge, and it is what Yousef saw
// (^zany-fox) because the map was only ever written by a full sync, so
// every label created since the last one resolved to its id. `syncLabels`
// now self-heals on exactly this condition — see gmail/sync.ts.

export const USER_LABEL_PREFIX = 'Label_'

export function isUserLabel(id: string): boolean {
  return id.startsWith(USER_LABEL_PREFIX)
}

/** Display names for a thread's user labels, in the order Gmail listed them.
 *  Unknown ids are omitted. */
export function userLabelNames(labelIds: readonly string[] | undefined, labelMap: Record<string, string> | undefined): string[] {
  if (!labelIds?.length || !labelMap) return []
  const names: string[] = []
  for (const id of labelIds) {
    if (!isUserLabel(id)) continue
    const name = labelMap[id]
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** Ids a thread carries that the map can't name — the signal to re-fetch. */
export function unknownUserLabels(labelIds: readonly string[] | undefined, labelMap: Record<string, string> | undefined): string[] {
  if (!labelIds?.length) return []
  return labelIds.filter((id) => isUserLabel(id) && !labelMap?.[id])
}
