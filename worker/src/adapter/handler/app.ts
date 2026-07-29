// HTTP と usecase の橋渡し。
//
// 責務は JSON の変換とエラーのステータスコードへの対応づけに限る。業務判断は
// ここに書かない。金額の妥当性も状態遷移の可否も domain が持ち、usecase が
// それを呼ぶ。

import { Hono } from 'hono'
import type { AccountKind } from '../../domain/account'
import { isWishStatus, type WishCategory } from '../../domain/wish'
import { YearMonth } from '../../domain/yearMonth'
import { badRequest, toErrorResponse } from './errors'
import {
  accountResponse,
  dashboardResponse,
  lendingResponse,
  monthlyBalanceResponse,
  transactionResponse,
  wishResponse,
} from './dto'
import {
  parseUuid,
  readBody,
  readDate,
  readMoney,
  readNullableDate,
  readOptionalInteger,
  readOptionalMoney,
  readOptionalString,
  readString,
  readUuid,
} from './request'
import type { Deps } from './services'

/**
 * 固定トークンによる認証。
 *
 * 単一ユーザーのため、ユーザー管理・パスワード・セッションは持たない。
 * 環境変数のトークンと突き合わせるだけ。
 *
 * 比較を定数時間で行うのは、実行時間からトークンを推測されるのを避けるため。
 * 単一ユーザーの個人アプリで現実的な脅威ではないが、正しい比較を書くコストが
 * ほぼゼロなので、そちらに寄せる。
 *
 * Go 版にあった CORS の考慮は要らない。front と同一オリジンから配信される。
 */
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.byteLength !== right.byteLength) return false
  return crypto.subtle.timingSafeEqual(left, right)
}

/**
 * 経路を組み立てる。
 *
 * 状態遷移は PATCH ではなく専用の経路にする。クライアントが不正な状態を
 * 組み立てられないようにするため。
 */
