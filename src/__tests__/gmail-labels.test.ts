import { describe, it, expect } from 'vitest'
import { isUserLabel, unknownUserLabels, userLabelNames } from '@/gmail/labels'

// The live defect (^zany-fox): the stored map held 9 old labels and named
// none of the 7 Yousef files with, so every Mail row rendered a raw id.
const STALE_MAP = { Label_1: 'Clan', Label_27: 'Mailspring' }
const FRESH_MAP = { ...STALE_MAP, Label_32: 'Astera/Platform', Label_36: 'Noise', Label_38: 'Action' }
const THREAD_IDS = ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'Label_38', 'Label_32']

describe('isUserLabel', () => {
  it('only Label_* ids are the user\'s — system ids are the pane itself', () => {
    expect(['INBOX', 'UNREAD', 'SENT', 'IMPORTANT', 'CATEGORY_UPDATES', 'DRAFT'].some(isUserLabel)).toBe(false)
    expect(isUserLabel('Label_38')).toBe(true)
    expect(isUserLabel('Label_6606885050107994301')).toBe(true)
  })
})

describe('userLabelNames', () => {
  it('names the user labels and keeps Gmail\'s order', () => {
    expect(userLabelNames(THREAD_IDS, FRESH_MAP)).toEqual(['Action', 'Astera/Platform'])
  })

  it('drops ids the map cannot name instead of rendering them raw', () => {
    expect(userLabelNames(THREAD_IDS, STALE_MAP)).toEqual([])
    expect(userLabelNames(THREAD_IDS, undefined)).toEqual([])
    expect(userLabelNames(undefined, FRESH_MAP)).toEqual([])
  })

  it('de-duplicates: a thread\'s ids are the union over its messages', () => {
    expect(userLabelNames(['Label_38', 'Label_38'], FRESH_MAP)).toEqual(['Action'])
  })
})

describe('unknownUserLabels', () => {
  it('reports exactly the user ids the map is missing — the self-heal trigger', () => {
    expect(unknownUserLabels(THREAD_IDS, STALE_MAP)).toEqual(['Label_38', 'Label_32'])
    expect(unknownUserLabels(THREAD_IDS, FRESH_MAP)).toEqual([])
  })

  it('never asks for a refetch over a system id', () => {
    expect(unknownUserLabels(['INBOX', 'UNREAD', 'CATEGORY_SOCIAL'], {})).toEqual([])
  })

  it('no map at all means every user label is unknown', () => {
    expect(unknownUserLabels(['Label_1'], undefined)).toEqual(['Label_1'])
  })
})
