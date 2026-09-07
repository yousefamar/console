import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The hub runs in London and several helpers format LOCAL dates/times
    // (ring log day headings, list stamps) — pin the zone or those assertions
    // depend on the runner's TZ.
    env: { TZ: 'Europe/London' },
  },
})
