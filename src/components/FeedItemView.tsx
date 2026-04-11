import { useMemo, useEffect, useRef } from 'react'
import { useFeedStore } from '@/store/feeds'
import DOMPurify from 'dompurify'
import { ExternalLink, Rss, MessageSquare } from 'lucide-react'

// Make all links open in new tabs after DOMPurify sanitization
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function extractYoutubeId(url: string): string | null {
  const match = url?.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

function isRedditUrl(url: string): boolean {
  return /reddit\.com\/r\//.test(url)
}

export function FeedItemView() {
  const items = useFeedStore((s) => s.items)
  const selectedItemId = useFeedStore((s) => s.selectedItemId)
  const feeds = useFeedStore((s) => s.feeds)
  const contentRef = useRef<HTMLDivElement>(null)

  const item = items.find((i) => i.id === selectedItemId)
  const feed = item ? feeds.find((f) => f.id === item.feedId) : null

  const sanitizedContent = useMemo(() => {
    if (!item?.content) return ''
    return DOMPurify.sanitize(item.content, {
      ADD_TAGS: ['iframe'],
      ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'src', 'target'],
      FORBID_TAGS: ['script', 'style'],
    })
  }, [item?.content])

  // Scroll to top when item changes
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0)
  }, [selectedItemId])

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Rss size={20} className="mx-auto mb-2 text-text-tertiary" />
          <span className="text-xs text-text-tertiary">Select an article to read</span>
        </div>
      </div>
    )
  }

  const youtubeId = extractYoutubeId(item.link)
  const isReddit = isRedditUrl(item.link)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Article header */}
      <div className="px-4 py-3 border-b border-border flex-shrink-0">
        <h1 className="text-sm font-semibold text-text-primary leading-tight">
          {item.title}
        </h1>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {feed && (
            <span className="text-[10px] text-text-tertiary">{feed.title}</span>
          )}
          {item.author && (
            <>
              <span className="text-[10px] text-text-tertiary">·</span>
              <span className="text-[10px] text-text-tertiary">{item.author}</span>
            </>
          )}
          <span className="text-[10px] text-text-tertiary">·</span>
          <span className="text-[10px] text-text-tertiary">
            {new Date(item.publishedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
          <span className="flex items-center gap-2 ml-auto">
            {isReddit && (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                <MessageSquare size={10} />
                <span>Comments</span>
              </a>
            )}
            {item.link && (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                <ExternalLink size={10} />
                <span>Open</span>
              </a>
            )}
          </span>
        </div>
      </div>

      {/* Article content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-4 py-3">
        {/* YouTube embed */}
        {youtubeId && (
          <div className="mb-3 aspect-video w-full max-w-2xl">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${youtubeId}`}
              className="w-full h-full rounded-sm"
              style={{ pointerEvents: 'auto' }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title="YouTube video"
            />
          </div>
        )}

        {/* Thumbnail for items with imageUrl but no YouTube embed */}
        {!youtubeId && item.imageUrl && (
          <img
            src={item.imageUrl}
            alt=""
            className="max-w-full max-h-64 rounded-sm mb-3 object-contain"
          />
        )}

        {sanitizedContent ? (
          <div
            className="feed-article-content text-xs text-text-secondary leading-relaxed max-w-full overflow-hidden break-words [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-sm [&_a]:text-blue-400 [&_a]:underline [&_a:hover]:text-blue-300 [&_a]:break-all [&_pre]:bg-surface-2 [&_pre]:p-2 [&_pre]:rounded-sm [&_pre]:overflow-x-auto [&_pre]:text-[11px] [&_pre]:max-w-full [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:rounded-sm [&_code]:text-[11px] [&_code]:break-all [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-tertiary [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-2 [&_li]:mb-0.5 [&_hr]:border-border [&_hr]:my-3 [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold"
            dangerouslySetInnerHTML={{ __html: sanitizedContent }}
          />
        ) : item.link ? (
          <div className="text-center py-8">
            <p className="text-xs text-text-tertiary mb-2">No article content available</p>
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Open in browser
            </a>
          </div>
        ) : null}
      </div>
    </div>
  )
}
