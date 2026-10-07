// A mail row's Gmail labels, rendered the same in the Mail pane and the
// unified Inbox pane — one component so the two can't drift (they already
// had: the Inbox pane showed none at all, ^zany-fox).
//
// Sits immediately left of the row's timestamp, muted, and truncates rather
// than pushing the time around: a nested Gmail label carries its whole path
// ("Astera/Past meetings"), which is wider than the slot deserves. Full name
// in the tooltip.

export function MailLabels({ names }: { names: string[] }) {
  if (names.length === 0) return null
  return (
    <>
      {names.map((name) => (
        <span
          key={name}
          title={name}
          className="max-w-[7rem] truncate text-[9px] text-text-tertiary opacity-60 flex-shrink-0"
        >
          {name}
        </span>
      ))}
    </>
  )
}