export function createApp(deps: Deps) {
  const app = new Hono()

  app.onError((err) => {
    const { status, body } = toErrorResponse(err)
    return Response.json(body, { status })
  })

  app.use('/api/*', async (c, next) => {
    if (!constantTimeEquals(c.req.header('Authorization') ?? '', `Bearer ${deps.authToken}`)) {
      return Response.json(
        { error: { code: 'UNAUTHORIZED', message: '認証が必要です' } },
        { status: 401 },
      )
    }
    await next()
  })

  // ---- ダッシュボード ----

  app.get('/api/dashboard', async (c) => {
    return c.json(dashboardResponse(await deps.dashboard.get()))
  })

  // ---- 口座 ----

  app.get('/api/accounts', async (c) => {
    const now = deps.now()
    const accounts = await deps.accounts.list()
    return c.json(accounts.map((a) => accountResponse(a, now)))
  })

  app.post('/api/accounts', async (c) => {
    const body = await readBody(c, ['name', 'kind', 'balance'])
    const a = await deps.accounts.create(
      readString(body, 'name', ''),
      // kind の妥当性は domain が判定する（不正なら 422）。
      // ここで弾くと、同じ判断が2箇所に散る。
      readString(body, 'kind', '') as AccountKind,
      readMoney(body, 'balance', 0),
    )
    return c.json(accountResponse(a, deps.now()), 201)
  })

  // kind を受け取らない。口座種別が変わると、その口座が実質資産の計算から
  // 丸ごと外れる（不変条件1）。未知の項目は 400 になるので、kind を送れば
  // 400 で返る。黙って無視するより、送れないと伝えるほうがよい。
  app.patch('/api/accounts/:id', async (c) => {
    const id = parseUuid(c.req.param('id'), 'id')
    const body = await readBody(c, ['name', 'balance'])
    const a = await deps.accounts.update(id, {
      name: readOptionalString(body, 'name'),
      balance: readOptionalMoney(body, 'balance'),
    })
    return c.json(accountResponse(a, deps.now()))
  })

  app.delete('/api/accounts/:id', async (c) => {
    // 取引履歴が残っていれば ACCOUNT_IN_USE になり 422。
    await deps.accounts.delete(parseUuid(c.req.param('id'), 'id'))
    return c.body(null, 204)
  })

  // ---- 立替 ----

  app.get('/api/lendings', async (c) => {
    // ?outstanding=true で未回収のみ。それ以外の値は全件として扱う。
    const lendings = await deps.lendings.list(c.req.query('outstanding') === 'true')
    return c.json(lendings.map(lendingResponse))
  })

  app.post('/api/lendings', async (c) => {
    const body = await readBody(c, ['counterparty', 'description', 'amount', 'occurredOn', 'accountId'])
    const l = await deps.lendings.create(
      readString(body, 'counterparty', ''),
      readString(body, 'description', ''),
      readMoney(body, 'amount', 0),
      readDate(body, 'occurredOn'),
      readUuid(body, 'accountId'),
    )
    return c.json(lendingResponse(l), 201)
  })

  // 未回収残高を超える額は 422（COLLECT_EXCEEDS_OUTSTANDING）になる。
  app.post('/api/lendings/:id/collect', async (c) => {
    const id = parseUuid(c.req.param('id'), 'id')
    const body = await readBody(c, ['amount', 'occurredOn', 'accountId'])
    const l = await deps.lendings.collect(
      id,
      readMoney(body, 'amount', 0),
      readDate(body, 'occurredOn'),
      readUuid(body, 'accountId'),
    )
    return c.json(lendingResponse(l))
  })

  app.delete('/api/lendings/:id', async (c) => {
    await deps.lendings.delete(parseUuid(c.req.param('id'), 'id'))
    return c.body(null, 204)
  })

  // ---- ウィッシュ ----

  app.get('/api/wishes', async (c) => {
    const raw = c.req.query('status')
    if (raw !== undefined && raw !== '' && !isWishStatus(raw)) {
      // 絞り込みの指定ミスは形式の誤り。存在しない状態で空配列を返すと、
      // 絞り込めているように見えてしまう。
      throw badRequest('INVALID_WISH_STATUS', 'status の指定が不正です')
    }
    const status = raw === undefined || raw === '' ? null : raw
    const wishes = await deps.wishes.list(status)
    return c.json(wishes.map(wishResponse))
  })

  // status は受け取らない。新規は必ず検討中から始まる（不変条件3）。
  app.post('/api/wishes', async (c) => {
    const body = await readBody(c, ['title', 'amount', 'category', 'priority', 'deadline'])
    const deadline = readNullableDate(body, 'deadline')
    const w = await deps.wishes.create(
      readString(body, 'title', ''),
      readMoney(body, 'amount', 0),
      // category の妥当性は domain が判定する（不正なら 422）。
      readString(body, 'category', '') as WishCategory,
      readOptionalInteger(body, 'priority') ?? 0,
      deadline ?? null,
    )
    return c.json(wishResponse(w), 201)
  })

  // status を持たない。状態遷移は /commit /pay /drop の専用経路に限る
  // （不変条件6）。未知の項目は 400 になるので、status を送れば 400 で返る。
  app.patch('/api/wishes/:id', async (c) => {
    const id = parseUuid(c.req.param('id'), 'id')
    const body = await readBody(c, ['title', 'amount', 'category', 'priority', 'deadline'])
    const category = readOptionalString(body, 'category')
    const w = await deps.wishes.updateContent(id, {
      title: readOptionalString(body, 'title'),
      amount: readOptionalMoney(body, 'amount'),
      // 妥当性は domain が判定する（不正なら 422）。
      category: category as WishCategory | undefined,
      priority: readOptionalInteger(body, 'priority'),
      deadline: readNullableDate(body, 'deadline'),
    })
    return c.json(wishResponse(w))
  })

  // 検討中 → 確定。確定した時点で実質資産から控除される。
  app.post('/api/wishes/:id/commit', async (c) => {
    return c.json(wishResponse(await deps.wishes.commit(parseUuid(c.req.param('id'), 'id'))))
  })

  // 確定 → 完了。口座残高が減り、取引履歴が残る。
  // 支払いの前後で実質資産は変わらない。
  app.post('/api/wishes/:id/pay', async (c) => {
    const id = parseUuid(c.req.param('id'), 'id')
    const body = await readBody(c, ['accountId', 'occurredOn'])
    const w = await deps.wishes.pay(id, readUuid(body, 'accountId'), readDate(body, 'occurredOn'))
    return c.json(wishResponse(w))
  })

  // 見送りへ。不正な遷移は 422（INVALID_TRANSITION）。
  app.post('/api/wishes/:id/drop', async (c) => {
    return c.json(wishResponse(await deps.wishes.drop(parseUuid(c.req.param('id'), 'id'))))
  })

  app.delete('/api/wishes/:id', async (c) => {
    await deps.wishes.delete(parseUuid(c.req.param('id'), 'id'))
    return c.body(null, 204)
  })

  // ---- 月次収支 ----

  app.get('/api/monthly-balances', async (c) => {
    const balances = await deps.balances.list()
    return c.json(balances.map(monthlyBalanceResponse))
  })

  /**
   * 月次収支を登録・更新する（冪等）。
   *
   * 経路の {yearMonth} は '2026-07' 形式。形式の誤り（桁数・区切り）は 400、
   * 範囲外（13月など）は 422 に分ける。前者はクライアントの組み立てミス、
   * 後者は値の誤り。
   */
  app.put('/api/monthly-balances/:yearMonth', async (c) => {
    const raw = c.req.param('yearMonth')
    if (!/^\d{4}-\d{2}$/.test(raw)) {
      throw badRequest('INVALID_YEAR_MONTH', '年月は YYYY-MM 形式で指定してください')
    }
    // 形は合っているが値が範囲外。domain のエラーなので 422 になる。
    const yearMonth = YearMonth.parse(raw)

    const body = await readBody(c, ['income', 'expense'])
    const m = await deps.balances.upsert(
      yearMonth,
      readMoney(body, 'income', 0),
      readMoney(body, 'expense', 0),
    )
    return c.json(monthlyBalanceResponse(m))
  })

  // ---- 取引履歴 ----

  app.get('/api/transactions', async (c) => {
    const raw = c.req.query('limit')
    let limit = 0
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw)
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw badRequest('INVALID_LIMIT', 'limit は 0 以上の整数で指定してください')
      }
      limit = parsed
    }
    const transactions = await deps.transactions.list(limit)
    return c.json(transactions.map(transactionResponse))
  })

  app.all('/api/*', (c) => {
    return c.json({ error: { code: 'NOT_FOUND', message: '対象が見つかりません' } }, 404)
  })

  return app
}
