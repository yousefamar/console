import { describe, it, expect } from 'vitest'
import { withPatchAmount } from '../utils/scenario-patch'

type Patch = { amountPence?: number; startDate?: string }

describe('withPatchAmount', () => {
  it('sets the amount in pence', () => {
    expect(withPatchAmount<Patch>({ startDate: '2027-01-01' }, '1250.5')).toEqual({ startDate: '2027-01-01', amountPence: 125050 })
  })

  it('a blank field leaves the amount unchanged instead of zeroing the stream', () => {
    const next = withPatchAmount<Patch>({ amountPence: 90000, startDate: '2027-01-01' }, '')
    expect(next).toEqual({ startDate: '2027-01-01' })
    expect('amountPence' in next).toBe(false)
  })

  it('half-typed input is not an amount yet', () => {
    expect('amountPence' in withPatchAmount({ amountPence: 100 }, '-')).toBe(false)
    expect('amountPence' in withPatchAmount({}, '   ')).toBe(false)
  })

  it('a typed zero is a real zero', () => {
    expect(withPatchAmount({}, '0')).toEqual({ amountPence: 0 })
  })

  it('does not mutate the patch it was given', () => {
    const patch = { amountPence: 500 }
    withPatchAmount(patch, '')
    expect(patch).toEqual({ amountPence: 500 })
  })
})
