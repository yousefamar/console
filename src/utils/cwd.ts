/** `/home/<user>/x` → `~/x` for display; other paths untouched. The SPA has
 *  no $HOME, so it recognises the Linux home shape the hub reports. */
export function shortCwd(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, '~')
}

/** A bound session runs OUTSIDE its space's home. Inside it — the home itself
 *  or any subdir (AL's `projects/al/workspace`) — is fine. Unknown on either
 *  side (older hub payload, pre-init session) is never a stray. */
export function isStrayCwd(sessionCwd: string | undefined, spaceCwd: string | undefined): boolean {
  if (!sessionCwd || !spaceCwd) return false
  const home = spaceCwd.replace(/\/+$/, '')
  const cwd = sessionCwd.replace(/\/+$/, '')
  return cwd !== home && !cwd.startsWith(home + '/')
}
