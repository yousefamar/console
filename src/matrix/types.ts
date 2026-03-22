// Matrix Client-Server API types

// --- API Response Types ---

export interface MatrixLoginResponse {
  user_id: string
  access_token: string
  device_id: string
  home_server?: string
  well_known?: {
    'm.homeserver': { base_url: string }
  }
}

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>
    invite?: Record<string, MatrixInvitedRoom>
    leave?: Record<string, unknown>
  }
  account_data?: { events?: MatrixEvent[] }
  // E2EE fields
  to_device?: { events?: MatrixEvent[] }
  device_lists?: { changed?: string[]; left?: string[] }
  device_one_time_keys_count?: Record<string, number>
  device_unused_fallback_key_types?: string[]
}

export interface MatrixJoinedRoom {
  timeline?: {
    events?: MatrixEvent[]
    prev_batch?: string
    limited?: boolean
  }
  state?: { events?: MatrixEvent[] }
  account_data?: { events?: MatrixEvent[] }
  unread_notifications?: {
    notification_count?: number
    highlight_count?: number
  }
  ephemeral?: { events?: MatrixEvent[] }
}

export interface MatrixInvitedRoom {
  invite_state?: { events?: MatrixEvent[] }
}

export interface MatrixEvent {
  event_id?: string
  type: string
  content: Record<string, unknown>
  sender?: string
  origin_server_ts?: number
  state_key?: string
  unsigned?: {
    age?: number
    transaction_id?: string
    prev_content?: Record<string, unknown>
    'm.relations'?: Record<string, unknown>
  }
}

export interface MatrixRoomEvent extends MatrixEvent {
  event_id: string
  sender: string
  origin_server_ts: number
  room_id: string
}

export interface MatrixMessagesResponse {
  start: string
  end?: string
  chunk: MatrixRoomEvent[]
  state?: MatrixEvent[]
}

export interface MatrixWhoamiResponse {
  user_id: string
  device_id?: string
}

// --- Message Content Types ---

export interface MatrixTextContent {
  msgtype: 'm.text' | 'm.notice' | 'm.emote'
  body: string
  format?: 'org.matrix.custom.html'
  formatted_body?: string
  'm.relates_to'?: MatrixRelatesTo
}

export interface MatrixImageContent {
  msgtype: 'm.image'
  body: string
  url?: string // mxc:// URL
  info?: {
    mimetype?: string
    size?: number
    w?: number
    h?: number
    thumbnail_url?: string
  }
}

export interface MatrixFileContent {
  msgtype: 'm.file'
  body: string
  url?: string
  filename?: string
  info?: {
    mimetype?: string
    size?: number
  }
}

export type MatrixMessageContent = MatrixTextContent | MatrixImageContent | MatrixFileContent

export interface MatrixRelatesTo {
  rel_type?: string // 'm.replace', 'm.annotation', 'm.thread'
  event_id?: string
  'm.in_reply_to'?: { event_id: string }
  key?: string // for reactions
}

// --- Local Database Types ---

export interface DbChatRoom {
  id: string                   // Matrix room ID (!abc:matrix.org)
  name: string                 // Room name or DM contact name
  avatar?: string              // MXC URL (converted to HTTP for display)
  isDirect: boolean            // DM vs group chat
  memberCount: number
  lastMessageBody?: string     // Snippet for inbox list
  lastMessageSender?: string   // Display name of last sender
  lastMessageTime: number      // Timestamp ms — sort key
  isUnread: boolean            // Has unread messages
  unreadCount?: number         // Server notification_count (for badge)
  lastReadEventId?: string     // Read receipt marker
  lastReadTs?: number          // Timestamp of latest message when marked read
  isMuted: boolean
  isLowPriority: boolean       // m.lowpriority or m.archive tag — only surface on @mention
  tags?: string[]              // Raw Matrix room tags (m.favourite, m.lowpriority, etc.)
  isEncrypted: boolean         // Room has m.room.encryption state event
  networkIcon?: string         // Bridge type: 'whatsapp' | 'signal' | 'telegram' | etc.
  snoozedUntil?: number        // Timestamp ms (same pattern as email snooze)
  prevBatch?: string           // Pagination token for loading older messages
  readReceipts?: Record<string, { eventId: string; ts: number; displayName?: string; avatar?: string }>
}

export interface DbChatMessage {
  id: string                   // Matrix event ID ($abc)
  roomId: string
  senderId: string             // @user:matrix.org
  senderName: string
  senderAvatar?: string        // MXC URL
  body: string                 // Plain text
  formattedBody?: string       // HTML (org.matrix.custom.html)
  timestamp: number            // origin_server_ts
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'notice' | 'emote'
  mediaUrl?: string              // mxc:// URL for images/files (unencrypted)
  encryptedFile?: EncryptedFile  // Encrypted attachment metadata (E2EE rooms)
  replyTo?: {
    eventId: string
    body: string
    sender: string
  }
  isEdited: boolean
  originalBody?: string            // Body before edit (for diff view)
  isDeleted?: boolean              // Redacted/deleted message
  deletedBy?: string               // Who deleted it
  reactions?: Record<string, string[]> // emoji → senderIds
  mediaMimeType?: string     // MIME type from info.mimetype (for audio/file decryption)
  audioDuration?: number     // Duration in milliseconds (m.audio)
  audioWaveform?: number[]   // MSC 1767 waveform values (m.audio)
  isVoiceNote?: boolean      // MSC 3245 voice message flag
  encryptedEvent?: string // JSON of original m.room.encrypted event (for retry after key import)
  sendFailed?: string       // Error message if local echo failed to send
}

// --- Encrypted File (E2EE attachment) ---

export interface EncryptedFile {
  url: string          // mxc:// URL of encrypted blob
  key: {
    kty: string
    key_ops: string[]
    alg: string
    k: string          // base64url AES key
    ext: boolean
  }
  iv: string           // base64 IV
  hashes: Record<string, string>
  v: string
}

// --- Queue Action Types ---

export type ChatQueueActionType =
  | 'chatSend'
  | 'chatMarkRead'
  | 'chatEdit'
  | 'chatReact'
