import { describe, it, expect } from 'vitest'
import { graftNewerKeys, type AuthConfig } from '../auth-store'

function base(): AuthConfig {
  return { google: { clientId: 'c', clientSecret: 's', accounts: [] } }
}

describe('graftNewerKeys', () => {
  it('rescues a top-level key present on disk but absent in memory', () => {
    const mem = base()
    const rescued = graftNewerKeys(mem, { ...base(), googleMaps: { apiKey: 'AIzaXXX' } })
    expect(mem.googleMaps).toEqual({ apiKey: 'AIzaXXX' })
    expect(rescued).toEqual(['googleMaps'])
  })

  it('does NOT resurrect a key we intentionally cleared (present-but-undefined)', () => {
    const mem: AuthConfig = { ...base(), googleMaps: undefined }
    const rescued = graftNewerKeys(mem, { ...base(), googleMaps: { apiKey: 'AIzaOLD' } })
    expect(mem.googleMaps).toBeUndefined()
    expect(rescued).toEqual([])
  })

  it('never overwrites a key we already hold with a value', () => {
    const mem: AuthConfig = { ...base(), serpApi: { apiKey: 'MINE' } }
    graftNewerKeys(mem, { ...base(), serpApi: { apiKey: 'THEIRS' } })
    expect(mem.serpApi).toEqual({ apiKey: 'MINE' })
  })

  it('merges google accounts by email without duplicating', () => {
    const mem: AuthConfig = {
      google: { clientId: 'c', clientSecret: 's', accounts: [{ email: 'a@x', refreshToken: 'r1', scopes: [] }] },
    }
    const disk: Partial<AuthConfig> = {
      google: {
        clientId: 'c',
        clientSecret: 's',
        accounts: [
          { email: 'a@x', refreshToken: 'STALE', scopes: [] },
          { email: 'b@x', refreshToken: 'r2', scopes: [] },
        ],
      },
    }
    const rescued = graftNewerKeys(mem, disk)
    expect(mem.google.accounts.map((a) => a.email)).toEqual(['a@x', 'b@x'])
    // existing account's token untouched (not clobbered by the stale disk copy)
    expect(mem.google.accounts.find((a) => a.email === 'a@x')?.refreshToken).toBe('r1')
    expect(rescued).toEqual(['google account b@x'])
  })

  it('rescues multiple keys at once', () => {
    const mem = base()
    const rescued = graftNewerKeys(mem, {
      ...base(),
      googleMaps: { apiKey: 'k' },
      serpApi: { apiKey: 'sk' },
    })
    expect(rescued.sort()).toEqual(['googleMaps', 'serpApi'])
  })

  it('no-op when disk carries nothing new', () => {
    const mem: AuthConfig = { ...base(), googleMaps: { apiKey: 'k' } }
    const rescued = graftNewerKeys(mem, { ...base(), googleMaps: { apiKey: 'k2' } })
    expect(rescued).toEqual([])
    expect(mem.googleMaps).toEqual({ apiKey: 'k' })
  })
})
