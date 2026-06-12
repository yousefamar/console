// Note file server for hub fallback — serves vault files over REST

import { readdir, readFile, writeFile, unlink, mkdir, rename, stat } from 'fs/promises'
import { join, relative, extname, basename, dirname } from 'path'

export interface NoteFile {
  path: string    // relative to vault root
  name: string    // filename
  dir: string     // directory relative to vault root
  mtime: number   // last modified timestamp (ms)
  size: number    // file size in bytes
}

// Directories to skip when listing
const SKIP_DIRS = new Set(['.obsidian', '.trash', 'bookmarks', 'bookmarks-meta', '.git', 'node_modules'])

export class NoteStore {
  constructor(readonly vaultPath: string) {}

  /** List all .md files recursively */
  async list(): Promise<NoteFile[]> {
    const files: NoteFile[] = []
    await this.walkDir(this.vaultPath, '', files)
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async walkDir(absDir: string, relDir: string, out: NoteFile[]): Promise<void> {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) continue
      if (SKIP_DIRS.has(entry.name)) continue

      const absPath = join(absDir, entry.name)
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await this.walkDir(absPath, relPath, out)
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        try {
          const st = await stat(absPath)
          out.push({
            path: relPath,
            name: entry.name,
            dir: relDir,
            mtime: st.mtimeMs,
            size: st.size,
          })
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  /** Read file content */
  async read(relPath: string): Promise<string> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    return readFile(absPath, 'utf-8')
  }

  /** Write file content (create or update) */
  async write(relPath: string, content: string): Promise<void> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    // Ensure directory exists
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, content, 'utf-8')
  }

  /** Delete file */
  async delete(relPath: string): Promise<void> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    await unlink(absPath)
  }

  /** Create directory */
  async createDir(relPath: string): Promise<void> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    await mkdir(absPath, { recursive: true })
  }

  /** Rename / move file */
  async rename(fromPath: string, toPath: string): Promise<void> {
    this.validatePath(fromPath)
    this.validatePath(toPath)
    const absFrom = join(this.vaultPath, fromPath)
    const absTo = join(this.vaultPath, toPath)
    await mkdir(dirname(absTo), { recursive: true })
    await rename(absFrom, absTo)
  }

  /** Read file as raw bytes (images etc.) */
  async readBinary(relPath: string): Promise<Buffer> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    return readFile(absPath)
  }

  /** Write raw bytes (images etc.) */
  async writeBinary(relPath: string, data: Buffer): Promise<void> {
    this.validatePath(relPath)
    const absPath = join(this.vaultPath, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, data)
  }

  // -------------------------------------------------------------------------
  // Sibling assets dir (~/sync/brain/assets — OUTSIDE the vault root).
  // Obsidian's attachment folder and Eleventy's passthrough-copied assets both
  // live there, so vault wiki-embeds like ![[Pasted image X.png]] resolve to
  // files the vault-rooted methods above can't reach.
  // -------------------------------------------------------------------------

  /** Absolute path of the sibling assets dir (vault root's parent + /assets). */
  get assetsPath(): string {
    return join(this.vaultPath, '..', 'assets')
  }

  /** Read an asset (path relative to the assets dir, e.g. "images/foo.png") */
  async readAsset(relPath: string): Promise<Buffer> {
    this.validateAssetPath(relPath)
    return readFile(join(this.assetsPath, relPath))
  }

  /** Write an asset (path relative to the assets dir) */
  async writeAsset(relPath: string, data: Buffer): Promise<void> {
    this.validateAssetPath(relPath)
    const absPath = join(this.assetsPath, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, data)
  }

  /** Ensure path doesn't escape vault directory */
  private validatePath(relPath: string): void {
    const resolved = join(this.vaultPath, relPath)
    const rel = relative(this.vaultPath, resolved)
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error('Path escapes vault directory')
    }
  }

  /** Ensure path doesn't escape the assets directory */
  private validateAssetPath(relPath: string): void {
    const resolved = join(this.assetsPath, relPath)
    const rel = relative(this.assetsPath, resolved)
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error('Path escapes assets directory')
    }
  }
}

/** Minimal content-type map for asset serving */
export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}
