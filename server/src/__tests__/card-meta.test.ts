// Card metadata (`#key/value` tags) and the rule that no card is created
// without a creator (^busy-koi).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore } from '../notes.js'
import { BoardOps } from '../kanban/board-ops.js'
import { parseBoard, serializeBoard, parseCardTokens, addCard, refreshCardLine, metaLabel, metaKey, metaValue, tagAsMeta, splitTrailingMeta } from '../kanban/board.js'
import { buildBoardEnvelope } from '../kanban/dispatch.js'
import { cardCreator } from '../routes/board.js'

const BOARD = `---
kanban-plugin: board
---

## Backlog

- [ ] First idea
- [ ] Second idea #created-by/ui #requested-by:essam #haiku @eng ^aa11bb
	- existing note

## Done
`

describe('metadata grammar', () => {
  it('trailing #key/value tags parse into meta in line order; `:` is read too', () => {
    const t = parseCardTokens('Ship it #created-by/ui #requested-by:essam #haiku #blocked @eng ^aa11bb')
    expect(t.text).toBe('Ship it')
    expect(t.meta).toEqual({ 'created-by': 'ui', 'requested-by': 'essam' })
    expect(Object.keys(t.meta)).toEqual(['created-by', 'requested-by'])
    expect(t).toMatchObject({ model: 'haiku', blocked: true, agentKey: 'eng', blockId: 'aa11bb' })
  })

  it('mid-text, dispatch keys and plain tags are not metadata', () => {
    expect(parseCardTokens('The #area/billing page is slow').meta).toEqual({})
    expect(parseCardTokens('Not a level #effort/turbo')).toMatchObject({ text: 'Not a level #effort/turbo', meta: {} })
    expect(parseCardTokens('Canadian tax lines #rfp')).toMatchObject({ text: 'Canadian tax lines #rfp', meta: {} })
    expect(tagAsMeta('created-by/ui')).toEqual({ key: 'created-by', value: 'ui' })
    expect(tagAsMeta('rfp')).toBeNull()
    expect(tagAsMeta('model/haiku')).toBeNull()
  })

  it('an untouched board round-trips byte for byte; a rewritten line normalises to `/`', () => {
    const board = parseBoard(BOARD)
    expect(serializeBoard(board)).toBe(BOARD)
    const card = board.columns[0]!.cards[1]!
    refreshCardLine(card)
    expect(card.lines[0]).toBe('- [ ] Second idea #created-by/ui #requested-by/essam #haiku @eng ^aa11bb')
  })

  it('labels read as prose; hub-stamped creators get their proper names', () => {
    expect(metaLabel('created-by', 'ui')).toEqual({ key: 'Created by', value: 'UI' })
    expect(metaLabel('created-by', 'cosy-boar')).toEqual({ key: 'Created by', value: 'cosy-boar' })
    expect(metaLabel('requested-by', 'essam')).toEqual({ key: 'Requested by', value: 'essam' })
  })

  it('keys and values are normalised to what a tag can carry, or refused', () => {
    expect(metaKey('Requested By')).toBe('requested-by')
    expect(metaValue('Essam K.')).toBe('Essam-K.')
    expect(() => metaKey('9lives')).toThrow(/not a usable tag key/)
    expect(() => metaKey('model')).toThrow(/dispatch tag/)
    expect(() => metaValue(' !! ')).toThrow(/not a usable tag value/)
  })

  it('splitTrailingMeta peels only metadata off typed text', () => {
    expect(splitTrailingMeta('Fix export #requested-by/essam #area/orders')).toEqual({ text: 'Fix export', meta: { 'requested-by': 'essam', area: 'orders' } })
    expect(splitTrailingMeta('Fix export #haiku')).toEqual({ text: 'Fix export #haiku', meta: {} })
  })
})

describe('addCard needs a creator', () => {
  it('throws without one and stamps it with one', () => {
    const board = parseBoard(BOARD)
    // @ts-expect-error — the type forbids it too
    expect(() => addCard(board, 'Backlog', 'Orphan')).toThrow(/needs a creator/)
    expect(() => addCard(board, 'Backlog', 'Orphan', { createdBy: '  ' })).toThrow(/needs a creator/)
    const card = addCard(board, 'Backlog', 'New work', { createdBy: 'ring', meta: { 'Requested By': 'Essam K' } })!
    expect(card.lines[0]).toBe('- [ ] New work #created-by/ring #requested-by/Essam-K')
  })

  it('metadata typed on the text joins the card; it cannot replace the creator', () => {
    const board = parseBoard(BOARD)
    const card = addCard(board, 'Backlog', 'Fix export #created-by/essam #area/orders', { createdBy: 'ui' })!
    expect(card.text).toBe('Fix export')
    expect(card.meta).toEqual({ 'created-by': 'ui', area: 'orders' })
  })
})

