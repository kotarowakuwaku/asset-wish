import { defineConfig, devices } from '@playwright/test'

// このファイルの存在が CI の front ジョブの切り替えスイッチになっている
// （.github/workflows/ci.yml 参照）。移動・改名するときは CI も直すこと。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,

  // CI に .only を持ち込ませない。1件でも残っていれば落とす。
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // html レポーターを自動で開かせない。ループ中にブラウザが立ち上がると邪魔になる。
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // dev サーバーではなく build 済みの成果物を preview で配る。
  // 実際に配信するのはこのビルド結果なので、検証対象を本番と揃える。
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
