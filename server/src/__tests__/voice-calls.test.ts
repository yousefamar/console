// AL's WhatsApp voice calls (^wise-lark): the hub's pure half — who gets
// answered, what the fold-back envelope says, what lands on disk and in
// wa-history, how a destination resolves, and the sidecar relay's state
// machine. The sidecar + pipeline processes are out of scope here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  answerPolicy, callEnvelope, historyLineFor, transcriptRecord, saveTranscript,
  resolveCallTarget, hasPriorChat, applySidecarEvent, getSidecarStatus, getSidecarQr, formatDuration,
  loadVoiceConfig, closingTurn, callerLanguage, type CallTranscript,
} from '../al/voice.js'
import { buildCallEnvelope, voiceForkRules } from '../al/voice-fork.js'
import { record, resetHistoryCache } from '../al/wa-history.js'

const YOUSEF = '447845443890@s.whatsapp.net'
const AL = '447897073727@s.whatsapp.net'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-calls-test-'))
  process.env.CONSOLE_WA_HISTORY_FILE = join(dir, 'wa-history.json')
  resetHistoryCache()
})
afterEach(() => {
  delete process.env.CONSOLE_WA_HISTORY_FILE
  resetHistoryCache()
  rmSync(dir, { recursive: true, force: true })
})

const completed = (over: Partial<CallTranscript> = {}): CallTranscript => ({
  callId: 'ABC123DEF',
  jid: YOUSEF,
  user: 'yousef',
  displayName: 'Yousef',
  direction: 'in',
  outcome: 'completed',
  durationMs: 125_000,
  startedAt: '2026-09-20T18:00:00.000Z',
  turns: [
    { role: 'user', text: 'Can you hear me?', t: 1200 },
    { role: 'assistant', text: 'Loud and clear. What do you need?', t: 2500 },
    { role: 'user', text: "What's on tomorrow?", t: 6000 },
    { role: 'assistant', text: 'Just the ten a.m. with Callum.', t: 9800 },
  ],
  delegations: 1,
  ...over,
})

describe('answerPolicy', () => {
  it('owner always, known contact by default, unknown never', () => {
    expect(answerPolicy({ user: 'yousef', trust: 'owner', frontmatter: {} }, 'in')).toEqual({ answer: true, why: 'owner' })
    expect(answerPolicy({ user: 'nica', trust: null, frontmatter: {} }, 'in')).toMatchObject({ answer: true })
    expect(answerPolicy({ user: null, trust: null, frontmatter: {} }, 'in')).toEqual({ answer: false, why: 'unknown number' })
  })
  it('a contact can opt out via calls: false or deny: [calls]; the owner cannot be locked out', () => {
    expect(answerPolicy({ user: 'mai', trust: null, frontmatter: { calls: 'false' } }, 'in').answer).toBe(false)
    expect(answerPolicy({ user: 'mai', trust: null, frontmatter: { deny: ['veronica', 'Calls'] } }, 'in').answer).toBe(false)
    expect(answerPolicy({ user: 'yousef', trust: 'owner', frontmatter: { calls: 'false' } }, 'in').answer).toBe(true)
  })
  it('outbound is not policed here (the prior-chat guard is)', () => {
    expect(answerPolicy({ user: null, trust: null, frontmatter: {} }, 'out').answer).toBe(true)
  })
})

