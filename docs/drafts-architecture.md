# Drafts Architecture (Removed)

This document describes how drafts worked before they were removed from the codebase.
Drafts were removed because they are an anti-pattern in an inbox-zero tool — you deal
with emails immediately or snooze them. No half-written replies hanging around.

## Overview

The draft system provided auto-saving of in-progress email compositions to both local
IndexedDB and Gmail's Drafts API. It also supported standalone drafts (new compositions
not tied to a thread) and schedule-send (saving a draft with a future send time).

## Data Model

### DbDraft (stored in Dexie `drafts` table)

```ts
interface DbDraft {
  id: string              // local UUID
  threadId?: string       // associated thread (undefined for standalone)
  to: string
  cc: string
  subject: string
  bodyMarkdown: string
  bodyHtml: string
  gmailDraftId?: string   // Gmail API draft ID (set after first sync)
  updatedAt: number       // timestamp ms
  scheduledAt?: number    // for schedule-send feature
}
```

Dexie indexes: `id` (primary), `threadId`, `updatedAt`, `scheduledAt`

### DbThread draft fields (runtime-injected, not persisted)

```ts
// Added to DbThread at runtime during useSync merge:
draftId?: string       // local draft ID associated with this thread
isDraftOnly?: boolean  // true for standalone drafts (no real Gmail thread)
```

### QueueActionTypes

- `saveDraft` — create or update a Gmail draft
- `deleteDraft` — delete a Gmail draft
- `scheduleSend` — queue a draft for future sending

## Auto-Save System

The compose store had an auto-save mechanism:

1. Module-level variables: `autoSaveTimer` and `autoSavePaused`
2. `scheduleAutoSave()` — called on every field change (setTo, setCc, setSubject, setBody)
3. Debounced at 3 seconds — after 3s of no changes, `saveDraft()` fires
4. `pauseAutoSave()` / `resumeAutoSave()` — used by ComposeEditor during field initialization
   to avoid creating orphan drafts when populating reply/forward fields

### Auto-Save Flow

```
User types → setBody() → scheduleAutoSave() → 3s timeout → saveDraft()
  → writes to Dexie `drafts` table
  → enqueues `saveDraft` action to sync queue
  → queue flushes within 500ms
  → processQueue calls Gmail API (createDraft or updateDraft)
  → on first create, syncs gmailDraftId back to Dexie and Zustand
```

## Compose Store Draft State

```ts
// State fields
draftId: string | null        // local draft ID
gmailDraftId: string | null   // Gmail API draft ID

// Actions
loadDraft(draftId)    — load draft from Dexie into compose state
saveDraft(threadId?)  — save current compose state to Dexie + enqueue sync
discard()             — delete local draft + enqueue Gmail draft deletion + reset
scheduleSend(sendAt)  — save as draft with scheduledAt + enqueue scheduleSend
```

## Gmail API Functions (in api.ts)

```ts
createDraft(opts)         — POST /drafts with raw MIME
updateDraft(draftId, opts) — PUT /drafts/{id} with raw MIME
deleteDraft(draftId)      — DELETE /drafts/{id}
listDrafts()              — GET /drafts (up to 500, returns {id}[])
```

## Sync Integration

### reconcileDrafts() (called after fullSync and incrementalSync)

Compared local drafts against Gmail's draft list. If a local draft had a
`gmailDraftId` that no longer existed on Gmail, the local draft was deleted.

### processQueue handlers

- `saveDraft`: If `existingDraftId` present, called `updateDraft()`. Otherwise called
  `createDraft()` and synced the new `gmailDraftId` back to Dexie and Zustand.
- `deleteDraft`: Called `api.deleteDraft()` with the `gmailDraftId`.
- `send` case also deleted the associated Gmail draft after sending.

## Thread List Integration (useSync.ts)

The `useSync` hook had a live query on `db.drafts` that merged drafts into the
thread list:

1. **Thread-associated drafts**: Threads with matching drafts got a `draftId` annotation
2. **Standalone drafts**: Created synthetic `DbThread` entries with `id: "draft:{draftId}"`,
   `isDraftOnly: true`, shown at the top of the thread list
3. Scheduled drafts (those with `scheduledAt`) were excluded from the merge

## Inbox Store Integration

### selectThread

- If thread was `isDraftOnly`, loaded the draft into compose and opened compose modal
- If thread had a `draftId`, loaded the draft into compose and set `replyMode: 'reply'`

### archiveThread

- Special handling for `draft:` prefix threads: deleted the draft from Dexie instead
  of archiving

### sendReply

- Before sending, checked for associated draft. If found, enqueued `deleteDraft`
  for the Gmail copy and deleted the local draft from Dexie.
- Special handling for `draft:` prefix threads: sent without threadId

## ComposeEditor Integration

- Called `pauseAutoSave()` during field initialization (reply/forward setup)
- Called `resumeAutoSave()` after init complete
- Set `threadId` on compose store so auto-save associated drafts with threads
- Discard button called `compose.discard()` (which deleted draft + reset)
- Schedule button opened ScheduleMenu which called `compose.scheduleSend()`

## ThreadListItem Display

- Threads with `isDraftOnly` showed "Draft" in red instead of sender name
- Threads with `draftId` (but not `isDraftOnly`) showed a red "Draft" badge next to the date
- `isDraftOnly` threads hid the snippet line

## Why It Was Removed

1. **Anti-pattern for inbox-zero**: Drafts encourage leaving things half-done
2. **Complexity cost**: Auto-save system, reconciliation, synthetic threads, special
   archive/send paths for draft-only threads
3. **Philosophy**: Deal with emails now or snooze them. Compose and send in one motion.
