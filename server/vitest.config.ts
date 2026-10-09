import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest 4 stopped excluding `dist/` by default. `server/dist` is gitignored
    // build output nothing runs from (the hub is `tsx src/index.ts`), and it
    // held 47 compiled test files from a 30 Aug 2026 build: every suite run in
    // the main checkout collected them, tested six-week-old code, passed, and
    // inflated the count (168 files reported, 121 real). A worktree has no
    // dist, which is why the same suite looked smaller there.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // The hub runs in London and several helpers format LOCAL dates/times
    // (ring log day headings, list stamps) — pin the zone or those assertions
    // depend on the runner's TZ.
    env: { TZ: 'Europe/London' },
  },
})
