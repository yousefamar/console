// forge instance lifecycle.
//
// Cost control is not optional here: left running, the box is ~$680/month
// instead of ~$170 (m7i.4xlarge, 16 vCPU / 64 GiB, eu-west-2, $0.9324/hr
// on-demand — resized up from m7i-flex.2xlarge on 8 Oct 2026 so forks stop
// queueing behind each other). The hub starts it on the first remote dispatch
// and stops it once no remote session has needed it for a while. A STOPPED
// instance bills only its EBS.
//
// We shell out to the `aws` CLI rather than take an SDK dependency: the server
// has no AWS client today and adding one from a worktree is its own problem
// (node_modules is not shared between worktrees).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { ForgeConfig } from './config.js'
import { forgeExec, ensureMaster, closeMaster } from './ssh.js'

const execFileP = promisify(execFile)

export type InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated' | 'unknown'

function awsEnv(cfg: ForgeConfig): NodeJS.ProcessEnv {
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: merged.join(':'), AWS_REGION: cfg.region, AWS_DEFAULT_REGION: cfg.region }
  if (cfg.accessKeyId && cfg.secretAccessKey) {
    env.AWS_ACCESS_KEY_ID = cfg.accessKeyId
    env.AWS_SECRET_ACCESS_KEY = cfg.secretAccessKey
    // The scoped hub key is self-contained — an ambient profile would shadow it
    // with admin credentials, which is exactly what we split apart.
    delete env.AWS_PROFILE
  }
  return env
}

async function aws(cfg: ForgeConfig, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('aws', args, { env: awsEnv(cfg), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' }
  }
}

export async function instanceState(cfg: ForgeConfig): Promise<InstanceState> {
  const r = await aws(cfg, ['ec2', 'describe-instances', '--instance-ids', cfg.instanceId,
    '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text'])
  if (!r.ok) return 'unknown'
  const s = r.stdout.trim()
  const known: string[] = ['pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated']
  return known.includes(s) ? (s as InstanceState) : 'unknown'
}

/** Whether the box's SSM agent has checked in — `Online`, or `none` when SSM
 *  holds no record of it at all.
 *
 *  Worth asking about separately, because "running but not registered" is a BOX
 *  fault that looks exactly like a card fault from the board: the transport is
 *  SSH-over-SSM, so an unregistered instance refuses ssh with a bare
 *  "Connection closed by UNKNOWN port 65535" and every prepare times out. It
 *  happened for 20 minutes on 8 Oct 2026 after the first boot following the
 *  m7i.4xlarge resize, and recovered on the next start. Naming it in the
 *  failure reason is the difference between re-firing the card and debugging
 *  the wrong thing. */
export async function ssmPingStatus(cfg: ForgeConfig): Promise<string> {
  const r = await aws(cfg, ['ssm', 'describe-instance-information',
    '--filters', `Key=InstanceIds,Values=${cfg.instanceId}`,
    '--query', 'InstanceInformationList[0].PingStatus', '--output', 'text'], 30_000)
  if (!r.ok) return 'unknown'
  const s = r.stdout.trim()
  return s && s !== 'None' ? s : 'none'
}

export async function startInstance(cfg: ForgeConfig): Promise<boolean> {
  const r = await aws(cfg, ['ec2', 'start-instances', '--instance-ids', cfg.instanceId], 120_000)
  return r.ok
}

export async function stopInstance(cfg: ForgeConfig): Promise<boolean> {
  const r = await aws(cfg, ['ec2', 'stop-instances', '--instance-ids', cfg.instanceId], 120_000)
  return r.ok
}

/** Bring forge to a state where `ssh forge true` answers and the master
 *  connection (with its reverse forwards) is up.
 *
 *  Returns false rather than throwing: every caller's fallback is "run this
 *  fork locally", so an asleep or broken box degrades instead of failing. */
export async function ensureForgeReady(cfg: ForgeConfig, log: (m: string) => void = () => {}, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
  let state = await instanceState(cfg)
  if (state === 'terminated' || state === 'shutting-down') {
    log(`[forge] instance ${cfg.instanceId} is ${state} — re-provision with scripts/forge/provision.sh`)
    return false
  }
  if (state === 'stopped') {
    log(`[forge] starting ${cfg.instanceId}`)
    if (!(await startInstance(cfg))) {
      log('[forge] start-instances failed')
      return false
    }
  }
  while (Date.now() < deadline) {
    state = await instanceState(cfg)
    if (state === 'running') break
    await new Promise((r) => setTimeout(r, 5_000))
  }
  if (state !== 'running') {
    log(`[forge] instance did not reach running (last state ${state})`)
    return false
  }
  // Running is not the same as sshable: sshd and the SSM agent come up later.
  while (Date.now() < deadline) {
    if (await ensureMaster(cfg, log)) {
      const probe = await forgeExec(cfg, 'true', { timeoutMs: 20_000 })
      if (probe.code === 0) return true
    }
    await new Promise((r) => setTimeout(r, 5_000))
  }
  log('[forge] never became reachable before the deadline')
  return false
}

/** Stop the box when nothing needs it. `liveRemoteSessions` is counted by the
 *  caller (the hub knows its own sessions); we never guess from the box. */
export async function stopIfIdle(cfg: ForgeConfig, liveRemoteSessions: number, lastUseAt: number, log: (m: string) => void = () => {}): Promise<boolean> {
  if (liveRemoteSessions > 0) return false
  const idleMs = cfg.idleStopMinutes * 60_000
  if (Date.now() - lastUseAt < idleMs) return false
  const state = await instanceState(cfg)
  if (state !== 'running') return false
  log(`[forge] idle for ${cfg.idleStopMinutes}m with no remote sessions — stopping ${cfg.instanceId}`)
  await closeMaster(cfg)
  return stopInstance(cfg)
}
