import { describe, it, expect } from 'vitest'
import { checkDelegation, buildChain, chainLabel, MAX_DEPTH } from '../agents/delegation.js'
import { buildOrgPosition, shortDescription, renderOrgRoster, buildDelegationEnvelope } from '../agents/delegation-protocol.js'
import type { OrgNode } from '../agents/registry.js'
import type { AgentTask } from '../agents/tasks.js'

describe('checkDelegation', () => {
  it('accepts a normal delegation', () => {
    expect(checkDelegation(['al'], 'al', 'eng').ok).toBe(true)
  })
  it('rejects self-delegation', () => {
    expect(checkDelegation(['al'], 'al', 'al').ok).toBe(false)
  })
  it('rejects a cycle (assignee already in the chain)', () => {
    const r = checkDelegation(['al', 'eng'], 'eng', 'al')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cycle/i)
  })
  it('rejects when the chain is already at the depth cap', () => {
    const deep = Array.from({ length: MAX_DEPTH }, (_, i) => `n${i}`)
    const r = checkDelegation(deep, deep[deep.length - 1]!, 'leaf')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/deep/i)
  })
  it('rejects an empty assignee', () => {
    expect(checkDelegation(['al'], 'al', '').ok).toBe(false)
  })
})

describe('buildChain', () => {
  it('starts a top-level chain at [fromKey, toKey]', () => {
    expect(buildChain(undefined, 'al', 'eng')).toEqual(['al', 'eng'])
  })
  it('extends a parent chain by the new assignee', () => {
    expect(buildChain(['al', 'eng'], 'eng', 'fe')).toEqual(['al', 'eng', 'fe'])
  })
  it('appends fromKey if the parent chain does not already end with it', () => {
    expect(buildChain(['al'], 'eng', 'fe')).toEqual(['al', 'eng', 'fe'])
  })
})

describe('shortDescription', () => {
  it('takes the first prose sentence, skipping headers/placeholders', () => {
    expect(shortDescription('## Charter\n\nOwns the Feeds pane. More detail here.\n\n## Memory\n_(x)_'))
      .toBe('Owns the Feeds pane.')
  })
  it('truncates long sentences', () => {
    const long = 'A'.repeat(200)
    expect(shortDescription(long).endsWith('…')).toBe(true)
  })
  it('empty for no charter', () => {
    expect(shortDescription('')).toBe('')
    expect(shortDescription(null)).toBe('')
  })
})

describe('renderOrgRoster', () => {
  const tree: OrgNode[] = [
    { role: { key: 'al', title: 'Al', manager: null, goals: [], cwd: null, created: null, charter: '', hasFile: true, folder: false }, children: [
      { role: { key: 'cg', title: 'Console general', manager: 'al', goals: [], cwd: null, created: null, charter: '', hasFile: true, folder: false }, children: [
        { role: { key: 'feeds', title: 'Feeds', manager: 'cg', goals: [], cwd: null, created: null, charter: '', hasFile: true, folder: false }, children: [] },
      ] },
    ] },
  ]
  it('renders an indented name roster', () => {
    const r = renderOrgRoster(tree)
    expect(r).toContain('- Al (`al`)')
    expect(r).toContain('  - Console general (`cg`)')
    expect(r).toContain('    - Feeds (`feeds`)')
  })
})

describe('buildOrgPosition', () => {
  it('includes the full roster + neighbour descriptions + self-identity', () => {
    const s = buildOrgPosition({
      self: { key: 'feeds-tab', title: 'Feeds tab' },
      roster: '- Al (`al`)\n  - Console general (`console-general`)',
      manager: { key: 'console-general', title: 'Console general', desc: 'Owns the Console panes.' },
      reports: [{ key: 'a', title: 'Aye', desc: 'Does A.' }, { key: 'b', title: 'Bee', folder: true }],
    })
    expect(s).toContain('You are:')
    expect(s).toContain('Feeds tab (`feeds-tab`)')
    expect(s).toContain('~/.config/console/agents/feeds-tab.md')
    expect(s).toContain('locate anyone')
    expect(s).toContain('- Al (`al`)')                       // roster
    expect(s).toContain('Console general (`console-general`)')
    expect(s).toContain('Owns the Console panes.')           // manager desc
    expect(s).toContain('Aye (`a`) — Does A.')               // report desc
    expect(s).toContain('Bee (`b`) [folder]')
    expect(s).toContain('Do not skip levels')
  })
  it('handles a root with no reports', () => {
    const s = buildOrgPosition({ roster: '- Al (`al`)', manager: null, reports: [] })
    expect(s).toContain('org root')
    expect(s).toContain('no direct reports')
  })
})

describe('buildDelegationEnvelope', () => {
  const task: AgentTask = { id: 'tsk_1', title: 'T', brief: 'route this to agents-tab', fromKey: 'al', toKey: 'console-general', origin: 'human', parentTaskId: null, chain: ['al', 'console-general'], status: 'in_progress', result: null, createdAt: 0, updatedAt: 0 }
  it('mandates re-delegation with the exact command when the assignee has reports', () => {
    const e = buildDelegationEnvelope({ task, fromTitle: 'Al', chainLabel: 'Yousef → Al → you', reports: [{ key: 'agents-tab', title: 'Agents tab' }] })
    expect(e).toContain('You manage: Agents tab (`agents-tab`)')
    expect(e).toContain('MUST re-delegate')
    expect(e).toContain('con agent delegate <reportKey> "<brief, addressed to them>" --from console-general --parent tsk_1')
    expect(e).toContain('NOT answer on their behalf')
  })
  it('omits the manager mandate for a leaf (no reports)', () => {
    const e = buildDelegationEnvelope({ task, fromTitle: 'Al', chainLabel: 'Yousef → Al → you', reports: [] })
    expect(e).not.toContain('MUST re-delegate')
    expect(e).toContain('con agent report tsk_1')
  })
})

describe('chainLabel', () => {
  const titleFor = (k: string) => ({ al: 'Al', eng: 'Engineering', fe: 'Frontend' }[k] ?? k)
  it('renders a human-origin chain with Yousef prefix and "you" tail', () => {
    expect(chainLabel(['al', 'eng', 'fe'], titleFor, 'human')).toBe('Yousef → Al → Engineering → you')
  })
  it('omits the Yousef prefix for agent-origin chains', () => {
    expect(chainLabel(['eng', 'fe'], titleFor, 'agent')).toBe('Engineering → you')
  })
})