describe('BoardOps', () => {
  let dir: string
  let ops: BoardOps
  const onDisk = () => readFileSync(join(dir, 'projects', 'demo', 'board.md'), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'card-meta-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'demo', 'board.md'), BOARD)
    ops = new BoardOps(new NoteStore(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('add refuses a card with no creator and leaves the board untouched', async () => {
    // @ts-expect-error — the type forbids it too
    await expect(ops.add('demo', 'Orphan', { column: 'Backlog' })).rejects.toThrow(/needs a creator/)
    await expect(ops.add('demo', 'Orphan', { createdBy: '', column: 'Backlog' })).rejects.toThrow(/needs a creator/)
    expect(onDisk()).toBe(BOARD)
  })

  it('add stamps the creator and optional metadata, and the view carries both', async () => {
    const r = await ops.add('demo', 'Export orders', { createdBy: 'cosy-boar', meta: { 'requested-by': 'essam' }, column: 'Backlog' })
    expect(r.meta).toEqual({ 'created-by': 'cosy-boar', 'requested-by': 'essam' })
    expect(onDisk()).toContain('- [ ] Export orders #created-by/cosy-boar #requested-by/essam\n')
    const shown = (await ops.show('demo')).columns[0]!.cards
    expect(shown[0]!.meta).toEqual({ 'created-by': 'cosy-boar', 'requested-by': 'essam' })
    expect(shown[1]!.meta).toEqual({})
  })

  it('tag sets and clears metadata; the creator can be filled in once, never changed or removed', async () => {
    await ops.setMeta('demo', '^aa11bb', 'Area', 'orders')
    expect(onDisk()).toContain('- [ ] Second idea #created-by/ui #requested-by/essam #area/orders #haiku @eng ^aa11bb')
    await ops.setMeta('demo', '^aa11bb', 'requested-by', null)
    expect(onDisk()).toContain('- [ ] Second idea #created-by/ui #area/orders #haiku @eng ^aa11bb')
    await expect(ops.setMeta('demo', '^aa11bb', 'created-by', 'someone')).rejects.toThrow(/cannot be changed/)
    await expect(ops.setMeta('demo', '^aa11bb', 'created-by', null)).rejects.toThrow(/cannot be changed/)
    const legacy = await ops.setMeta('demo', 'First idea', 'created-by', 'yousef')
    expect(legacy.meta).toEqual({ 'created-by': 'yousef' })
  })

  it('editing the text keeps the metadata', async () => {
    await ops.edit('demo', '^aa11bb', { text: 'Second idea, sharper' })
    expect(onDisk()).toContain('- [ ] Second idea, sharper #created-by/ui #requested-by/essam #haiku @eng ^aa11bb')
  })
})

describe('who is creating the card (POST /board/:project/cards)', () => {
  it('explicit createdBy, else the agent header, else the app it plainly came from', () => {
    expect(cardCreator({ createdBy: 'ui' }, 'some-agent', 'Mozilla/5.0')).toBe('ui')
    expect(cardCreator({}, 'console-general-cosy-boar-fork', undefined)).toBe('console-general-cosy-boar-fork')
    expect(cardCreator({}, undefined, 'okhttp/4.12.0')).toBe('android')
    expect(cardCreator({}, undefined, 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('ui')
    expect(cardCreator({}, undefined, 'node')).toBe('cli')
  })

  it('nobody to name = no card', () => {
    expect(() => cardCreator({}, undefined, 'curl/8.5.0')).toThrow(/needs a creator/)
    expect(() => cardCreator({ createdBy: '  ' }, undefined, undefined)).toThrow(/needs a creator/)
  })
})

describe('dispatch envelope', () => {
  it('names the creator and requester under the card text', () => {
    const env = buildBoardEnvelope({
      boardAbsPath: '/v/projects/demo/board.md', column: 'In Progress', project: 'demo',
      card: { text: 'Export orders', blockId: 'aa11bb', lines: ['- [ ] Export orders'], meta: { 'created-by': 'ui', 'requested-by': 'essam' } },
    })
    expect(env).toContain('Export orders\n\nCreated by: UI · Requested by: essam\n')
  })
})
