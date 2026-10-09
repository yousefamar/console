// ============================================================================
// Claude CLI Session Manager
//
// Spawns `claude` as a child process with --output-format stream-json and
// --input-format stream-json. Reads NDJSON from stdout line-by-line, writes
// NDJSON to stdin. Translates between the Claude CLI protocol and the hub's
// internal event emitter interface.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type {
  ClaudeStdoutMessage,
  ClaudeRateLimitInfo,
  ClaudeStdinMessage,
  ClaudeStdinContentBlock,
  ClaudeContentBlock,
  HubMessage,
  LoggableHubMessage,
  TokenUsage,
  SessionInfo,
  AttentionState,
} from './protocol.js'
import { parseModelString, cwdToProjectDir } from './utils.js'
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getLastReadIndex, isReadPinned, setLastReadIndex } from './read-state.js'
import { getChildCountSync } from './process-tree.js'
import { gitStatusSync } from './git-status.js'
import { forgeConfig, remoteCommandArgv, forgeSshEnv, noteForgeUse, syncTranscript } from './forge/index.js'
import { HUB_PID_ENV } from './agents/process-reaper.js'
import { isAuthFailure } from './agents/auth-failure.js'
import { mentionsAmar, extractAttentionSnippet } from './attention.js'
import { parseHandoff } from './handoff.js'
import { looksLikeModelError } from './model-config.js'
import { taggedModelId } from './bedrock-profiles.js'
import { remoteBedrockEnv, forgeSpawnPlan, forgeMaxLoginDir } from './forge/agent-env.js'
import { activeLoginDir, activeLoginName, canonicalDir } from './max-logins.js'
import { detectActiveBackend } from './auth-backend.js'
import { isTransientApiError, isUpstreamOutageError, isUsageLimitError, usageLimitTypeOf, upstreamOutages, RESUME_BACKOFF_MS, MAX_AUTO_RESUMES_PER_HOUR } from './transient-errors.js'
import { readTodos, watchTodos, todosUpdatedAt, isStaleTodoList, type TodoItem } from './agents/todo-store.js'
import { resolveCacheTtl, cacheTtlHooks, type CacheTtl, type CacheTtlReason } from './agents/cache-ttl.js'
import { resolveEffort, effortHooks, type Effort, type EffortReason, type SpawnKind } from './agents/effort.js'
import { resolveCompactWindow, compactWindowHooks, isThrashing, liftCompactWindow, THRASH_WINDOW_MS } from './agents/compact-window.js'

let sessionCounter = 0

// Ultimate fallback model when no resolver is wired (e.g. unit tests). In the
// running hub the model comes from ModelConfig via setAgentModelResolver — see
// model-config.ts. Kept currently-available so a bare Session() never spawns a
// dead model.
const DEFAULT_AGENT_MODEL = 'claude-opus-4-8'

// Injected at boot (index.ts) so the model is a runtime-configurable setting
// with a fallback chain rather than a hardcoded const. Honours the CLAUDE_MODEL
// env override internally (see ModelConfig.getModel).
let agentModelResolver: (() => string) | null = null
export function setAgentModelResolver(fn: () => string) { agentModelResolver = fn }
// Extra spawn env from the context proxy (agents/context-proxy.ts) for sessions
// opted in by name/id; null = bypass, the process talks to Bedrock directly.
let contextProxyEnv: ((name: string | undefined, hubId: string, spawnId: string) => Record<string, string> | null) | null = null
export function setContextProxyEnv(fn: typeof contextProxyEnv) { contextProxyEnv = fn }
function resolveAgentModel(): string {
  return agentModelResolver?.() ?? process.env.CLAUDE_MODEL?.trim() ?? DEFAULT_AGENT_MODEL
}

/** kill(): SIGTERM → SIGKILL if the subprocess is still alive after this. */
const KILL_ESCALATE_MS = 5_000
/** Agent processes (and every test run, build and dev server they spawn) run
 *  at this nice so the hub, the voice path (wa-voice + al-voice-pipeline at
 *  nice 0) and Yousef's desktop win under contention — on 30 Sept 2026 two
 *  calls were unusable at load 16 from forks' test runs. Only matters when
 *  cores are contended; agents share equally among themselves as before.
 *  `CONSOLE_AGENT_NICE=0` disables. Raising nice needs no privilege; the
 *  `nice` binary execs claude in place, so the pid is the claude process. */
export function agentNice(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONSOLE_AGENT_NICE?.trim()
  if (raw === undefined || raw === '') return 10
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 19 ? n : 10
}
/** How many times a single session may auto-restart chasing a working model
 *  before giving up — guards against a restart loop if every model fails. */
const MAX_MODEL_RESTARTS = 6
const PRE_INIT_STDERR_LOG_CAP = 5
const FORGE_SSH_RETRY_MAX = 3
/** Delivered to a session whose in-flight turn was cut by a model/backend respawn. */
export const MODEL_RESTART_NUDGE = 'The hub switched model/backend mid-turn, which interrupted you. Continue from where you left off.'

export interface ImageAttachment {
  media_type: string
  data: string  // base64
}

export interface SessionOptions {
  prompt: string
  images?: ImageAttachment[]
  cwd?: string
  resume?: string
  /** If true, resume the session but don't send any initial prompt (used for auto-restore on hub restart) */
  silent?: boolean
  /** If true, fork the resumed session (new session ID, same conversation history) */
  fork?: boolean
  /** Fresh spawn with a HUB-minted claudeSessionId pinned via `--session-id`
   *  (no --resume): the id is known — and in the manifest — from birth, and
   *  the process argv names itself. Fresh-context ticket-forks use this. */
  pinSessionId?: boolean
  /** How a ticket-fork got its context — `fresh` (new session + digest) or
   *  `inherited` (`--fork-session` transcript copy). Persisted; feeds the
   *  fork-cost ledger that compares the two (^tall-colt). */
  forkContext?: 'fresh' | 'inherited'
  /** claudeSessionId of the session this was forked from — used to nest forks
   *  under their parent in the sidebar. Persisted across restarts. */
  parentClaudeSessionId?: string
  /** Display name for the session (persists across restarts) */
  name?: string
  /**
   * Verbatim text appended to Claude's system prompt at spawn time. Passed to
   * `claude --append-system-prompt`. Used to inject a persona (Al's AL.md +
   * mistakes.md + workflows summary) into a fresh long-lived session.
   * Ignored on `resume` — Claude's CLI uses the prompt from the original spawn.
   */
  systemPrompt?: string
  /** Apply `systemPrompt` even though this spawn is a --resume (charter
   *  reload: new prompt, full history). See the spawn-args comment. */
  reapplyPromptOnResume?: boolean
  /** Restore the `@amar` attention flag on hub-restart resume (from manifest). */
  needsAttention?: AttentionState | null
  /** Stable slug for board `@key` addressing + CONSOLE_AGENT_KEY env (actor
   *  attribution). Pure identifier — no file behind it. Persisted in the manifest. */
  agentKey?: string
  /** Vault project slug this session is bound to (Spaces agent panel, board
   *  default-owner resolution). Persisted in the manifest. */
  project?: string
  /** PARA area tags this session is bound to. Persisted in the manifest. */
  areas?: string[]
  /** Absolute message-log high-water at the last manifest save. Restored into
   *  `logOffset` on a hub-restart resume so `messageLogLength` reports the true
   *  total (the in-memory log starts empty) — otherwise the unread marker
   *  (`messageLogLength > lastReadIndex`) collapses to false for every session
   *  on restart. Persisted in the manifest. */
  restoreMessageLogLength?: number
  /** Restore the session directly into hibernation: NO subprocess is spawned
   *  until the first message arrives (sendMessage wakes it with --resume).
   *  Used by the hub-restart restore loop for idle sessions so a restart
   *  doesn't thunder-herd 40+ claude spawns (~250MB RSS each). Requires
   *  `resume`; ignored for forks/fresh spawns. */
  hibernateOnStart?: boolean
  /** Per-session model pin. When set, THIS session spawns with (and stays on)
   *  this model instead of the hub-wide ModelConfig one, and fleet-wide model
   *  changes skip it. Persisted in the manifest. */
  modelOverride?: string
  /** Restore a prompt that was queued for turn-end but never flushed (hub
   *  restarted mid-turn). Persisted in the manifest. */
  queuedMessage?: string | null
  /** Pin the prompt-cache TTL for this session's whole life (every spawn,
   *  incl. hibernation wakes). Ticket forks pin `1h`: they work a card for an
   *  hour or more with think-gaps the 5m cache keeps lapsing across. Unset =
   *  the hub decides per spawn (agents/cache-ttl.ts). */
  cacheTtl?: CacheTtl
  /** What this session is for — picks its `--effort` via the per-kind policy
   *  (agents/effort.ts). Unset = 'default' (generals, Al, anything Yousef
   *  types into). Fixed for life, persisted in the manifest. */
  spawnKind?: SpawnKind
  /** Lifetime `--effort` pin (card `#effort/<level>`) — beats the policy. */
  effort?: Effort
  /** Restore-loop hint: the manifest said this session was mid-turn, so the
   *  restore spawn counts as "being worked" for the TTL decision even though
   *  the fresh instance has no activity yet. */
  resumeMidTurn?: boolean
  /** Hub ids this conversation had before this hub process (restore loop,
   *  from the manifest's `hubId` + `formerHubIds`). See Session.formerIds. */
  formerIds?: string[]
  /** Where this session's `claude` process runs. 'forge' pipes it over SSH to
   *  the remote compute box (server/src/forge/) so its dev servers, builds and
   *  tests stop competing with the hub for this machine's 8 cores and one
   *  disk (forge has 16 and its own NVMe, and nothing else on it).
   *  The CALLER must have run `prepareRemoteSession` first — by the time
   *  spawn happens the box has to be awake, the cwd mounted and the repo
   *  synced; on any failure the caller leaves this unset and the session is
   *  simply local. Persisted, so a hub-restart resume lands on the same box.
   *  Unset = local, which is also the fallback for everything. */
  placement?: 'local' | 'forge'
  /** The dev-server port assigned to a remote session and already forwarded
   *  back to the same port on the desktop, so `http://localhost:<port>` is the
   *  remote server. Rides the env as CONSOLE_DEV_PORT. */
  devPort?: number
  /** Create the session WITHOUT a subprocess: it exists (so a board dispatch is
   *  satisfied and its wake can be buffered) but nothing spawns until
   *  `startDeferred()` names a placement. The board uses this when a card wants
   *  forge and the box is still cold — waking the box takes ~60-90 s, which the
   *  synchronous dispatch path cannot wait for, and the alternative was running
   *  every such card locally "just this once", every time. */
  deferSpawn?: boolean
}

/** Pin the CLI's per-project directory (transcripts + auto-memory) to the
 *  session's CWD. By default the CLI derives it from the GIT ROOT, so every
 *  cwd inside one repo shares one memory dir — for us that meant every vault-
 *  homed project session (`~/sync/brain/root/projects/<slug>/`) wrote into the
 *  vault's single MEMORY.md, and a fork running from `console/server` filed
 *  its memory under Console's (^spry-seal, 2026-09-05). The pinned name is the
 *  same encoding the CLI derives for a non-git cwd, so transcript paths are
 *  unchanged and `relocate()`'s memory links line up. `CLAUDE_CONFIG_DIR` must
 *  be set alongside or the name is ignored (docs: sessions#name-the-project-
 *  directory-yourself, v≥2.1.234). Names outside `[A-Za-z0-9_-]{1,64}` are
 *  ignored by the CLI — fall back to its derivation rather than send junk. */
export function projectDirEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const name = cwdToProjectDir(cwd)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return {}
  // The dir is also WHICH MAX LOGIN this session spawns under (max-logins.ts).
  // With one subscription it is `~/.claude`, as it always was; its `projects`
  // tree is shared into every other login dir by symlink, so transcript and
  // memory paths (and therefore `--resume`) do not move when the fleet rotates.
  return { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? activeLoginDir(), CLAUDE_CODE_PROJECT_DIR_NAME: name }
}

export type RelocateMemoryOutcome = 'linked' | 'already-shared' | 'kept-existing' | 'none'

/** Make `toMemory` resolve to `fromMemory`'s content (auto-memory follows a
 *  relocation). Symlink, not move: other sessions may still run from the old
 *  cwd. An existing non-empty target is the destination project's own memory
 *  and wins untouched. */
export function linkMemoryDir(fromMemory: string, toMemory: string): RelocateMemoryOutcome {
  let fromIsDir = false
  try { fromIsDir = statSync(fromMemory).isDirectory() } catch { /* no source memory */ }
  if (!fromIsDir) return 'none'
  try {
    const st = lstatSync(toMemory)
    if (st.isSymbolicLink()) return 'already-shared'
    if (st.isDirectory()) {
      if (readdirSync(toMemory).length > 0) return 'kept-existing'
      rmdirSync(toMemory)
    } else {
      return 'kept-existing'
    }
  } catch { /* no target yet */ }
  mkdirSync(join(toMemory, '..'), { recursive: true })
  symlinkSync(fromMemory, toMemory)
  return 'linked'
}

