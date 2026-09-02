// Isolated SPA verification from a worktree (see CLAUDE.md → Debugging):
// `npx vite --config vite.verify.config.ts --port 5174` serves THIS tree with a
// Caddy-like /hub proxy to the live hub, authenticating every proxied request
// (HTTP + WS upgrade) with the local cli bearer and stripping Origin (the hub's
// WS Origin allow-list would 401 localhost). Never touches the user's live tab.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ClientRequest } from 'node:http'
import base from './vite.config'
import { mergeConfig } from 'vite'

const token = JSON.parse(readFileSync(`${homedir()}/.config/console/local-tokens.json`, 'utf8')).cli as string
const authenticate = (req: ClientRequest) => {
  req.setHeader('Authorization', `Bearer ${token}`)
  req.removeHeader('cookie')
  req.removeHeader('origin')
}

export default mergeConfig(base, {
  server: {
    proxy: {
      '/hub': {
        target: 'https://127.0.0.1:9877',
        secure: false,
        ws: true,
        rewrite: (p: string) => p.replace(/^\/hub/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', authenticate)
          proxy.on('proxyReqWs', authenticate)
        },
      },
    },
  },
})
