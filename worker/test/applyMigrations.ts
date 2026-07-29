import { applyD1Migrations, env } from 'cloudflare:test'

// migrations/ の内容をテスト用の D1 に流す。
//
// setup で当てておくと、各テストは分離されたストレージの上で走りつつ
// スキーマだけを共有できる。テストごとの書き込みはテスト終了時に巻き戻る。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
