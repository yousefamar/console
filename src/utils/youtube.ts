export function extractYoutubeId(url: string): string | null {
  const match = url?.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}
