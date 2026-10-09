/**
 * Body for a PATCH that edits a hub record. JSON has no `undefined`, so a form
 * field the user emptied (`notes: notes || undefined`) simply drops out of the
 * request and the hub keeps the old value. An own key whose value is
 * `undefined` goes as `null` instead, which the hub reads as "clear this
 * field". A key that is absent stays absent (= leave alone). Top level only:
 * the hub replaces nested objects whole.
 */
export function editBody(input: object): string {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) out[k] = v === undefined ? null : v
  return JSON.stringify(out)
}
