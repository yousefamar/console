#!/usr/bin/env node
// Wrapper that uses tsx to run the TypeScript source directly
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = resolve(__dirname, '..', 'src', 'index.ts')

try {
  execFileSync('npx', ['tsx', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  })
} catch (err) {
  process.exit(err.status || 1)
}
