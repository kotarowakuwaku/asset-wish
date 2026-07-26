/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ は Playwright の担当。Vitest に拾わせると
    // jsdom 上で Playwright を起動しようとして落ちる。
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
