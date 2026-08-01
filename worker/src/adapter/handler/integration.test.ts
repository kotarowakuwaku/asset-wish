// 実 D1・実 usecase・実 repository を通す統合テスト。
//
// app.test.ts はスタブで HTTP の関心事だけを見る。こちらは結線が正しいか——
// index.ts の組み立て、SQL、ドメインの計算が API 越しに噛み合うか——を見る。
// スタブでは絶対に落ちない種類の間違いがここで落ちる。

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, givenMonthlyBalance, resetDb } from '../../../test/db'
import { authed, jsonRequest, TEST_TOKEN } from '../../../test/stubs'
import { buildDeps } from '../../index'
import { createApp } from './app'

const app = createApp(buildDeps({ ...env, AUTH_TOKEN: TEST_TOKEN }))

beforeEach(resetDb)

async function req<T>(path: string, init: RequestInit = authed()): Promise<{ status: number; body: T }> {
  const res = await app.request(path, init)
  const text = await res.text()
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as T }
}

type AccountBody = { id: string; balance: number; kind: string }
type LoanBody = {
  id: string
  direction: string
  outstanding: number
  status: string
  settledAmount: number
}
type WishBody = { id: string; status: string }
type DashboardBody = {
  netAsset: number
  investmentTotal: number
  outstandingLent: number
  outstandingBorrowed: number
  breakdown: { cashTotal: number; commitments: number }
  averageSurplus: number
  hasAverageSurplus: boolean
  projectedBalance: number
  pendingRecurringCount: number
  pendingRecurringTotal: number
  wishes: { id: string; shortfall: number; monthsToReach: number | null }[]
}

async function createAccount(balance: number, kind = 'cash'): Promise<AccountBody> {
  const { status, body } = await req<AccountBody>(
    '/api/accounts',
    jsonRequest('POST', { name: 'テスト口座', kind, balance }),
  )
  expect(status).toBe(201)
  return body
}

type TransactionBody = { id: string; amount: number; kind: string; note: string }

/** 入出金の明細を1件打つ。金額は符号付きで、出金は負。 */
async function createEntry(
  accountId: string,
  amount: number,
  occurredOn = '2026-07-12',
  note = '',
): Promise<TransactionBody> {
  const { status, body } = await req<TransactionBody>(
    '/api/transactions',
    jsonRequest('POST', { accountId, amount, occurredOn, note }),
  )
  expect(status).toBe(201)
  return body
}

async function balanceOf(id: string): Promise<number> {
  const { body } = await req<AccountBody[]>('/api/accounts')
  return body.filter((a) => a.id === id)[0].balance
}

