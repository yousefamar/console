// ============================================================================
// Whitespace between already-present text and an incoming dictation chunk.
//
// The two STT sources chunk at different granularities and that changes who
// owns the word boundary:
//
// - Hub /stt (OpenAI realtime) streams raw TOKEN deltas. A token carries its
//   own leading space when it starts a word, and carries none when it
//   continues one ("structur" + "ally"). So it must be appended verbatim —
//   padding a mid-word delta splits the word ("structur ally").
// - Browser SpeechRecognition emits whole finalized utterances with no leading
//   space at all, so consecutive segments need one inserted or they glue
//   together ("hello worldhow are you").
// ============================================================================

/** Separator to place before `insert`. `verbatim` = the chunk is a streaming
 *  token delta that already carries its own spacing. */
export function dictationSeparator(before: string, insert: string, verbatim: boolean): string {
  if (verbatim) return ''
  return before.length > 0 && /\w$/.test(before) && /^\w/.test(insert) ? ' ' : ''
}
