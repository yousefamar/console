/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// Tailscale HTTPS certs (generated via `sudo tailscale cert <hostname>`)
const tsHost = 'amarhp-lin.rya-yo.ts.net'
const configDir = path.resolve(process.env.HOME || '', '.config/console')
const certPath = path.resolve(configDir, `${tsHost}.crt`)
const keyPath = path.resolve(configDir, `${tsHost}.key`)
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath)

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    // Exclude WASM package from dep optimization — it uses import.meta.url for WASM loading
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  server: {
    host: true,
    allowedHosts: true,
    ...(useHttps && {
      https: {
        cert: certPath,
        key: keyPath,
      },
    }),
    headers: { 'Cache-Control': 'no-store' },
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
