// Worker のエントリポイント。
//
// /api/* だけがここに来る。それ以外のパスは front/dist の静的アセットが
// 手前で処理する（wrangler.jsonc の assets.run_worker_first を参照）。
//
// 段階5でここに Hono のルート（19経路）を載せる。
export default {
  fetch(): Response {
    return Response.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
