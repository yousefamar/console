/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
    headers: { 'Cache-Control': 'no-store' },
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
