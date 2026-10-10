import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DebugLog, rotatedLines } from '../debug-log.js'

const net = (i: number) => JSON.stringify({ ts: i, cat: 'net', method: 'GET', url: `/notes/file/${i}`, status: 200 })
const err = (i: number) => JSON.stringify({ ts: i, cat: 'error', message: `IllegalStateException: ${i}`, stack: 'at a.B(C.kt:1)' })

describe('rotatedLines', () => {
  it('keeps the newest lines when nothing dropped is an error', () => {
    const lines = Array.from({ length: 10 }, (_, i) => net(i))
    expect(rotatedLines(lines, 4)).toEqual(lines.slice(-4))
  })

  it('carries a dropped error over the rotation, ahead of the tail', () => {
    const lines = [net(0), err(1), net(2), net(3), net(4), net(5)]
    expect(rotatedLines(lines, 2)).toEqual([err(1), net(4), net(5)])
  })

  it('caps how many old errors ride along, keeping the newest', () => {
    const lines = [err(0), err(1), err(2), net(3), net(4)]
    expect(rotatedLines(lines, 2, 2)).toEqual([err(1), err(2), net(3), net(4)])
  })

  it('leaves a short log alone, and a net line that only mentions an error is not one', () => {
    const quoting = JSON.stringify({ ts: 1, cat: 'net', resBody: '{"cat":"error"}' })
    expect(rotatedLines([net(0), err(1)], 5)).toEqual([net(0), err(1)])
    expect(rotatedLines([quoting, net(2), net(3)], 2)).toEqual([net(2), net(3)])
  })
})

describe('DebugLog', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'debug-log-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a crash survives an hour of traffic and is found by category', () => {
    const log = new DebugLog(join(dir, 'debug.log'))
    log.append(JSON.parse(err(1)))
    for (let batch = 0; batch < 130; batch++) {
      log.appendBatch(Array.from({ length: 100 }, (_, i) => JSON.parse(net(batch * 100 + i + 2))))
    }
    const onDisk = readFileSync(join(dir, 'debug.log'), 'utf8').split('\n').filter(Boolean)
    expect(onDisk.length).toBeLessThan(5200)
    expect(onDisk[0]).toBe(err(1))
    expect(log.readTail(50).some((l) => l.includes('"cat":"error"'))).toBe(false)
    expect(log.readTail(50, 'error')).toEqual([err(1)])
  })
})
