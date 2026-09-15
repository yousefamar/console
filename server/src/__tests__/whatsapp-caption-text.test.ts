import { describe, it, expect } from 'vitest'
import { inboundContent, inboundEnvelope } from '../al/whatsapp.js'

// A caption on a document/video IS the message. 2026-09-15: Yousef sent a zip
// whose 1,023-char caption carried the task; the envelope said "(no text —
// attachment only)" and Al worked the file blind.

const doc = { fileName: 'WhatsApp_Chat_with_Mohamed_Amar.zip', mimetype: 'application/zip', caption: 'Ingest this chat and summarise the open threads' }

describe('inboundContent', () => {
  it('reads a documentMessage caption', () => {
    const { content, text } = inboundContent({ documentMessage: doc } as any)
    expect(text).toBe(doc.caption)
    expect(content.documentMessage?.fileName).toBe(doc.fileName)
  })

  it('unwraps documentWithCaptionMessage so the caption AND the file are found', () => {
    const { content, text } = inboundContent({ documentWithCaptionMessage: { message: { documentMessage: doc } } } as any)
    expect(text).toBe(doc.caption)
    expect(content.documentMessage?.fileName).toBe(doc.fileName)
  })

  it('unwraps ephemeral and view-once wrappers', () => {
    const wrapped = { ephemeralMessage: { message: { viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4', caption: 'watch this' } } } } } }
    const { content, text } = inboundContent(wrapped as any)
    expect(text).toBe('watch this')
    expect(content.videoMessage?.mimetype).toBe('video/mp4')
  })

  it('reads a videoMessage caption', () => {
    expect(inboundContent({ videoMessage: { mimetype: 'video/mp4', caption: 'clip' } } as any).text).toBe('clip')
  })

  it('still reads plain text, extended text and image captions', () => {
    expect(inboundContent({ conversation: 'hi' } as any).text).toBe('hi')
    expect(inboundContent({ extendedTextMessage: { text: 'hello there' } } as any).text).toBe('hello there')
    expect(inboundContent({ imageMessage: { mimetype: 'image/jpeg', caption: 'look' } } as any).text).toBe('look')
  })

  it('returns empty text for an uncaptioned attachment', () => {
    const { content, text } = inboundContent({ documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } } as any)
    expect(text).toBe('')
    expect(content.documentMessage?.fileName).toBe('a.pdf')
  })

  it('tolerates a missing message', () => {
    expect(inboundContent(undefined)).toEqual({ content: {}, text: '' })
  })
})

describe('inboundEnvelope with a captioned file', () => {
  it('puts the caption in the Message slot and lists the file below', () => {
    const env = inboundEnvelope({
      id: 'ID1', jid: '447700900000@s.whatsapp.net', sender: '447700900000@s.whatsapp.net', senderName: 'Yousef',
      text: doc.caption, images: [], imagePaths: [],
      files: [{ path: '/tmp/x.zip', mimeType: 'application/zip', kind: 'document' }],
      timestamp: 0,
    }, 'yousef')
    expect(env).toMatch(/^Message:\nIngest this chat and summarise the open threads$/m)
    expect(env).not.toContain('attachment only')
    expect(env).toContain('[INBOUND WhatsApp] Attached file (document, application/zip): /tmp/x.zip')
  })
})
