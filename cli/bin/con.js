#!/usr/bin/env node
// Wrapper that uses tsx to run the TypeScript source directly
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = resolve(__dirname, '..', 'src', 'index.ts')
// The local tsx binary directly: `npx tsx` spends ~0.5 s (1 s+ under load)
// resolving what is already installed beside us, on every single `con` call.
const localTsx = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx')
const [cmd, args] = existsSync(localTsx) ? [localTsx, [entry]] : ['npx', ['tsx', entry]]

try {
  execFileSync(cmd, [...args, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  })
} catch (err) {
  process.exit(err.status || 1)
}
