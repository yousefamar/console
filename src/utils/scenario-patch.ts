/**
 * The amount field of a scenario's "Modify stream" change. Blank (or anything
 * that is not a number yet, like a lone "-") takes `amountPence` OUT of the
 * patch, which is what "unchanged" means: the hub spreads the patch over the
 * stream, so a 0 written here zeroed the stream in that scenario. A typed 0
 * stays a 0.
 */
export function withPatchAmount<P extends { amountPence?: number }>(patch: P, raw: string): P {
  const next = { ...patch }
  const pence = Math.round(parseFloat(raw) * 100)
  if (raw.trim() !== '' && Number.isFinite(pence)) next.amountPence = pence
  else delete next.amountPence
  return next
}
