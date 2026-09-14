import { describe, it, expect } from 'vitest'
import { inboundEnvelope } from '../al/whatsapp.js'

// A transcribed voice note must read as the MESSAGE, not as an attachment with
// a transcript footnote — otherwise the reader treats it as "attachment only"
// and hedges instead of answering (^lime-boar).

const base = {
  id: 'ID1', jid: '39075763458123@lid', sender: '39075763458123@lid', senderName: 'Yousef',
  text: '', imagePaths: [],
} as any

describe('inboundEnvelope voice notes', () => {
  it('puts the transcript in the Message slot and drops the attachment-only marker', () => {
    const env = inboundEnvelope({
      ...base,
      files: [{ path: '/tmp/x.ogg', mimeType: 'audio/ogg; codecs=opus', kind: 'audio', voiceNote: true, transcript: 'Add milk to the order' }],
    }, 'yousef')
    expect(env).toMatch(/^Message \(voice note, transcribed — treat exactly like typed text\):\nAdd milk to the order$/m)
    expect(env).not.toContain('attachment only')
    expect(env).not.toContain('Voice note transcript')
    expect(env).toContain('(voice note audio: /tmp/x.ogg)')
  })

  it('says so explicitly when transcription failed', () => {
    const env = inboundEnvelope({
      ...base,
      files: [{ path: '/tmp/x.ogg', mimeType: 'audio/ogg; codecs=opus', kind: 'audio', voiceNote: true }],
    }, 'yousef')
    expect(env).toMatch(/^Message:\n\(voice note — transcription FAILED;/m)
    expect(env).not.toContain('attachment only')
  })

  it('leaves shared (non-ptt) audio files as attachments', () => {
    const env = inboundEnvelope({
      ...base,
      files: [{ path: '/tmp/song.mp3', mimeType: 'audio/mpeg', kind: 'audio' }],
    }, 'yousef')
    expect(env).toMatch(/^Message:\n\(no text — attachment only\)$/m)
    expect(env).toContain('[INBOUND WhatsApp] Attached file (audio, audio/mpeg): /tmp/song.mp3')
  })

  it('typed text wins when both are present', () => {
    const env = inboundEnvelope({
      ...base, text: 'see attached',
      files: [{ path: '/tmp/x.ogg', mimeType: 'audio/ogg; codecs=opus', kind: 'audio', voiceNote: true, transcript: 'hello' }],
    }, 'yousef')
    expect(env).toMatch(/^Message:\nsee attached$/m)
  })
})
