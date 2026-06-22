// Writing action bar — thumb-zone toolbar for blog drafts/posts.
// [Photo] [Camera] [Mic] [Format] ………… [Publish ↗ | View live ↗]
// Camera button is mobile-only; desktop has paste for images.

import { useRef, useState } from 'react'
import { Camera, Image, Loader2, Mic, Send, ExternalLink, Sparkles } from 'lucide-react'
import { useNotesStore } from '@/store/notes'
import { useBlogStore } from '@/store/blog'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useDictation } from '@/hooks/useDictation'
import { frontmatterRange, permalinkForLogPath, isPublishedPath } from '@/utils/frontmatter'

interface Props {
  path: string
  onPublish: () => void
}

/** Downscale an image blob to maxDim px on the long edge, JPEG q0.85.
 *  GIFs and small images pass through untouched. */
async function downscaleImage(blob: Blob, maxDim = 2000): Promise<Blob> {
  if (blob.type === 'image/gif') return blob
  try {
    const bmp = await createImageBitmap(blob)
    if (Math.max(bmp.width, bmp.height) <= maxDim) { bmp.close(); return blob }
    const scale = maxDim / Math.max(bmp.width, bmp.height)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return out ?? blob
  } catch {
    return blob
  }
}

/** Insert text at the cursor (replacing any selection). Adds a separating
 *  space ONLY when gluing two word characters together — STT deltas usually
 *  carry their own leading space, so blindly padding doubles them up. */
function insertAtCursor(text: string) {
  if (!text) return
  const view = useNotesStore.getState().editorView
  if (!view) return
  const sel = view.state.selection.main
  const before = sel.from > 0 ? view.state.sliceDoc(sel.from - 1, sel.from) : ''
  const needsSpace = /\w$/.test(before) && /^\w/.test(text)
  const piece = needsSpace ? ' ' + text : text
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: piece },
    selection: { anchor: sel.from + piece.length },
    scrollIntoView: true,
  })
}

export function WriteActionBar({ path, onPublish }: Props) {
  const isMobile = useIsMobile()
  const isFileDirty = useNotesStore((s) => s.isFileDirty)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [formatting, setFormatting] = useState(false)

  const published = isPublishedPath(path)
  const permalink = permalinkForLogPath(path)

  const dictation = useDictation({
    // Insert each transcript chunk raw — insertAtCursor handles spacing.
    onText: (text) => insertAtCursor(text),
  })

  const handleImagePick = async (file: File | null | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const scaled = await downscaleImage(file)
      const ext = scaled.type === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop() || 'png')
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const savedPath = await useNotesStore.getState().pasteImage(scaled, `photo-${ts}.${ext}`)
      if (savedPath) {
        // Bare filename = sibling assets dir → wiki-embed (publishes correctly);
        // path = offline vault fallback → markdown form.
        insertAtCursor(savedPath.includes('/') ? `![](${savedPath})\n` : `![[${savedPath}]]\n`)
      } else {
        useUiStore.getState().pushToast({ kind: 'error', message: 'Image upload failed' })
      }
    } finally {
      setUploading(false)
    }
  }

  const handleFormat = async () => {
    const view = useNotesStore.getState().editorView
    const content = useNotesStore.getState().openFiles[path]?.content ?? ''
    if (!content.trim()) return
    setFormatting(true)
    try {
      // Format the selection if there is one; otherwise the whole body
      // (content minus frontmatter).
      const sel = view?.state.selection.main
      const hasSelection = !!sel && !sel.empty
      const fmRange = frontmatterRange(content)
      const from = hasSelection ? sel!.from : (fmRange?.to ?? 0)
      const to = hasSelection ? sel!.to : content.length
      const text = content.slice(from, to)
      if (!text.trim()) return

      const r = await useBlogStore.getState().formatDictation(text)
      if (!r.ok || !r.text) {
        useUiStore.getState().pushToast({ kind: 'error', message: `Format failed: ${r.error ?? 'unknown'}` })
        return
      }
      if (view && view.state.doc.toString() === content) {
        // Single transaction = single undo step
        view.dispatch({ changes: { from, to, insert: r.text } })
      } else {
        const next = content.slice(0, from) + r.text + content.slice(to)
        useNotesStore.getState().updateFileContent(path, next)
      }
      useUiStore.getState().pushToast({ kind: 'success', message: 'Formatted' })
    } finally {
      setFormatting(false)
    }
  }

  const btnCls = 'flex items-center justify-center min-w-9 h-9 px-2 text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors disabled:opacity-40'

  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1 flex-shrink-0 bg-surface-1/50">
      {/* Hidden file inputs */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { void handleImagePick(e.target.files?.[0]); e.target.value = '' }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => { void handleImagePick(e.target.files?.[0]); e.target.value = '' }}
      />

      <button
        onClick={() => photoInputRef.current?.click()}
        className={btnCls}
        disabled={uploading}
        title="Insert image"
        aria-label="Insert image"
      >
        {uploading ? <Loader2 size={15} className="animate-spin" /> : <Image size={15} />}
      </button>
      {isMobile && (
        <button
          onClick={() => cameraInputRef.current?.click()}
          className={btnCls}
          disabled={uploading}
          title="Take photo"
          aria-label="Take photo"
        >
          <Camera size={15} />
        </button>
      )}
      <button
        onClick={() => dictation.recording ? dictation.stop() : dictation.start()}
        className={`${btnCls} ${dictation.recording ? 'text-red-400 bg-surface-2' : ''}`}
        title={dictation.recording ? 'Stop dictation' : 'Dictate'}
        aria-label={dictation.recording ? 'Stop dictation' : 'Dictate'}
      >
        <Mic size={15} className={dictation.recording ? 'animate-pulse' : ''} />
      </button>
      <button
        onClick={() => void handleFormat()}
        className={btnCls}
        disabled={formatting}
        title="Format dictation (AI: punctuation + paragraphs, wording untouched)"
        aria-label="Format dictation"
      >
        {formatting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
      </button>

      <div className="flex-1" />

      {published && permalink ? (
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 h-9 text-xs text-text-primary bg-surface-2 hover:bg-surface-0 border border-border rounded-sm transition-colors"
        >
          <ExternalLink size={13} />
          View live
        </a>
      ) : (
        <button
          onClick={onPublish}
          className="flex items-center gap-1.5 px-3 h-9 text-xs text-text-primary bg-surface-2 hover:bg-surface-0 border border-border rounded-sm transition-colors font-medium"
          title="Publish this post"
        >
          <Send size={13} />
          Publish{isFileDirty(path) ? '*' : ''}
        </button>
      )}
    </div>
  )
}

