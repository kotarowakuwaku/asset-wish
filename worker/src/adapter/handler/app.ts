// HTTP と usecase の橋渡し。
//
// 責務は JSON の変換とエラーのステータスコードへの対応づけに限る。業務判断は
// ここに書かない。金額の妥当性も状態遷移の可否も domain が持ち、usecase が
// それを呼ぶ。

import { Hono } from 'hono'
import type { AccountKind } from '../../domain/account'
import type { LoanDirection } from '../../domain/loan'
import { isWishStatus, type WishCategory } from '../../domain/wish'
import { badRequest, toErrorResponse } from './errors'
import {
  accountResponse,
  dashboardResponse,
  loanResponse,
  monthlySummaryResponse,
  recurringEntryResponse,
  transactionResponse,
  wishResponse,
} from './dto'
import {
  parseUuid,
  readBody,
  readDate,
  readInteger,
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

  // ---- 貸し借り ----

  app.get('/api/loans', async (c) => {
    // ?outstanding=true で未精算のみ。それ以外の値は全件として扱う。
    const loans = await deps.loans.list(c.req.query('outstanding') === 'true')
    return c.json(loans.map(loanResponse))
  })

  // accountId を受け取らない。貸し借りは口座残高を動かさない（不変条件4）。
  // 未知の項目は 400 になるので、accountId を送れば 400 で返る。黙って
  // 無視すると「口座を指定したのに残高が変わらない」と読める。
  app.post('/api/loans', async (c) => {
    const body = await readBody(c, [
      'direction',
      'counterparty',
      'description',
      'amount',
      'occurredOn',
    ])
    const l = await deps.loans.create(
      // direction の妥当性は domain が判定する（不正なら 422）。
      // ここで弾くと、同じ判断が2箇所に散る。
      readString(body, 'direction', '') as LoanDirection,
      readString(body, 'counterparty', ''),
      readString(body, 'description', ''),
      readMoney(body, 'amount', 0),
      readDate(body, 'occurredOn'),
    )
    return c.json(loanResponse(l), 201)
  })

  /**
   * 精算を記録する。貸した側では回収、借りた側では返済にあたる。
   *
   * **向きごとに経路を分けない。** domain の処理はどちらも「未精算残高が減る」
   * だけで同じなので、分けると同じ手順が2本に増える。さらに「lent に /repay を
   * 投げたら 422 か？」という判定が新たに必要になる。
   *
   * 未精算残高を超える額は 422（SETTLE_EXCEEDS_OUTSTANDING）になる。
   * occurredOn は受け取らない。口座を触らないので取引履歴が作られず、
   * 精算日を残す先が無い。
   */
  app.post('/api/loans/:id/settle', async (c) => {
    const id = parseUuid(c.req.param('id'), 'id')
    const body = await readBody(c, ['amount'])
    const l = await deps.loans.settle(id, readMoney(body, 'amount', 0))
    return c.json(loanResponse(l))
  })

  app.delete('/api/loans/:id', async (c) => {
    await deps.loans.delete(parseUuid(c.req.param('id'), 'id'))
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

  // ---- 定期入出金 ----

  app.get('/api/recurring-entries', async (c) => {
    const entries = await deps.recurring.list()
    return c.json(entries.map(recurringEntryResponse))
  })

  /**
   * 定期入出金を登録する。**この時点では口座を触らない。**
   *
   * amount は符号付き。給料は正、家賃は負。入出金の明細と同じ約束にしてある。
   * 適用の起点は登録した月で、当月の適用日をすでに過ぎていれば次の適用で
   * 当月分が入る。0 と範囲外の適用日は 422（domain の判定）。
   *
   * appliedThrough は受け取らない。適用の記録はサーバーが持つもので、
   * クライアントから動かせると二重適用の防止が成り立たなくなる。
   */
  app.post('/api/recurring-entries', async (c) => {
    const body = await readBody(c, ['name', 'accountId', 'amount', 'dayOfMonth'])
    const e = await deps.recurring.create(
      readString(body, 'name', ''),
      readUuid(body, 'accountId'),
      readMoney(body, 'amount', 0),
      readInteger(body, 'dayOfMonth', 0),
    )
    return c.json(recurringEntryResponse(e), 201)
  })

  /**
   * 未適用の分をまとめて適用する。適用した件数を返す。
   *
   * **自動では起きない。** 背景で勝手に動かない分、何が起きたかが常に見える
   * （docs/decisions.md 2.5）。2ヶ月開かなかった場合は2ヶ月分がまとめて入る。
   * 2つのタブから同時に押せば、2度目は 409 になり残高は二重に動かない。
   */
  app.post('/api/recurring-entries/apply', async (c) => {
    return c.json({ applied: await deps.recurring.apply() })
  })

  // 適用済みの履歴は消さない。名称は履歴側に写してあるので、消しても
  // 何だったかは読める。
  app.delete('/api/recurring-entries/:id', async (c) => {
    await deps.recurring.delete(parseUuid(c.req.param('id'), 'id'))
    return c.body(null, 204)
  })

  // ---- 月次の集計 ----

  /**
   * 月ごとの収入・支出・余剰を返す。年月の降順。
   *
   * **登録の経路は無い。** 明細を打てばその月の収支は自動で出る。手入力の
   * 経路を残すと、同じ数字を明細と月次の2箇所に入れることになり、どちらが
   * 正なのかが決まらない（docs/decisions.md 2.4）。
   *
   * 明細が1件も無い月に限り、廃止前に手入力された値が `source: "manual"`
   * として混ざる。
   */
  app.get('/api/monthly-summaries', async (c) => {
    const summaries = await deps.summaries.list()
    return c.json(summaries.map(monthlySummaryResponse))
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

  /**
   * 入出金の明細を1件打つ。口座残高が同額だけ動き、履歴が残る。
   *
   * amount は符号付き。出金は負、入金は正。0 は 422（INVALID_AMOUNT）。
   * kind を受け取らないのは、ここで作れるのが手入力の明細だけのため。
   * 送れば 400 で返る。ウィッシュや貸し借りの履歴は、それぞれの経路が作る。
   *
   * 分類（カテゴリ）は持たない。何に使ったかは note に書く。
   */
  app.post('/api/transactions', async (c) => {
    const body = await readBody(c, ['accountId', 'amount', 'occurredOn', 'note'])
    const t = await deps.transactions.create(
      readUuid(body, 'accountId'),
      readMoney(body, 'amount', 0),
      readDate(body, 'occurredOn'),
      readString(body, 'note', ''),
    )
    return c.json(transactionResponse(t), 201)
  })

  // 消せるのは手入力の明細だけ。ウィッシュや貸し借りに紐づく履歴は 422
  // （TRANSACTION_NOT_DELETABLE）。判定は domain が持つ。
  app.delete('/api/transactions/:id', async (c) => {
    await deps.transactions.delete(parseUuid(c.req.param('id'), 'id'))
    return c.body(null, 204)
  })

  app.all('/api/*', (c) => {
    return c.json({ error: { code: 'NOT_FOUND', message: '対象が見つかりません' } }, 404)
  })

  return app
}
