// Where does a redaction point? Spec v11+ moved the target into
// content.redacts; everything older (INCLUDING Beeper's hungryserv — verified
// live with a canary redaction, ^cosy-bass) carries it ONLY at the event's
// top level with content = {reason?}. Read both, content first.
// Dependency-free so tests don't drag Dexie into a node environment.
export function redactionTargetId(event: {
  content?: Record<string, unknown>
  redacts?: unknown
}): string | undefined {
  const fromContent = event.content?.redacts
  if (typeof fromContent === 'string' && fromContent) return fromContent
  if (typeof event.redacts === 'string' && event.redacts) return event.redacts
  return undefined
}
