// ============================================================================
// Hub-side Matrix crypto (M1). OlmMachine wrapper for Node.
//
// Persistence: OlmMachine wants IndexedDB. Node doesn't have one, so we
// shim via `fake-indexeddb/auto` (memory-only) and periodically dump the
// in-memory DB to a JSON snapshot on disk. On restart we restore the
// snapshot back into fake-indexeddb *before* initializing OlmMachine, so
// the machine finds its store already populated.
//
// This pattern was verified in the /tmp/matrix-spike proof-of-concept
// (identity keys round-trip across process restarts).
//
// Scope extended for M1-verify SEND:
//   - processOutgoingRequests / executeRequest — drain KeysUpload/Query/Claim/
//     ToDevice/SignatureUpload/KeysBackup to the homeserver
//   - shareRoomKeys / encryptRoomEventForSend — pre-send path
//   - processSyncCrypto — used by M2 hub sync loop (added now, exercised later)
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Lazy-loaded so the hub doesn't pay the WASM cost unless actually used.
type OlmModule = typeof import('@matrix-org/matrix-sdk-crypto-wasm')
type OlmMachineInstance = InstanceType<OlmModule['OlmMachine']>

const SHIM_INSTALLED = Symbol.for('console.fake-indexeddb-installed')

async function ensureIdbShim(): Promise<void> {
  const g = globalThis as any
  if (g[SHIM_INSTALLED]) return
  // @ts-expect-error — fake-indexeddb's "/auto" export subpath has no types under NodeNext resolution
  await import('fake-indexeddb/auto')
  g[SHIM_INSTALLED] = true
}

interface SnapshotIndex {
  name: string
  keyPath: string | string[]
  unique: boolean
  multiEntry: boolean
}

interface SnapshotStore {
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: SnapshotIndex[]
  entries: Array<[IDBValidKey | null, unknown]>
}

type SnapshotFile = Record<string, {
  version: number
  stores: Record<string, SnapshotStore>
}>

export class HubMatrixCrypto {
  private mod: OlmModule | null = null
  private machine: OlmMachineInstance | null = null
  private initialized = false
  private snapshotTimer: ReturnType<typeof setInterval> | null = null
  private dumpInflight = false

  constructor(
    private readonly snapshotFile: string,
    private readonly log: (msg: string) => void,
  ) {}

  isReady(): boolean {
    return this.initialized && this.machine !== null
  }

  async init(userId: string, deviceId: string): Promise<void> {
    if (this.initialized) return
    await ensureIdbShim()

    // Restore snapshot into fake-indexeddb BEFORE OlmMachine.initialize
    // so the machine finds its existing store populated.
    if (existsSync(this.snapshotFile)) {
      try {
        await this.restoreSnapshot()
        this.log('[hub-crypto] restored crypto snapshot')
      } catch (e) {
        this.log(`[hub-crypto] snapshot restore failed: ${e} — continuing with empty store`)
      }
    }

    this.mod = await import('@matrix-org/matrix-sdk-crypto-wasm')
    await this.mod.initAsync()

    this.machine = await this.mod.OlmMachine.initialize(
      new this.mod.UserId(userId),
      new this.mod.DeviceId(deviceId),
      'hub-matrix-crypto',
    )
    this.initialized = true
    this.log(`[hub-crypto] initialized as ${userId} / ${deviceId}`)

    // Dump once after init so a fresh install writes the snapshot, then every 60s.
    await this.dumpSnapshot().catch((e) => this.log(`[hub-crypto] initial dump failed: ${e}`))
    this.snapshotTimer = setInterval(() => {
      this.dumpSnapshot().catch((e) => this.log(`[hub-crypto] periodic dump failed: ${e}`))
    }, 60_000)
  }

  async stop(): Promise<void> {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
    await this.dumpSnapshot().catch(() => {})
  }

  identity(): { userId: string; deviceId: string; ed25519: string; curve25519: string } | null {
    if (!this.machine) return null
    const k = this.machine.identityKeys
    return {
      userId: this.machine.userId.toString(),
      deviceId: this.machine.deviceId.toString(),
      ed25519: k.ed25519.toBase64(),
      curve25519: k.curve25519.toBase64(),
    }
  }

