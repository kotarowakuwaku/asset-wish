import type { D1Migration } from '@cloudflare/vitest-pool-workers'

// cloudflare:test の env は wrangler types が生成する Cloudflare.Env。
// テスト専用の binding はここで足す。
declare global {
  namespace Cloudflare {
    interface Env {
      // vitest.config.ts の miniflare.bindings で渡している。
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
