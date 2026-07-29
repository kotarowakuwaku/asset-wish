import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// migrations/ の中身を読み、テスト用の D1 に流し込めるようにする。
// スキーマの定義元を1つに保つための仕掛けで、テスト側に DDL を書き写さない。
const migrations = await readD1Migrations('./migrations')

// テストは workerd の中で走る。Node の API が使えないため、
// domain が Node 依存を持ち込んだ時点でここが落ちる（不変条件5の副次的な効果）。
//
// D1 は miniflare がテストごとに分離したローカルインスタンスを用意する。
// Go 版で必要だったアドバイザリロックによる直列化（internal/dbtest）は不要。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ['worker/**/*.test.ts'],
    setupFiles: ['./worker/test/applyMigrations.ts'],
  },
})
