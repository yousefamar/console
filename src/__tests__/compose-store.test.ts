import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useComposeStore } from '@/store/compose'
import type { ComposeAttachment } from '@/store/compose'

beforeEach(async () => {
  useComposeStore.setState({
    from: '',
    to: '',
    cc: '',
    subject: '',
    bodyMarkdown: '',
    bodyHtml: '',
    quotedHtml: '',
    attachments: [],
  })
})

describe('setFrom', () => {
  it('sets the from field', () => {
    useComposeStore.getState().setFrom('user@example.com')
    expect(useComposeStore.getState().from).toBe('user@example.com')
  })
})

describe('setTo', () => {
  it('sets the to field', () => {
    useComposeStore.getState().setTo('recipient@example.com')
    expect(useComposeStore.getState().to).toBe('recipient@example.com')
  })
})

describe('setCc', () => {
  it('sets the cc field', () => {
    useComposeStore.getState().setCc('cc@example.com')
    expect(useComposeStore.getState().cc).toBe('cc@example.com')
  })
})

describe('setSubject', () => {
  it('sets the subject field', () => {
    useComposeStore.getState().setSubject('Test Subject')
    expect(useComposeStore.getState().subject).toBe('Test Subject')
  })
})

describe('setBody', () => {
  it('sets both bodyMarkdown and bodyHtml', () => {
    useComposeStore.getState().setBody('**hello**', '<strong>hello</strong>')
    const state = useComposeStore.getState()
    expect(state.bodyMarkdown).toBe('**hello**')
    expect(state.bodyHtml).toBe('<strong>hello</strong>')
  })
})

describe('setQuotedHtml', () => {
  it('sets the quotedHtml field', () => {
    useComposeStore.getState().setQuotedHtml('<blockquote>original</blockquote>')
    expect(useComposeStore.getState().quotedHtml).toBe('<blockquote>original</blockquote>')
  })
})

describe('addAttachmentFromData', () => {
  it('adds a single attachment', () => {
    const att: ComposeAttachment = {
      id: 'att-1',
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      data: 'base64data',
    }
    useComposeStore.getState().addAttachmentFromData(att)
    expect(useComposeStore.getState().attachments).toHaveLength(1)
    expect(useComposeStore.getState().attachments[0]!.filename).toBe('test.pdf')
  })

  it('adds an array of attachments', () => {
    const atts: ComposeAttachment[] = [
      { id: 'att-1', filename: 'a.pdf', mimeType: 'application/pdf', size: 100, data: 'a' },
      { id: 'att-2', filename: 'b.png', mimeType: 'image/png', size: 200, data: 'b' },
    ]
    useComposeStore.getState().addAttachmentFromData(atts)
    expect(useComposeStore.getState().attachments).toHaveLength(2)
  })

  it('appends to existing attachments', () => {
    const att1: ComposeAttachment = { id: '1', filename: 'a.pdf', mimeType: 'application/pdf', size: 100, data: 'a' }
    const att2: ComposeAttachment = { id: '2', filename: 'b.pdf', mimeType: 'application/pdf', size: 200, data: 'b' }
    useComposeStore.getState().addAttachmentFromData(att1)
    useComposeStore.getState().addAttachmentFromData(att2)
    expect(useComposeStore.getState().attachments).toHaveLength(2)
  })
})

describe('removeAttachment', () => {
  it('removes the attachment by id', () => {
    const atts: ComposeAttachment[] = [
      { id: 'att-1', filename: 'a.pdf', mimeType: 'application/pdf', size: 100, data: 'a' },
      { id: 'att-2', filename: 'b.pdf', mimeType: 'application/pdf', size: 200, data: 'b' },
    ]
    useComposeStore.getState().addAttachmentFromData(atts)
    useComposeStore.getState().removeAttachment('att-1')
    expect(useComposeStore.getState().attachments).toHaveLength(1)
    expect(useComposeStore.getState().attachments[0]!.id).toBe('att-2')
  })

  it('does nothing when id not found', () => {
    const att: ComposeAttachment = { id: 'att-1', filename: 'a.pdf', mimeType: 'application/pdf', size: 100, data: 'a' }
    useComposeStore.getState().addAttachmentFromData(att)
    useComposeStore.getState().removeAttachment('nonexistent')
    expect(useComposeStore.getState().attachments).toHaveLength(1)
  })
})

describe('addAttachment (File)', () => {
  it('reads a File and adds as base64 attachment', async () => {
    // Mock FileReader as a proper constructor for Node environment
    function MockFileReader(this: {
      onload: (() => void) | null
      onerror: ((err: unknown) => void) | null
      result: string
      readAsDataURL: (blob: Blob) => void
    }) {
      this.onload = null
      this.onerror = null
      this.result = 'data:text/plain;base64,aGVsbG8='
      this.readAsDataURL = function () {
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('FileReader', MockFileReader)
    vi.stubGlobal('crypto', { randomUUID: () => 'mock-uuid' })

    const file = { name: 'test.txt', type: 'text/plain', size: 5 } as File

    await useComposeStore.getState().addAttachment(file)
    const attachments = useComposeStore.getState().attachments
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe('test.txt')
    expect(attachments[0]!.mimeType).toBe('text/plain')
    expect(attachments[0]!.size).toBe(5)
    expect(attachments[0]!.data).toBe('aGVsbG8=')

    vi.unstubAllGlobals()
  })
})

describe('reset', () => {
  it('clears all fields', () => {
    useComposeStore.setState({
      from: 'me@example.com',
      to: 'you@example.com',
      cc: 'cc@example.com',
      subject: 'Test',
      bodyMarkdown: '**hi**',
      bodyHtml: '<strong>hi</strong>',
      quotedHtml: '<blockquote>q</blockquote>',
      attachments: [{ id: '1', filename: 'f.txt', mimeType: 'text/plain', size: 10, data: 'x' }],
    })

    useComposeStore.getState().reset()

    const state = useComposeStore.getState()
    expect(state.from).toBe('')
    expect(state.to).toBe('')
    expect(state.cc).toBe('')
    expect(state.subject).toBe('')
    expect(state.bodyMarkdown).toBe('')
    expect(state.bodyHtml).toBe('')
    expect(state.quotedHtml).toBe('')
    expect(state.attachments).toEqual([])
  })
})
