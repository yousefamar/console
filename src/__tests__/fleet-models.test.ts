// The fleet picker is the only place Yousef can move the fleet onto a model, so
// it must offer at least everything the hub is willing to spawn. ^trim-duck was
// exactly this drifting: Bedrock served opus/sonnet 5.5 from 6 Oct 2026, the hub
// chain named opus-5, and the picker named opus-5 too — so there was no way to
// pick the newer model from either end.

import { describe, it, expect } from 'vitest'
import { BEDROCK_MODELS, FIRST_PARTY_MODELS } from '@/utils/fleet-models'
import { BEDROCK_CHAIN, FIRST_PARTY_CHAIN } from '../../server/src/model-chains'
import { modelLabel } from '@/utils/model-label'

describe('fleet picker model lists', () => {
  it('offers every model in the hub Bedrock chain', () => {
    for (const id of BEDROCK_CHAIN) {
      expect(BEDROCK_MODELS as readonly string[], id).toContain(id)
    }
  })

  it('offers every model in the hub first-party chain', () => {
    for (const id of FIRST_PARTY_CHAIN) {
      expect(FIRST_PARTY_MODELS as readonly string[], id).toContain(id)
    }
  })

  it('leads each list with that backend chain head, so the default is the newest', () => {
    expect(BEDROCK_MODELS[0]).toBe(BEDROCK_CHAIN[0])
    expect(FIRST_PARTY_MODELS[0]).toBe(FIRST_PARTY_CHAIN[0])
  })

  it('uses ids the label util can render — no raw id leaks into the menu', () => {
    for (const id of [...BEDROCK_MODELS, ...FIRST_PARTY_MODELS]) {
      expect(modelLabel(id), id).not.toBeNull()
    }
  })

  it('keeps each backend to its own id form (a cross-backend id 400s)', () => {
    for (const id of BEDROCK_MODELS) expect(id, id).toMatch(/^us\.anthropic\./)
    for (const id of FIRST_PARTY_MODELS) expect(id, id).toMatch(/^claude-/)
  })
})
