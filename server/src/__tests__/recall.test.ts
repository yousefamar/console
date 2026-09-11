// ^jade-bat — past-session recall: JSONL parse, redaction, FTS search, the
// address ladder (session → turn → tool result), and the render contract the
// CLI prints for agents.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parseTranscriptText, humanText, firstHumanPrompt } from '../recall/parse.js'
import { redact, isSensitivePath } from '../recall/redact.js'
import { openDb, upsertSession, stats } from '../recall/db.js'
import { parseAddress, formatAddress } from '../recall/address.js'
import { buildMatch, orTerms, parseSince, selectTurns, resolveSession, NotFoundError } from '../recall/query.js'
import { runSearch, runRead, indexFile } from '../recall/service.js'
import { listTranscripts } from '../recall/index.js'

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const CWD_A = '/home/amar/proj/code/console'
const CWD_B = '/home/amar/sync/brain/root/projects/astera'

function rec(o: Record<string, unknown>): string { return JSON.stringify(o) }

function user(text: string, uuid: string, ts: string, extra: Record<string, unknown> = {}) {
  return rec({ type: 'user', uuid, timestamp: ts, cwd: CWD_A, gitBranch: 'main', entrypoint: 'sdk-cli', message: { role: 'user', content: text }, ...extra })
}
function assistant(blocks: unknown[], uuid: string, ts: string) {
  return rec({ type: 'assistant', uuid, timestamp: ts, cwd: CWD_A, gitBranch: 'main', message: { role: 'assistant', content: blocks } })
}
function toolResult(toolUseId: string, content: string, ts: string) {
  return rec({ type: 'user', uuid: 'r-' + toolUseId, timestamp: ts, toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })
}

