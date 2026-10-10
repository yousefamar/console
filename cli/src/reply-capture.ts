// The reply to one injected message, read off the hub's broadcast stream.
// Import-free so the root suite can test it (src/__tests__/cli-reply-capture.test.ts).
//
// A new socket gets each session's last 50 logged messages replayed, stamped
// with their absIndex, newest session last. A pause anywhere in that burst used
// to let the previous turn's text + result arrive after the send and be taken
// as the reply (a forge throwaway answered "forge-ready", the CLI printed its
// old "ready", 10 Oct 2026). Anything logged before the send is history.
export interface StreamMsg { type?: string; sessionId?: string; content?: string; absIndex?: number }

export class ReplyCapture {
  private readonly texts: string[] = []
  private readonly deltas: string[] = []
  constructor(private readonly sessionId: string, private readonly fromIndex: number) {}

  /** Feed one broadcast message; true once the turn is over. */
  take(msg: StreamMsg): boolean {
    if (msg.sessionId !== this.sessionId) return false
    if (typeof msg.absIndex === 'number' && msg.absIndex < this.fromIndex) return false
    if (msg.type === 'text_delta') this.deltas.push(msg.content || '')
    else if (msg.type === 'text') this.texts.push(msg.content || '')
    else return msg.type === 'result' || msg.type === 'session_ended'
    return false
  }

  get reply(): string {
    return this.texts.join('\n').trim() || this.deltas.join('').trim()
  }
}
