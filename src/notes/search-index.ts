// Search index for notes — fzf for filenames, MiniSearch for full-text

import MiniSearch from 'minisearch'
import { Fzf, type FzfResultItem } from 'fzf'
import type { VaultFile } from './vault-adapter'

export interface SearchResult {
  path: string
  title: string
  snippet: string        // matched text context
  score: number
}

export interface FilenameResult {
  path: string
  name: string
  dir: string
  score: number
  positions: Set<number> // character positions for highlighting
}

export class NotesSearchIndex {
  private mini: MiniSearch
  private paths: string[] = []
  private fzfInstance: Fzf<string[]> | null = null

  constructor() {
    this.mini = new MiniSearch({
      fields: ['title', 'content', 'path'],
      storeFields: ['title', 'path'],
      searchOptions: {
        boost: { title: 3, path: 1.5 },
        fuzzy: 0.2,
        prefix: true,
      },
    })
  }

  /** Build index from file list + contents */
  async buildIndex(
    files: VaultFile[],
    readFile: (path: string) => Promise<string>,
  ): Promise<void> {
    this.mini.removeAll()
    this.paths = files.map((f) => f.path)

    // Build fzf instance for filename search
    this.fzfInstance = new Fzf(this.paths, {
      selector: (item) => item,
      limit: 50,
    })

    // Index content in batches, yielding to main thread between batches
    const BATCH_SIZE = 50
    const yield_ = () => new Promise<void>((r) => setTimeout(r, 0))

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const contents = await Promise.all(
        batch.map(async (f) => {
          try {
            return await readFile(f.path)
          } catch {
            return ''
          }
        }),
      )

      const docs: Array<{ id: string; title: string; content: string; path: string }> = []
      for (let j = 0; j < batch.length; j++) {
        const file = batch[j]!
        const content = contents[j]!
        const title = extractTitle(file.name, content)
        docs.push({
          id: file.path,
          title,
          content: content.slice(0, 10000), // cap content for index performance
          path: file.path,
        })
      }

      this.mini.addAll(docs)
      // Yield to main thread so keyboard events can process
      await yield_()
    }
  }

  /** Fuzzy filename search (Quick Switcher) */
  searchFilenames(query: string): FilenameResult[] {
    if (!query || !this.fzfInstance) return []
    const results: FzfResultItem<string>[] = this.fzfInstance.find(query)
    return results.map((r) => {
      const path = r.item
      const parts = path.split('/')
      const name = parts.pop() || path
      const dir = parts.join('/')
      return {
        path,
        name,
        dir,
        score: r.score,
        positions: r.positions,
      }
    })
  }

  /** Full-text content search */
  searchContent(query: string): SearchResult[] {
    if (!query) return []
    const results = this.mini.search(query).slice(0, 50)
    return results.map((r) => ({
      path: r.path as string,
      title: r.title as string,
      snippet: '', // snippets generated at display time
      score: r.score,
    }))
  }

  /** Update a single document in the index */
  updateDocument(path: string, content: string, title?: string): void {
    try {
      this.mini.discard(path)
    } catch {
      // not in index yet
    }
    this.mini.add({
      id: path,
      title: title || extractTitle(path.split('/').pop() || '', content),
      content: content.slice(0, 10000),
      path,
    })

    // Rebuild fzf if paths changed
    if (!this.paths.includes(path)) {
      this.paths.push(path)
      this.fzfInstance = new Fzf(this.paths, {
        selector: (item) => item,
        limit: 50,
      })
    }
  }

  /** Remove a document from the index */
  removeDocument(path: string): void {
    try {
      this.mini.discard(path)
    } catch {
      // not in index
    }
    this.paths = this.paths.filter((p) => p !== path)
    this.fzfInstance = new Fzf(this.paths, {
      selector: (item) => item,
      limit: 50,
    })
  }
}

/** Extract title from filename or frontmatter */
function extractTitle(filename: string, content: string): string {
  // Check YAML frontmatter for title
  const match = content.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/)
  if (match) return match[1]!.trim().replace(/^['"]|['"]$/g, '')

  // Check first H1
  const h1Match = content.match(/^#\s+(.+)$/m)
  if (h1Match) return h1Match[1]!.trim()

  // Fallback to filename without extension
  return filename.replace(/\.md$/, '').replace(/[-_]/g, ' ')
}