const TRANSCRIPT_A = [
  rec({ type: 'custom-title', customTitle: 'Console general', sessionId: SID_A }),
  user('[BOARD TASK — action required]\nCard ^x: fix the pruned transcript respawn', 'e0000001-0000-4000-8000-000000000001', '2026-09-01T10:00:00.000Z'),
  assistant([{ type: 'text', text: 'On it.' }], 'a0000001', '2026-09-01T10:00:05.000Z'),
  user('Why does the hub lose crons when a transcript is pruned? <system-reminder>noise</system-reminder>', 'e0000002-0000-4000-8000-000000000002', '2026-09-01T10:05:00.000Z'),
  assistant([
    { type: 'text', text: 'Because crons are keyed by claudeSessionId and the fresh respawn mints a new one.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'grep -n rekeyedFrom server/src/session.ts' } },
  ], 'a0000002', '2026-09-01T10:05:10.000Z'),
  toolResult('toolu_1', 'session.ts:512: rekeyedFrom: this.previousCsid\npassword=hunter2secret\n', '2026-09-01T10:05:11.000Z'),
  assistant([
    { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/home/amar/proj/code/console/server/src/session.ts', old_string: 'a', new_string: 'b' } },
    { type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: '/home/amar/.config/console/auth.json' } },
  ], 'a0000003', '2026-09-01T10:06:00.000Z'),
  toolResult('toolu_2', 'The file has been updated', '2026-09-01T10:06:01.000Z'),
  toolResult('toolu_3', '{"token":"supersecretvalue123"}', '2026-09-01T10:06:02.000Z'),
  assistant([{ type: 'text', text: 'Fixed in 3360883c: reassignSession re-keys active crons on the pruned-transcript path. Bearer token was sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in the log, now scrubbed.' }], 'a0000004', '2026-09-01T10:07:00.000Z'),
  rec({ type: 'user', uuid: 'side', isSidechain: true, timestamp: '2026-09-01T10:08:00.000Z', message: { role: 'user', content: 'sidechain zebra' } }),
  rec({ type: 'user', uuid: 'meta', isMeta: true, timestamp: '2026-09-01T10:08:00.000Z', message: { role: 'user', content: 'meta giraffe' } }),
  user('<command-name>/clear</command-name><command-args></command-args>', 'e0000003-0000-4000-8000-000000000003', '2026-09-01T10:09:00.000Z'),
  user('<local-command-stdout>ignored</local-command-stdout>', 'e0000004-0000-4000-8000-000000000004', '2026-09-01T10:09:30.000Z'),
].join('\n') + '\n'

const TRANSCRIPT_B = [
  rec({ type: 'user', uuid: 'b0000001-0000-4000-8000-000000000001', timestamp: '2026-08-20T09:00:00.000Z', cwd: CWD_B, gitBranch: 'master', entrypoint: 'cli', message: { role: 'user', content: 'Draft the Astera investor update about the pruned budget' } }),
  rec({ type: 'assistant', uuid: 'b-a1', timestamp: '2026-08-20T09:01:00.000Z', cwd: CWD_B, message: { role: 'assistant', content: [{ type: 'text', text: 'Drafted. The transcript of the call is attached.' }] } }),
].join('\n') + '\n'

let dir: string
let db: DatabaseSync

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recall-'))
  const pa = join(dir, 'projects', '-home-amar-proj-code-console')
  const pb = join(dir, 'projects', '-home-amar-sync-brain-root-projects-astera')
  mkdirSync(pa, { recursive: true })
  mkdirSync(pb, { recursive: true })
  writeFileSync(join(pa, `${SID_A}.jsonl`), TRANSCRIPT_A)
  writeFileSync(join(pb, `${SID_B}.jsonl`), TRANSCRIPT_B)
  db = openDb(join(dir, 'recall.db'))
  indexFile(db, SID_A, join(pa, `${SID_A}.jsonl`), { hubName: 'Console general', agentKey: 'console-general' })
  indexFile(db, SID_B, join(pb, `${SID_B}.jsonl`))
})
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('parse', () => {
  const s = parseTranscriptText(TRANSCRIPT_A, SID_A)

  it('pairs human prompts with replies and skips sidechain/meta/machine records', () => {
    expect(s.turns.map((t) => t.userText.slice(0, 12))).toEqual(['[BOARD TASK ', 'Why does the', '/clear'])
    expect(s.turns[1]!.assistantText).toContain('keyed by claudeSessionId')
    expect(s.turns[1]!.assistantText).toContain('Fixed in 3360883c')
    expect(JSON.stringify(s)).not.toContain('zebra')
    expect(JSON.stringify(s)).not.toContain('giraffe')
    expect(JSON.stringify(s)).not.toContain('ignored')
  })

  it('records metadata, title and stable turn uuids', () => {
    expect(s.cwd).toBe(CWD_A)
    expect(s.gitBranch).toBe('main')
    expect(s.title).toBe('Console general')
    expect(s.entrypoint).toBe('sdk-cli')
    expect(s.turns[1]!.uuid).toBe('e0000002-0000-4000-8000-000000000002')
    expect(s.startedAt).toBe('2026-09-01T10:00:00.000Z')
  })

  it('attaches tool results to their tool_use and tracks files read/written', () => {
    const t = s.turns[1]!
    expect(t.events.map((e) => e.name)).toEqual(['Bash', 'Edit', 'Read'])
    expect(t.events[0]!.result).toContain('rekeyedFrom')
    expect(t.events[1]!.result).toBe('The file has been updated')
    expect(t.files.get('/home/amar/proj/code/console/server/src/session.ts')).toEqual(new Set(['write']))
  })

  it('redacts secrets and replaces sensitive-file reads with a placeholder', () => {
    const t = s.turns[1]!
    expect(t.events[0]!.result).not.toContain('hunter2secret')
    expect(t.events[0]!.result).toContain('[redacted]')
    expect(t.events[2]!.result).toBe('[not indexed: sensitive path]')
    expect(t.assistantText).not.toContain('sk-ant-api03')
    expect(t.assistantText).toContain('[redacted key]')
  })

  it('strips system reminders and turns slash commands into /name', () => {
    expect(s.turns[1]!.userText).not.toContain('system-reminder')
    expect(humanText({ message: { content: '<command-name>/foo</command-name><command-args>bar baz</command-args>' } })).toBe('/foo bar baz')
    expect(firstHumanPrompt(s)).toMatch(/^Why does the hub/)
  })
})