export class Session extends EventEmitter {
  readonly id: string
  /** Hub ids this conversation carried in earlier hub processes, newest first
   *  (hub ids are per-process; the claudeSessionId is the stable key). */
  readonly formerIds: string[]
  claudeSessionId?: string
  name?: string
  /** claudeSessionId of the parent session if this is a fork (else undefined).
   *  Mutable only via `reparent_session`. */
  parentClaudeSessionId?: string
  /** See SessionOptions.forkContext. Undefined for non-forks / pre-^tall-colt forks. */
  readonly forkContext?: 'fresh' | 'inherited'
  /** Completed turns (`result` messages) — the denominator for per-turn cost. */
  turnCount = 0
  /** Durable org-chart role key (agents/registry.ts), if this session embodies one. */
  readonly agentKey?: string
  readonly project?: string
  readonly areas?: string[]
  status: 'running' | 'idle' | 'ended' = 'running'
  /** Durable "a turn is unfinished" bit, and the ONLY thing the manifest's
   *  `wasRunning` may trust. `status` is not enough: pm2 restarts the hub with
   *  treekill, so SIGINT reaches the claude CHILDREN too and they EXIT — often
   *  before the hub's own signal handler runs. Those exits flip `status` to
   *  'ended', so the manifest saved moments later recorded every mid-turn
   *  session as not-running and the restore never sent the "hub was restarted,
   *  continue" nudge (silent since ~Sept 2026, proven by SIGINTing a live
   *  child: status → 'ended', wasRunning → false). Set when a turn starts;
   *  cleared ONLY by a turn actually finishing (`result`) or a user interrupt —
   *  never by a process death, which is the whole point. */
  midTurn = false
  readonly createdAt = Date.now()
  readonly initialPrompt: string
  /** Fixed at spawn (`--resume` is keyed by it) — changes only via relocate(),
   *  which moves the transcript to the new cwd's project dir first. */
  cwd: string
  totalCost = 0
  /** totalCost carried by earlier claude processes of this session. The CLI's
   *  `total_cost_usd` is cumulative PER PROCESS, so every hibernation wake /
   *  respawn restarts it at 0 — assigning it raw made a session's cost DROP on
   *  wake while its tokens kept climbing (three astera forks read $0 at 100k+
   *  output tokens, ^sly-orca 2026-09-11). Rebased at each spawn. */
  private costBase = 0
  totalTokens: TokenUsage = { input: 0, output: 0 }
  contextWindow = 200_000
  /** Per-session model pin (see SessionOptions.modelOverride). While set, this
   *  session ignores the hub-wide model: spawns/respawns use it, and
   *  restartAllSessionsForModel skips the session. undefined = follow the hub. */
  modelOverride?: string

  /** Set when a turn came back as the CLI's own "no usable login" verdict
   *  (agents/auth-failure.ts), cleared by the next real answer. `count` is how
   *  many messages were spent into that error — each one was delivered,
   *  "answered", and not acted on, so this is also the re-send list. */
  authFailure: { at: number; detail: string; count: number } | null = null

  /** `@amar` attention flag — set when the session emits `@amar` in assistant
   *  output, cleared when Yousef opens / marks-read the session. */
  needsAttention: AttentionState | null = null
  /** Push dedup + anti-noise: last push time and a rolling 10-min window of
   *  push timestamps. The marker always refreshes; only the PUSH is gated. */
  private lastAttentionPushAt = 0
  private attentionPushTimes: number[] = []

  /** A prompt held back until the current turn FULLY ends (see queueMessage).
   *  Distinct from steering: any stdin write lands at the next tool boundary,
   *  so a real queue must not touch stdin until `result`. */
  queuedMessage: string | null = null
  /** Images riding the queued prompt (card attachments on a compact-first
   *  fork wake). In-memory only — the manifest persists the text, so a
   *  restart mid-queue delivers the words without the pictures. */
  private queuedImages: ImageAttachment[] = []

  /** The CLI's own task list for this session, read from
   *  ~/.claude/tasks/<claudeSessionId>/ (see agents/todo-store.ts). The stream
   *  never carries the assembled list, so the disk store is the only source. */
  todos: TodoItem[] = []
  /** Newest task-file mtime — drives the stale-list cut in visibleTodos(). */
  private todosUpdatedAt = 0
  private todoWatcher: (() => void) | null = null
  /** claudeSessionId the todo watcher is bound to — a fork gets a new csid, so
   *  the watcher must re-bind rather than keep watching the parent's dir. */
  private todoWatchedCsid: string | null = null

  /**
   * Coalesced message log for replay to late-joining clients.
   *
   * Bounded by MAX_LOG_SIZE — older entries roll off into the abyss as new
   * ones arrive. This is the rolling window; absolute indexing is tracked via
   * `logOffset`. Without the cap a 13-hour multi-session hub blew through V8's
   * default 4 GB heap (24+ sessions × hours of tool_use blocks).
   *
   * Source of truth for the full history is Claude CLI's own JSONL transcript
   * at ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl, which it
   * writes regardless of this log. On hub restart the SDK replays into this
   * log via stream-json, so cold-boot naturally rebuilds the recent window.
   */
  readonly messageLog: LoggableHubMessage[] = []
  /** Absolute index of `messageLog[0]`. Increases when the rolling window
   *  rolls off the oldest entry; never decreases except on clearLog. */
  private logOffset = 0
  private readonly MAX_LOG_SIZE = 500

  private process: ChildProcess | null = null
  private stdinReady = false
  /** Accumulator for text_delta coalescing */
  private pendingText = ''
  /** Accumulator for thinking_delta coalescing */
  private pendingThinking = ''

  constructor(options: SessionOptions) {
    super()
    this.id = `session_${++sessionCounter}_${Date.now()}`
    this.formerIds = (options.formerIds ?? []).slice(0, 8)
    this.initialPrompt = options.prompt
    this.name = options.name
    this.parentClaudeSessionId = options.parentClaudeSessionId
    this.forkContext = options.forkContext
    this.agentKey = options.agentKey
    this.project = options.project
    this.areas = options.areas
    this.cwd = options.cwd || process.cwd()
    this.modelOverride = options.modelOverride
    this.spawnKind = options.spawnKind ?? 'default'
    this.effortPin = options.effort ?? null
    this.placement = options.placement ?? 'local'
    this.devPort = options.devPort ?? null
    // Restore the absolute message-log high-water (see SessionOptions). The
    // in-memory log starts empty, so without this messageLogLength would report
    // 0 after a restart and every session's unread marker would be wiped. The
    // restored offset models "all prior messages rolled off to disk", exactly
    // the get_older_messages boundary, so pagination stays consistent.
    if (options.restoreMessageLogLength && options.restoreMessageLogLength > 0) {
      this.logOffset = options.restoreMessageLogLength
    }
    // Set claudeSessionId immediately so list_sessions / the manifest can match
    // before Claude emits the `system` init. Resumes reuse the target id; FORKS
    // get a hub-minted id that spawn() pins with `--session-id` (the CLI honours
    // it alongside `--resume <parent> --fork-session`, verified 2026-09-05).
    // Without the pin a fork had NO csid until init and its argv named only
    // the PARENT's id — so a fork reading `ps` believed it was the parent, and
    // anything matching processes by `--resume` could not tell the two apart
    // (^blue-vole). Never pre-set the parent's id here: that collides in the
    // manifest dedup.
    if (options.resume) {
      this.claudeSessionId = options.fork ? randomUUID() : options.resume
      if (options.fork) this.forkPin = this.claudeSessionId
    } else if (options.pinSessionId) {
      // Fresh spawn, hub-minted id: same pin mechanism as a fork, no parent
      // transcript. spawn() passes `--session-id` alone.
      this.claudeSessionId = randomUUID()
      this.forkPin = this.claudeSessionId
    }
    // Silent resumes (hub restart restore) start idle — no prompt will be sent
    if (options.silent) {
      this.status = 'idle'
    }
    // Restore a pending @amar marker across hub restarts.
    if (options.needsAttention) this.needsAttention = options.needsAttention
    // A queued prompt survives a hub restart mid-turn (that's the whole point
    // of it living hub-side) — restore BEFORE the hibernate early-return.
    // A restored queue is NOT auto-flushed here: for a session that was
    // mid-turn the restart nudge re-runs the turn and the flush happens at its
    // end (the normal path); for an idle one the restore loop flushes
    // explicitly once its listeners are attached. Flushing from the ctor would
    // race the nudge and turn the queued prompt into steering.
    if (options.queuedMessage) this.queuedMessage = options.queuedMessage
    if (options.cacheTtl) this.cacheTtlPin = options.cacheTtl
    // Restore-into-hibernation: skip the spawn entirely — the first message
    // wakes the session with --resume (sendMessage → wakeFromHibernation).
    // Keeps hub restarts light: 40+ idle sessions = zero claude processes.
    if (options.hibernateOnStart && options.resume && !options.fork) {
      this.status = 'idle'
      this.hibernated = true
      return
    }
    // Deferred spawn (see SessionOptions.deferSpawn): no process, and no
    // `hibernated` flag either — there is no transcript to --resume yet, so the
    // hibernation wake path must not be able to fire. startDeferred() spawns.
    if (options.deferSpawn) {
      this.deferredSpawn = options
      this.status = 'idle'
      return
    }
    this.spawn(options)
    // Send the initial prompt via stdin (since we use --input-format stream-json instead of -p)
    // For silent resumes (hub restart restore), skip — Claude resumes idle, waiting for user input
    if (!options.silent) {
      this.sendMessage(options.prompt, options.images)
    }
  }

  /** Deliver a queued prompt when there's no turn left to wait for. */
  flushIfIdle(): void {
    if (this.status === 'idle') this.flushQueuedMessage()
  }

  private spawn(options: SessionOptions, spawnCtx: { wake?: boolean } = {}) {
    this.costBase = this.totalCost
    // Prompt-cache TTL for every request this process will make — decided
    // here because the CLI reads the env var once at start. See
    // agents/cache-ttl.ts for the policy; the reason is logged per spawn and
    // the ledger there counts what the CLI actually wrote per TTL class.
    const hooks = cacheTtlHooks()
    const ttlChoice = resolveCacheTtl({
      pin: this.cacheTtlPin,
      wake: spawnCtx.wake,
      // `status` is 'running' on every fresh instance, so it says nothing here;
      // midTurn is the durable "turn unfinished" bit (set by sendMessage,
      // cleared only by a success result / interrupt).
      midTurn: options.resumeMidTurn || this.midTurn,
      everActive: this.everActive,
      lastActivityAt: this.lastActivityAt,
      recentMs: hooks.recentMinutes() * 60_000,
    })
    this.cacheTtl = ttlChoice.ttl
    this.cacheTtlReason = ttlChoice.reason
    hooks.onSpawn?.(ttlChoice.ttl, ttlChoice.reason, this.name ?? this.id)
    // Extended thinking is an explicit CLI flag in Claude Code 2.x — without
    // --effort no thinking blocks are emitted. Per spawn KIND (agents/effort.ts):
    // generals xhigh, throwaway forks high; a card `#effort/<level>` pins it.
    const effortChoice = resolveEffort({ kind: this.spawnKind, pin: this.effortPin, policy: effortHooks().policy() })
    const effort = effortChoice.effort
    this.effort = effort
    this.effortReason = effortChoice.reason
    effortHooks().onSpawn?.(effort, effortChoice.kind, effortChoice.reason, this.name ?? this.id)
    // Autocompact window per spawn KIND (agents/compact-window.ts): throwaway
    // forks cap at 400k, generals keep the CLI default.
    const compactChoice = resolveCompactWindow(this.spawnKind, compactWindowHooks().policy(), this.cwd)
    this.compactWindow = compactChoice.window
    this.compactStamps = []
    compactWindowHooks().onSpawn?.(compactChoice.window, this.spawnKind, compactChoice.reason, this.name ?? this.id)
    // Per-session pin wins; else resolved from ModelConfig (runtime-configurable
    // + fallback chain). Record what we spawned with so a model-unavailable
    // failure reports the right id.
    const model = this.modelOverride ?? resolveAgentModel()
    this.spawnedModel = model
    this.spawnedAt = Date.now()
    this.gotSystemInit = false
    this.preInitStderrLogged = 0
    this.lastStdinPrompt = null
    // A respawn orphans any outstanding control_request — the new process
    // knows nothing of it, so a stale marker would misroute normal messages
    // into denyTool (whose response would go unanswered anyway).
    this.approvalPending = false
    this.pendingApprovalRequest = null
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
      '--chrome',
      '--effort', effort,
      // Translate to this owner's tagged inference-profile ARN on Bedrock, so
      // the spend is attributable to a person. `--model` OVERRIDES
      // `ANTHROPIC_MODEL`, so passing the bare id here bypassed every tagged
      // profile and made ~all fleet spend permanently untagged in Cost
      // Explorer. `spawnedModel` deliberately keeps the BARE id (above) — the
      // fallback chain, model labels, and context-window table are all keyed on
      // it. No-op off Bedrock. See bedrock-profiles.ts.
      '--model', taggedModelId(model),
    ]

    if (options.resume) {
      args.push('--resume', options.resume)
    }

    if (options.fork) {
      // The pre-minted id (ctor) — the fork's argv now names ITSELF, so `ps`
      // identifies a fork and a reaper can match it without confusing it with
      // its parent (whose id sits in --resume).
      args.push('--fork-session', '--session-id', this.claudeSessionId!)
    } else if (options.pinSessionId && !options.resume && this.claudeSessionId) {
      args.push('--session-id', this.claudeSessionId)
    }

    if (options.name) {
      args.push('--name', options.name)
    }