describe('voice fork rules + envelope', () => {
  it('the rules name the identity rule, the hold-on-before-tools rule and the hangup command with the call id', () => {
    const rules = voiceForkRules('CALL42XYZ')
    expect(rules).toMatch(/Yousef's cloned voice/)
    expect(rules).toMatch(/holding phrase/)
    expect(rules).toMatch(/con whatsapp hangup CALL42XYZ/)
    expect(rules).toMatch(/ONCE/)
    expect(rules).toMatch(/do not retry/)
    expect(rules).toMatch(/English, Arabic \(Modern Standard accent\), German, Italian, French and Spanish/)
    expect(rules).toMatch(/ALWAYS written in Arabic script/)
    expect(rules).toMatch(/never Franco-Arabic/)
    expect(rules).toMatch(/ONE language at a time/)
    expect(rules).not.toMatch(/delegate/)
  })
  it('the envelope carries caller, thread, task and ends with the warm-turn cue; inherited mode inlines the rules', () => {
    const base = {
      callId: 'CALL42XYZ', displayName: 'Yousef', phone: '447845443890', user: 'yousef', trust: 'owner', userBody: 'likes tea',
      recentThread: ['[2 h ago] Yousef: hi', '[2 h ago] AL: hello'], openThreads: '- dentist', now: Date.UTC(2026, 8, 20, 18, 0, 0),
    }
    const out = buildCallEnvelope({ ...base, direction: 'out', task: 'Ask about dinner.' })
    expect(out.split('\n')[0]).toBe('[VOICE CALL OUTBOUND to Yousef (yousef, +447845443890) — callId CALL42XYZ]')
    expect(out).toContain('this is Yousef himself, your owner')
    expect(out).toContain('likes tea')
    expect(out).toContain('[2 h ago] AL: hello')
    expect(out).toContain('- dentist')
    expect(out).toContain('Your task: Ask about dinner.')
    expect(out).toMatch(/Reply with ONLY your opening line/)
    expect(out).not.toContain('Reply with exactly the word: ready')
    expect(out).not.toContain('# You are on a live voice call')

    const inbound = buildCallEnvelope({ ...base, direction: 'in', task: null, rulesInline: voiceForkRules('CALL42XYZ') })
    expect(inbound.startsWith('# You are on a live voice call')).toBe(true)
    expect(inbound).toContain('[VOICE CALL INBOUND from Yousef')
    expect(inbound).toContain('Yousef is calling you.')
    expect(inbound).not.toContain('## Call task')
    expect(inbound.trimEnd().endsWith('Reply with exactly the word: ready')).toBe(true)
  })
  it('the closing turn is the merge request: not spoken, follow-ups + memory first, then a digest — no transcript', () => {
    const c = closingTurn(completed())
    expect(c.split('\n')[0]).toBe('[CALL ENDED after 2m05s — you are being folded back into AL and closed]')
    expect(c).toMatch(/Nothing you write now is spoken/)
    expect(c).toMatch(/memory\/open-threads.md/)
    expect(c).toMatch(/FINAL message, write the hand-back/)
    expect(c).toContain('call-transcripts/ABC123DEF.json')
    expect(closingTurn(completed({ outcome: 'no-answer', durationMs: 0 })).split('\n')[0]).toBe('[CALL NO-ANSWER — you are being folded back into AL and closed]')
  })
})

describe('callEnvelope', () => {
  it('a completed call reads like a past-tense chat envelope with the transcript and the fold-back instruction', () => {
    const env = callEnvelope(completed(), 'Yousef')
    expect(env.split('\n')[0]).toBe('[WHATSAPP CALL with Yousef (+447845443890), 2m05s, inbound]')
    expect(env).toContain('1 delegate request(s)')
    expect(env).toContain('    1s Yousef: Can you hear me?')
    expect(env).toContain('    3s AL: Loud and clear. What do you need?')
    expect(env).toMatch(/This call already happened/)
    expect(env).toMatch(/Reply in this session only if something needs Yousef/)
    expect(env).not.toMatch(/con whatsapp send/)
  })
  it('an outbound call carries its task', () => {
    const env = callEnvelope(completed({ direction: 'out', task: 'Ask about dinner' }), 'Yousef')
    expect(env).toContain(', outbound]')
    expect(env).toContain('Task: Ask about dinner')
  })
  it('a rejected unknown caller becomes a missed-call envelope that leaves texting back to AL', () => {
    const env = callEnvelope(completed({ jid: '447700900999@s.whatsapp.net', user: null, outcome: 'rejected', reason: 'unknown number', turns: [], durationMs: 0 }), '+447700900999')
    expect(env.split('\n')[0]).toBe('[MISSED WHATSAPP CALL from +447700900999 (+447700900999) — rejected: unknown number]')
    expect(env).toMatch(/an unknown number gets nothing unless Yousef says so/)
  })
  it('no-answer and declined outbound calls say so', () => {
    expect(callEnvelope(completed({ direction: 'out', outcome: 'no-answer', turns: [], durationMs: 0 }), 'Yousef').split('\n')[0])
      .toBe('[WHATSAPP CALL to Yousef (+447845443890) — no answer]')
    expect(callEnvelope(completed({ direction: 'out', outcome: 'declined', turns: [], durationMs: 0 }), 'Yousef')).toMatch(/declined\]/)
  })
  it('a pipeline failure after pickup names the fault, what the caller heard, and asks AL to text them (call 008048b0)', () => {
    const env = callEnvelope(completed({
      direction: 'out', outcome: 'failed', reason: 'PIPELINE SETUP FAILED: pipeline setup timed out after 20 s; still connecting: CartesiaTTSService (cancelled after 20 s)',
      answeredAt: '2026-09-23T22:16:32Z', durationMs: 9400, task: 'Test call',
      turns: [{ role: 'assistant', text: "Sorry, I have a technical problem on my side. I'll text you instead.", t: 8385 }],
    }), 'Yousef')
    expect(env.split('\n')[0]).toBe('[WHATSAPP CALL with Yousef (+447845443890) — failed: PIPELINE SETUP FAILED: pipeline setup timed out after 20 s; still connecting: CartesiaTTSService (cancelled after 20 s)]')
    expect(env).toContain('Task: Test call')
    expect(env).toContain('Answered: yes, 9s — they heard only the canned line: "Sorry, I have a technical problem on my side. I\'ll text you instead."')
    expect(env).toMatch(/Text them now \(con whatsapp send\)/)
    expect(env).toMatch(/you promised a message/)
    expect(env).toMatch(/Tell Yousef the call failed and why/)
    expect(env).not.toMatch(/Nothing was said/)
  })
  it('a pipeline failure with no clip available says the caller heard nothing; one before pickup says it never rang through', () => {
    const silent = callEnvelope(completed({ direction: 'out', outcome: 'failed', reason: 'PIPELINE SETUP FAILED: x', answeredAt: '2026-09-23T22:16:32Z', durationMs: 3000, turns: [] }), 'Yousef')
    expect(silent).toContain('they heard NOTHING (no clip could be played)')
    expect(silent).not.toMatch(/you promised a message/)
    const ringing = callEnvelope(completed({ direction: 'out', outcome: 'failed', reason: 'PIPELINE SETUP FAILED: pipeline could not be built', answeredAt: null, durationMs: 0, turns: [] }), 'Yousef')
    expect(ringing).toContain('Answered: no — the call was ended before they picked up.')
    expect(ringing).toMatch(/tell Yousef the call failed and why/)
  })
})