describe('redact', () => {
  it('covers the common shapes', () => {
    expect(redact('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [redacted]')
    expect(redact('https://user:pa55word@host/x')).toBe('https://user:[redacted]@host/x')
    expect(redact('ghp_' + 'A'.repeat(36))).toBe('[redacted github token]')
    expect(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('[redacted jwt]')
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[redacted private key]')
    expect(redact('API_KEY=abcdef123456')).toBe('API_KEY=[redacted]')
    expect(redact('the password field is required')).toBe('the password field is required')
  })
  it('flags credential paths', () => {
    expect(isSensitivePath('/x/.env')).toBe(true)
    expect(isSensitivePath('/x/.env.local')).toBe(true)
    expect(isSensitivePath('/home/amar/.ssh/id_ed25519')).toBe(true)
    expect(isSensitivePath('/x/server.pem')).toBe(true)
    expect(isSensitivePath('/x/environment.ts')).toBe(false)
  })
})

describe('address', () => {
  it('parses every accepted form', () => {
    expect(parseAddress('aaaaaaaa')).toEqual({ session: 'aaaaaaaa', turn: '', seq: -1 })
    expect(parseAddress('aaaaaaaa/e0000002')).toEqual({ session: 'aaaaaaaa', turn: 'e0000002', seq: -1 })
    expect(parseAddress('aaaaaaaa/t1#2')).toEqual({ session: 'aaaaaaaa', turn: 't1', seq: 2 })
    expect(parseAddress('cc://aaaaaaaa/T1')).toEqual({ session: 'aaaaaaaa', turn: 't1', seq: -1 })
    expect(parseAddress('[aaaaaaaa e0000002 t1 2026-09-01 claude]')).toEqual({ session: 'aaaaaaaa', turn: 't1', seq: -1 })
    expect(parseAddress('[aaaaaaaa e0000002 t1#0 tool:Bash 2026-09-01]')).toEqual({ session: 'aaaaaaaa', turn: 't1', seq: 0 })
    expect(formatAddress({ session: 'aaaaaaaa', turn: 't1', seq: 2 })).toBe('aaaaaaaa/t1#2')
  })
  it('rejects garbage', () => {
    expect(() => parseAddress('')).toThrow()
    expect(() => parseAddress('zz')).toThrow(/session id/)
    expect(() => parseAddress('aaaaaaaa#2')).toThrow(/needs a turn/)
    expect(() => parseAddress('aaaaaaaa/x/y')).toThrow()
  })
})

describe('query helpers', () => {
  it('quotes tokens and keeps prefix/operators', () => {
    expect(buildMatch('pruned transcript')).toBe('"pruned" "transcript"')
    expect(buildMatch('con agent OR pyrig*')).toBe('"con" "agent" OR "pyrig"*')
    expect(buildMatch('a "quoted; thing" NOT')).toBe('"a" "quoted;" "thing"')
    expect(buildMatch('   ')).toBe('')
  })
  it('picks distinctive OR terms', () => {
    expect(orTerms('why did the pruned transcript pruned')).toEqual(['pruned', 'transcript'])
  })
  it('parses since', () => {
    const now = new Date('2026-09-11T12:00:00.000Z')
    expect(parseSince('7d', now)).toBe('2026-09-04T12:00:00.000Z')
    expect(parseSince('2w', now)).toBe('2026-08-28T12:00:00.000Z')
    expect(parseSince('2026-09-01', now)).toBe('2026-09-01T00:00:00.000Z')
    expect(() => parseSince('yesterday-ish', now)).toThrow()
  })
  it('selects turns', () => {
    const all = [0, 1, 2, 3, 4].map((idx) => ({ idx })) as never[]
    expect(selectTurns(all, 'last:2').map((t: { idx: number }) => t.idx)).toEqual([3, 4])
    expect(selectTurns(all, 'first:1').map((t: { idx: number }) => t.idx)).toEqual([0])
    expect(selectTurns(all, '1-2').map((t: { idx: number }) => t.idx)).toEqual([1, 2])
    expect(selectTurns(all, '0,4').map((t: { idx: number }) => t.idx)).toEqual([0, 4])
    expect(() => selectTurns(all, 'nope')).toThrow()
  })
})

describe('index + search', () => {
  it('indexes both sessions once and skips unchanged files', () => {
    expect(stats(db)).toEqual({ sessions: 2, turns: 4, toolEvents: 3 })
    const again = indexFile(db, SID_A, join(dir, 'projects', '-home-amar-proj-code-console', `${SID_A}.jsonl`))
    expect(again.indexed).toBe(false)
    expect(stats(db).turns).toBe(4)
  })

  it('finds a session by words in the reply and prints the ladder', () => {
    const r = runSearch(db, { query: 'crons keyed claudeSessionId', filters: {} })
    expect(r.hits).toBe(1)
    expect(r.text).toContain('aaaaaaaa 2026-09-01 ~/proj/code/console (main) 3t "Console general"')
    expect(r.text).toContain('t1 e0000002:')
    expect(r.text).toContain('wrote: ~/proj/code/console/server/src/session.ts')
    expect(r.text).toContain('con agent read <session8> --grep')
    expect(r.text).toContain('never quote them')
  })

  it('counts tool-output matches separately and shows them on request', () => {
    const quiet = runSearch(db, { query: 'rekeyedFrom', filters: {} })
    expect(quiet.text).toContain('+1 match in tool output (--tools to show)')
    const loud = runSearch(db, { query: 'rekeyedFrom', filters: {}, includeTools: true })
    expect(loud.text).toContain('t1#0 Bash:')
  })

  it('applies filters: project, since, file, session, excludeId', () => {
    expect(runSearch(db, { query: 'pruned', filters: {} }).hits).toBe(2)
    expect(runSearch(db, { query: 'pruned', filters: { project: 'astera' } }).hits).toBe(1)
    expect(runSearch(db, { query: 'pruned', filters: { since: '2026-08-25' } }).text).toContain('aaaaaaaa')
    expect(runSearch(db, { query: 'pruned', filters: { since: '2026-08-25' } }).text).not.toContain('bbbbbbbb')
    expect(runSearch(db, { query: 'pruned', filters: { file: 'session.ts' } }).hits).toBe(1)
    expect(runSearch(db, { query: 'pruned', filters: { excludeId: SID_A } }).text).not.toContain('aaaaaaaa')
    expect(runSearch(db, { query: 'pruned', filters: { session: 'bbbbbbbb' } }).hits).toBe(1)
  })

  it('boosts sessions under the caller cwd', () => {
    const fromConsole = runSearch(db, { query: 'pruned', filters: {}, cwdHint: CWD_A })
    expect(fromConsole.text.indexOf('aaaaaaaa')).toBeLessThan(fromConsole.text.indexOf('bbbbbbbb'))
    const fromAstera = runSearch(db, { query: 'pruned', filters: {}, cwdHint: CWD_B })
    expect(fromAstera.text.indexOf('bbbbbbbb')).toBeLessThan(fromAstera.text.indexOf('aaaaaaaa'))
  })

  it('falls back to an OR listing when nothing matches every word', () => {
    const r = runSearch(db, { query: 'pruned unicorn festival', filters: {} })
    expect(r.fallback).toBe('pruned OR unicorn OR festival')
    expect(r.text).toMatch(/^No session matches all of/)
    expect(r.hits).toBe(2)
    const none = runSearch(db, { query: 'unicorn festival', filters: {} })
    expect(none.hits).toBe(0)
    expect(none.text).toMatch(/^No indexed session matches/)
  })

  it('lists recent sessions and sessions touching a file when the query is empty', () => {
    const now = new Date()
    const recentText = runSearch(db, { query: '', filters: { since: `${Math.ceil((now.getTime() - Date.parse('2026-08-01')) / 86_400_000)}d` } }).text
    expect(recentText).toContain('2 most recent sessions')
    expect(recentText.indexOf('aaaaaaaa')).toBeLessThan(recentText.indexOf('bbbbbbbb'))
    const files = runSearch(db, { query: '', filters: { file: 'session.ts' } }).text
    expect(files).toContain('write ~/proj/code/console/server/src/session.ts×1')
  })

  it('never surfaces redacted material', () => {
    expect(runSearch(db, { query: 'hunter2secret', filters: {} }).hits).toBe(0)
    expect(runSearch(db, { query: 'supersecretvalue123', filters: {} }).hits).toBe(0)
  })
})

describe('read ladder', () => {
  it('session view: header, resume line, clipped turns, and a grep mode', () => {
    const v = runRead(db, { address: 'aaaaaaaa' }).text
    expect(v).toContain('resume: cd ~/proj/code/console && claude --resume ' + SID_A)
    expect(v).toContain('3/3 turns')
    expect(v).toContain('t1 e0000002 2026-09-01 10:05  3 tool calls')
    expect(v).toContain('never quote from it')
    const last = runRead(db, { address: 'aaaaaaaa', turns: 'last:1' }).text
    expect(last).toContain('1/3 turns (last:1)')
    expect(last).toContain('/clear')
    const g = runRead(db, { address: 'aaaaaaaa', grep: 'rekey|re-keys' }).text
    expect(g).toContain('t1 e0000002 2026-09-01 claude: Fixed in 3360883c')
    expect(g).toContain('t1 e0000002 2026-09-01 tool:Bash#0: session.ts:512')
  })

  it('turn view: full text, cite line, tool list; --tools adds results', () => {
    const t = runRead(db, { address: 'aaaaaaaa/e0000002' }).text
    expect(t).toContain('cite: [aaaaaaaa e0000002 t1 2026-09-01]')
    expect(t).toContain('Why does the hub lose crons')
    expect(t).toContain('#0 Bash grep -n rekeyedFrom')
    expect(t).not.toContain('session.ts:512')
    const withTools = runRead(db, { address: 'aaaaaaaa/t1', includeTools: true }).text
    expect(withTools).toContain('session.ts:512')
    const grep = runRead(db, { address: 'aaaaaaaa/t1', grep: 'Fixed in' }).text
    expect(grep).toContain('Fixed in 3360883c')
    expect(grep).not.toContain('Why does the hub')
  })

  it('tool view: output with its own cite line', () => {
    const e = runRead(db, { address: 'aaaaaaaa/t1#0' }).text
    expect(e).toContain('cite: [aaaaaaaa e0000002 t1#0 tool:Bash 2026-09-01]')
    expect(e).toContain('input: grep -n rekeyedFrom')
    expect(e).toContain('rekeyedFrom: this.previousCsid')
    expect(runRead(db, { address: '[aaaaaaaa e0000002 t1#0 tool:Bash 2026-09-01]' }).text).toBe(e)
  })

  it('errors name the missing thing', () => {
    expect(() => runRead(db, { address: 'cccccccc' })).toThrow(NotFoundError)
    expect(() => runRead(db, { address: 'aaaaaaaa/t9' })).toThrow(/no turn "t9"/)
    expect(() => runRead(db, { address: 'aaaaaaaa/t1#7' })).toThrow(/no tool call #7/)
    expect(() => resolveSession(db, 'a')).not.toThrow()
  })
})

describe('discovery', () => {
  it('lists every transcript under the projects dir, newest first', () => {
    const files = listTranscripts(join(dir, 'projects'))
    expect(files.map((f) => f.sessionId).sort()).toEqual([SID_A, SID_B].sort())
    expect(listTranscripts(join(dir, 'nope'))).toEqual([])
  })
})