  /**
   * Import room keys from the M0 safety-net blob (JSON array as produced by
   * browser OlmMachine.exportRoomKeys). Returns total/imported counts.
   */
  async importRoomKeys(keysJson: string, passphrase?: string): Promise<{ imported: number; total: number }> {
    if (!this.machine) throw new Error('crypto not initialized')
    void passphrase // reserved; M0 blob is unencrypted, but API ready for encrypted blobs
    let imported = 0
    let total = 0
    // importExportedRoomKeys accepts a progress callback (imported, total)
    const progress = await (this.machine as any).importExportedRoomKeys(
      keysJson,
      (done: bigint | number, all: bigint | number) => {
        imported = Number(done)
        total = Number(all)
      },
    ) as { imported_count?: number; total_count?: number } | undefined
    if (progress) {
      imported = progress.imported_count ?? imported
      total = progress.total_count ?? total
    }
    await this.dumpSnapshot()
    this.log(`[hub-crypto] imported ${imported}/${total} room keys`)
    return { imported, total }
  }

  /** Decrypt a single room event (m.room.encrypted → plaintext). */
  async decryptRoomEvent(event: unknown, roomId: string): Promise<{ type: string; content: Record<string, unknown> } | null> {
    if (!this.machine || !this.mod) return null
    try {
      const settings = new this.mod.DecryptionSettings(this.mod.TrustRequirement.Untrusted)
      const decrypted = await this.machine.decryptRoomEvent(
        JSON.stringify(event),
        new this.mod.RoomId(roomId),
        settings,
      )
      const parsed = JSON.parse(decrypted.event) as { type?: string; content?: Record<string, unknown> }
      return { type: parsed.type ?? 'm.room.message', content: parsed.content ?? {} }
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Send path — ported from src/matrix/crypto.ts (browser).
  // Network I/O uses credentials passed in (homeserver+token) so this class
  // stays agnostic of the auth store.
  // -------------------------------------------------------------------------

  /**
   * Drain pending OlmMachine outgoing requests to the homeserver:
   * KeysUpload, KeysQuery, KeysClaim, ToDevice, SignatureUpload, KeysBackup.
   * Loops up to N passes since KeysQuery responses spawn KeysClaim requests etc.
   */
  async processOutgoingRequests(homeserver: string, token: string): Promise<void> {
    if (!this.machine || !this.mod) return
    for (let pass = 0; pass < 10; pass++) {
      const requests = await this.machine.outgoingRequests()
      if (requests.length === 0) break
      for (const req of requests) {
        try {
          await this.executeRequest(req, homeserver, token)
        } catch (err) {
          // Bridge devices can reject key claims etc. — log but don't abort.
          this.log(`[hub-crypto] executeRequest ${String((req as any).type)} failed: ${(err as Error).message}`)
        }
      }
    }
  }

  private async executeRequest(req: unknown, homeserver: string, token: string): Promise<void> {
    if (!this.machine || !this.mod) return
    const r = req as { id?: string; type: unknown; body: string; event_type?: string; txn_id?: string; version?: string }
    const RT = this.mod.RequestType

    let respBody: string
    switch (r.type) {
      case RT.KeysUpload:
        respBody = await httpPost(`${homeserver}/_matrix/client/v3/keys/upload`, r.body, token)
        break
      case RT.KeysQuery:
        respBody = await httpPost(`${homeserver}/_matrix/client/v3/keys/query`, r.body, token)
        break
      case RT.KeysClaim:
        respBody = await httpPost(`${homeserver}/_matrix/client/v3/keys/claim`, r.body, token)
        break
      case RT.ToDevice: {
        const url = `${homeserver}/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.event_type!)}/${encodeURIComponent(r.txn_id!)}`
        respBody = await httpPut(url, r.body, token)
        break
      }
      case RT.SignatureUpload:
        respBody = await httpPost(`${homeserver}/_matrix/client/v3/keys/signatures/upload`, r.body, token)
        break
      case RT.KeysBackup: {
        const url = `${homeserver}/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(r.version!)}`
        respBody = await httpPut(url, r.body, token)
        break
      }
      case RT.RoomMessage:
        // Not an outgoing crypto request — ignored here.
        return
      default:
        this.log(`[hub-crypto] unknown outgoing request type: ${String(r.type)}`)
        return
    }
    if (r.id) {
      await this.machine.markRequestAsSent(r.id, r.type as any, respBody)
    }
  }

  /**
   * Share a Megolm session with the given users in `roomId`. Mirrors the
   * browser implementation closely (track users → drain → claim OTKs →
   * shareRoomKey → drain). Bridge-device errors are swallowed.
   */
  async shareRoomKeys(
    roomId: string,
    memberUserIds: string[],
    homeserver: string,
    token: string,
  ): Promise<void> {
    if (!this.machine || !this.mod) return
    const UserIdCtor = this.mod.UserId
    const RoomIdCtor = this.mod.RoomId

    // 1. Track the users
    await this.machine.updateTrackedUsers(memberUserIds.map((id) => new UserIdCtor(id)))

    // 2. Drain (fetches device keys)
    await this.processOutgoingRequests(homeserver, token)

    // 3. Claim OTKs for missing Olm sessions (best-effort)
    let claimFailed = false
    try {
      const claimReq = await this.machine.getMissingSessions(
        memberUserIds.map((id) => new UserIdCtor(id)),
      )
      if (claimReq) {
        const resp = await httpPost(`${homeserver}/_matrix/client/v3/keys/claim`, claimReq.body, token)
        await this.machine.markRequestAsSent(claimReq.id, claimReq.type, resp)
      }
    } catch (err) {
      this.log(`[hub-crypto] claim OTKs failed: ${(err as Error).message}`)
      claimFailed = true
    }

    // 4. Drain again
    await this.processOutgoingRequests(homeserver, token)

    if (claimFailed) return

    // 5. Share the Megolm session
    const settings = new this.mod.EncryptionSettings()
    const requests = await this.machine.shareRoomKey(
      new RoomIdCtor(roomId),
      memberUserIds.map((id) => new UserIdCtor(id)),
      settings,
    )
    for (const req of requests) {
      try {
        const r = req as { id?: string; type: unknown; body: string; event_type: string; txn_id: string }
        const url = `${homeserver}/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`
        const resp = await httpPut(url, r.body, token)
        if (r.id) await this.machine.markRequestAsSent(r.id, r.type as any, resp)
      } catch (err) {
        this.log(`[hub-crypto] shareRoomKey to-device failed: ${(err as Error).message}`)
      }
    }

    // 6. Final drain
    await this.processOutgoingRequests(homeserver, token)
  }

  /**
   * Encrypt a room event for sending. Returns the parsed content object
   * (matches the browser helper's return shape when JSON-parsed).
   */
  async encryptRoomEventForSend(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!this.machine || !this.mod) return null
    try {
      const encrypted = await this.machine.encryptRoomEvent(
        new this.mod.RoomId(roomId),
        eventType,
        JSON.stringify(content),
      )
      return JSON.parse(encrypted) as Record<string, unknown>
    } catch (err) {
      this.log(`[hub-crypto] encryptRoomEvent failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Feed a /sync response's crypto-relevant fields into the OlmMachine.
   * Required for the M2 hub sync loop. Safe to call during M1 too.
   */
  async processSyncCrypto(
    response: {
      to_device?: { events?: unknown[] }
      device_lists?: { changed?: string[]; left?: string[] }
      device_one_time_keys_count?: Record<string, number>
      device_unused_fallback_key_types?: string[]
    },
    homeserver: string,
    token: string,
  ): Promise<void> {
    if (!this.machine || !this.mod) return

    const toDeviceEvents = JSON.stringify(response.to_device?.events ?? [])
    const changed = (response.device_lists?.changed ?? []).map((u) => new this.mod!.UserId(u))
    const left = (response.device_lists?.left ?? []).map((u) => new this.mod!.UserId(u))
    const deviceLists = new this.mod.DeviceLists(changed, left)

    const otkCounts = new Map<string, number>()
    if (response.device_one_time_keys_count) {
      for (const [algo, count] of Object.entries(response.device_one_time_keys_count)) {
        otkCounts.set(algo, count)
      }
    }
    const unusedFallback = response.device_unused_fallback_key_types
      ? new Set(response.device_unused_fallback_key_types)
      : undefined

    const settings = new this.mod.DecryptionSettings(this.mod.TrustRequirement.Untrusted)
    await this.machine.receiveSyncChanges(
      toDeviceEvents,
      deviceLists,
      otkCounts,
      unusedFallback,
      settings,
    )
    await this.processOutgoingRequests(homeserver, token)
  }

  // -------------------------------------------------------------------------
  // fake-indexeddb snapshot round-trip
  // Pattern verified in /tmp/matrix-spike/spike.mjs (identity keys round-trip).
  // -------------------------------------------------------------------------

  private async dumpSnapshot(): Promise<void> {
    if (this.dumpInflight) return
    this.dumpInflight = true
    try {
      const idb = (globalThis as any).indexedDB as IDBFactory
      const dbs = await idb.databases()
      const out: SnapshotFile = {}
      for (const info of dbs) {
        if (!info.name) continue
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = idb.open(info.name!, info.version)
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        const stores: Record<string, SnapshotStore> = {}
        const storeNames = Array.from(db.objectStoreNames)
        for (const storeName of storeNames) {
          const tx = db.transaction(storeName, 'readonly')
          const st = tx.objectStore(storeName)
          const indexes: SnapshotIndex[] = []
          for (const idxName of Array.from(st.indexNames)) {
            const idx = st.index(idxName)
            indexes.push({
              name: idx.name,
              keyPath: idx.keyPath as string | string[],
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            })
          }
          const keys = await new Promise<IDBValidKey[]>((res) => {
            const r = st.getAllKeys()
            r.onsuccess = () => res(r.result as IDBValidKey[])
          })
          const vals = await new Promise<unknown[]>((res) => {
            const r = st.getAll()
            r.onsuccess = () => res(r.result as unknown[])
          })
          // With a keyPath, the key is derived from the value — don't store it.
          const hasKeyPath = st.keyPath !== null
          stores[storeName] = {
            keyPath: st.keyPath as string | string[] | null,
            autoIncrement: st.autoIncrement,
            indexes,
            entries: keys.map((k, i) => [hasKeyPath ? null : k, vals[i]]),
          }
        }
        out[info.name] = { version: info.version ?? 1, stores }
        db.close()
      }
      mkdirSync(dirname(this.snapshotFile), { recursive: true })
      writeFileSync(this.snapshotFile, JSON.stringify(out, (_k, v) => {
        if (v instanceof Uint8Array) return { __u8: Array.from(v) }
        if (v && typeof v === 'object' && (v as any).type === 'Buffer' && Array.isArray((v as any).data)) {
          return { __u8: (v as any).data }
        }
        return v
      }))
    } finally {
      this.dumpInflight = false
    }
  }

  private async restoreSnapshot(): Promise<void> {
    const raw = readFileSync(this.snapshotFile, 'utf8')
    const parsed = JSON.parse(raw, (_k, v) => {
      if (v && typeof v === 'object' && Array.isArray((v as any).__u8)) return new Uint8Array((v as any).__u8)
      return v
    }) as SnapshotFile | Record<string, { version: number; stores: Record<string, any> }>
    const idb = (globalThis as any).indexedDB as IDBFactory
    for (const [dbName, { version, stores }] of Object.entries(parsed)) {
      await new Promise<void>((res, rej) => {
        const r = idb.open(dbName, version)
        r.onupgradeneeded = () => {
          const db = r.result
          for (const [storeName, meta] of Object.entries(stores)) {
            if (db.objectStoreNames.contains(storeName)) continue
            // Back-compat: legacy snapshots stored `stores[name] = Array<[key,val]>`.
            if (Array.isArray(meta)) {
              db.createObjectStore(storeName)
              continue
            }
            const m = meta as SnapshotStore
            const opts: IDBObjectStoreParameters = {}
            if (m.keyPath !== null) opts.keyPath = m.keyPath
            if (m.autoIncrement) opts.autoIncrement = true
            const st = db.createObjectStore(storeName, opts)
            for (const idx of m.indexes ?? []) {
              st.createIndex(idx.name, idx.keyPath, {
                unique: idx.unique,
                multiEntry: idx.multiEntry,
              })
            }
          }
        }
        r.onsuccess = () => {
          const db = r.result
          const toWrite = Object.keys(stores).filter((n) => db.objectStoreNames.contains(n))
          if (toWrite.length === 0) { db.close(); res(); return }
          const tx = db.transaction(toWrite, 'readwrite')
          for (const storeName of toWrite) {
            const st = tx.objectStore(storeName)
            const meta = stores[storeName]!
            // Legacy shape: Array<[key,val]>
            if (Array.isArray(meta)) {
              for (const [key, val] of meta as Array<[IDBValidKey, unknown]>) {
                st.put(val, key)
              }
              continue
            }
            const m = meta as SnapshotStore
            for (const [key, val] of m.entries) {
              if (key === null || key === undefined) st.put(val)
              else st.put(val, key)
            }
          }
          tx.oncomplete = () => { db.close(); res() }
          tx.onerror = () => { db.close(); rej(tx.error) }
        }
        r.onerror = () => rej(r.error)
      })
    }
  }
}

// -------------------------------------------------------------------------
// Low-level HTTP helpers — bypass MatrixClient so OlmMachine can drive
// raw request bodies (already-serialized JSON strings).
// -------------------------------------------------------------------------

async function httpPost(url: string, body: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Matrix POST ${res.status}: ${text}`)
  return text
}

async function httpPut(url: string, body: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Matrix PUT ${res.status}: ${text}`)
  return text
}
