import { useMemo } from 'react'
import { X, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useAgentStore } from '@/store/agent'

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
  const selectSession = useAgentStore((s) => s.selectSession)

  const role = roles.find((r) => r.key === agentKey)
  const live = useMemo(() => sessions.find((s) => s.agentKey === agentKey && s.status !== 'ended'), [sessions, agentKey])
  const managerOptions = useMemo(
    () => roles.filter((r) => r.key !== agentKey).map((r) => ({ key: r.key, title: r.title })).sort((a, b) => a.title.localeCompare(b.title)),
    [roles, agentKey],
  )

  if (!role) {
    return (
      <div className="flex h-full w-80 flex-shrink-0 flex-col border-l border-border p-3 text-xs text-text-tertiary">
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
    <div className="flex h-full w-80 flex-shrink-0 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{role.title}</div>
          <div className="truncate font-mono text-[10px] text-text-tertiary">{role.key}{live ? '' : ' · parked'}</div>
        </div>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
        {live ? (
          <>
            <PanelBtn onClick={() => selectSession(live.id)} icon={<Play size={12} />}>Open</PanelBtn>
            <PanelBtn onClick={() => reloadSession(live.id)} icon={<RefreshCw size={12} />}>Reload</PanelBtn>
            <PanelBtn onClick={() => killSession(live.id)} icon={<Square size={12} />}>Park</PanelBtn>
          </>
        ) : (
          <PanelBtn onClick={() => reviveAgent(role.key)} icon={<Play size={12} />}>Revive</PanelBtn>
        )}
        <PanelBtn onClick={() => { if (confirm(`Delete role "${role.title}"? This removes its file and kills any live session.`)) { deleteRole(role.key); onClose() } }} icon={<Trash2 size={12} />} danger>Delete</PanelBtn>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-xs">
        <Field label="Reports to">
          <select
            value={role.manager ?? ''}
            onChange={(e) => setAgentManager(role.key, e.target.value || null)}
            className="w-full rounded bg-bg-secondary px-2 py-1 text-text-secondary outline-none border border-border"
          >
            <option value="">— (root)</option>
            {managerOptions.map((m) => <option key={m.key} value={m.key}>{m.title}</option>)}
          </select>
        </Field>

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
      className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${danger ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-border text-text-secondary hover:bg-bg-secondary'}`}
    >
      {icon}{children}
    </button>
  )
}
