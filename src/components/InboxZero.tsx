import { Sun } from 'lucide-react'

export function InboxZero() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <Sun size={48} className="text-text-tertiary opacity-60" strokeWidth={1.5} />
      <div>
        <p className="text-lg font-medium text-text-primary">You're all done</p>
        <p className="mt-1 text-sm text-text-tertiary">Nothing in your inbox. Go enjoy your day.</p>
      </div>
    </div>
  )
}
