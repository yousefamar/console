import { useState, useCallback } from 'react'
import type { AttachmentMeta } from '@/gmail/types'
import { getAttachmentBlobUrl, getAttachmentBlob, formatFileSize } from '@/utils/attachment-cache'
import { Download, Eye, X, FileText, Image as ImageIcon, File } from 'lucide-react'

interface AttachmentBarProps {
  messageId: string
  attachments: AttachmentMeta[]
}

function getIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return ImageIcon
  if (mimeType === 'application/pdf') return FileText
  return File
}

function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf'
}

export function AttachmentBar({ messageId, attachments }: AttachmentBarProps) {
  // Filter out inline CID images — they're rendered in the email body
  const regularAttachments = attachments.filter((a) => !a.contentId)
  const [preview, setPreview] = useState<{ url: string; mimeType: string; filename: string } | null>(null)

  const handleDownload = useCallback(async (att: AttachmentMeta) => {
    const blob = await getAttachmentBlob(messageId, att)
    if (!blob) return

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = att.filename
    a.click()
    URL.revokeObjectURL(url)
  }, [messageId])

  const handlePreview = useCallback(async (att: AttachmentMeta) => {
    const url = await getAttachmentBlobUrl(messageId, att)
    if (url) {
      setPreview({ url, mimeType: att.mimeType, filename: att.filename })
    }
  }, [messageId])

  if (regularAttachments.length === 0) return null

  return (
    <>
      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        {regularAttachments.map((att) => {
          const Icon = getIcon(att.mimeType)
          return (
            <div
              key={att.attachmentId}
              className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <Icon size={12} className="text-text-tertiary flex-shrink-0" />
              <span className="text-text-secondary truncate max-w-[150px]">{att.filename}</span>
              <span className="text-text-tertiary">({formatFileSize(att.size)})</span>
              {isPreviewable(att.mimeType) && (
                <button
                  onClick={() => handlePreview(att)}
                  className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                  title="Preview"
                >
                  <Eye size={12} />
                </button>
              )}
              <button
                onClick={() => handleDownload(att)}
                className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                title="Download"
              >
                <Download size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Preview overlay */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPreview(null)} />
          <div className="relative z-10 max-w-4xl max-h-[90vh] w-full mx-4 flex flex-col">
            <div className="flex items-center justify-between bg-surface-1 border border-border rounded-t-sm px-4 py-2">
              <span className="text-sm text-text-primary truncate">{preview.filename}</span>
              <button
                onClick={() => setPreview(null)}
                className="text-text-tertiary hover:text-text-secondary"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 bg-surface-0 border-x border-b border-border rounded-b-sm overflow-auto">
              {preview.mimeType.startsWith('image/') ? (
                <img src={preview.url} alt={preview.filename} className="max-w-full h-auto mx-auto" />
              ) : preview.mimeType === 'application/pdf' ? (
                <iframe src={preview.url} className="w-full h-[80vh]" title={preview.filename} />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
