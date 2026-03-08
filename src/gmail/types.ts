// Gmail API response types

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
  historyId: string
}

export interface GmailMessagePartHeader {
  name: string
  value: string
}

export interface GmailMessagePartBody {
  attachmentId?: string
  size: number
  data?: string // base64url encoded
}

export interface GmailMessagePart {
  partId: string
  mimeType: string
  filename: string
  headers: GmailMessagePartHeader[]
  body: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  historyId: string
  internalDate: string
  payload: GmailMessagePart
  sizeEstimate: number
  raw?: string
}

export interface GmailThread {
  id: string
  historyId: string
  messages: GmailMessage[]
}

export interface GmailLabel {
  id: string
  name: string
  type: string
}

export interface GmailHistoryRecord {
  id: string
  messages?: { id: string; threadId: string }[]
  messagesAdded?: { message: { id: string; threadId: string; labelIds: string[] } }[]
  messagesDeleted?: { message: { id: string; threadId: string } }[]
  labelsAdded?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[]
  labelsRemoved?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[]
}

export interface GmailSendAs {
  sendAsEmail: string
  displayName: string
  isDefault: boolean
  isPrimary: boolean
}

export interface SendAsAlias {
  email: string
  name: string
  isDefault: boolean
}

// Local database types

export interface DbThread {
  id: string
  historyId: string
  snippet: string
  subject: string
  from: string
  fromEmail: string
  date: number // timestamp ms
  messageCount: number
  isUnread: boolean
  labelIds: string[]
  hasAttachments: boolean
  // Snooze
  snoozedUntil?: number // timestamp ms
}

export interface AttachmentMeta {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
  contentId?: string // for CID inline images
}

export interface CalendarEvent {
  summary: string
  location?: string
  description?: string
  start: number    // timestamp ms
  end: number      // timestamp ms
  organizer?: { name?: string; email: string }
  attendees?: { name?: string; email: string; status: string }[]
  status?: string  // CONFIRMED, CANCELLED, TENTATIVE
  method?: string  // REQUEST, CANCEL, REPLY
}

export interface DbMessage {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  from: string
  fromEmail: string
  to: string
  cc: string
  date: number
  subject: string
  bodyHtml: string
  bodyText: string
  historyId: string
  isUnread: boolean
  headers: Record<string, string>
  attachments?: AttachmentMeta[]
  calendarEvent?: CalendarEvent
}

export interface DbAttachmentData {
  attachmentId: string
  messageId: string
  data: Blob
  mimeType: string
  filename: string
}

export type QueueActionType =
  | 'archive'
  | 'unarchive'
  | 'trash'
  | 'markRead'
  | 'markUnread'
  | 'snooze'
  | 'unsnooze'
  | 'send'

export interface QueuedAction {
  id?: number // auto-increment
  type: QueueActionType
  threadId?: string
  messageId?: string
  draftId?: string
  payload: Record<string, unknown>
  createdAt: number
  status: 'pending' | 'processing' | 'failed' | 'conflict'
  error?: string
  retryCount: number
}
