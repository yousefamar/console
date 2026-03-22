import { db, getMeta, setMeta } from '@/db'
import { getRoomState } from './api'
import { getMatrixUserId } from './auth'
import type { MatrixEvent } from './types'

// Bridge bot user ID pattern (includes Beeper "go" variants: @slackgobot, @discordgobot, etc.)
const BRIDGE_BOT_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage|imessagecloud|meta|bluesky)bot$/i

// Ghost user ID pattern (includes Beeper "go" variants: @slackgo_*, @discordgo_*, etc.)
const GHOST_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)_/i

function ghostToNetwork(localpart: string): string | undefined {
  const m = localpart.match(GHOST_RE)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  if (raw === 'imessagecloud') return 'imessage'
  return raw.replace(/go$/, '')
}

function botToNetwork(localpart: string): string | undefined {
  const m = localpart.match(BRIDGE_BOT_RE)
  if (!m) return undefined
  return m[1]!.toLowerCase().replace(/go$/, '')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isBotUser(userId: string): boolean {
  return BRIDGE_BOT_RE.test((userId.split(':')[0] ?? ''))
}

function computeIsDirect(members: MatrixEvent[]): boolean {
  const realMembers = members.filter(
    (e) => e.content.membership === 'join' && !isBotUser(e.state_key ?? ''),
  )
  return realMembers.length <= 2
}

/**
 * One-time migration: fix room names (strip bridge bot display names),
 * fill missing networkIcon, fix isDirect/memberCount, and backfill DM avatars.
 */
export async function backfillRoomInfo(): Promise<void> {
  const KEY_NAMES = 'backfill_rooms_v2'
  const KEY_FIX = 'backfill_rooms_fix_v7'

  const namesDone = await getMeta(KEY_NAMES)
  const fixDone = await getMeta(KEY_FIX)
  if (namesDone && fixDone) return

  const rooms = await db.chatRooms.toArray()
  const myUserId = getMatrixUserId()

  // Phase 1: names + network icons (skip if already done)
  if (!namesDone) {
    const nameCandidates = rooms.filter(
      (r) => !r.networkIcon || /bridge bot/i.test(r.name),
    )
    for (const room of nameCandidates) {
      try {
        const state = await getRoomState(room.id)
        const members = state.filter(
          (e: MatrixEvent) => e.type === 'm.room.member' && e.content.membership === 'join',
        )

        let networkIcon = room.networkIcon
        if (!networkIcon) {
          let fromBot: string | undefined
          for (const member of members) {
            const localpart = (member.state_key ?? '').split(':')[0] ?? ''
            const ghost = ghostToNetwork(localpart)
            if (ghost) { networkIcon = ghost; break }
            if (!fromBot) fromBot = botToNetwork(localpart)
          }
          if (!networkIcon) networkIcon = fromBot
        }

        let name = room.name
        const botNames: string[] = []
        for (const member of members) {
          const localpart = (member.state_key ?? '').split(':')[0] ?? ''
          if (BRIDGE_BOT_RE.test(localpart)) {
            const dn = member.content.displayname as string | undefined
            if (dn) botNames.push(dn)
          }
        }
        if (botNames.length > 0) {
          for (const botName of botNames) {
            name = name
              .replace(new RegExp(`${escapeRegex(botName)},\\s*`, 'gi'), '')
              .replace(new RegExp(`,\\s*${escapeRegex(botName)}`, 'gi'), '')
              .replace(new RegExp(`^${escapeRegex(botName)}$`, 'gi'), '')
          }
          name = name.trim() || room.name
        }

        if ((networkIcon && networkIcon !== room.networkIcon) || name !== room.name) {
          await db.chatRooms.update(room.id, {
            ...(networkIcon && networkIcon !== room.networkIcon ? { networkIcon } : {}),
            ...(name !== room.name ? { name } : {}),
          })
        }
      } catch { /* non-critical */ }
    }
    await setMeta(KEY_NAMES, '1')
  }

  // Phase 2: fix isDirect/memberCount/avatar for all bridged rooms.
  // - Corrects stale isDirect from before bridge bot regex was fixed
  // - Prefers explicit m.room.avatar over participant fallback
  // - Falls back to parent Space avatar for channels (e.g. Slack workspace icon)
  // - Falls back to other member's avatar for DMs
  if (!fixDone) {
    const spaceAvatarCache = new Map<string, string | null>()

    async function getSpaceAvatar(spaceId: string): Promise<string | null> {
      if (spaceAvatarCache.has(spaceId)) return spaceAvatarCache.get(spaceId)!
      try {
        const spaceState = await getRoomState(spaceId)
        const av = spaceState.find(
          (e: MatrixEvent) => e.type === 'm.room.avatar' && e.state_key === '',
        )
        const url = (av?.content?.url as string) || null
        spaceAvatarCache.set(spaceId, url)
        return url
      } catch {
        spaceAvatarCache.set(spaceId, null)
        return null
      }
    }

    const candidates = rooms
    for (const room of candidates) {
      try {
        const state = await getRoomState(room.id)
        const joinedMembers = state.filter(
          (e: MatrixEvent) => e.type === 'm.room.member' && e.content.membership === 'join',
        )
        const direct = computeIsDirect(joinedMembers)
        const realCount = joinedMembers.filter((e) => !isBotUser(e.state_key ?? '')).length

        // Explicit room avatar from state
        const avatarEvent = state.find(
          (e: MatrixEvent) => e.type === 'm.room.avatar' && e.state_key === '',
        )
        const explicitAvatar = avatarEvent?.content?.url as string | undefined

        let needsUpdate = false
        const patch: Partial<{ isDirect: boolean; memberCount: number; avatar: string }> = {}

        if (direct !== room.isDirect) { patch.isDirect = direct; needsUpdate = true }
        if (realCount !== room.memberCount) { patch.memberCount = realCount; needsUpdate = true }

        // Avatar priority: explicit room avatar > DM member fallback > Space fallback
        if (explicitAvatar) {
          if (explicitAvatar !== room.avatar) {
            patch.avatar = explicitAvatar
            needsUpdate = true
          }
        } else if (direct) {
          // DM fallback: use member avatar when no explicit room avatar
          const otherMembers = joinedMembers.filter((e) => {
            const uid = e.state_key ?? ''
            return uid !== myUserId && !isBotUser(uid)
          })
          const avatarSource = otherMembers.length === 1
            ? otherMembers[0]
            : otherMembers.length === 0
              ? joinedMembers.find((e) => e.state_key === myUserId) // self-room
              : undefined
          if (avatarSource?.content.avatar_url && avatarSource.content.avatar_url !== room.avatar) {
            patch.avatar = avatarSource.content.avatar_url as string
            needsUpdate = true
          }
        } else if (!room.avatar) {
          patch.avatar = explicitAvatar
          needsUpdate = true
        } else if (!explicitAvatar && !room.avatar) {
          // Channel fallback: use parent Space avatar (e.g. Slack workspace icon)
          const spaceParent = state.find(
            (e: MatrixEvent) => e.type === 'm.space.parent',
          )
          if (spaceParent?.state_key) {
            const spaceAvatar = await getSpaceAvatar(spaceParent.state_key as string)
            if (spaceAvatar) {
              patch.avatar = spaceAvatar
              needsUpdate = true
            }
          }
        }

        if (needsUpdate) {
          await db.chatRooms.update(room.id, patch)
        }
      } catch { /* non-critical */ }
    }
    await setMeta(KEY_FIX, '1')
  }
}
