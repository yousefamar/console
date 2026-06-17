import { useMemo } from 'react'
import { X, Play, RefreshCw, Square, Trash2, Folder } from 'lucide-react'
import { useAgentStore } from '@/store/agent'
import { showConfirm } from '@/dialog'

// Editable-ish profile for an org-chart role. Charter / goals / memory are
// AGENT-owned (read-only here — edited in the role's .md file); the hub-writable
// bits are the manager edge + lifecycle actions.
export function AgentProfilePanel({ agentKey, onClose }: { agentKey: string; onClose: () => void }) {
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const setAgentManager = useAgentStore((s) => s.setAgentManager)
  const reviveAgent = useAgentStore((s) => s.reviveAgent)
  const reloadSession = useAgentStore((s) => s.reloadSession)
  const killSession = useAgentStore((s) => s.killSession)
  const deleteRole = useAgentStore((s) => s.deleteRole)
  const renameRole = useAgentStore((s) => s.renameRole)
  const selectSession = useAgentStore((s) => s.selectSession)

  const role = roles.find((r) => r.key === agentKey)
  const isFolder = !!role?.folder
  const isAl = role?.key === 'al' // the org root — never reparented, parked, or deleted
  const live = useMemo(() => sessions.find((s) => s.agentKey === agentKey && s.status !== 'ended'), [sessions, agentKey])
  const managerOptions = useMemo(
    () => roles.filter((r) => r.key !== agentKey).map((r) => ({ key: r.key, title: r.title, folder: !!r.folder })).sort((a, b) => a.title.localeCompare(b.title)),
    [roles, agentKey],
  )

  if (!role) {
    return (
      <div className="flex w-full flex-col p-3 text-xs text-text-tertiary">
        <button onClick={onClose} className="self-end text-text-tertiary hover:text-text-primary"><X size={14} /></button>
        Role not found.
      </div>
    )
  }

  // Split the charter body into charter prose vs the "## Memory" section.
  const memIdx = role.charter.search(/^##\s+Memory/im)
  const charterText = memIdx >= 0 ? role.charter.slice(0, memIdx).trim() : role.charter.trim()
  const memoryText = memIdx >= 0 ? role.charter.slice(memIdx).replace(/^##\s+Memory\s*/im, '').trim() : ''

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-2">
        <div className="min-w-0 flex items-center gap-1.5">
          {isFolder && <Folder size={13} className="flex-shrink-0 text-text-tertiary" />}
          <div className="min-w-0">
            {isFolder ? (
              <input
                defaultValue={role.title}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== role.title) renameRole(role.key, v) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                className="w-full bg-transparent text-sm font-medium text-text-primary outline-none"
              />
            ) : (
              <div className="truncate text-sm font-medium text-text-primary">{role.title}</div>
            )}
            <div className="truncate font-mono text-[10px] text-text-tertiary">{isFolder ? 'folder' : role.key + (live ? '' : ' · parked')}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
        {!isFolder && (live ? (
          <>
            <PanelBtn onClick={() => selectSession(live.id)} icon={<Play size={12} />}>Open</PanelBtn>
            <PanelBtn onClick={() => reloadSession(live.id)} icon={<RefreshCw size={12} />}>Reload</PanelBtn>
            {!isAl && <PanelBtn onClick={() => killSession(live.id)} icon={<Square size={12} />}>Park</PanelBtn>}
          </>
        ) : (
          !isAl && <PanelBtn onClick={() => reviveAgent(role.key)} icon={<Play size={12} />}>Revive</PanelBtn>
        ))}
        {!isAl && (
          <PanelBtn onClick={async () => {
            const ok = await showConfirm(
              isFolder ? 'Its children become roots.' : 'This removes its role file and kills any live session.',
              { title: `Delete ${isFolder ? 'folder' : 'agent'} "${role.title}"?`, danger: true, confirmLabel: 'Delete' },
            )
            if (ok) { deleteRole(role.key); onClose() }
          }} icon={<Trash2 size={12} />} danger>Delete</PanelBtn>
        )}
      </div>

      <div className="space-y-3 px-3 py-3 text-xs">
        {!isAl && (
          <Field label={isFolder ? 'Inside' : 'Reports to'}>
            <select
              value={role.manager ?? ''}
              onChange={(e) => setAgentManager(role.key, e.target.value || null)}
              className="w-full rounded bg-surface-2 px-2 py-1 text-text-secondary outline-none border border-border"
            >
              <option value="">— (root)</option>
              {managerOptions.map((m) => <option key={m.key} value={m.key}>{m.folder ? `📁 ${m.title}` : m.title}</option>)}
            </select>
          </Field>
        )}

        {!isFolder && <>
          {role.goals.length > 0 && (
            <Field label="Goals">
              <ul className="list-disc space-y-0.5 pl-4 text-text-secondary">
                {role.goals.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </Field>
          )}

          <Field label="Charter">
            <p className="whitespace-pre-wrap text-text-secondary">{charterText || <span className="text-text-tertiary">— (the agent maintains this in its file)</span>}</p>
          </Field>

          {memoryText && (
            <Field label="Memory">
              <p className="whitespace-pre-wrap text-text-secondary">{memoryText}</p>
            </Field>
          )}

          <Field label="File">
            <code className="block break-all text-[10px] text-text-tertiary">~/.config/console/agents/{role.key}.md</code>
          </Field>
        </>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{label}</div>
      {children}
    </div>
  )
}

function PanelBtn({ onClick, icon, children, danger }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${danger ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-border text-text-secondary hover:bg-surface-2'}`}
    >
      {icon}{children}
    </button>
  )
}
