// Run a guard or `run` action: `bash -c <cmd>` with the batch JSON on stdin.
// Exit code is the protocol (guard: 0 = proceed); a timeout is an error, not
// a "no". Injectable so the engine is testable without spawning anything.

import { spawn } from 'node:child_process'

export interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  killed: boolean
}

export interface ShellOpts {
  cwd: string
  input: string
  env: Record<string, string>
  timeoutMs: number
  outputCap: number
}

export type ShellRunner = (cmd: string, opts: ShellOpts) => Promise<ShellResult>

export const runShell: ShellRunner = (cmd, opts) => new Promise((resolve) => {
  const child = spawn('bash', ['-c', cmd], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let killed = false
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, opts.timeoutMs)
  child.stdout.on('data', (c: Buffer) => { if (stdout.length < opts.outputCap * 4) stdout += c.toString('utf8') })
  child.stderr.on('data', (c: Buffer) => { if (stderr.length < opts.outputCap) stderr += c.toString('utf8') })
  child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, killed }) })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.slice(0, opts.outputCap), stderr: stderr.slice(0, opts.outputCap), killed }) })
  child.stdin.on('error', () => { /* the script may not read stdin */ })
  child.stdin.end(opts.input)
})
