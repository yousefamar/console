import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'

// The CLI's scheme probe must not keep the CLI alive.
//
// 9 Oct 2026: `/health` carries the whole session list, the fleet reached 78
// sessions, and the body crossed the ~64 KiB the HTTP client buffers unread.
// The probe never read it, so its connection stayed open and every `con` call
// answered at once and then took 17-74 s to EXIT. Guards that shell out to
// `con` under a 60 s cap timed out for four hours, and each timeout was logged
// as "guard: no change".
//
// The claim is about a PROCESS ending, so the test runs one. And it has to be
// HTTPS: over plain HTTP the CLI uses Node's built-in fetch, which does not
// hold the process open; the hub is HTTPS, where the CLI brings its own
// connection agent (self-signed cert), and that one does.

const here = dirname(fileURLToPath(import.meta.url))
const cliDir = resolve(here, '..', '..', '..', 'cli')
const tsx = resolve(cliDir, 'node_modules', '.bin', 'tsx')

let server: Server
let base: string
let certDir: string

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'cli-probe-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' })
  // Sized like the real thing on the night: comfortably past 64 KiB, not vastly
  // so. (A 300 KB body did NOT reproduce it — the client then reads the stream
  // differently — so this size is part of the test, not a detail.)
  const body = JSON.stringify({ ok: true, sessions: Array.from({ length: 900 }, (_, i) => ({ id: `session_${i}`, lastTextSnippet: 'x'.repeat(60) })) })
  expect(body.length).toBeGreaterThan(80_000)
  expect(body.length).toBeLessThan(120_000)
  server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body) } else { res.writeHead(404); res.end() }
  })
  server.keepAliveTimeout = 65_000
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server?.closeAllConnections()
  server?.close()
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

/** Run a script file inside the CLI package, the way `con` itself is launched
 *  (tsx on a file), and time how long the process takes to end BY ITSELF — the
 *  script never calls process.exit. A file, not `tsx -e`: eval mode ends the
 *  process differently and hid the very thing under test. */
let scriptSeq = 0
function runToNaturalExit(source: string, giveUpMs: number): Promise<{ exitedAfterMs: number | null; out: string }> {
  const file = join(cliDir, `.probe-exit-test-${process.pid}-${++scriptSeq}.mts`)
  writeFileSync(file, source)
  return new Promise((done) => {
    const t0 = Date.now()
    const child = spawn(tsx, [file], { cwd: cliDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const finish = (exitedAfterMs: number | null) => { rmSync(file, { force: true }); done({ exitedAfterMs, out }) }
    const giveUp = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, giveUpMs)
    child.on('exit', () => { clearTimeout(giveUp); finish(Date.now() - t0) })
  })
}

describe('the CLI scheme probe', () => {
  it('lets the process end as soon as the command is done', async () => {
    const r = await runToNaturalExit(`
      import { probeHub } from './src/client.ts'
      console.log('probe:', await probeHub(${JSON.stringify(base)}))
    `, 15_000)
    expect(r.out).toContain('probe: true')
    expect(r.exitedAfterMs).not.toBeNull()
    expect(r.exitedAfterMs!).toBeLessThan(8_000)
  }, 25_000)

  it('control: the same request with its body left unread holds the process open', async () => {
    // Without this the test above could pass for a reason that has nothing to
    // do with the fix (a smaller body, a client that buffers more). The
    // response is kept referenced so the outcome does not depend on when the
    // garbage collector gets to it — in the CLI that is what made the delay
    // vary between 17 and 74 seconds.
    const r = await runToNaturalExit(`
      import { Agent } from 'undici'
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
      globalThis.held = await fetch(${JSON.stringify(`${base}/health`)}, { dispatcher })
      console.log('status:', globalThis.held.status)
    `, 6_000)
    expect(r.out).toContain('status: 200')
    expect(r.exitedAfterMs).toBeNull()
  }, 15_000)

  it('answers false, quickly, when nothing is listening', async () => {
    const r = await runToNaturalExit(`
      import { probeHub } from './src/client.ts'
      const t0 = Date.now()
      console.log('dead port:', await probeHub('https://127.0.0.1:9'), Date.now() - t0 < 1400 ? 'under the timeout' : 'TOO LONG')
    `, 15_000)
    expect(r.out).toContain('dead port: false under the timeout')
    expect(r.exitedAfterMs!).toBeLessThan(8_000)
  }, 25_000)
})
