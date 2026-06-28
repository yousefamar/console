// Glasses HUD + notification configuration — persisted hub-side.
//
// Lives hub-side (not localStorage) because both consumers run on the hub:
//   - the notification forwarder (`notify-forward.ts`) fires even when Console
//     is backgrounded, so the enable/channel toggles must be readable without
//     a browser open;
//   - the HUD controller (`hud.ts`) renders on head-tilt independent of the SPA.
//
// Atomic tmp+rename write, mirroring `model-config.ts`.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type GlassesChannel = 'mail' | 'chat' | 'calendar' | 'agent' | 'money' | 'generic'

export const GLASSES_CHANNELS: GlassesChannel[] = ['mail', 'chat', 'calendar', 'agent', 'money', 'generic']

export interface GlassesConfigState {
  /** Master switch for forwarding hub push notifications to the lenses. */
  notifyEnabled: boolean
  /** Per-source opt-out. A channel absent from the map defaults to enabled. */
  channels: Record<GlassesChannel, boolean>
  /** Show the idle HUD on head-up tilt. */
  hudEnabled: boolean
  /** Head-up pitch threshold (degrees) pushed to the glasses on connect. */
  headUpAngleDeg: number
}

function defaults(): GlassesConfigState {
  return {
    notifyEnabled: true,
    channels: { mail: true, chat: true, calendar: true, agent: true, money: true, generic: true },
    hudEnabled: true,
    headUpAngleDeg: 30,
  }
}

export class GlassesConfig {
  private state: GlassesConfigState

  constructor(private readonly file: string) {
    this.state = this.load()
  }

  private load(): GlassesConfigState {
    const d = defaults()
    if (!existsSync(this.file)) return d
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GlassesConfigState>
      return {
        notifyEnabled: raw.notifyEnabled ?? d.notifyEnabled,
        channels: { ...d.channels, ...(raw.channels ?? {}) },
        hudEnabled: raw.hudEnabled ?? d.hudEnabled,
        headUpAngleDeg: typeof raw.headUpAngleDeg === 'number' ? raw.headUpAngleDeg : d.headUpAngleDeg,
      }
    } catch {
      return d
    }
  }

  get(): GlassesConfigState {
    return { ...this.state, channels: { ...this.state.channels } }
  }

  /** True if a given push type should be forwarded to the glasses. */
  channelEnabled(type: GlassesChannel): boolean {
    return this.state.notifyEnabled && (this.state.channels[type] ?? true)
  }

  hudEnabled(): boolean {
    return this.state.hudEnabled
  }

  /** Shallow-merge a patch and persist. Returns the merged state. */
  merge(patch: Partial<GlassesConfigState>): GlassesConfigState {
    if (typeof patch.notifyEnabled === 'boolean') this.state.notifyEnabled = patch.notifyEnabled
    if (typeof patch.hudEnabled === 'boolean') this.state.hudEnabled = patch.hudEnabled
    if (typeof patch.headUpAngleDeg === 'number') {
      this.state.headUpAngleDeg = Math.max(0, Math.min(60, Math.round(patch.headUpAngleDeg)))
    }
    if (patch.channels) {
      for (const k of GLASSES_CHANNELS) {
        if (typeof patch.channels[k] === 'boolean') this.state.channels[k] = patch.channels[k]
      }
    }
    this.persist()
    return this.get()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.file)
    } catch {
      // best-effort
    }
  }
}
