import { describe, it, expect } from 'vitest'
import { shortCwd, isStrayCwd } from '@/utils/cwd'

describe('shortCwd', () => {
  it('collapses a Linux home prefix to ~', () => {
    expect(shortCwd('/home/amar/sync/brain/root/projects/demovid')).toBe('~/sync/brain/root/projects/demovid')
    expect(shortCwd('/home/amar')).toBe('~')
  })
  it('leaves non-home paths and look-alikes alone', () => {
    expect(shortCwd('/opt/hub')).toBe('/opt/hub')
    expect(shortCwd('/home/amarillo-x/y').startsWith('~/')).toBe(true) // any user is home
    expect(shortCwd('/homer/amar')).toBe('/homer/amar')
  })
})

describe('isStrayCwd', () => {
  const home = '/home/amar/sync/brain/root/projects/demovid'
  it('flags a session running outside its space home', () => {
    expect(isStrayCwd('/home/amar/proj/code/console/server', home)).toBe(true)
  })
  it('accepts the space home, trailing slash or not, and any subdir of it', () => {
    expect(isStrayCwd(home, home)).toBe(false)
    expect(isStrayCwd(`${home}/`, home)).toBe(false)
    expect(isStrayCwd(`${home}/workspace`, home)).toBe(false)
    expect(isStrayCwd(`${home}-other`, home)).toBe(true) // sibling dir sharing the prefix is NOT inside
  })
  it('never flags when either side is unknown', () => {
    expect(isStrayCwd(undefined, home)).toBe(false)
    expect(isStrayCwd(home, undefined)).toBe(false)
  })
})
