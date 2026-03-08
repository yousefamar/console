import { create } from 'zustand'

export interface ComposeAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  data: string // base64
}

interface ComposeState {
  // Current compose/reply state
  from: string
  to: string
  cc: string
  subject: string
  bodyMarkdown: string
  bodyHtml: string
  quotedHtml: string // original forwarded body, preserved raw (not passed through Tiptap)
  attachments: ComposeAttachment[]

  // Actions
  setFrom: (from: string) => void
  setTo: (to: string) => void
  setCc: (cc: string) => void
  setSubject: (subject: string) => void
  setBody: (markdown: string, html: string) => void
  setQuotedHtml: (html: string) => void
  addAttachment: (file: File) => Promise<void>
  addAttachmentFromData: (att: ComposeAttachment | ComposeAttachment[]) => void
  removeAttachment: (id: string) => void
  reset: () => void
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data URL prefix
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export const useComposeStore = create<ComposeState>((set) => ({
  from: '',
  to: '',
  cc: '',
  subject: '',
  bodyMarkdown: '',
  bodyHtml: '',
  quotedHtml: '',
  attachments: [],

  setFrom: (from) => set({ from }),
  setTo: (to) => set({ to }),
  setCc: (cc) => set({ cc }),
  setSubject: (subject) => set({ subject }),
  setBody: (markdown, html) => set({ bodyMarkdown: markdown, bodyHtml: html }),
  setQuotedHtml: (html) => set({ quotedHtml: html }),

  addAttachment: async (file) => {
    const data = await fileToBase64(file)
    const att: ComposeAttachment = {
      id: crypto.randomUUID(),
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      data,
    }
    set((s) => ({ attachments: [...s.attachments, att] }))
  },

  addAttachmentFromData: (att) => {
    if (Array.isArray(att)) {
      set((s) => ({ attachments: [...s.attachments, ...att] }))
    } else {
      set((s) => ({ attachments: [...s.attachments, att] }))
    }
  },

  removeAttachment: (id) => {
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }))
  },

  reset: () => {
    set({
      from: '',
      to: '',
      cc: '',
      subject: '',
      bodyMarkdown: '',
      bodyHtml: '',
      quotedHtml: '',
      attachments: [],
    })
  },
}))
