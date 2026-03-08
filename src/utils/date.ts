const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  // Future timestamps (e.g. snooze-until)
  if (diff < 0) {
    const absDiff = -diff
    if (absDiff < HOUR) return `in ${Math.ceil(absDiff / MINUTE)}m`
    if (absDiff < DAY) return `in ${Math.floor(absDiff / HOUR)}h`
    if (absDiff < 7 * DAY) return `in ${Math.floor(absDiff / DAY)}d`
    const date = new Date(timestamp)
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`

  const date = new Date(timestamp)
  const thisYear = new Date().getFullYear()
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / DAY)

  if (diffDays === 0) return `Today at ${formatTime(timestamp)}`
  if (diffDays === 1) return `Yesterday at ${formatTime(timestamp)}`
  if (diffDays < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: 'long' })} at ${formatTime(timestamp)}`
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function getSnoozeTime(option: 'laterToday' | 'tomorrow' | 'nextWeek' | 'custom', customDate?: Date): number {
  const now = new Date()

  switch (option) {
    case 'laterToday': {
      // 3 hours from now, or 6pm, whichever is later
      const threeHours = new Date(now.getTime() + 3 * HOUR)
      const sixPm = new Date(now)
      sixPm.setHours(18, 0, 0, 0)
      return Math.max(threeHours.getTime(), sixPm.getTime())
    }
    case 'tomorrow': {
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(8, 0, 0, 0)
      return tomorrow.getTime()
    }
    case 'nextWeek': {
      const nextMonday = new Date(now)
      nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7))
      nextMonday.setHours(8, 0, 0, 0)
      return nextMonday.getTime()
    }
    case 'custom': {
      return customDate?.getTime() ?? now.getTime()
    }
  }
}
