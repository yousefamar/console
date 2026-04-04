import { hubFetch } from '../client.js'
import { output, exitWithError, info, outputLine, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function agent(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return agentList(args, flags)
    case 'create': return agentCreate(args, flags)
    case 'send': return agentSend(args, flags)
    case 'resume': return agentResume(args, flags)
    case 'kill': return agentKill(args, flags)
    case 'interrupt': return agentInterrupt(args, flags)
    case 'approve': return agentApprove(args, flags)
    case 'deny': return agentDeny(args, flags)
    case 'tail': return agentTail(args, flags)
    case 'wait': return agentWait(args, flags)
    default:
      exitWithError('USAGE', `Unknown agent command: ${verb}. Run 'con help agent'.`, flags)
  }
}

async function agentList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)

  // Get active sessions via WebSocket message or health endpoint
  const health = await hubFetch<{ sessions: unknown[] }>('/health')
  let sessions = health.sessions

  if (opts.past) {
    // Connect to WebSocket and request past sessions
    const { sendAndReceive } = await import('../ws-client.js')
    const result = await sendAndReceive(
      { type: 'list_past_sessions', cwd: opts.cwd || process.cwd() },
      (msg: any) => msg.type === 'past_sessions',
    )
    sessions = [...sessions, ...(result?.sessions || [])]
  }

  output(sessions, flags)
}

async function agentCreate(args: string[], flags: GlobalFlags): Promise<void> {
  const prompt = args[0]
  if (!prompt) exitWithError('USAGE', 'Usage: con agent create <prompt> [--cwd <path>] [--wait]', flags)
  const opts = parseFlags(args.slice(1))

  const { sendAndReceive, connectAndStream } = await import('../ws-client.js')

  // Create session
  const result = await sendAndReceive(
    { type: 'create_session', prompt, cwd: opts.cwd || process.cwd() },
    (msg: any) => msg.type === 'session_created',
  )

  if (!result) exitWithError('ERROR', 'Failed to create session', flags)

  const sessionId = result.sessionId

  if (opts.wait === 'true') {
    // Stream until result
    info(`Session ${sessionId} created. Waiting for completion...`)
    await connectAndStream({
      filter: (msg: any) => msg.sessionId === sessionId,
      onMessage: (msg: any) => {
        if (msg.type === 'text' || msg.type === 'text_delta') {
          if (!flags.json) {
            process.stderr.write(msg.content || '')
          }
        }
        if (msg.type === 'result' || msg.type === 'session_ended') {
          output(msg, flags)
          return 'stop'
        }
        if (flags.json) outputLine(msg)
      },
    })
  } else {
    output({ sessionId, status: 'created' }, flags)
  }
}

async function agentSend(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const message = args.slice(1).join(' ')
  if (!sessionId || !message) exitWithError('USAGE', 'Usage: con agent send <session-id> <message>', flags)

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'send_message', sessionId, content: message },
    () => false, // Don't wait for response
  )
  output({ sent: true, sessionId }, flags)
}

async function agentResume(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent resume <session-id> [<prompt>]', flags)
  const opts = parseFlags(args.slice(1))
  const prompt = args[1] && !args[1].startsWith('--') ? args[1] : opts.prompt

  const { sendAndReceive } = await import('../ws-client.js')
  const result = await sendAndReceive(
    { type: 'resume_session', sessionId, prompt, cwd: opts.cwd },
    (msg: any) => msg.type === 'session_created' || msg.type === 'session_init',
  )
  output(result, flags)
}

async function agentKill(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent kill <session-id>', flags)

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'kill_session', sessionId },
    () => false,
  )
  output({ killed: sessionId }, flags)
}

async function agentInterrupt(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent interrupt <session-id>', flags)

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'interrupt', sessionId },
    () => false,
  )
  output({ interrupted: sessionId }, flags)
}

async function agentApprove(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const requestId = args[1]
  if (!sessionId || !requestId) exitWithError('USAGE', 'Usage: con agent approve <session-id> <request-id>', flags)
  const opts = parseFlags(args.slice(2))

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    {
      type: 'approve_tool',
      sessionId,
      requestId,
      modifiedInput: opts.input ? JSON.parse(opts.input) : undefined,
    },
    () => false,
  )
  output({ approved: requestId }, flags)
}

async function agentDeny(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const requestId = args[1]
  if (!sessionId || !requestId) exitWithError('USAGE', 'Usage: con agent deny <session-id> <request-id>', flags)
  const opts = parseFlags(args.slice(2))

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'deny_tool', sessionId, requestId, reason: opts.reason },
    () => false,
  )
  output({ denied: requestId }, flags)
}

async function agentTail(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent tail <session-id>', flags)

  const { connectAndStream } = await import('../ws-client.js')
  await connectAndStream({
    filter: (msg: any) => msg.sessionId === sessionId,
    onMessage: (msg: any) => {
      if (flags.json || flags.agent) {
        outputLine(msg)
      } else {
        // Human-readable streaming
        if (msg.type === 'text_delta') process.stderr.write(msg.content || '')
        else if (msg.type === 'text') process.stderr.write('\n')
        else if (msg.type === 'tool_use') process.stderr.write(`\n[tool] ${msg.toolName}: ${JSON.stringify(msg.input).slice(0, 100)}\n`)
        else if (msg.type === 'result') {
          process.stderr.write(`\n[done] cost=$${msg.cost?.toFixed(4)} tokens=${msg.totalTokens}\n`)
          return 'stop'
        }
        else if (msg.type === 'session_ended') return 'stop'
      }
    },
  })
}

async function agentWait(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent wait <session-id>', flags)

  const { connectAndStream } = await import('../ws-client.js')
  await connectAndStream({
    filter: (msg: any) => msg.sessionId === sessionId && (msg.type === 'result' || msg.type === 'session_ended'),
    onMessage: (msg: any) => {
      output(msg, flags)
      return 'stop'
    },
  })
}
