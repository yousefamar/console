// Vault adapter — abstracts file system access for notes
// Primary: File System Access API (Chrome/Edge, offline)
// Fallback: Hub REST API (any browser, requires hub server)

export interface VaultFile {
  path: string      // relative to vault root, e.g. "notes/guides/foo.md"
  name: string      // filename, e.g. "foo.md"
  dir: string       // directory, e.g. "notes/guides"
  mtime: number     // last modified timestamp (ms)
}

export interface VaultAdapter {
  listFiles(): Promise<VaultFile[]>
  readFile(path: string): Promise<string>
  readFileBinary(path: string): Promise<Blob>
  writeFile(path: string, content: string): Promise<void>
  writeFileBinary(path: string, data: Blob): Promise<void>
  deleteFile(path: string): Promise<void>
  createDirectory(path: string): Promise<void>
  renameFile(oldPath: string, newPath: string): Promise<void>
  exists(path: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// File System Access API adapter
// ---------------------------------------------------------------------------

const VAULT_HANDLE_DB = 'console-vault-handle'
const VAULT_HANDLE_STORE = 'handles'
const VAULT_HANDLE_KEY = 'vault'

async function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_HANDLE_DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VAULT_HANDLE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function persistHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_HANDLE_STORE, 'readwrite')
    tx.objectStore(VAULT_HANDLE_STORE).put(handle, VAULT_HANDLE_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function retrieveHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VAULT_HANDLE_STORE, 'readonly')
      const req = tx.objectStore(VAULT_HANDLE_STORE).get(VAULT_HANDLE_KEY)
      req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  } catch {
    return null
  }
}

// Skip these directories when listing files
const SKIP_DIRS = new Set(['.obsidian', '.trash', 'bookmarks', 'bookmarks-meta', '.git', 'node_modules', '_site', '_build', 'vendor', '.cache', 'dist', 'build'])

export class FsaVaultAdapter implements VaultAdapter {
  constructor(private root: FileSystemDirectoryHandle) {}

  async listFiles(): Promise<VaultFile[]> {
    const files: VaultFile[] = []
    await this.walkDir(this.root, '', files)
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async walkDir(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    out: VaultFile[],
  ): Promise<void> {
    for await (const [name, handle] of dir as any) {
      // Skip hidden files/dirs
      if (name.startsWith('.')) continue

      const path = prefix ? `${prefix}/${name}` : name

      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name)) continue
        await this.walkDir(handle as FileSystemDirectoryHandle, path, out)
      } else if (handle.kind === 'file' && name.endsWith('.md')) {
        const file = await (handle as FileSystemFileHandle).getFile()
        out.push({
          path,
          name,
          dir: prefix,
          mtime: file.lastModified,
        })
      }
    }
  }

  async readFile(path: string): Promise<string> {
    const handle = await this.getFileHandle(path, false)
    const file = await handle.getFile()
    return file.text()
  }

  async readFileBinary(path: string): Promise<Blob> {
    const handle = await this.getFileHandle(path, false)
    return handle.getFile()
  }

  async writeFile(path: string, content: string): Promise<void> {
    const handle = await this.getFileHandle(path, true)
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async writeFileBinary(path: string, data: Blob): Promise<void> {
    const handle = await this.getFileHandle(path, true)
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async deleteFile(path: string): Promise<void> {
    const parts = path.split('/')
    const fileName = parts.pop()!
    const dir = await this.getDirHandle(parts.join('/'), false)
    await dir.removeEntry(fileName)
  }

  async createDirectory(path: string): Promise<void> {
    await this.getDirHandle(path, true)
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    // FSA has no rename — read, create new, delete old
    const content = await this.readFile(oldPath)
    await this.writeFile(newPath, content)
    await this.deleteFile(oldPath)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.getFileHandle(path, false)
      return true
    } catch {
      return false
    }
  }

  private async getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = path.split('/')
    const fileName = parts.pop()!
    const dir = await this.getDirHandle(parts.join('/'), create)
    return dir.getFileHandle(fileName, { create })
  }

  private async getDirHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!path) return this.root
    let dir = this.root
    for (const part of path.split('/')) {
      if (!part) continue
      dir = await dir.getDirectoryHandle(part, { create })
    }
    return dir
  }
}

// ---------------------------------------------------------------------------
// Hub REST API adapter (fallback)
// ---------------------------------------------------------------------------

import { getHubUrl } from '@/hub'

export class HubVaultAdapter implements VaultAdapter {
  async listFiles(): Promise<VaultFile[]> {
    const res = await fetch(`${getHubUrl()}/notes`)
    if (!res.ok) throw new Error(`Hub list failed: ${res.status}`)
    return res.json()
  }

  async readFile(path: string): Promise<string> {
    const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}`)
    if (!res.ok) throw new Error(`Hub read failed: ${res.status}`)
    const data = await res.json()
    return data.content
  }

  async readFileBinary(path: string): Promise<Blob> {
    const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}?binary=1`)
    if (!res.ok) throw new Error(`Hub read binary failed: ${res.status}`)
    return res.blob()
  }

  async writeFileBinary(path: string, data: Blob): Promise<void> {
    const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}?binary=1`, {
      method: 'PUT',
      body: data,
    })
    if (!res.ok) throw new Error(`Hub write binary failed: ${res.status}`)
  }

  async writeFile(path: string, content: string): Promise<void> {
    const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`Hub write failed: ${res.status}`)
  }

  async deleteFile(path: string): Promise<void> {
    const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`Hub delete failed: ${res.status}`)
  }

  async createDirectory(path: string): Promise<void> {
    const res = await fetch(`${getHubUrl()}/notes/mkdir/${encodeURIComponent(path)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(`Hub mkdir failed: ${res.status}`)
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const res = await fetch(`${getHubUrl()}/notes/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: oldPath, to: newPath }),
    })
    if (!res.ok) throw new Error(`Hub rename failed: ${res.status}`)
  }

  async exists(path: string): Promise<boolean> {
    try {
      const res = await fetch(`${getHubUrl()}/notes/file/${encodeURIComponent(path)}`, {
        method: 'HEAD',
      })
      return res.ok
    } catch {
      return false
    }
  }
}
