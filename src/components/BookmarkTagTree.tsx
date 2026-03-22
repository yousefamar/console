import { useBookmarkStore, type TagTreeNode } from '@/store/bookmarks'

export function BookmarkTagTree() {
  const tagTree = useBookmarkStore((s) => s.tagTree)
  const selectedTag = useBookmarkStore((s) => s.selectedTag)
  const expandedTags = useBookmarkStore((s) => s.expandedTags)
  const selectTag = useBookmarkStore((s) => s.selectTag)
  const toggleTagExpanded = useBookmarkStore((s) => s.toggleTagExpanded)

  if (tagTree.length === 0) {
    return (
      <div className="px-2 py-4 text-[10px] text-text-tertiary text-center">
        No tags
      </div>
    )
  }

  return (
    <div className="py-1">
      <div className="px-2 py-1">
        <button
          onClick={() => selectTag(null)}
          className={`text-[10px] w-full text-left px-1 py-0.5 rounded-sm transition-colors ${
            selectedTag === null
              ? 'text-text-primary font-medium'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          All bookmarks
        </button>
      </div>
      {tagTree.map((node) => (
        <TagNode
          key={node.fullPath}
          node={node}
          depth={0}
          selectedTag={selectedTag}
          expandedTags={expandedTags}
          selectTag={selectTag}
          toggleExpanded={toggleTagExpanded}
        />
      ))}
    </div>
  )
}

function TagNode({
  node,
  depth,
  selectedTag,
  expandedTags,
  selectTag,
  toggleExpanded,
}: {
  node: TagTreeNode
  depth: number
  selectedTag: string | null
  expandedTags: Set<string>
  selectTag: (tag: string | null) => void
  toggleExpanded: (tag: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expandedTags.has(node.fullPath)
  const isActive = selectedTag === node.fullPath

  return (
    <div>
      <div
        className={`
          flex items-center gap-0.5 px-2 py-0.5 cursor-pointer transition-colors duration-fast text-[10px]
          ${isActive ? 'bg-surface-2 text-text-primary font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-1'}
        `}
        style={{ paddingLeft: `${depth * 10 + 8}px` }}
        onClick={() => selectTag(node.fullPath)}
      >
        {hasChildren ? (
          <span
            className="w-3 text-center flex-shrink-0 text-text-tertiary"
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(node.fullPath)
            }}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <span className="flex-1 truncate">{node.name}</span>
        <span className="text-text-tertiary flex-shrink-0 ml-1">{node.count}</span>
      </div>

      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <TagNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              selectedTag={selectedTag}
              expandedTags={expandedTags}
              selectTag={selectTag}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  )
}
