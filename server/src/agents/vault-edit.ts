// Agent-edit → editor review bridge (pure half).
//
// Every hub Edit/Write already emits a `tool_diff` (mined from the CLI's
// structuredPatch in session.ts). When the edited file lives inside the
// VAULT, the SPA's doc editor wants to know so it can flip an open buffer
// into inline review mode (word-level diff, per-chunk accept/reject).
// The hub side is deliberately thin: resolve the absolute path against the
// vault root and broadcast `notes.agent_edit {path, sessionId}` — the diff
// itself is NOT shipped, the client re-reads disk and diffs against its own
// buffer (the buffer, not the pre-edit disk copy, is what review is against).

import { resolve, sep } from 'path'

/** Vault-relative path for an absolute file path, or null when the file is
 *  outside the vault. Pure; symlinks are not chased (the CLI reports the
 *  path it was asked to edit, which for vault files is the real one). */
export function vaultRelative(vaultPath: string, filePath: string): string | null {
  const root = resolve(vaultPath)
  const abs = resolve(filePath)
  if (!abs.startsWith(root + sep)) return null
  return abs.slice(root.length + 1).split(sep).join('/')
}
