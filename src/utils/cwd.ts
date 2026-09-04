/** `/home/<user>/x` → `~/x` for display; other paths untouched. The SPA has
 *  no $HOME, so it recognises the Linux home shape the hub reports. */
export function shortCwd(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, '~')
}

/** A bound session runs somewhere other than its space's home. Unknown on
 *  either side (older hub payload, pre-init session) is never a stray. */
export function isStrayCwd(sessionCwd: string | undefined, spaceCwd: string | undefined): boolean {
  return !!sessionCwd && !!spaceCwd && sessionCwd.replace(/\/+$/, '') !== spaceCwd.replace(/\/+$/, '')
}