describe('貸し借りの一連の流れ', () => {
  async function createLoan(
    amount: number,
    counterparty = 'テスト相手',
    direction = 'lent',
  ): Promise<LoanBody> {
    const { status, body } = await req<LoanBody>(
      '/api/loans',
      jsonRequest('POST', {
        direction,
        counterparty,
        description: '',
        amount,
        occurredOn: '2026-07-12',
      }),
    )
    expect(status).toBe(201)
    return body
  }

  // 不変条件4。立て替えた時点で現金が出たとは限らない（カード払い）。
  it.each(['lent', 'borrowed'])(
    '登録しても残高は動かず、履歴も残らない（%s）',
    async (direction) => {
      await createAccount(500_000)

      const created = await createLoan(12_000, 'テスト相手', direction)
      expect(created.direction).toBe(direction)
      // 借りた側も金額は正で持つ。
      expect(created.outstanding).toBe(12_000)

      const accounts = await req<AccountBody[]>('/api/accounts')
      expect(accounts.body[0].balance).toBe(500_000)

      const transactions = await req<unknown[]>('/api/transactions')
      expect(transactions.body).toHaveLength(0)
    },
  )

  // 向きが変わっても経路は1本。処理も同じ（未精算残高が減るだけ）。
  it('借りた分も同じ /settle で精算できる', async () => {
    const loan = await createLoan(5_000, 'テスト相手', 'borrowed')

    const settled = await req<LoanBody>(
      `/api/loans/${loan.id}/settle`,
      jsonRequest('POST', { amount: 2_000 }),
    )

    expect(settled.status).toBe(200)
    expect(settled.body.direction).toBe('borrowed')
    expect(settled.body.outstanding).toBe(3_000)
  })

  // 向きは domain が判定するので 422（業務ルール違反）。400 ではない。
  it('向きが不正なら 422', async () => {
    const res = await req<{ error: { code: string } }>(
      '/api/loans',
      jsonRequest('POST', {
        direction: 'sideways',
        counterparty: 'テスト相手',
        amount: 1_000,
        occurredOn: '2026-07-12',
      }),
    )
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_LOAN_DIRECTION')
  })

  it('精算すると未精算残高が減る。残高は動かない', async () => {
    await createAccount(500_000)
    const loan = await createLoan(12_000)

    const settled = await req<LoanBody>(
      `/api/loans/${loan.id}/settle`,
      jsonRequest('POST', { amount: 5_000 }),
    )

    expect(settled.status).toBe(200)
    expect(settled.body.outstanding).toBe(7_000)
    expect(settled.body.status).toBe('partial')

    const accounts = await req<AccountBody[]>('/api/accounts')
    expect(accounts.body[0].balance).toBe(500_000)
  })

  // 不変条件4。domain の判定と DB の CHECK 制約の両方が守っている。
  it('未精算残高を超える精算は 422 で、何も動かない', async () => {
    const loan = await createLoan(12_000)

    const over = await req<{ error: { code: string } }>(
      `/api/loans/${loan.id}/settle`,
      jsonRequest('POST', { amount: 12_001 }),
    )

    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('SETTLE_EXCEEDS_OUTSTANDING')
    expect((await req<LoanBody[]>('/api/loans')).body[0].settledAmount).toBe(0)
  })

  it('未精算だけに絞り込める', async () => {
    const l = await createLoan(1_000, '完済予定')
    await req(`/api/loans/${l.id}/settle`, jsonRequest('POST', { amount: 1_000 }))

    expect((await req<LoanBody[]>('/api/loans')).body).toHaveLength(1)
    expect((await req<LoanBody[]>('/api/loans?outstanding=true')).body).toHaveLength(0)
  })

  // 口座を指定させないことは API の形として保証する。黙って無視すると
  // 「口座を選んだのに残高が変わらない」と読める。
  it('accountId を送ると 400', async () => {
    const account = await createAccount(500_000)
    const res = await req<{ error: { code: string } }>(
      '/api/loans',
      jsonRequest('POST', {
        direction: 'lent',
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('ウィッシュの一連の流れ', () => {
  async function createWish(amount: number): Promise<WishBody> {
    const { body } = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount, category: 'item', priority: 1 }),
    )
    return body
  }

  it('確定 → 支払い で状態と残高が動く', async () => {
    const account = await createAccount(500_000)
    const wish = await createWish(80_000)

    expect((await req<WishBody>(`/api/wishes/${wish.id}/commit`, authed({ method: 'POST' }))).body.status).toBe(
      'committed',
    )

    const paid = await req<WishBody>(
      `/api/wishes/${wish.id}/pay`,
      jsonRequest('POST', { accountId: account.id, occurredOn: '2026-07-12' }),
    )
    expect(paid.status).toBe(200)
    expect(paid.body.status).toBe('done')

    const accounts = await req<AccountBody[]>('/api/accounts')
    expect(accounts.body[0].balance).toBe(420_000)
  })

  it('検討中のまま支払おうとすると 422', async () => {
    const account = await createAccount(500_000)
    const wish = await createWish(80_000)

    const res = await req<{ error: { code: string } }>(
      `/api/wishes/${wish.id}/pay`,
      jsonRequest('POST', { accountId: account.id, occurredOn: '2026-07-12' }),
    )

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_TRANSITION')
    expect((await req<AccountBody[]>('/api/accounts')).body[0].balance).toBe(500_000)
  })

  // 真の同時実行なら 409（楽観ロック）になるが、逐次に投げれば読み取った
  // 時点で既に committed なので domain が遷移そのものを拒む。
  it('2度目の確定は 422', async () => {
    const wish = await createWish(80_000)
    await req(`/api/wishes/${wish.id}/commit`, authed({ method: 'POST' }))

    const second = await req<{ error: { code: string } }>(
      `/api/wishes/${wish.id}/commit`,
      authed({ method: 'POST' }),
    )
    expect(second.status).toBe(422)
    expect(second.body.error.code).toBe('INVALID_TRANSITION')
  })

  it('内容の更新は状態を動かさない', async () => {
    const wish = await createWish(80_000)
    await req(`/api/wishes/${wish.id}/commit`, authed({ method: 'POST' }))

    const updated = await req<WishBody & { title: string; amount: number }>(
      `/api/wishes/${wish.id}`,
      jsonRequest('PATCH', { title: '新題', amount: 90_000 }),
    )

    expect(updated.body.title).toBe('新題')
    expect(updated.body.amount).toBe(90_000)
    expect(updated.body.status).toBe('committed')
  })
})

describe('ダッシュボード', () => {
  // このアプリの存在理由そのもの。実質資産の式が API 越しに保たれているか。
  it('現金 - 確定支出。投資と貸し借りは別枠', async () => {
    await createAccount(910_000)
    await createAccount(350_000, 'investment')

    await req(
      '/api/loans',
      jsonRequest('POST', {
        direction: 'lent',
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
      }),
    )

    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.breakdown).toEqual({ cashTotal: 910_000, commitments: 80_000 })
    expect(body.netAsset).toBe(830_000)
    // どちらも実質資産の外（不変条件1・4）。
    expect(body.investmentTotal).toBe(350_000)
    expect(body.outstandingLent).toBe(12_000)
  })

  // 明細を打てば月次の収支は自動で出る。手入力の経路はもう無い。
  // 月は過去に固定してある。当月は平均に含めないため。
  it('明細から平均余剰と到達見込みを出す', async () => {
    const account = await createAccount(500_000)
    for (const [month, expense] of [
      ['2026-04', 240_000],
      ['2026-05', 250_000],
      ['2026-06', 230_000],
    ] as const) {
      await createEntry(account.id, 300_000, `${month}-25`)
      await createEntry(account.id, -expense, `${month}-05`)
    }
    // 3ヶ月の余剰は +60k / +50k / +70k。残高は 500,000 + 180,000。
    await req('/api/wishes', jsonRequest('POST', { title: '目標', amount: 800_000, category: 'goal' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.hasAverageSurplus).toBe(true)
    expect(body.averageSurplus).toBe(60_000)
    expect(body.netAsset).toBe(680_000)
    expect(body.wishes[0].shortfall).toBe(120_000)
    expect(body.wishes[0].monthsToReach).toBe(2) // 120,000 / 60,000
  })

  // 明細を打ち始める前の月は、手入力の値しか残っていない。切り捨てると
  // 3ヶ月分貯まるまで到達見込みが出せなくなる。
  it('明細が1件も無い月は手入力の月次収支で埋まる', async () => {
    await createAccount(500_000)
    await givenMonthlyBalance('2026-06', 300_000, 230_000) // +70k

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.hasAverageSurplus).toBe(true)
    expect(body.averageSurplus).toBe(70_000)
  })

  // 同じ月について両方を足すと二重計上になる。月単位でどちらか一方に決める。
  it('明細のある月は手入力の値を使わない', async () => {
    const account = await createAccount(500_000)
    await givenMonthlyBalance('2026-06', 300_000, 100_000) // +200k（使われないはず）
    await createEntry(account.id, 300_000, '2026-06-25')
    await createEntry(account.id, -230_000, '2026-06-05')

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.averageSurplus).toBe(70_000)
  })

  it('月次の収支が無ければ到達見込みは算出不可', async () => {
    await createAccount(500_000)
    await req('/api/wishes', jsonRequest('POST', { title: '目標', amount: 800_000, category: 'goal' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.hasAverageSurplus).toBe(false)
    expect(body.wishes[0].monthsToReach).toBeNull()
  })
})

describe('月次の集計', () => {
  type SummaryBody = {
    yearMonth: string
    income: number
    expense: number
    surplus: number
    source: string
  }

  it('明細を月ごとに足し上げ、年月の降順で返す', async () => {
    const account = await createAccount(500_000)
    await createEntry(account.id, 300_000, '2026-06-25')
    await createEntry(account.id, -230_000, '2026-06-05')
    await createEntry(account.id, -3_000, '2026-05-20')

    const { status, body } = await req<SummaryBody[]>('/api/monthly-summaries')

    expect(status).toBe(200)
    expect(body).toEqual([
      {
        yearMonth: '2026-06',
        income: 300_000,
        expense: 230_000,
        surplus: 70_000,
        source: 'entries',
      },
      { yearMonth: '2026-05', income: 0, expense: 3_000, surplus: -3_000, source: 'entries' },
    ])
  })

  it('明細が1件も無い月は手入力の値が source: manual で混ざる', async () => {
    const account = await createAccount(500_000)
    await givenMonthlyBalance('2026-05', 300_000, 240_000)
    await createEntry(account.id, -3_000, '2026-06-20')

    const { body } = await req<SummaryBody[]>('/api/monthly-summaries')

    expect(body.map((s) => [s.yearMonth, s.source])).toEqual([
      ['2026-06', 'entries'],
      ['2026-05', 'manual'],
    ])
  })

  it('ウィッシュの支払いは集計に足さない', async () => {
    const account = await createAccount(500_000)
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))
    await req(
      `/api/wishes/${wish.body.id}/pay`,
      jsonRequest('POST', { accountId: account.id, occurredOn: '2026-06-10' }),
    )

    expect((await req<SummaryBody[]>('/api/monthly-summaries')).body).toEqual([])
  })

  it('明細が1件も無ければ空配列', async () => {
    expect((await req<SummaryBody[]>('/api/monthly-summaries')).body).toEqual([])
  })

  // 手入力の経路は消した。同じ数字を明細と月次の2箇所に入れさせないため。
  it('月次収支を手で書く経路は残っていない', async () => {
    const put = await req(
      '/api/monthly-balances/2026-07',
      jsonRequest('PUT', { income: 300_000, expense: 230_000 }),
    )
    expect(put.status).toBe(404)
    expect((await req('/api/monthly-balances')).status).toBe(404)
  })
})

describe('入出金の明細', () => {
  it('出金を打つと残高が減り、履歴が残る', async () => {
    const account = await createAccount(500_000)

    const entry = await createEntry(account.id, -3_000, '2026-07-12', 'コンビニ')

    expect(entry.kind).toBe('adjustment')
    expect(entry.note).toBe('コンビニ')
    expect(await balanceOf(account.id)).toBe(497_000)
    expect((await req<unknown[]>('/api/transactions')).body).toHaveLength(1)
  })

  it('入金を打つと残高が増える', async () => {
    const account = await createAccount(500_000)

    await createEntry(account.id, 250_000, '2026-07-12', '給料')

    expect(await balanceOf(account.id)).toBe(750_000)
  })

  it('消すと残高が戻り、履歴からも消える', async () => {
    const account = await createAccount(500_000)
    const entry = await createEntry(account.id, -3_000, '2026-07-12', 'コンビニ')

    const res = await req(`/api/transactions/${entry.id}`, authed({ method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect(await balanceOf(account.id)).toBe(500_000)
    expect((await req<unknown[]>('/api/transactions')).body).toHaveLength(0)
  })

  // 履歴だけ消すと、ウィッシュが完了のままなのに支払いが無かったことになる。
  it('ウィッシュの支払いは消せず、残高も動かない', async () => {
    const account = await createAccount(500_000)
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))
    await req(
      `/api/wishes/${wish.body.id}/pay`,
      jsonRequest('POST', { accountId: account.id, occurredOn: '2026-07-12' }),
    )
    const paid = (await req<TransactionBody[]>('/api/transactions')).body[0]

    const res = await req<{ error: { code: string } }>(
      `/api/transactions/${paid.id}`,
      authed({ method: 'DELETE' }),
    )

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('TRANSACTION_NOT_DELETABLE')
    expect(await balanceOf(account.id)).toBe(420_000)
  })

  // 残高が動かない記録に意味は無い。domain の判定なので 422。
  it('金額0は 422', async () => {
    const account = await createAccount(500_000)

    const res = await req<{ error: { code: string } }>(
      '/api/transactions',
      jsonRequest('POST', { accountId: account.id, amount: 0, occurredOn: '2026-07-12' }),
    )

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_AMOUNT')
    expect(await balanceOf(account.id)).toBe(500_000)
  })

  it('存在しない口座は 404', async () => {
    const res = await req(
      '/api/transactions',
      jsonRequest('POST', {
        accountId: '00000000-0000-4000-8000-00000000dead',
        amount: -3_000,
        occurredOn: '2026-07-12',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('無い履歴の削除は 404', async () => {
    const res = await req(
      '/api/transactions/00000000-0000-4000-8000-00000000dead',
      authed({ method: 'DELETE' }),
    )
    expect(res.status).toBe(404)
  })

  // 明細は実質資産に効く。残高を動かすので、cashTotal 経由で netAsset に乗る。
  it('明細で動いた残高が実質資産に反映される', async () => {
    const account = await createAccount(500_000)

    await createEntry(account.id, -3_000, '2026-07-12', 'コンビニ')

    const { body } = await req<DashboardBody>('/api/dashboard')
    expect(body.breakdown.cashTotal).toBe(497_000)
    expect(body.netAsset).toBe(497_000)
  })
})

describe('定期入出金', () => {
  type RecurringBody = { id: string; name: string; amount: number; appliedThrough: string }
  type ApplyBody = { applied: number }

  async function createRecurring(
    accountId: string,
    name: string,
    amount: number,
    dayOfMonth: number,
  ): Promise<RecurringBody> {
    const { status, body } = await req<RecurringBody>(
      '/api/recurring-entries',
      jsonRequest('POST', { name, accountId, amount, dayOfMonth }),
    )
    expect(status).toBe(201)
    return body
  }

  /** 適用日を過ぎた状態にする。適用済み年月を過去へ巻き戻すのは SQL でしかできない。 */
  async function rewind(id: string, appliedThrough: string): Promise<void> {
    await db
      .prepare('UPDATE recurring_entries SET applied_through = ? WHERE id = ?')
      .bind(appliedThrough, id)
      .run()
  }

  it('登録しただけでは残高が動かない', async () => {
    const account = await createAccount(500_000)

    const created = await createRecurring(account.id, '給料', 250_000, 25)

    expect(created.amount).toBe(250_000)
    expect(await balanceOf(account.id)).toBe(500_000)
    expect((await req<unknown[]>('/api/transactions')).body).toHaveLength(0)
  })

  it('適用すると残高が動き、履歴が残る', async () => {
    const account = await createAccount(500_000)
    const created = await createRecurring(account.id, '給料', 250_000, 1)
    await rewind(created.id, '2026-05')

    const applied = await req<ApplyBody>('/api/recurring-entries/apply', authed({ method: 'POST' }))

    // 2026-06 から当月まで。件数は実行時期で変わるので残高との整合だけ見る。
    expect(applied.status).toBe(200)
    expect(applied.body.applied).toBeGreaterThanOrEqual(3)
    expect(await balanceOf(account.id)).toBe(500_000 + 250_000 * applied.body.applied)

    const history = (await req<TransactionBody[]>('/api/transactions')).body
    expect(history).toHaveLength(applied.body.applied)
    expect(history[0].kind).toBe('recurring_applied')
    // 名称を写してあるので、定期入出金を消しても何だったか読める。
    expect(history[0].note).toBe('給料')
  })

  it('二度目の適用では何も起きない', async () => {
    const account = await createAccount(500_000)
    const created = await createRecurring(account.id, '家賃', -80_000, 1)
    await rewind(created.id, '2026-06')

    const first = await req<ApplyBody>('/api/recurring-entries/apply', authed({ method: 'POST' }))
    const balance = await balanceOf(account.id)

    const second = await req<ApplyBody>('/api/recurring-entries/apply', authed({ method: 'POST' }))

    expect(first.body.applied).toBeGreaterThan(0)
    expect(second.body.applied).toBe(0)
    expect(await balanceOf(account.id)).toBe(balance)
  })

  // 同じ口座への更新が2本並ぶと番人が必ず失敗する。合算して1本にしてある。
  it('同じ口座への収入と支出をまとめて適用できる', async () => {
    const account = await createAccount(500_000)
    const salary = await createRecurring(account.id, '給料', 250_000, 1)
    const rent = await createRecurring(account.id, '家賃', -80_000, 1)
    await rewind(salary.id, '2026-06')
    await rewind(rent.id, '2026-06')

    const applied = await req<ApplyBody>('/api/recurring-entries/apply', authed({ method: 'POST' }))

    expect(applied.status).toBe(200)
    const perMonth = applied.body.applied / 2
    expect(await balanceOf(account.id)).toBe(500_000 + (250_000 - 80_000) * perMonth)
  })

  // 適用の履歴は生活費の収支そのもの。月次の集計に足す（不変条件2）。
  it('適用した分は月次の集計に入る', async () => {
    const account = await createAccount(500_000)
    const created = await createRecurring(account.id, '給料', 250_000, 1)
    await rewind(created.id, '2026-06')

    await req('/api/recurring-entries/apply', authed({ method: 'POST' }))

    const summaries = (await req<{ yearMonth: string; income: number }[]>(
      '/api/monthly-summaries',
    )).body
    const july = summaries.filter((s) => s.yearMonth === '2026-07')[0]
    expect(july.income).toBe(250_000)
  })

  // 適用済みの年月と食い違う履歴を残さない。消したいときは定期のほうを消す。
  it('適用の履歴は削除できない', async () => {
    const account = await createAccount(500_000)
    const created = await createRecurring(account.id, '給料', 250_000, 1)
    await rewind(created.id, '2026-06')
    await req('/api/recurring-entries/apply', authed({ method: 'POST' }))
    const [history] = (await req<TransactionBody[]>('/api/transactions')).body

    const res = await req<{ error: { code: string } }>(
      `/api/transactions/${history.id}`,
      authed({ method: 'DELETE' }),
    )

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('TRANSACTION_NOT_DELETABLE')
  })

  it('消しても適用済みの履歴は残る', async () => {
    const account = await createAccount(500_000)
    const created = await createRecurring(account.id, '給料', 250_000, 1)
    await rewind(created.id, '2026-06')
    await req('/api/recurring-entries/apply', authed({ method: 'POST' }))

    const res = await req(`/api/recurring-entries/${created.id}`, authed({ method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect((await req<unknown[]>('/api/recurring-entries')).body).toHaveLength(0)
    expect((await req<TransactionBody[]>('/api/transactions')).body[0].note).toBe('給料')
  })

  it('存在しない口座なら 404', async () => {
    const res = await req(
      '/api/recurring-entries',
      jsonRequest('POST', {
        name: '給料',
        accountId: '00000000-0000-4000-8000-00000000dead',
        amount: 250_000,
        dayOfMonth: 25,
      }),
    )
    expect(res.status).toBe(404)
  })

  // 適用日の範囲は domain が判定するので 422。400 ではない。
  it('適用日が範囲外なら 422', async () => {
    const account = await createAccount(500_000)
    const res = await req<{ error: { code: string } }>(
      '/api/recurring-entries',
      jsonRequest('POST', { name: '給料', accountId: account.id, amount: 250_000, dayOfMonth: 32 }),
    )
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_DAY_OF_MONTH')
  })

  it('未適用の件数と合計がダッシュボードに出る', async () => {
    const account = await createAccount(500_000)
    const salary = await createRecurring(account.id, '給料', 250_000, 1)
    await rewind(salary.id, '2026-06')

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.pendingRecurringCount).toBeGreaterThan(0)
    expect(body.pendingRecurringTotal).toBe(250_000 * body.pendingRecurringCount)
    // 数えるだけで、残高は動かさない。
    expect(await balanceOf(account.id)).toBe(500_000)
  })
})

// 「今いくらあるか」だけでは月末に向けてどうなるかが読めない、という
// 要望への回答。3つの時点を並べて出す。
describe('残高の3つの時点', () => {
  it('今ある額・支払い後に残る額・来月初めの見込みを返す', async () => {
    const account = await createAccount(500_000)
    // 確定したウィッシュは「支払い後に残る額」だけを動かす。
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))
    // 定期は「来月初めの見込み」だけを動かす。適用日を1日にすると、
    // **未適用の当月分と翌月分の2回**が翌月1日までに来る（登録した月の
    // 前月まで適用済みとして始まるため）。実行時期には依存しない。
    await req(
      '/api/recurring-entries',
      jsonRequest('POST', { name: '給料', accountId: account.id, amount: 250_000, dayOfMonth: 1 }),
    )

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.breakdown.cashTotal).toBe(500_000)
    expect(body.netAsset).toBe(420_000)
    expect(body.projectedBalance).toBe(1_000_000)
  })

  // 確定支出を見込みに含めない。いつ払うかが決まっていないため、含めると
  // 「まだ払っていないのに減っている」が別の形で再発する。
  it('確定した支出は見込みに含めない', async () => {
    await createAccount(500_000)
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.netAsset).toBe(420_000)
    expect(body.projectedBalance).toBe(500_000)
  })

  it('定期が無ければ見込みは今ある額と同じ', async () => {
    await createAccount(500_000)

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.projectedBalance).toBe(500_000)
  })
})

describe('口座の削除', () => {
  // 履歴を作るのはウィッシュの支払い。貸し借りはもう口座を触らない（不変条件4）。
  it('取引履歴が残っていれば 422', async () => {
    const account = await createAccount(500_000)
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))
    await req(
      `/api/wishes/${wish.body.id}/pay`,
      jsonRequest('POST', { accountId: account.id, occurredOn: '2026-07-12' }),
    )

    const res = await req<{ error: { code: string } }>(
      `/api/accounts/${account.id}`,
      authed({ method: 'DELETE' }),
    )

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('ACCOUNT_IN_USE')
  })

  it('履歴が無ければ 204', async () => {
    const account = await createAccount(500_000)
    const res = await req(`/api/accounts/${account.id}`, authed({ method: 'DELETE' }))
    expect(res.status).toBe(204)
    expect((await req<unknown[]>('/api/accounts')).body).toHaveLength(0)
  })
})

describe('存在しない対象', () => {
  it('無い貸し借りの精算は 404', async () => {
    const res = await req(
      '/api/loans/00000000-0000-4000-8000-00000000dead/settle',
      jsonRequest('POST', { amount: 1 }),
    )
    expect(res.status).toBe(404)
  })

  it('無い口座へのウィッシュの支払いは 404', async () => {
    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 1_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))

    const res = await req(
      `/api/wishes/${wish.body.id}/pay`,
      jsonRequest('POST', {
        accountId: '00000000-0000-4000-8000-00000000dead',
        occurredOn: '2026-07-12',
      }),
    )
    expect(res.status).toBe(404)
  })
})