describe('historyLineFor + formatDuration', () => {
  it('summarises the call in one wa-history line ending with the last thing said', () => {
    expect(historyLineFor(completed())).toBe('(inbound call, 2m05s, 4 turns) …AL: Just the ten a.m. with Callum.')
    expect(historyLineFor(completed({ outcome: 'missed', reason: 'busy', turns: [] }))).toBe('(inbound call, missed: busy)')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(3_600_000)).toBe('60m00s')
  })
})

describe('transcriptRecord + saveTranscript', () => {
  it('keeps the Atoms-era fields (from/to/duration/transcript[]) and adds the new ones', async () => {
    const rec = transcriptRecord(completed(), AL)
    expect(rec).toMatchObject({ callId: 'ABC123DEF', from: '+447845443890', to: '+447897073727', duration: '125s', transport: 'whatsapp', direction: 'in' })
    expect((rec.transcript as Array<{ role: string }>)[1]!.role).toBe('agent')
    const out = transcriptRecord(completed({ direction: 'out' }), AL)
    expect(out).toMatchObject({ from: '+447897073727', to: '+447845443890' })

    const file = await saveTranscript(completed(), AL, join(dir, 'transcripts'))
    expect(file.endsWith('/ABC123DEF.json')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf-8')).transport).toBe('whatsapp')
  })
})

describe('resolveCallTarget + hasPriorChat', () => {
  it('accepts phones and phone/lid JIDs, refuses junk', () => {
    expect(resolveCallTarget('+44 7845 443890')).toBe(YOUSEF)
    expect(resolveCallTarget('447845443890')).toBe(YOUSEF)
    expect(resolveCallTarget(YOUSEF)).toBe(YOUSEF)
    expect(resolveCallTarget('142245139378326@lid')).toBe('142245139378326@lid')
    expect(resolveCallTarget('x@g.us')).toBeNull()
    expect(resolveCallTarget('../../etc/passwd')).toBeNull()
    expect(resolveCallTarget('')).toBeNull()
  })
  it('a number with no wa-history thread is never dialled; one message is enough', () => {
    expect(hasPriorChat(YOUSEF)).toBe(false)
    record({ ts: Date.now(), dir: 'in', jid: YOUSEF, user: 'yousef', text: 'hi' })
    expect(hasPriorChat(YOUSEF)).toBe(true)
    expect(hasPriorChat('447845443890')).toBe(true)
    expect(hasPriorChat('447700900999@s.whatsapp.net')).toBe(false)
  })
})

describe('sidecar relay state', () => {
  it('tracks status/ready/qr/loggedout and expires a QR after a minute', () => {
    const seen: string[] = []
    const cb = { onQr: (c: string) => seen.push(`qr:${c}`), onReady: (j: string) => seen.push(`ready:${j}`), onLoggedOut: () => seen.push('out') }
    applySidecarEvent({ ev: 'status', connected: false, paired: false, calls: [] }, cb)
    expect(getSidecarStatus()).toMatchObject({ connected: false, paired: false, hasQr: false })
    applySidecarEvent({ ev: 'qr', code: '2@abc', dataUrl: 'data:…', timeoutSecs: 20 }, cb)
    expect(getSidecarQr()).toBe('2@abc')
    expect(getSidecarStatus().hasQr).toBe(true)
    applySidecarEvent({ ev: 'ready', jid: AL }, cb)
    expect(getSidecarStatus()).toMatchObject({ connected: true, paired: true, jid: AL, hasQr: false })
    expect(getSidecarQr()).toBeNull()
    applySidecarEvent({ ev: 'loggedout' }, cb)
    expect(getSidecarStatus()).toMatchObject({ connected: false, paired: false, jid: null })
    expect(seen).toEqual(['qr:2@abc', `ready:${AL}`, 'out'])
  })
})

describe('callerLanguage', () => {
  it('reads users/<slug>.md language/lang/locale as a base code, default en', () => {
    expect(callerLanguage({})).toBe('en')
    expect(callerLanguage({ language: 'ar' })).toBe('ar')
    expect(callerLanguage({ lang: 'de-DE' })).toBe('de')
    expect(callerLanguage({ locale: ['it_IT'] })).toBe('it')
    expect(callerLanguage({ language: 'arabic' })).toBe('en')
  })
})

describe('loadVoiceConfig', () => {
  it('fork model/context default to Sonnet 5 and fresh', () => {
    const f = join(dir, 'none.env')
    const cfg = loadVoiceConfig(f)
    expect(cfg.forkModel).toBe('claude-sonnet-5')
    expect(cfg.forkContext).toBe('fresh')
    writeFileSync(f, 'VOICE_FORK_MODEL=haiku\nVOICE_FORK_CONTEXT=inherited\n')
    const cfg2 = loadVoiceConfig(f)
    expect(cfg2.forkModel).toBe('haiku')
    expect(cfg2.forkContext).toBe('inherited')
  })
  it('defaults to the documented loopback ports and honours voice.env', () => {
    const none = loadVoiceConfig(join(dir, 'missing.env'))
    expect(none).toMatchObject({ sidecarUrl: 'ws://127.0.0.1:9878', pipelineUrl: 'http://127.0.0.1:9879' })
    const f = join(dir, 'voice.env')
    writeFileSync(f, 'WA_VOICE_PORT=9900\nVOICE_PIPELINE_PORT="9901"\n')
    expect(loadVoiceConfig(f)).toMatchObject({ sidecarUrl: 'ws://127.0.0.1:9900', pipelineUrl: 'http://127.0.0.1:9901' })
  })
})
