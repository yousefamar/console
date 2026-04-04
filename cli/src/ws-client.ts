// WebSocket client for streaming agent sessions and chat tails

import WebSocket from 'ws'
import { getHubUrl } from './client.js'

function getWsUrl(): string {
  const httpUrl = getHubUrl()
  return httpUrl.replace(/^http/, 'ws')
}

export async function connectAndStream(opts: {
  filter: (msg: unknown) => boolean
  onMessage: (msg: unknown) => void | 'stop'
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl())

    ws.on('open', () => {
      // Connection established — messages will flow
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (opts.filter(msg)) {
          const result = opts.onMessage(msg)
          if (result === 'stop') {
            ws.close()
            resolve()
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    })

    ws.on('close', () => resolve())
    ws.on('error', (err) => reject(err))
  })
}

export async function sendAndReceive(
  message: unknown,
  matchResponse: (msg: unknown) => boolean,
  timeoutMs = 10000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl())
    let timer: ReturnType<typeof setTimeout>

    ws.on('open', () => {
      ws.send(JSON.stringify(message))

      // If we don't need a response, resolve immediately
      if (matchResponse === (() => false)) {
        setTimeout(() => {
          ws.close()
          resolve(null)
        }, 100)
        return
      }

      timer = setTimeout(() => {
        ws.close()
        resolve(null)
      }, timeoutMs)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (matchResponse(msg)) {
          clearTimeout(timer)
          ws.close()
          resolve(msg)
        }
      } catch {
        // Ignore
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      resolve(null)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
