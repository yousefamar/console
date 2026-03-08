const textarea = document.createElement('textarea')

/** Decode HTML entities like `&#39;` → `'` */
export function decodeEntities(text: string): string {
  textarea.innerHTML = text
  return textarea.value
}