    // Append the system prompt on fresh spawns, and on resumes ONLY when the
    // caller explicitly asks (role reload): --append-system-prompt applies per
    // INVOCATION — a resume without it keeps the original prompt, a resume
    // with it REPLACES the previous append (empirically verified 2026-08-18:
    // ALPHA appended at spawn, BETA appended at resume → model sees only BETA,
    // history intact). So charter reloads can keep full history. Ordinary
    // hub-restart resumes still pass no prompt (charter unchanged).
    if (options.systemPrompt && (!options.resume || options.reapplyPromptOnResume)) {
      args.push('--append-system-prompt', options.systemPrompt)
    }

    const cwd = this.cwd
    const nice = agentNice()

    // Everything the HUB decides for this session, as opposed to everything the
    // machine happens to have in its environment. Split out because a remote
    // spawn ferries exactly this set across SSH (which forwards no env of its
    // own) while a local spawn merges it over process.env.
    const sessionEnv: Record<string, string> = {
        // The session's own agentKey rides the env so the `con` CLI (and any
        // script the agent runs) can self-identify to the hub — board mutations
        // carry an X-Console-Agent header, letting notifiers skip echoing an
        // agent's own edits back at it.
        ...(this.agentKey ? { CONSOLE_AGENT_KEY: this.agentKey } : {}),
        // Known before spawn for pinned/resumed sessions — `con listen add`
        // and `con cron add` default --session to it so agents stop
        // grepping their own argv for it.
        ...(this.claudeSessionId ? { CONSOLE_CLAUDE_SESSION_ID: this.claudeSessionId } : {}),
        ...projectDirEnv(cwd),
        CLAUDE_CODE_PROMPT_CACHE_TTL: ttlChoice.ttl,
        ...(compactChoice.window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactChoice.window) } : {}),
        ...(contextProxyEnv?.(this.name, this.id, String(this.spawnedAt)) ?? {}),
        // Which hub generation spawned this process — the reaper kills claude
        // children whose marker names a dead hub (process-reaper.ts).
        [HUB_PID_ENV]: String(process.pid),
        // Remote sessions get their own dev-server port, already forwarded back
        // to the same port on the desktop. Told to the agent in the envelope too.
        ...(this.devPort ? { CONSOLE_DEV_PORT: String(this.devPort) } : {}),
        // Where this process is running, so a SCRIPT can tell. The envelope
        // tells the agent, but the throttles that exist to protect the desktop
        // (astera's scripts/heavy.sh, its dev-server reaper) are shell, and a
        // remote fork must be able to opt them out without being asked to.
        CONSOLE_PLACEMENT: this.placement ?? 'local',
    }

    // A respawn (model restart, hibernation wake) must not reuse the old
    // handle when deciding whether the remote branch took.
    let proc: ChildProcess | null = null
    if (this.placement === 'forge') {
      // The hub's transport to an agent is stream-json over stdin/stdout, which
      // is pipe-based and therefore transport-agnostic: `ssh -T` carries it
      // verbatim and nothing downstream of the pipe (the SPA, the message log,
      // cost accounting, interrupts) can tell the difference. That is what
      // makes a remote fork a one-line change here rather than a rewrite.
      //
      // Preconditions (box awake, cwd mounted, repo synced, agent env mirrored)
      // are the CALLER's job — see forge/index.ts prepareRemoteSession. If any
      // of them failed, placement was left 'local' and we never reach here.
      const cfg = forgeConfig()
      if (!cfg) {
        // Config vanished between prepare and spawn. Fall back rather than
        // spawn into nothing — a local fork is always better than no fork.
        this.placement = 'local'
        this.emitHub({ type: 'status', sessionId: this.id, text: '[forge] config missing at spawn — running locally' })
      } else {
        // A Max login is a dir on THIS machine; forge has only its own
        // `~/.claude` (Bedrock-pinned, no Max credentials). Forwarding the
        // active login's dir made every forge fork resume under a path absent
        // on the box, read as a pruned transcript, and respawn with no context
        // (9 Oct 2026, 15 forks). Same path string as before multi-login.
        //
        // The identity is decided HERE, per spawn, never inherited from whatever
        // the mirrored settings.json happens to carry. The night the fleet moved
        // to a second Max login every forge fork was started with `--model
        // claude-opus-5-5` and no AWS env on a box with no login, and answered
        // "Not logged in" (9 Oct 2026, 21 forks, ~40 min).
        //
        // Two identities exist on the box (forge/agent-env.ts forgeSpawnPlan):
        //  - the subscription, when the fleet is on it AND Yousef has logged the
        //    SAME account in on forge. Its dir shares `projects` with the box's
        //    `~/.claude` by symlink, so `--resume` finds the same transcript;
        //  - Bedrock through the instance role, for everything else. That needs
        //    its env and a Bedrock `--model` set explicitly.
        const plan = forgeSpawnPlan(detectActiveBackend(), forgeMaxLoginDir(activeLoginName()))
        this.remoteBackend = plan.backend
        const remoteEnv = plan.backend === 'first_party'
          ? { ...sessionEnv, CLAUDE_CONFIG_DIR: plan.configDir }
          : { ...sessionEnv, CLAUDE_CONFIG_DIR: canonicalDir(), ...remoteBedrockEnv() }
        const remoteArgs = plan.backend === 'first_party'
          ? args
          : args.map((a, i) => (args[i - 1] === '--model' ? taggedModelId(model, { forceBedrock: true }) : a))
        // dieWithConnection: every kill() below signals `proc`, which here is
        // only the ssh client. Without it the remote claude outlives each one
        // of them as a twin still working its turn (forge/ssh.ts, watchdog).
        const argv = remoteCommandArgv(cfg, { cwd, env: remoteEnv, command: 'claude', args: remoteArgs, dieWithConnection: true })
        proc = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'], env: forgeSshEnv() })
        this.remoteHost = cfg.host
        noteForgeUse()
      }
    }

    if (!proc) {
      const [bin, argv] = nice > 0 ? ['nice', ['-n', String(nice), 'claude', ...args]] : ['claude', args]
      proc = spawn(bin, argv, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...sessionEnv },
      })
    }
    this.process = proc
    this.processAlive = true

    this.stdinReady = true

    // A child that died keeps a writable stdin handle until its `exit` event
    // lands, so any write in that gap raises EPIPE on the socket. Without a
    // listener Node treats it as an unhandled 'error' and kills the HUB — on
    // 2026-10-06 the CLI self-upgraded to 2.1.292 mid-flight, every spawn
    // exited 1, and the stdin writes that followed crash-looped the hub 17
    // times (pm2 restart → resume 40 sessions → write → crash). The child's
    // death is already handled by the `exit` handler below; this just stops it
    // being fatal here.
    this.process.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return // the child is gone; `exit` handles it
      this.emitHub({ type: 'error', sessionId: this.id, message: `Session stdin error: ${err.message}` })
    })

    // Read stdout as NDJSON (one JSON object per line)
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const msg = JSON.parse(trimmed) as ClaudeStdoutMessage
          this.handleClaudeMessage(msg)
        } catch {
          // Non-JSON output (e.g. debug logs) — emit as status
          if (trimmed.length > 0) {
            this.emitHub({ type: 'status', sessionId: this.id, text: trimmed })
          }
        }
      })
    }

    // Capture stderr for debugging
    if (this.process.stderr) {
      const rl = createInterface({ input: this.process.stderr })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (trimmed) {
          // Pre-init stderr is the ONLY record of why a spawn died before it
          // could report anything — and a pre-init exit is read below as "the
          // model is unavailable", which walks the hub's fallback chain. On
          // 6 Oct 2026 a burst of pre-init exits burned all seven Bedrock
          // entries in 70 s and parked ~40 sessions on haiku, with no trace of
          // the actual cause anywhere: this handler only ever forwarded stderr
          // to the SPA as a transient `status` event.
          if (!this.gotSystemInit && this.preInitStderrLogged < PRE_INIT_STDERR_LOG_CAP) {
            this.preInitStderrLogged++
            console.log(`[spawn-stderr] ${this.id} (${this.spawnedModel}): ${trimmed.slice(0, 300)}`)
          }
          // The --resume target's JSONL is gone from disk (CLI retention
          // prune). The process is about to exit(1) pre-init — flag it so the
          // exit handler respawns fresh instead of misreading it as a model
          // failure ("choking on figuring out which model to use").
          if (/no conversation found with session id/i.test(trimmed)) this.resumeTargetMissing = true
          else if (looksLikeModelError(trimmed)) this.signalModelFailure(`stderr: ${trimmed.slice(0, 200)}`)
          this.emitHub({ type: 'status', sessionId: this.id, text: trimmed })
        }
      })
    }

    this.process.on('exit', (code) => {
      this.stdinReady = false
      this.processAlive = false
      // Hub going down: the manifest was already saved with this session's
      // real status. Touch nothing — flipping status/endedByUser here would be
      // persisted as `ended` by the hub's exit listener and skipped on restore.
      if (this.shuttingDown) return
      // A model-driven restart or a user `reload()` killed the subprocess on
      // purpose — re-spawn it instead of ending the session.
      if (this.restartingForModel || this.reloading) {
        this.restartingForModel = false
        this.reloading = false
        this.doModelRespawn()
        return
      }
      // The --resume target's JSONL was pruned from the CLI's ~/.claude
      // retention — resuming can never succeed, so retrying (or blaming the
      // model) just wedges the session forever. Respawn FRESH: the hub-side
      // log/name/role survive, the CLI mints a new claudeSessionId on init,
      // and the message that triggered the wake is re-delivered.
      if (this.resumeTargetMissing && !this.endedByUser) {
        this.resumeTargetMissing = false
        // The message that triggered the wake was written to the dying
        // process's stdin (lastStdinPrompt) or is still parked
        // (pendingWakeMessage) — either way, re-deliver it to the fresh spawn.
        const pending = this.pendingWakeMessage ?? this.lastStdinPrompt
        this.pendingWakeMessage = null
        this.lastStdinPrompt = null
        this.emitHub({ type: 'error', sessionId: this.id, message: 'This session\'s transcript was pruned from disk, so it can\'t be resumed — restarted as a fresh conversation (hub history kept; the model starts without its old context).' })
        this.spawn({ prompt: '', cwd: this.cwd, silent: true, name: this.name })
        if (pending) this.sendMessage(pending.content, pending.images)
        else this.status = 'idle'
        return
      }
      // Hibernation: we killed the subprocess of an idle session to reclaim
      // its ~250MB RSS. The session stays alive (idle, log + unread intact) —
      // it re-spawns with --resume the moment a message arrives (sendMessage).
      // (If the user killed the session while the hibernation SIGKILL was in
      // flight, endedByUser wins — fall through to the normal ended path.)
      if (this.hibernating && !this.endedByUser) {
        this.hibernating = false
        this.hibernated = true
        // A message raced in while the process was dying — wake immediately.
        const pending = this.pendingWakeMessage
        if (pending) {
          this.pendingWakeMessage = null
          this.wakeFromHibernation()
          this.sendMessage(pending.content, pending.images)
        }
        return
      }
      // If process exited after an interrupt and we have a claudeSessionId,
      // auto-resume instead of ending the session
      if (this.interrupted && this.claudeSessionId) {
        this.interrupted = false
        this.status = 'idle'
        this.emitHub({ type: 'result', sessionId: this.id, cost: this.totalCost, tokens: { input: 0, output: 0 }, duration: 0, sessionIdClaude: this.claudeSessionId })
        // Re-spawn with --resume to keep the session alive
        this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId, silent: true, name: this.name })
        // This synthetic `result` bypasses handleResultMessage, so the queue
        // flush has to be repeated here — otherwise an interrupt would strand
        // the queued prompt until the end of some later turn.
        this.flushQueuedMessage()
        return
      }
      // ssh itself failed (255) before the remote claude spoke: the box refused
      // the session or the SSM transport timed out. Not a model fault. On
      // 9 Oct 2026 a failover respawned 11 forge forks at once over one
      // multiplexed connection (sshd MaxSessions 10, box at load 40); nine died
      // here and three lost their in-flight turn, because the "continue" nudge
      // had been written into the dead pipe.
      const sshFailed = this.placement === 'forge' && code === 255 && !this.gotSystemInit
      if (sshFailed && !this.endedByUser && this.claudeSessionId) {
        const lost = this.pendingWakeMessage ?? this.lastStdinPrompt
        if (lost && this.forgeSshRetries < FORGE_SSH_RETRY_MAX) {
          this.forgeSshRetries++
          this.pendingWakeMessage = null
          this.lastStdinPrompt = null
          this.hibernated = true
          this.status = 'idle'
          this.forgeSshRetryPending = lost
          const delay = this.forgeSshRetries * 20_000 + Math.floor(Math.random() * 10_000)
          console.log(`[forge] ${this.id}: ssh failed before the agent started — retry ${this.forgeSshRetries}/${FORGE_SSH_RETRY_MAX} in ${Math.round(delay / 1000)}s`)
          this.emitHub({ type: 'status', sessionId: this.id, text: `[forge] ssh to the box failed before the agent started — retrying in ${Math.round(delay / 1000)}s` })
          this.forgeSshRetryTimer = setTimeout(() => {
            this.forgeSshRetryTimer = null
            const p = this.forgeSshRetryPending
            this.forgeSshRetryPending = null
            if (!p || this.endedByUser || !this.hibernated) return
            this.sendMessage(p.content, p.images)
          }, delay)
          this.forgeSshRetryTimer.unref?.()
          return
        }
      }
      // Exited before ever initializing, soon after spawn → the model is the
      // likely culprit (pulled / unavailable / not entitled). Signal the hub so
      // it can advance the fallback chain. reportFailure → restartAllSessions
      // (or the stale/else branch) synchronously re-spawns THIS session via
      // restartForModelChange (which handles the now-dead process). Do NOT end
      // the session here — returning lets that re-spawn stand.
      if (!this.gotSystemInit && !this.endedByUser && !sshFailed
          && Date.now() - this.spawnedAt < 20_000) {
        this.signalModelFailure(`exited before init (code=${code})`)
        // If the signal led to a re-spawn (new process alive), we're done.
        if (this.processAlive || this.restartingForModel) return
        // Otherwise (chain exhausted / no advance) fall through to end cleanly.
      }
      // An incidental death (crash, OOM, killed from outside) of a resumable
      // session is treated like hibernation: the session stays in the list as
      // idle and the next message wakes it with --resume. A session is either
      // there or gone — 'ended' is reserved for one that can never come back.
      if (!this.endedByUser && this.claudeSessionId) {
        this.hibernating = false
        this.hibernated = true
        this.interrupted = false
        const wasRunning = this.status === 'running'
        this.status = 'idle'
        if (wasRunning) {
          this.emitHub({ type: 'error', sessionId: this.id, message: `The agent process exited unexpectedly (code=${code}) mid-turn. The session is kept — your next message resumes it.` })
        }
        this.emitHub({ type: 'result', sessionId: this.id, cost: this.totalCost, tokens: { input: 0, output: 0 }, duration: 0, sessionIdClaude: this.claudeSessionId })
        this.emit('exit', code)
        const pending = this.pendingWakeMessage
        if (pending) {
          this.pendingWakeMessage = null
          this.sendMessage(pending.content, pending.images)
        } else {
          this.flushQueuedMessage()
        }
        return
      }
      this.status = 'ended'
      this.emitHub({ type: 'session_ended', sessionId: this.id })
      this.emit('exit', code)
    })

    this.process.on('error', (err) => {
      this.emitHub({
        type: 'error',
        sessionId: this.id,
        message: `Process error: ${err.message}`,
      })
    })
  }

  /** Write a JSON message to Claude's stdin */
  writeStdin(msg: ClaudeStdinMessage) {
    if (!this.process?.stdin || !this.stdinReady) {
      this.emitHub({
        type: 'error',
        sessionId: this.id,
        message: 'Session stdin not available',
      })
      return
    }
    const json = JSON.stringify(msg)
    try {
      this.process.stdin.write(json + '\n')
    } catch (err) {
      // Writing to an already-destroyed stdin throws synchronously rather than
      // emitting — same dead-child race as the 'error' handler in spawn().
      this.emitHub({ type: 'error', sessionId: this.id, message: `Session stdin write failed: ${(err as Error).message}` })
    }
  }

  // ------------------------------------------------------------------ //
  // Transient-error auto-resume (429/503/overloaded). One pending timer per
  // session; consecutive failures walk RESUME_BACKOFF_MS; an hourly cap stops
  // a persistent outage from burning tokens; any real user prompt cancels
  // (their message continues the turn anyway) and resets the backoff.

  private transientResumeTimer: ReturnType<typeof setTimeout> | null = null
  private transientResumeAttempt = 0
  private transientResumeTimestamps: number[] = []

  private scheduleTransientResume(errorText: string): void {
    if (this.status === 'ended') return
    if (this.transientResumeTimer) return // one in flight is enough
    const hourAgo = Date.now() - 3_600_000
    this.transientResumeTimestamps = this.transientResumeTimestamps.filter((t) => t > hourAgo)
    if (this.transientResumeTimestamps.length >= MAX_AUTO_RESUMES_PER_HOUR) {
      console.log(`[auto-resume] ${this.id}: hourly cap reached, staying idle (${errorText.slice(0, 80)})`)
      return
    }
    const wait = RESUME_BACKOFF_MS[Math.min(this.transientResumeAttempt, RESUME_BACKOFF_MS.length - 1)]
    this.transientResumeAttempt++
    console.log(`[auto-resume] ${this.id}: transient API error, resuming in ${Math.round(wait / 1000)}s (attempt ${this.transientResumeAttempt})`)
    const failedModel = this.spawnedModel
    this.transientResumeTimer = setTimeout(() => {
      this.transientResumeTimer = null
      if (this.status === 'ended' || this.status === 'running') return
      this.transientResumeTimestamps.push(Date.now())
      // The model may have been swapped under us while we waited (outage
      // fallback or a manual `con agent model set`) — tell the agent, or it
      // carries on believing it is still the model that failed.
      const content = this.spawnedModel !== failedModel
        ? `The previous request failed because ${failedModel} was unavailable upstream; this session now runs on ${this.spawnedModel}. Continue from where you left off.`
        : 'The previous request hit a transient API error (rate limit / overloaded). Continue from where you left off.'
      const userMsg = { type: 'user_prompt' as const, sessionId: this.id, content }
      this.emitHub(userMsg)
      this.logMessage(userMsg)
      this.sendMessage(content)
    }, wait)
    this.transientResumeTimer.unref?.()
  }

  /** A real user message supersedes any pending auto-resume. Called from the
   *  send_message route (NOT from the nudge itself — it nulls the timer
   *  before sending). */
  cancelTransientResume(): void {
    if (this.transientResumeTimer) {
      clearTimeout(this.transientResumeTimer)
      this.transientResumeTimer = null
    }
    this.transientResumeAttempt = 0
  }

  /** Send a follow-up user prompt, optionally with images */
  sendMessage(content: string, images?: ImageAttachment[]) {
    this.lastActivityAt = Date.now()
    this.midTurn = true
    this.everActive = true
    // Awaiting a placement decision (deferSpawn) — there is nothing to write
    // to. Hold the prompt; startDeferred() delivers it to the fresh process.
    if (this.deferredSpawn) {
      this.pendingWakeMessage = this.pendingWakeMessage
        ? { content: `${this.pendingWakeMessage.content}\n\n${content}`, images: [...(this.pendingWakeMessage.images ?? []), ...(images ?? [])] }
        : { content, images }
      this.status = 'running'
      return
    }
    // Hibernated (or mid-hibernation) — bring the subprocess back first.
    if (this.hibernating) {
      // SIGKILL in flight; the exit handler wakes + sends this for us.
      this.pendingWakeMessage = { content, images }
      this.status = 'running'
      return
    }
    if (this.hibernated) {
      // Waking ahead of a forge ssh retry: carry what the failed spawn lost.
      if (this.forgeSshRetryTimer) {
        clearTimeout(this.forgeSshRetryTimer)
        this.forgeSshRetryTimer = null
      }
      const lost = this.forgeSshRetryPending
      this.forgeSshRetryPending = null
      if (lost) {
        content = `${lost.content}\n\n${content}`
        images = [...(lost.images ?? []), ...(images ?? [])]
        if (images.length === 0) images = undefined
      }
      this.wakeFromHibernation()
    }
    this.status = 'running'
    // Keep a copy: if this process dies because its --resume target was
    // pruned from disk, the write below went nowhere — the fresh respawn
    // re-delivers it.
    this.lastStdinPrompt = { content, images }
    if (images && images.length > 0) {
      const blocks: ClaudeStdinContentBlock[] = images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
      }))
      blocks.push({ type: 'text', text: content })
      this.writeStdin({
        type: 'user',
        message: { role: 'user', content: blocks },
      })
    } else {
      this.writeStdin({
        type: 'user',
        message: { role: 'user', content },
      })
    }
  }

  // ------------------------------------------------------------------ //
  // Queued messages — "send this when the WHOLE turn is done".
  //
  // NOT steering: a stdin write lands at the CLI's next tool boundary, so
  // anything queued client-side would interrupt the turn. Held here instead
  // and flushed on `result`, which also means it survives a page reload, the
  // phone backgrounding, and a hub restart mid-turn (manifest-persisted).
  // ONE buffer that grows — a second queue appends rather than making a FIFO.
  // A queue only ever waits for a turn that is actually running: on an idle
  // session every queue path delivers at once. (A 10-min hold that batched
  // wind-down digests left them visibly parked on idle parents — ^gray-koi.)

  /** Append `content` to the queued prompt (blank-line separated). */
  queueMessage(content: string, images?: ImageAttachment[]): void {
    const text = content.trim()
    if (!text) return
    this.queuedMessage = this.queuedMessage ? `${this.queuedMessage}\n\n${text}` : text
    if (images?.length) this.queuedImages.push(...images)
    this.emitQueued()
    // No turn to wait for — queueing on an idle session is just sending.
    this.flushIfIdle()
  }

  /** Replace the queued prompt outright; `null`/empty cancels it. */
  setQueuedMessage(content: string | null): void {
    const text = content?.trim() || null
    if (text === this.queuedMessage) return
    this.queuedMessage = text
    if (!text) this.queuedImages = []
    this.emitQueued()
    if (text) this.flushIfIdle()
  }

  /** Deliver the queued prompt as a real user message. Called at turn end.
   *  Clears the slot FIRST — sendMessage flips status back to 'running', and a
   *  re-entrant flush would double-send. */
  flushQueuedMessage(): void {
    const content = this.queuedMessage
    if (!content || this.status === 'ended') return
    const images = this.queuedImages
    this.queuedMessage = null
    this.queuedImages = []
    this.emitQueued()
    // Same triple as the transient-resume nudge: broadcast + log so the
    // transcript shows it, then write it to stdin.
    const userMsg = {
      type: 'user_prompt' as const, sessionId: this.id, content,
      ...(images.length ? { images: images.map((i) => `data:${i.media_type};base64,${i.data}`) } : {}),
    }
    this.logMessage(userMsg)
    this.emit('hub_message', userMsg satisfies HubMessage)
    this.sendMessage(content, images.length ? images : undefined)
  }

  /** Broadcast the queue state. Bypasses emitHub deliberately — emitHub logs
   *  everything but status/tool_input_delta, and this is ephemeral state, not
   *  transcript. */
  private emitQueued(): void {
    this.emit('hub_message', {
      type: 'session_queued',
      sessionId: this.id,
      queuedMessage: this.queuedMessage,
    } satisfies HubMessage)
  }

  // --------------------------------------------------------------------------
  // Task list (CLI todos)
  // --------------------------------------------------------------------------

  /** Bind the watcher for a session whose csid was known at construction (a
   *  resume, incl. restore-into-hibernation, which never emits system/init).
   *  Called by the hub AFTER listeners are attached — the ctor is too early for
   *  the initial emit to reach anyone. Idempotent. */
  startTodoWatch(): void {
    this.bindTodoWatcher()
  }

  /** Bind (or re-bind) the todo watcher to the current claudeSessionId. Called
   *  once the csid is known — on `system`/init and on a pre-set resume. */
  private bindTodoWatcher(): void {
    const csid = this.claudeSessionId
    if (!csid || csid === this.todoWatchedCsid) return
    this.todoWatcher?.()
    this.todoWatchedCsid = csid
    this.todos = readTodos(csid)
    this.todosUpdatedAt = todosUpdatedAt(csid)
    if (this.visibleTodos().length) this.emitTodos()
    this.todoWatcher = watchTodos(csid, (todos) => {
      this.todos = todos
      this.todosUpdatedAt = todosUpdatedAt(csid)
      this.emitTodos()
    })
  }

  /** What clients should show: the list, unless it's finished and stale
   *  (see TODO_STALE_MS). Evaluated per read — getInfo() runs on every
   *  sessions_list poll, so the cut lands without any file event. */
  visibleTodos(): TodoItem[] {
    return isStaleTodoList(this.todos, this.todosUpdatedAt) ? [] : this.todos
  }

  /** Ephemeral like session_queued — the authoritative copy rides
   *  SessionInfo.todos, and the files on disk outlive everything. */
  private emitTodos(): void {
    this.emit('hub_message', {
      type: 'session_todos',
      sessionId: this.id,
      todos: this.visibleTodos(),
    } satisfies HubMessage)
  }

  /** Approve a tool use request */
  approveTool(requestId: string, modifiedInput?: Record<string, unknown>) {
    const inner: Record<string, unknown> = { behavior: 'allow' }
    // Only include updatedInput when the caller is actually modifying the
    // tool input (e.g. AskUserQuestion answers). Plain approvals omit it —
    // cleaner on the wire and matches what the Claude CLI expects.
    if (modifiedInput !== undefined) inner.updatedInput = modifiedInput
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: inner,
      },
    }
    this.resolveUserApproval(requestId)
    this.lastActivityAt = Date.now()
    this.writeStdin(response as any)
  }

  /** Answering a user-facing approval (AskUserQuestion/ExitPlanMode) IS the
   *  acknowledgement — drop the red marker it raised. Auto-approvals of
   *  ordinary tools never set pendingApprovalRequest, so a genuine @amar
   *  marker survives them. */
  private resolveUserApproval(requestId: string) {
    const wasUserFacing = this.pendingApprovalRequest?.requestId === requestId
    this.approvalPending = false
    this.pendingApprovalRequest = null
    if (wasUserFacing) this.clearAttention()
  }

  /** Deny a tool use request */
  denyTool(requestId: string, reason?: string) {
    // Claude CLI requires `message` to be a string (Zod rejects undefined)
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: { behavior: 'deny', message: reason ?? 'Denied by user' },
      },
    }
    this.resolveUserApproval(requestId)
    this.lastActivityAt = Date.now()
    this.writeStdin(response as any)
  }

  /** Set when we send SIGINT so exit handler knows to auto-resume */
  private interrupted = false

  /** Interrupt the current operation (SIGINT) */
  interrupt() {
    if (this.process && this.status === 'running') {
      this.interrupted = true
      // Yousef asked for this turn to stop — it must NOT be resurrected by the
      // next hub restart's "continue" nudge.
      this.midTurn = false
      this.process.kill('SIGINT')
    }
  }

  /** Stop the current turn WITHOUT killing the process: the stream-json
   *  `interrupt` control request, which the CLI answers by ending the turn
   *  with a result. A voice barge-in needs this — SIGINT respawns the CLI and
   *  the next reply would wait on the resume. Falls back to SIGINT when the
   *  CLI does not acknowledge. */
  async softInterrupt(): Promise<'control' | 'signal' | 'idle'> {
    if (!this.process || this.status !== 'running') return 'idle'
    const res = await this.sendControlRequest('interrupt', {}, 3000)
    if (res.ok) {
      this.midTurn = false
      return 'control'
    }
    this.interrupt()
    return 'signal'
  }

  /** True when the user explicitly ended this session (kill_session /
   *  delete_session), as opposed to the subprocess dying on its own (SDK
   *  timeout, crash). Persisted to the manifest so an explicit "End session"
   *  survives hub restarts — incidental deaths still get resumed. */
  endedByUser = false

  // --- Model-failure / fallback bookkeeping (see model-config.ts) ---
  /** Model id passed to `--model` on the most recent spawn. */
  private spawnedModel = ''
  /** Wall-clock of the most recent spawn — used to scope the "exited before
   *  init" model-failure heuristic to a short window. */
  private spawnedAt = 0
  /** True once the subprocess emitted its `system` init — i.e. it started fine. */
  private gotSystemInit = false
  /** Pre-init stderr lines logged for the current spawn (capped so a crash loop
   *  across the whole fleet can't flood the hub log). */
  private preInitStderrLogged = 0
  /** The csid this fork was spawned with (`--session-id`); init must echo it. */
  private forkPin: string | null = null
  /** De-dupe: emit at most one `model_failure` per spawn. */
  private modelFailureSignaled = false
  /** Set while a model-driven restart is in flight so the exit handler re-spawns
   *  instead of ending the session. */
  private restartingForModel = false
  /** Set while a user-driven `reload()` is in flight — same re-spawn path as a
   *  model restart, but triggered manually (con agent reload). */
  private reloading = false
  /** Whether the current subprocess is still running — guards restart against
   *  kill()ing an already-dead process (which would never fire `exit`). */
  private processAlive = false
  /** Count of consecutive model restarts (reset on successful init). */
  private modelRestarts = 0

  // --- Idle hibernation (see index.ts sweep) ---------------------------------
  // A live `claude` subprocess holds ~250MB RSS even when idle; dozens of
  // parked sessions = many GB. Hibernation kills the subprocess of a
  // long-idle session while keeping the Session entry (message log, unread
  // state, claudeSessionId) — the process transparently re-spawns with
  // --resume on the next message.
  /** Set while the hibernation SIGKILL is in flight (exit handler pending). */
  private hibernating = false
  /** True when the subprocess is dead by hibernation (not ended). */
  hibernated = false
  /** Prompt-cache TTL this session's current process runs on, and why. */
  cacheTtl: CacheTtl | null = null
  cacheTtlReason: CacheTtlReason | null = null
  /** Lifetime pin from SessionOptions.cacheTtl (ticket forks). */
  cacheTtlPin: CacheTtl | null = null
  /** See SessionOptions.spawnKind / effort. `effort` is what the current
   *  process was spawned with (agents/effort.ts resolves kind + pin + pref). */
  spawnKind: SpawnKind = 'default'
  effortPin: Effort | null = null
  effort: Effort | null = null
  effortReason: EffortReason | null = null
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW the current process got; null = CLI default. */
  compactWindow: number | null = null
  /** compact_boundary times for the CURRENT process — see noteCompaction(). */
  private compactStamps: number[] = []
  /** See SessionOptions.placement / devPort. */
  placement: 'local' | 'forge' = 'local'
  devPort: number | null = null
  /** ssh host alias the current process actually runs on, when remote — shown
   *  in the session status bar so "where did this run?" is never a guess. */
  remoteHost: string | null = null
  /** Which identity this REMOTE process was spawned with (forgeSpawnPlan). The
   *  fleet backend does not answer that for a forge fork: it runs on Bedrock
   *  while the fleet is on Max unless the box has a login for the same account.
   *  null for a local session, whose backend is the fleet's. */
  remoteBackend: 'first_party' | 'bedrock' | null = null
  /** The spawn options held back by SessionOptions.deferSpawn, until
   *  startDeferred() decides where this session runs. */
  private deferredSpawn: SessionOptions | null = null
  /** A fresh instance has no activity to judge by; flips on the first sendMessage. */
  private everActive = false
  /** Message that arrived during the hibernating window — sent after exit→wake. */
  private pendingWakeMessage: { content: string; images?: ImageAttachment[] } | null = null
  /** stderr said "No conversation found with session ID" — the --resume
   *  target's JSONL was pruned; the exit handler must respawn fresh. */
  private resumeTargetMissing = false
  /** Last message written to stdin this process-lifetime — re-delivered when a
   *  failed resume forces a fresh respawn (the write went to a dying process). */
  private lastStdinPrompt: { content: string; images?: ImageAttachment[] } | null = null
  /** Forge spawns that died on ssh before init, retried with backoff (exit handler). */
  private forgeSshRetries = 0
  private forgeSshRetryTimer: ReturnType<typeof setTimeout> | null = null
  private forgeSshRetryPending: { content: string; images?: ImageAttachment[] } | null = null
  /** Wall-clock of the last user message or completed turn — the idle clock. */
  lastActivityAt = Date.now()
  /** An approval (AskUserQuestion / plan) is outstanding — hibernating now
   *  would orphan the pending control_request, making it unanswerable. */
  approvalPending = false
  /** Which approval is outstanding — lets the send_message path route a chat
   *  message typed during an ExitPlanMode review into plan feedback (deny with
   *  the message as reason) instead of stdin, where the CLI can't process it
   *  until the control_request resolves (the "frozen composer"). */
  pendingApprovalRequest: { requestId: string; toolName: string } | null = null

  /** True when this session is safe to hibernate: idle for real (no pending
   *  approval, not mid-anything), with a resumable claudeSessionId. */
  canHibernate(): boolean {
    return this.status === 'idle'
      && !this.endedByUser
      && !this.hibernated
      && !this.hibernating
      && !this.restartingForModel
      && !this.reloading
      && !this.approvalPending
      && this.processAlive
      && !!this.claudeSessionId
  }

  /** Kill the idle subprocess to reclaim its memory. The exit handler flips
   *  `hibernated`; the session stays 'idle' and wakes on the next message. */
  hibernate(): boolean {
    if (!this.canHibernate()) return false
    this.hibernating = true
    this.stdinReady = false
    // SIGKILL: instant, nothing to flush — mirrors restartForModelChange.
    this.process!.kill('SIGKILL')
    return true
  }

  /** Move an IDLE session to another cwd without losing its conversation.
   *  `--resume` finds a transcript under ~/.claude/projects/<encoded cwd>/, so
   *  the JSONL is moved into the new cwd's project dir and the subprocess (if
   *  alive) is put down like a hibernation — the next message wakes it with
   *  `--resume` from the new dir. Verified live: a relocated session recalls
   *  its earlier turns. Auto-memory and CLAUDE.md follow the NEW cwd (that is
   *  the point — a stray session was reading the wrong project's). Auto-memory
   *  FOLLOWS: it is per-cwd (`<project dir>/memory/`), so the new cwd's memory
   *  dir becomes a symlink to the old one — shared, nothing moves out from
   *  under sessions still at the old cwd. A target that already has its own
   *  memory keeps it (that IS the project's memory; the stray adopts it).
   *  Forks are separate sessions with their own cwd; relocate them
   *  individually. */
  relocate(newCwd: string): { ok: true; memory: RelocateMemoryOutcome } | { ok: false; error: string } {
    if (this.status === 'running' || this.approvalPending) return { ok: false, error: 'session is mid-turn — wait for it to go idle' }
    if (this.endedByUser || this.status === 'ended') return { ok: false, error: 'session has ended' }
    if (!this.claudeSessionId) return { ok: false, error: 'session has no claudeSessionId yet' }
    try { if (!statSync(newCwd).isDirectory()) return { ok: false, error: `not a directory: ${newCwd}` } } catch { return { ok: false, error: `not a directory: ${newCwd}` } }
    if (newCwd === this.cwd) return { ok: false, error: 'already there' }
    const projects = join(homedir(), '.claude', 'projects')
    const from = join(projects, cwdToProjectDir(this.cwd), `${this.claudeSessionId}.jsonl`)
    const toDir = join(projects, cwdToProjectDir(newCwd))
    const to = join(toDir, `${this.claudeSessionId}.jsonl`)
    if (existsSync(to)) return { ok: false, error: `a transcript for ${this.claudeSessionId} already exists under ${toDir}` }
    if (this.processAlive && this.process) {
      // Same mechanics as hibernate(): SIGKILL, exit handler flips `hibernated`,
      // a message racing the kill is queued and delivered after the wake.
      this.hibernating = true
      this.stdinReady = false
      this.process.kill('SIGKILL')
    }
    // A pruned transcript (no file) just means the wake respawns fresh — the
    // existing resumeTargetMissing path handles that; nothing to move.
    if (existsSync(from)) {
      mkdirSync(toDir, { recursive: true })
      renameSync(from, to)
    }
    const memory = linkMemoryDir(join(projects, cwdToProjectDir(this.cwd), 'memory'), join(toDir, 'memory'))
    this.cwd = newCwd
    return { ok: true, memory }
  }

  /** Change WHERE this session's process runs, keeping the conversation.
   *
   *  Mechanically a hibernation: the live process is put down and the next
   *  message respawns with `--resume` — on the other machine. The caller
   *  (forge/move.ts) must already have put the transcript and the worktree
   *  there; this only flips the switch, and only for an idle session. */
  applyPlacement(placement: 'local' | 'forge', devPort: number | null): { ok: boolean; error?: string } {
    if (this.placement === placement) return { ok: false, error: 'already there' }
    if (this.endedByUser || this.status === 'ended') return { ok: false, error: 'session has ended' }
    if (!this.claudeSessionId) return { ok: false, error: 'session has no claudeSessionId yet' }
    if (this.status === 'running' || this.approvalPending) return { ok: false, error: 'session is mid-turn — wait for it to go idle' }
    if (this.processAlive && this.process) {
      this.hibernating = true
      this.stdinReady = false
      this.process.kill('SIGKILL')
    }
    this.placement = placement
    this.devPort = devPort
    return { ok: true }
  }

  /** Run `fn` once, when the current turn finishes. Used by a mid-turn
   *  `forge move`: the turn's own output has to land before anything reads the
   *  transcript or the working tree. Replaces any earlier pending callback —
   *  two moves queued at once would race each other. */
  afterTurn(fn: () => void): void {
    this.afterTurnHook = fn
  }

  private afterTurnHook: (() => void) | null = null

  /** Spawn a session created with `deferSpawn`, now that its placement is
   *  known, and deliver whatever was buffered for it meanwhile. Returns false
   *  if there was nothing deferred or the session has since been ended. */
  startDeferred(opts: { placement: 'local' | 'forge'; devPort?: number | null } = { placement: 'local' }): boolean {
    const options = this.deferredSpawn
    if (!options) return false
    if (this.status === 'ended' || this.endedByUser) { this.deferredSpawn = null; return false }
    this.deferredSpawn = null
    this.placement = opts.placement
    this.devPort = opts.devPort ?? null
    this.spawn(options)
    const pending = this.pendingWakeMessage
    this.pendingWakeMessage = null
    if (pending) this.sendMessage(pending.content, pending.images)
    else if (!options.silent && options.prompt) this.sendMessage(options.prompt, options.images)
    return true
  }

  /** True while this session exists but has no process, awaiting startDeferred. */
  get awaitingSpawn(): boolean {
    return this.deferredSpawn !== null
  }

  /** Re-spawn a hibernated session with --resume (history preserved, no
   *  system-prompt re-append — spawn() only appends on fresh starts). */
  private wakeFromHibernation() {
    this.hibernated = false
    this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId!, silent: true, name: this.name }, { wake: true })
  }

  /** Set by terminateForShutdown(): the exit handler must not reinterpret
   *  the death as a session end or a reason to respawn. */
  private shuttingDown = false

  /** Hub shutdown: SIGTERM the subprocess WITHOUT changing session state (the
   *  manifest keeps status/wasRunning as they were, so the next hub resumes
   *  it). Returns the pid so the caller can wait and SIGKILL a survivor —
   *  a child left alive reparents to init as a live twin of the resumed one. */
  /** Freeze session state for an imminent shutdown WITHOUT killing anything —
   *  called for every session before the manifest is written, so a child that
   *  dies during the save (pm2's treekill SIGINTs the children too) can't flip
   *  `status` to 'ended' underneath it. */
  markShuttingDown(): void {
    this.shuttingDown = true
  }

  terminateForShutdown(): number | null {
    this.shuttingDown = true
    if (this.transientResumeTimer) { clearTimeout(this.transientResumeTimer); this.transientResumeTimer = null }
    if (this.forgeSshRetryTimer) { clearTimeout(this.forgeSshRetryTimer); this.forgeSshRetryTimer = null }
    if (!this.process || !this.processAlive) return null
    const pid = this.process.pid ?? null
    this.process.kill('SIGTERM')
    return pid
  }

  /** Kill the session */
  kill() {
    if (this.transientResumeTimer) { clearTimeout(this.transientResumeTimer); this.transientResumeTimer = null }
    if (this.forgeSshRetryTimer) { clearTimeout(this.forgeSshRetryTimer); this.forgeSshRetryTimer = null }
    this.forgeSshRetryPending = null

    this.endedByUser = true
    // Mark ended unconditionally — not only when a live process exists. If the
    // subprocess had already exited, the old guard left status untouched (e.g.
    // 'running'), so a killed fork could linger as running in the list.
    this.status = 'ended'
    this.stdinReady = false
    // An explicit end supersedes hibernation state (whatever its phase).
    this.hibernating = false
    this.hibernated = false
    this.pendingWakeMessage = null
    if (this.queuedMessage) this.setQueuedMessage(null)
    this.todoWatcher?.()
    this.todoWatcher = null
    this.todoWatchedCsid = null
    if (this.process) {
      const proc = this.process
      proc.kill('SIGTERM')
      // The CLI can sit on SIGTERM mid-tool-call; an ended session must not
      // keep a live process (it would be a twin of nothing, still writing).
      const t = setTimeout(() => { if (this.processAlive && this.process === proc) proc.kill('SIGKILL') }, KILL_ESCALATE_MS)
      t.unref?.()
    }
  }

  /** Emit a `model_failure` once per spawn so the hub can fall back to the next
   *  model in the chain. Skipped for user-ended sessions and during a model
   *  restart (the new spawn hasn't failed yet). */
  private signalModelFailure(reason: string) {
    if (this.modelFailureSignaled || this.endedByUser || this.restartingForModel) return
    this.modelFailureSignaled = true
    this.emit('model_failure', this.spawnedModel, reason)
  }

  /** Restart this session onto whatever model the resolver now returns. Driven
   *  by the hub after a fallback / manual model switch. Kills the current
   *  subprocess; the exit handler does the actual re-spawn (mirrors the
   *  interrupt-resume path). No-op once the per-session restart cap is hit. */
  restartForModelChange() {
    if (this.endedByUser) return
    // Hibernated sessions have no process to move — they resolve the (new)
    // model at wake time. Respawning here would wake the whole fleet.
    if (this.hibernated || this.hibernating) return
    if (this.restartingForModel) return // a restart is already in flight
    if (this.modelRestarts >= MAX_MODEL_RESTARTS) {
      this.emitHub({ type: 'error', sessionId: this.id, message: `Model fallback gave up after ${MAX_MODEL_RESTARTS} restarts — set a working model.` })
      return
    }
    this.modelRestarts++
    if (this.process && this.processAlive) {
      // Alive — kill it; the exit handler does the re-spawn on the new model.
      // A turn in flight dies with the process and a silent --resume would
      // leave it half-done forever (the hub-restart path has the same nudge).
      // Queued, so it is delivered once the respawn is idle — never mid-turn.
      if (this.status === 'running' && !this.transientResumeTimer) {
        this.queuedMessage = this.queuedMessage
          ? `${this.queuedMessage}\n\n${MODEL_RESTART_NUDGE}`
          : MODEL_RESTART_NUDGE
        this.emitQueued()
      }
      this.restartingForModel = true
      this.process.kill('SIGKILL')
    } else {
      // Already dead (e.g. failed before init) — re-spawn directly. Killing a
      // dead process would never fire `exit`, so the exit-driven path can't run.
      this.doModelRespawn()
    }
  }

  /** Re-spawn this session's subprocess, resuming the same Claude conversation
   *  (history + original system prompt preserved). Recovers a stuck/dead
   *  session — or revives a user-killed one — without bouncing the hub. For Al,
   *  the hub routes to `reloadAlSession()` instead, which re-derives the persona
   *  via a genuinely fresh spawn (a resume keeps the OLD `--append-system-prompt`). */
  reload() {
    this.endedByUser = false
    this.modelRestarts = 0
    if (this.process && this.processAlive) {
      this.reloading = true
      this.process.kill('SIGKILL') // exit handler does the re-spawn
    } else {
      this.doModelRespawn()
    }
  }

  /** Re-spawn after a model change. Resumes silently when we have a
   *  claudeSessionId (history preserved); otherwise re-runs the initial prompt
   *  fresh on the new model (the prior attempt never produced a session). */
  private doModelRespawn() {
    this.modelFailureSignaled = false
    this.gotSystemInit = false
    this.status = 'idle'
    if (this.claudeSessionId) {
      this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId, silent: true, name: this.name })
      // The resume is silent — deliver whatever was parked for the end of
      // the turn the kill cut short (incl. the restart nudge, if any).
      this.flushQueuedMessage()
    } else {
      this.spawn({ prompt: this.initialPrompt, cwd: this.cwd, name: this.name })
      if (this.initialPrompt) this.sendMessage(this.initialPrompt)
    }
  }

  /** Get session info for listing */
  getInfo(): SessionInfo {
    // Served from the shared per-cwd snapshot (git-status.ts) — never a
    // blocking shell-out; the SPA calls this for every session every 10 s.
    // The snapshot describes the code checkout INSIDE a vault project dir
    // when there is one (`repo` link or any child repository), else the cwd.
    const git = gitStatusSync(this.cwd)
    return {
      id: this.id,
      claudeSessionId: this.claudeSessionId,
      name: this.name,
      parentClaudeSessionId: this.parentClaudeSessionId,
      forkContext: this.forkContext,
      agentKey: this.agentKey,
      project: this.project,
      areas: this.areas,
      status: this.status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      prompt: this.initialPrompt,
      cwd: this.cwd,
      totalCost: this.totalCost,
      totalTokens: { ...this.totalTokens },
      modelOverride: this.modelOverride,
      cacheTtl: this.processAlive && this.cacheTtl ? this.cacheTtl : undefined,
      cacheTtlReason: this.processAlive && this.cacheTtlReason ? this.cacheTtlReason : undefined,
      spawnKind: this.spawnKind === 'default' ? undefined : this.spawnKind,
      // Where this session runs, so a hub restart resumes it on the same box —
      // its transcript and worktree live there. The restore path re-runs the
      // forge preconditions and downgrades to local if the box is unreachable.
      placement: this.placement === 'local' ? undefined : this.placement,
      devPort: this.devPort ?? undefined,
      effort: this.processAlive && this.effort ? this.effort : undefined,
      effortReason: this.processAlive && this.effortReason ? this.effortReason : undefined,
      compactWindow: this.processAlive && this.compactWindow ? this.compactWindow : undefined,
      messageLogLength: this.messageLogLength,
      lastReadIndex: this.readPinned ? this.messageLogLength : getLastReadIndex(this.claudeSessionId),
      readPinned: this.readPinned || undefined,
      hibernated: this.hibernated || undefined,
      backgroundProcessCount: getChildCountSync(this.process?.pid),
      needsAttention: this.needsAttention,
      authFailure: this.authFailure ?? undefined,
      lastTextSnippet: this.lastTextSnippet,
      queuedMessage: this.queuedMessage,
      todos: this.visibleTodos().length ? this.visibleTodos() : undefined,
      gitBranch: git.branch,
      gitRepo: git.repo,
      gitDirty: git.dirty,
      gitStats: git.stats,
    }
  }

  // --------------------------------------------------------------------------
  // Claude message handling
  // --------------------------------------------------------------------------

  private handleClaudeMessage(msg: ClaudeStdoutMessage) {
    switch (msg.type) {
      case 'system': {
        // Non-init lifecycle subtypes (status, task_*, compact_boundary) — the
        // init-only bookkeeping below must NOT run for these.
        if (msg.subtype !== 'init') {
          this.handleSystemLifecycle(msg)
          break
        }
        // A pre-set csid that differs from what the CLI minted means this live
        // session was re-keyed: a pruned-transcript fresh respawn, or a CLI that
        // ignored a fork's `--session-id` pin (log it — the pin is load-bearing
        // for identity). Un-pinned fresh spawns never pre-set, so they can't trip this.
        const prevCsid = this.claudeSessionId
        const rekeyedFrom = prevCsid && prevCsid !== msg.session_id ? prevCsid : undefined
        if (rekeyedFrom && rekeyedFrom === this.forkPin) {
          this.emitHub({ type: 'status', sessionId: this.id, text: `csid pin ignored by the CLI: pinned ${rekeyedFrom}, got ${msg.session_id}` })
        }
        this.claudeSessionId = msg.session_id
        // Binds the todo watcher to the confirmed csid (idempotent when the
        // pre-set id — resume target or fork pin — matches).
        this.bindTodoWatcher()
        // Subprocess started cleanly — clear model-failure bookkeeping so a
        // later (different) model death can still trip a fresh fallback.
        this.gotSystemInit = true
        this.modelFailureSignaled = false
        this.modelRestarts = 0
        this.forgeSshRetries = 0
        const { displayName, contextWindow } = parseModelString(msg.model)
        this.contextWindow = contextWindow
        this.emitHub({
          type: 'session_init',
          sessionId: this.id,
          claudeSessionId: msg.session_id,
          model: displayName,
          slashCommands: msg.slash_commands ?? [],
          contextWindow,
          permissionMode: msg.permissionMode,
          ...(rekeyedFrom ? { rekeyedFrom } : {}),
        })
        break
      }

      case 'assistant': {
        // Synthetic assistant messages (`model: "<synthetic>"`) come from the
        // CLI itself, not from the model. Two flavours:
        //   1. `isApiErrorMessage: true` — Usage Policy blocks, rate-limit
        //      kicks, etc. Render as error.
        //   2. Slash commands like /context, /usage, /help — markdown content
        //      (tables, headings). Render as plain text.
        // Both flavours arrive with NO preceding stream_event partials, so
        // handleAssistantMessage's text-block skip would drop them silently.
        // We emit text/error explicitly here based on the flag.
        const anyMsg = msg as unknown as { isApiErrorMessage?: boolean; is_api_error_message?: boolean; error?: string; message: { model?: string } }
        const isSynthetic = anyMsg.message?.model === '<synthetic>'
        // A real answer from the model is the only proof the login works again.
        if (!isSynthetic && this.authFailure) {
          this.authFailure = null
          this.emit('auth_recovered')
        }
        if (isSynthetic) {
          const text = msg.message.content
            .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
          if (text) {
            // The CLI's stream-json flag is `is_api_error_message` (snake_case)
            // as of 2.1.220 — the camelCase form is the on-disk JSONL shape and
            // matched NOTHING on the wire, so the whole error branch (incl.
            // transient auto-resume) silently dead-ended and 503s/timeouts left
            // sessions halted. Accept both, plus a text-prefix fallback so the
            // next field rename can't kill auto-resume silently again.
            const isApiError = anyMsg.isApiErrorMessage || anyMsg.is_api_error_message
              || anyMsg.error != null || /^API Error/i.test(text)
            if (isApiError) {
              // "Not logged in · Please run /login" is not an answer. Until
              // 9 Oct 2026 it was treated as one: 21 forge forks spent their
              // instructions into it and sat idle for 40 minutes unseen.
              if (isAuthFailure(anyMsg.error, text)) {
                this.authFailure = { at: this.authFailure?.at ?? Date.now(), detail: text.slice(0, 200), count: (this.authFailure?.count ?? 0) + 1 }
                this.emit('auth_failed', this.authFailure.detail, this.authFailure.count)
              }
              // A subscription quota exhaustion worded as an API error (the
              // structured rate_limit_event usually precedes it; this is the
              // belt to that brace). The turn is also a transient failure —
              // the Continue nudge below lands on Bedrock after the failover.
              if (isUsageLimitError(text)) {
                this.emit('rate_limit', { status: 'rejected', rateLimitType: usageLimitTypeOf(text) } satisfies ClaudeRateLimitInfo, text.slice(0, 200))
              }
              if (isTransientApiError(text) || isUsageLimitError(text)) {
                // 429/503/overloaded: the turn died but the session is fine.
                // Schedule a backoff "Continue." nudge instead of sitting
                // idle until someone notices (auto-resume, like hub restarts).
                this.scheduleTransientResume(text)
                // ...unless 503s keep landing on this one model fleet-wide,
                // which is a model outage wearing a transient's clothes —
                // hand it to the chain-advance path (2026-09-17 fable-5-1).
                if (isUpstreamOutageError(text)) {
                  const outage = upstreamOutages.recordFailure(this.spawnedModel)
                  if (outage) this.signalModelFailure(`upstream outage: ${outage} (last: ${text.slice(0, 120)})`)
                }
              } else if (looksLikeModelError(text)) {
                this.signalModelFailure(`api error: ${text.slice(0, 200)}`)
              }
              this.emitHub({ type: 'error', sessionId: this.id, message: text })
            } else {
              this.emitHub({ type: 'text', sessionId: this.id, content: text })
            }
          }
        }
        this.handleAssistantMessage(msg.message.content, msg.parent_tool_use_id)
        break
      }

      case 'user':
        this.handleUserMessage(msg.message.content)
        this.handleToolUseResult(msg)
        break

      case 'result':
        this.handleResultMessage(msg)
        break

      case 'control_response':
        this.handleControlResponse(msg)
        break

      case 'control_request': {
        // Claude CLI nests fields under `request` with `request_id` at top level
        const req = (msg as any).request ?? msg
        const requestId = (msg as any).request_id ?? (msg as any).id
        const subtype = req.subtype ?? msg.subtype
        const toolName = req.tool_name ?? msg.tool_name
        const input = req.input ?? msg.input ?? {}

        if (subtype === 'can_use_tool') {
          if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
            // These tools need user input/approval — forward to frontend.
            // Blocks hibernation: killing the process now would orphan the
            // pending control_request and the answer could never be delivered.
            this.approvalPending = true
            this.pendingApprovalRequest = { requestId, toolName }
            this.emitHub({
              type: 'approval_required',
              sessionId: this.id,
              requestId,
              toolName,
              input,
            })
            // A pending question IS "this session wants Yousef" — raise the
            // same red marker @amar sets so it can't be missed in the sidebar.
            // push:false — approval_required already fires its own phone push.
            // Cleared on approve/deny (answering is the acknowledgement).
            const q = (input as any)?.questions?.[0]?.question ?? (input as any)?.question
            this.flagAttention(
              typeof q === 'string' && q ? q :
                toolName === 'ExitPlanMode' ? 'Plan ready for review' : 'Question for you',
              false,
            )
          } else {
            // Auto-approve all other tools (replaces --dangerously-skip-permissions)
            this.approveTool(requestId)
          }
        }
        break
      }

      case 'stream_event':
        this.handleStreamEvent(msg)
        break

      // Subscription (Claude Max) rate-limit headers changed. `rejected` =
      // the 5h/weekly window is exhausted and every turn will fail until
      // resetsAt — the hub fails the fleet over to Bedrock (backend-failover.ts).
      // Bedrock sessions never emit this (no such headers on that route).
      case 'rate_limit_event':
        if (msg.rate_limit_info && typeof msg.rate_limit_info === 'object') {
          this.emit('rate_limit', msg.rate_limit_info satisfies ClaudeRateLimitInfo)
        }
        break
    }
  }

  private handleAssistantMessage(content: ClaudeContentBlock[], _parentToolUseId?: string) {
    for (const block of content) {
      switch (block.type) {
        case 'text':
          // Skip — already streamed via text_delta events (--include-partial-messages)
          break

        case 'thinking':
          // Skip — already streamed via thinking_delta events
          break

        case 'tool_use':
          this.emitHub({
            type: 'tool_use',
            sessionId: this.id,
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
          })
          // Auto-derive status from tool name
          this.emitHub({
            type: 'status',
            sessionId: this.id,
            text: describeToolUse(block.name, block.input),
          })
          break
      }
    }
  }

  private handleUserMessage(content: ClaudeContentBlock[]) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text).join('\n')
            : String(block.content)

        this.emitHub({
          type: 'tool_result',
          sessionId: this.id,
          toolUseId: block.tool_use_id,
          content: resultContent,
          isError: block.is_error ?? false,
        })
      }
    }
  }

  private handleResultMessage(msg: ClaudeStdoutMessage & { type: 'result' }) {
    // A completed turn = the API is healthy; reset auto-resume backoff.
    this.transientResumeAttempt = 0
    this.status = 'idle'
    // Only a FINISHED turn clears the mid-turn bit. pm2's treekill SIGINTs the
    // claude child, which emits `result/error_during_execution is_error=true`
    // and exits 0 (measured 2026-09-07) — that result reached here first and
    // cleared midTurn, so every mid-turn session was saved wasRunning=false
    // and came back without its "continue" nudge (^neat-wren). A user
    // interrupt() clears the bit itself before sending SIGINT.
    if (!msg.is_error && !msg.subtype.startsWith('error')) {
      this.midTurn = false
      upstreamOutages.recordSuccess(this.spawnedModel)
    }
    this.lastActivityAt = Date.now()
    this.turnCount++
    // A remote session writes its transcript on forge. Pull it home at every
    // turn end — the only precise signal for "the file is consistent right
    // now" — or `con agent search` / `con agent read` and the recall index
    // would be blind to every remote fork. Fire-and-forget: a failed sync
    // costs searchability, never the turn.
    if (this.placement === 'forge' && this.claudeSessionId) {
      const cfg = forgeConfig()
      if (cfg) void syncTranscript(cfg, this.cwd, this.claudeSessionId, (m) => this.emitHub({ type: 'status', sessionId: this.id, text: m }))
      noteForgeUse()
    }
    // A `forge move` that arrived mid-turn applies here, now that the turn's
    // own output is on disk.
    if (this.afterTurnHook) {
      const fn = this.afterTurnHook
      this.afterTurnHook = null
      try { fn() } catch { /* a move failure is reported by the mover itself */ }
    }
    // total_cost_usd is cumulative for THIS process, not per-turn — add the
    // cost of the processes before it (costBase) for a session total.
    this.totalCost = this.costBase + msg.total_cost_usd
    this.totalTokens.input += msg.usage.input_tokens
    this.totalTokens.output += msg.usage.output_tokens
    if (msg.usage.cache_read_input_tokens) {
      this.totalTokens.cacheRead = (this.totalTokens.cacheRead ?? 0) + msg.usage.cache_read_input_tokens
    }
    if (msg.usage.cache_creation_input_tokens) {
      this.totalTokens.cacheCreation = (this.totalTokens.cacheCreation ?? 0) + msg.usage.cache_creation_input_tokens
    }
    cacheTtlHooks().onUsage?.(msg.usage)

    // Per-model breakdown (modelUsage keys are model ids incl. Bedrock ARNs).
    const modelUsage = msg.modelUsage
      ? Object.entries(msg.modelUsage).map(([model, u]) => ({
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          costUSD: u.costUSD,
        }))
      : undefined

    this.emitHub({
      type: 'result',
      sessionId: this.id,
      cost: msg.total_cost_usd,
      tokens: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens,
        cacheCreation: msg.usage.cache_creation_input_tokens,
      },
      duration: msg.duration_ms,
      sessionIdClaude: msg.session_id,
      ttftMs: msg.ttft_ms,
      stopReason: msg.stop_reason,
      numTurns: msg.num_turns,
      modelUsage,
    })

    // Rough context estimate for immediate UI feedback. input_tokens EXCLUDES
    // cache reads, so after turn 1 this badly under-reports — the accurate
    // number comes from the async get_context_usage control request below,
    // which supersedes this within ~a second.
    // A turn's cumulative usage can exceed the window (it sums every API call
    // in the turn) — clamp so the meter never shows "391k / 200k".
    const used = Math.min(
      msg.usage.input_tokens
        + (msg.usage.cache_read_input_tokens ?? 0)
        + (msg.usage.cache_creation_input_tokens ?? 0)
        + msg.usage.output_tokens,
      this.contextWindow,
    )
    this.emitHub({
      type: 'context_update',
      sessionId: this.id,
      used,
      total: this.contextWindow,
    })

    // Ask the CLI for the authoritative, categorized context usage (system
    // prompt / tools / messages / free space). Response handled in
    // handleControlResponse → a second, accurate context_update.
    this.requestContextUsage()

    // The turn is FULLY done — now (and only now) deliver anything queued.
    this.flushQueuedMessage()
  }

  private handleStreamEvent(msg: ClaudeStdoutMessage & { type: 'stream_event' }) {
    const event = msg.event
    if (event.type === 'content_block_start' && event.content_block) {
      // Remember which tool call each block index belongs to so the
      // input_json_delta stream below can be attributed.
      if (event.content_block.type === 'tool_use' && event.content_block.id && event.index !== undefined) {
        const toolName = event.content_block.name ?? 'tool'
        this.streamingToolBlocks.set(event.index, { toolUseId: event.content_block.id, toolName })
        this.emitHub({ type: 'tool_use_start', sessionId: this.id, toolUseId: event.content_block.id, toolName })
      }
      return
    }
    if (event.type === 'content_block_stop' && event.index !== undefined) {
      this.streamingToolBlocks.delete(event.index)
      return
    }
    if (event.type === 'content_block_delta' && event.delta) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        this.emitHub({
          type: 'text_delta',
          sessionId: this.id,
          content: event.delta.text,
        })
      } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        this.emitHub({
          type: 'thinking_delta',
          sessionId: this.id,
          content: event.delta.thinking,
        })
      } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
        // Tool arguments streaming in — forward so the UI can render an
        // Edit/Write being typed live. Ephemeral (not logged/replayed).
        const blk = event.index !== undefined ? this.streamingToolBlocks.get(event.index) : undefined
        if (blk) {
          this.emitHub({
            type: 'tool_input_delta',
            sessionId: this.id,
            toolUseId: blk.toolUseId,
            toolName: blk.toolName,
            content: event.delta.partial_json,
          })
        }
      }
    }
  }

  // ---- rich-protocol handlers (task lifecycle, diffs, control responses) ----

  /** Block index → tool identity for attributing input_json_delta streams. */
  private streamingToolBlocks = new Map<number, { toolUseId: string; toolName: string }>()

  /** Monotonic id for control requests we initiate (get_context_usage, set_model). */
  private controlSeq = 0
  /** In-flight control requests awaiting a control_response, by request_id. */
  private pendingControl = new Map<string, { verb: string; resolve: (r: { ok: boolean; response?: Record<string, unknown>; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>()

  /** Non-init system lifecycle events: model-request status, background-task
   *  (bash/subagent) lifecycle, compaction boundaries. */
  private handleSystemLifecycle(msg: ClaudeStdoutMessage & { type: 'system' }) {
    switch (msg.subtype) {
      case 'status':
        // 'requesting' = a model request just started — surface as a live
        // status so the UI spinner is grounded in reality.
        if (msg.status === 'requesting') {
          this.emitHub({ type: 'status', sessionId: this.id, text: 'Waiting for model…' })
        }
        break
      case 'task_started':
        if (msg.task_id) {
          this.emitHub({
            type: 'bg_task',
            sessionId: this.id,
            taskId: msg.task_id,
            toolUseId: msg.tool_use_id,
            status: 'started',
            description: msg.description,
            taskType: msg.task_type,
          })
        }
        break
      case 'task_notification':
        if (msg.task_id) {
          const raw = (msg as unknown as { status?: string }).status
          this.emitHub({
            type: 'bg_task',
            sessionId: this.id,
            taskId: msg.task_id,
            toolUseId: msg.tool_use_id,
            status: raw === 'failed' ? 'failed' : 'completed',
            summary: msg.summary,
          })
        }
        break
      // task_updated carries incremental patches (e.g. status/end_time) — the
      // completion signal we care about arrives via task_notification, skip.
      case 'compact_boundary':
        this.emitHub({ type: 'status', sessionId: this.id, text: 'Context compacted' })
        this.noteCompaction()
        break
      // CLI ≥2.1.263: the model refused a turn and the CLI retried it on a
      // FALLBACK model (`direction` retry|revert|sticky; `scope` 'session' =
      // the session's model is now swapped, 'local' = one subagent response).
      // Surface it — a silently swapped model breaks attribution and the meter.
      case 'model_refusal_fallback': {
        const m = msg as unknown as { content?: string; direction?: string; scope?: string; fallback_model?: string }
        const text = `Model refusal → fallback${m.fallback_model ? ` to ${m.fallback_model}` : ''}${m.direction ? ` (${m.direction}${m.scope ? `, ${m.scope}` : ''})` : ''}${m.content ? `: ${m.content}` : ''}`
        console.log(`[session] ${this.id}: ${text.slice(0, 400)}`)
        this.emitHub({ type: 'status', sessionId: this.id, text: text.slice(0, 300) })
        break
      }
      // CLI ≥2.1.263 stream events with nothing for the hub: thinking_tokens
      // (per-delta token estimate, high volume), background_tasks_changed
      // (we track tasks via task_started/task_notification), vcs_state_changed
      // (the git chip reads the repo itself).
      case 'thinking_tokens':
      case 'background_tasks_changed':
      case 'vcs_state_changed':
      case 'task_updated':
        break
      default:
        if (!Session.unknownSystemSubtypes.has(msg.subtype)) {
          Session.unknownSystemSubtypes.add(msg.subtype)
          console.log(`[session] unhandled system subtype from the CLI: ${msg.subtype} (first seen on ${this.id}) — new CLI stream event? payload: ${JSON.stringify(msg).slice(0, 300)}`)
        }
    }
  }

  /** Process-wide, so a new CLI event is logged once per hub boot, not per session. */
  private static readonly unknownSystemSubtypes = new Set<string>()

  /**
   *  A capped session that compacts every other turn pays a full cold cache
   *  write each time and makes no progress, which costs several times what the
   *  cap saves (console/android, 8 Oct 2026: $62 for 27 compactions and
   *  nothing done). Treat repeated compaction as the window being too small
   *  for this directory's instruction bundle and hand the cwd back to the CLI
   *  default — it applies at the next spawn, so the current process still
   *  finishes its turn.
   */
  private noteCompaction() {
    const now = Date.now()
    this.compactStamps = [...this.compactStamps.filter((t) => now - t < THRASH_WINDOW_MS), now]
    const window = this.compactWindow
    if (!window || !isThrashing(this.compactStamps, now)) return
    if (liftCompactWindow(this.cwd)) {
      compactWindowHooks().onThrash?.(this.cwd, window, this.compactStamps.length, this.name ?? this.id)
    }
  }

  /** Mine the CLI's rich tool_use_result for Edit/Write structuredPatch — the
   *  same ready-made unified diff the terminal renders. */
  private handleToolUseResult(msg: ClaudeStdoutMessage & { type: 'user' }) {
    const r = msg.tool_use_result
    if (!r || !Array.isArray(r.structuredPatch) || r.structuredPatch.length === 0 || !r.filePath) return
    // Pair the diff to its tool call: the same user message carries the
    // tool_result block with the tool_use_id.
    const toolResultBlock = msg.message.content.find((b) => b.type === 'tool_result') as { tool_use_id?: string } | undefined
    if (!toolResultBlock?.tool_use_id) return
    this.emitHub({
      type: 'tool_diff',
      sessionId: this.id,
      toolUseId: toolResultBlock.tool_use_id,
      filePath: r.filePath,
      hunks: r.structuredPatch,
    })
  }

  /** Send a control_request to the CLI and await its control_response. */
  private sendControlRequest(verb: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<{ ok: boolean; response?: Record<string, unknown>; error?: string }> {
    return new Promise((resolve) => {
      if (!this.process || !this.processAlive || !this.stdinReady) {
        resolve({ ok: false, error: 'process not available' })
        return
      }
      const requestId = `hub_${++this.controlSeq}_${Date.now()}`
      const timer = setTimeout(() => {
        if (this.pendingControl.delete(requestId)) resolve({ ok: false, error: 'control request timeout' })
      }, timeoutMs)
      this.pendingControl.set(requestId, { verb, resolve, timer })
      this.writeStdin({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: verb, ...params },
      } as any)
    })
  }

  private handleControlResponse(msg: ClaudeStdoutMessage & { type: 'control_response' }) {
    const r = msg.response
    const pending = this.pendingControl.get(r.request_id)
    if (!pending) return // response to an approval or an unknown/expired request
    this.pendingControl.delete(r.request_id)
    clearTimeout(pending.timer)
    pending.resolve(r.subtype === 'success'
      ? { ok: true, response: r.response }
      : { ok: false, error: r.error ?? 'control request failed' })
  }

  /** Fetch the CLI's authoritative categorized context usage and re-emit an
   *  accurate context_update. Fire-and-forget; failures are silent (the rough
   *  estimate from the result path stays). */
  private requestContextUsage() {
    void this.sendControlRequest('get_context_usage').then((res) => {
      if (!res.ok || !res.response) return
      const resp = res.response as { totalTokens?: number; maxTokens?: number; categories?: Array<{ name: string; tokens: number }> }
      if (typeof resp.totalTokens !== 'number') return
      if (typeof resp.maxTokens === 'number' && resp.maxTokens > 0) this.contextWindow = resp.maxTokens
      this.emitHub({
        type: 'context_update',
        sessionId: this.id,
        used: resp.totalTokens,
        total: this.contextWindow,
        breakdown: (resp.categories ?? [])
          .filter((c) => c.name !== 'Free space' && c.tokens > 0)
          .map((c) => ({ name: c.name, tokens: c.tokens })),
      })
    })
  }

  /** Switch the live subprocess's model in place via the CLI's set_model
   *  control verb — no respawn, context fully preserved. Returns false when
   *  the fast path isn't possible (process dead / not inited / timeout);
   *  caller falls back to restartForModelChange(). */
  async setModelLive(model: string): Promise<boolean> {
    if (!this.process || !this.processAlive || !this.gotSystemInit || this.status === 'ended') return false
    // Same attribution translation as the spawn path — an in-place model switch
    // must not silently drop the session onto an untagged bare id.
    const res = await this.sendControlRequest('set_model', { model: taggedModelId(model) })
    if (!res.ok) return false
    this.spawnedModel = model
    // New model, fresh failure budget — only the respawn path reset this
    // before, so a session moved here in place could never report the NEW
    // model dying.
    this.modelFailureSignaled = false
    const { displayName, contextWindow } = parseModelString(model)
    this.contextWindow = contextWindow
    // Re-announce init-level metadata so clients update the model label.
    // (SPA ignores the empty slashCommands and keeps its current context
    // meter; the follow-up get_context_usage below re-syncs it accurately.)
    this.emitHub({
      type: 'session_init',
      sessionId: this.id,
      claudeSessionId: this.claudeSessionId ?? '',
      model: displayName,
      slashCommands: [],
      contextWindow,
    })
    this.requestContextUsage()
    return true
  }

  /** Pin THIS session to `model` (or clear the pin with null → back to the
   *  hub-wide model) and apply it mid-session: setModelLive fast path first,
   *  kill+respawn fallback (context preserved via --resume). */
  async setSessionModel(model: string | null): Promise<{ ok: boolean; error?: string }> {
    if (this.status === 'ended') return { ok: false, error: 'session has ended' }
    this.modelOverride = model ?? undefined
    const target = model ?? resolveAgentModel()
    if (this.spawnedModel === target) return { ok: true } // already there (e.g. clearing a pin that matched)
    const fast = await this.setModelLive(target)
    if (fast) return { ok: true }
    // Fast path unavailable (dead / pre-init / timeout) — respawn onto the
    // pinned model (spawn() reads modelOverride; resolveAgentModel is the
    // fallback when the pin was cleared).
    this.restartForModelChange()
    return { ok: true }
  }

  /** Log a message that should be replayed to late-joining clients.
   *  Rolls the oldest entry off once at MAX_LOG_SIZE; logOffset accounts for
   *  the absolute index so client pagination keeps working. */
  logMessage(msg: LoggableHubMessage) {
    this.messageLog.push(msg)
    if (this.messageLog.length > this.MAX_LOG_SIZE) {
      this.messageLog.shift()
      this.logOffset++
    }
    // Stamp the absolute index on the object so any subsequent broadcast of
    // it carries authoritative positioning (clients upsert, not append —
    // the transcript-duplication fix). Callers must log BEFORE broadcasting.
    ;(msg as unknown as { absIndex?: number }).absIndex = this.messageLogLength - 1
    this.holdReadIfPinned()
  }

  /** Pinned read (hand-back approved): the session stays read until it is
   *  folded into its parent, whatever its wind-down turn logs. */
  get readPinned(): boolean {
    return isReadPinned(this.claudeSessionId)
  }

  /** While pinned, every logged message advances the read pointer to the end
   *  and tells every client so — clients bump their own message count per
   *  message, so this lands a beat AFTER the message itself is broadcast. */
  private holdReadIfPinned() {
    const key = this.claudeSessionId
    if (!key || !isReadPinned(key)) return
    const len = this.messageLogLength
    setLastReadIndex(key, len)
    setImmediate(() => {
      if (!isReadPinned(key)) return
      this.emit('hub_message', {
        type: 'session_read_state',
        sessionId: this.id,
        lastReadIndex: len,
        messageLogLength: len,
        readPinned: true,
      } satisfies HubMessage)
    })
  }

  /** Absolute message count ever logged (monotonic, equals what would have
   *  been `messageLog.length` without the rolling cap). Indexing semantics
   *  expected by the client. */
  get messageLogLength(): number {
    return this.logOffset + this.messageLog.length
  }

  // Offline-outbox send dedup: last ~50 client dedupeKeys. Checking marks the
  // key as seen, so the FIRST delivery wins and retries drop.
  private readonly seenDedupeKeys: string[] = []
  hasSeenDedupeKey(key: string): boolean {
    if (this.seenDedupeKeys.includes(key)) return true
    this.seenDedupeKeys.push(key)
    if (this.seenDedupeKeys.length > 50) this.seenDedupeKeys.shift()
    return false
  }

  /** Absolute index of `messageLog[0]`. Used by get_older_messages to map
   *  the client's absolute beforeIndex into the in-memory window. */
  get messageLogOffset(): number {
    return this.logOffset
  }

  /** Clear the message log (e.g. after /clear). Resets the offset too —
   *  client indices start over from 0 after this. */
  clearLog() {
    this.messageLog.length = 0
    this.logOffset = 0
  }

  /** Flush accumulated deltas into coalesced log entries */
  private flushPendingDeltas() {
    if (this.pendingThinking) {
      this.logMessage({ type: 'thinking', sessionId: this.id, content: this.pendingThinking })
      this.pendingThinking = ''
    }
    if (this.pendingText) {
      // Scan the *complete* coalesced text — deltas split "@" and "amar" across
      // chunks, so per-delta scanning would miss it.
      this.scanForAttention(this.pendingText)
      this.scanForHandoff(this.pendingText)
      this.noteTextSnippet(this.pendingText)
      this.logMessage({ type: 'text', sessionId: this.id, content: this.pendingText })
      this.pendingText = ''
    }
  }

  /** Last assistant-text opener — the unified Inbox row preview. */
  lastTextSnippet?: string
  private noteTextSnippet(content: string) {
    const line = content.trim().split('\n')[0] ?? ''
    if (line) this.lastTextSnippet = line.length > 140 ? `${line.slice(0, 139)}…` : line
  }

  private emitHub(msg: HubMessage) {
    // Coalesce deltas in the log — don't store individual deltas
    if (msg.type === 'text_delta') {
      this.pendingText += msg.content
    } else if (msg.type === 'thinking_delta') {
      this.pendingThinking += msg.content
    } else {
      // Any non-delta message flushes accumulated deltas first
      if (msg.type === 'tool_use' || msg.type === 'tool_result' || msg.type === 'result'
        || msg.type === 'session_ended' || msg.type === 'approval_required') {
        this.flushPendingDeltas()
      }
      // Directly-emitted text (e.g. synthetic slash-command output) bypasses the
      // delta buffer — scan it too.
      if (msg.type === 'text') { this.scanForAttention(msg.content); this.scanForHandoff(msg.content); this.noteTextSnippet(msg.content) }
      // Log non-ephemeral messages (skip status + all delta streams — including
      // tool_input_delta, which fires per-chunk while tool args stream in and
      // would flood the rolling log — and tool_use_start, which the finalized
      // tool_use supersedes)
      if (msg.type !== 'status' && msg.type !== 'tool_input_delta' && msg.type !== 'tool_use_start') {
        this.logMessage(msg as LoggableHubMessage) // stamps absIndex pre-broadcast
      }
    }
    this.emit('hub_message', msg)
  }

  // --------------------------------------------------------------------------
  // @amar attention mechanism — agents emit `@amar` to pull Yousef's eyes
  // without injecting into his active workflow timeline. See ~/CLAUDE.md.
  // --------------------------------------------------------------------------

  private scanForAttention(content: string) {
    if (!mentionsAmar(content)) return
    this.flagAttention(extractAttentionSnippet(content), true)
  }

  /** Raise the red attention marker. `wantPush:false` for callers whose event
   *  already has its own notification (pending AskUserQuestion/ExitPlanMode). */
  flagAttention(snippet: string, wantPush: boolean) {
    // An approved hand-back is read for good: its wind-down must not pull
    // Yousef back in. No marker, no push.
    if (this.readPinned) return
    const now = Date.now()
    this.needsAttention = { ts: now, snippet }

    // Anti-noise: dedup pushes within 60s; suppress (marker-only) if a session
    // floods ≥5 pushes in 10 min — a misbehaving session per the CLAUDE.md rule.
    this.attentionPushTimes = this.attentionPushTimes.filter((t) => now - t < 10 * 60_000)
    const within60s = now - this.lastAttentionPushAt < 60_000
    const flooding = this.attentionPushTimes.length >= 5
    const push = wantPush && !within60s && !flooding
    if (push) { this.lastAttentionPushAt = now; this.attentionPushTimes.push(now) }
    if (flooding) console.warn(`[attention] session ${this.id} (${this.name ?? '?'}) flooding @amar — suppressing push, keeping marker`)

    this.emit('hub_message', {
      type: 'session_attention',
      sessionId: this.id,
      sessionName: this.name,
      needsAttention: this.needsAttention,
      push,
      // Desktop-notification hint: false when the triggering event already
      // notifies (approval_required does its own) — the marker still sticks.
      notify: wantPush,
    } satisfies HubMessage)
  }

  /** Clear the marker (Yousef opened / marked-read the session). */
  clearAttention() {
    if (!this.needsAttention) return
    this.needsAttention = null
    this.emit('hub_message', {
      type: 'session_attention',
      sessionId: this.id,
      sessionName: this.name,
      needsAttention: null,
    } satisfies HubMessage)
  }

  private lastHandoff = ''
  private lastHandoffAt = 0
  /** Detect `@handoff(<agentKey>)` in finalized assistant text → ask the SPA to
   *  offer Yousef a direct line to that agent. Deduped per-target within 30s so a
   *  sentinel re-scanned across flushes fires once. */
  private scanForHandoff(content: string) {
    const target = parseHandoff(content)
    if (!target) return
    const now = Date.now()
    if (target === this.lastHandoff && now - this.lastHandoffAt < 30_000) return
    this.lastHandoff = target
    this.lastHandoffAt = now
    this.emit('hub_message', {
      type: 'session_handoff',
      sessionId: this.id,
      targetAgentKey: target,
    } satisfies HubMessage)
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Produce a human-readable status string from a tool invocation */
function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `Reading ${input.file_path ?? 'file'}...`
    case 'Write':
      return `Writing ${input.file_path ?? 'file'}...`
    case 'Edit':
      return `Editing ${input.file_path ?? 'file'}...`
    case 'Bash':
      return `Running: ${truncate(String(input.command ?? ''), 60)}`
    case 'Glob':
      return `Searching for ${input.pattern ?? 'files'}...`
    case 'Grep':
      return `Searching for "${truncate(String(input.pattern ?? ''), 40)}"...`
    case 'WebSearch':
      return `Searching: ${truncate(String(input.query ?? ''), 50)}`
    case 'WebFetch':
      return `Fetching ${truncate(String(input.url ?? ''), 50)}...`
    case 'Agent':
      return `Spawning sub-agent: ${truncate(String(input.description ?? ''), 40)}`
    default:
      return `Using ${toolName}...`
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

