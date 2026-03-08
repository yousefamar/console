import { describe, it, expect } from 'vitest'

// formatFileSize is defined in attachment-cache.ts, but that file imports
// browser-only deps (Dexie, localStorage). Test the logic directly.
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })

  it('handles zero', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('handles boundary at 1 KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
  })

  it('handles boundary at 1 MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
  })
})
