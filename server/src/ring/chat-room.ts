// Contact → chat room, for `message <person>`: the message goes out AS YOUSEF
// through his own Matrix account (Beeper's WhatsApp bridge), not from AL.
// `users/<name>.md` lists the person's WhatsApp identifiers (phone and/or
// linked-device lid); the bridge names that person's ghost member
// `@whatsapp_<phone>:beeper.local` / `@whatsapp_lid-<lid>:beeper.local` — so
// the DM room is the direct WhatsApp room whose members include one of those
// ghosts. Deterministic, no config, no LLM. Member lists come from room state
// (one fetch per room, cached for the hub's lifetime — ghosts don't change).

export interface CandidateRoom {
  id: string
  name: string
  isDirect: boolean
  networkIcon?: string
}

/** Ghost user-id forms the bridge uses for a WhatsApp identifier. */
export function ghostUserIds(identifier: string, server = 'beeper.local'): string[] {
  const id = identifier.replace(/\D/g, '')
  return [`@whatsapp_${id}:${server}`, `@whatsapp_lid-${id}:${server}`]
}

/** The ghost's identifier (digits) from a member id, or null for non-ghosts. */
export function identifierFromGhost(userId: string): string | null {
  const m = /^@whatsapp_(?:lid-)?(\d+):/.exec(userId)
  return m ? m[1]! : null
}

export class ContactRoomResolver {
  private ghostsByRoom = new Map<string, Set<string>>()
  private roomByContact = new Map<string, string>()

  constructor(
    private rooms: () => CandidateRoom[],
    private members: (roomId: string) => Promise<string[]>,
  ) {}

  /** Direct WhatsApp room for a contact's identifiers, or null. */
  async resolve(contact: string, identifiers: string[]): Promise<CandidateRoom | null> {
    const ids = new Set(identifiers.map((i) => i.replace(/\D/g, '')).filter(Boolean))
    if (!ids.size) return null
    const cached = this.roomByContact.get(contact)
    const candidates = this.rooms().filter((r) => r.isDirect && (r.networkIcon ?? '').toLowerCase().includes('whatsapp'))
    if (cached) {
      const room = candidates.find((r) => r.id === cached)
      if (room) return room
      this.roomByContact.delete(contact)
    }
    for (const room of candidates) {
      let ghosts = this.ghostsByRoom.get(room.id)
      if (!ghosts) {
        try {
          ghosts = new Set(( await this.members(room.id)).map(identifierFromGhost).filter((g): g is string => !!g))
        } catch { continue }
        this.ghostsByRoom.set(room.id, ghosts)
      }
      for (const id of ids) {
        if (ghosts.has(id)) { this.roomByContact.set(contact, room.id); return room }
      }
    }
    return null
  }
}
