import { describe, it, expect } from 'vitest'
import { editBody } from '../utils/edit-body'

describe('editBody', () => {
  it('sends an emptied field as null so the hub clears it', () => {
    const body = JSON.parse(editBody({ id: 'acc_1', name: 'Savings', notes: undefined, growthPctYoy: undefined }))
    expect(body).toEqual({ id: 'acc_1', name: 'Savings', notes: null, growthPctYoy: null })
  })

  it('leaves out what the caller left out', () => {
    const body = JSON.parse(editBody({ id: 'scn_1', name: 'Plan B' }))
    expect(Object.keys(body)).toEqual(['id', 'name'])
  })

  it('keeps falsy values that are real values', () => {
    const body = JSON.parse(editBody({ isExternal: false, growthPctYoy: 0, notes: '' }))
    expect(body).toEqual({ isExternal: false, growthPctYoy: 0, notes: '' })
  })

  it('does not reach into nested objects', () => {
    const body = JSON.parse(editBody({ match: { merchantContains: undefined, amountSign: 'out' } }))
    expect(body).toEqual({ match: { amountSign: 'out' } })
  })
})
