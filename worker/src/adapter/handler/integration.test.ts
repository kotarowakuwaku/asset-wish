// 実 D1・実 usecase・実 repository を通す統合テスト。
//
// app.test.ts はスタブで HTTP の関心事だけを見る。こちらは結線が正しいか——
// index.ts の組み立て、SQL、ドメインの計算が API 越しに噛み合うか——を見る。
// スタブでは絶対に落ちない種類の間違いがここで落ちる。

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb } from '../../../test/db'
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
type LendingBody = { id: string; outstanding: number; status: string; collectedAmount: number }
type WishBody = { id: string; status: string }
type DashboardBody = {
  netAsset: number
  investmentTotal: number
  breakdown: { cashTotal: number; outstandingLendings: number; commitments: number }
  averageSurplus: number
  hasAverageSurplus: boolean
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

describe('立替の一連の流れ', () => {
  it('登録すると残高が減り、履歴が残る', async () => {
    const account = await createAccount(500_000)

    const created = await req<LendingBody>(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        description: '',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
    )
    expect(created.status).toBe(201)
    expect(created.body.outstanding).toBe(12_000)

    const accounts = await req<AccountBody[]>('/api/accounts')
    expect(accounts.body[0].balance).toBe(488_000)

    const transactions = await req<{ kind: string; amount: number }[]>('/api/transactions')
    expect(transactions.body).toHaveLength(1)
    expect(transactions.body[0]).toMatchObject({ kind: 'lending_created', amount: -12_000 })
  })

  it('回収すると残高が戻り、未回収残高が減る', async () => {
    const account = await createAccount(500_000)
    const lending = await req<LendingBody>(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
    )

    const collected = await req<LendingBody>(
      `/api/lendings/${lending.body.id}/collect`,
      jsonRequest('POST', { amount: 5_000, occurredOn: '2026-07-20', accountId: account.id }),
    )

    expect(collected.status).toBe(200)
    expect(collected.body.outstanding).toBe(7_000)
    expect(collected.body.status).toBe('partial')

    const accounts = await req<AccountBody[]>('/api/accounts')
    expect(accounts.body[0].balance).toBe(493_000)
  })

  // 不変条件4。domain の判定と DB の CHECK 制約の両方が守っている。
  it('未回収残高を超える回収は 422 で、何も動かない', async () => {
    const account = await createAccount(500_000)
    const lending = await req<LendingBody>(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
    )

    const over = await req<{ error: { code: string } }>(
      `/api/lendings/${lending.body.id}/collect`,
      jsonRequest('POST', { amount: 12_001, occurredOn: '2026-07-20', accountId: account.id }),
    )

    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('COLLECT_EXCEEDS_OUTSTANDING')

    const accounts = await req<AccountBody[]>('/api/accounts')
    expect(accounts.body[0].balance).toBe(488_000)
    const transactions = await req<unknown[]>('/api/transactions')
    expect(transactions.body).toHaveLength(1)
  })

  it('未回収だけに絞り込める', async () => {
    const account = await createAccount(500_000)
    const l = await req<LendingBody>(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: '完済予定',
        amount: 1_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
    )
    await req(
      `/api/lendings/${l.body.id}/collect`,
      jsonRequest('POST', { amount: 1_000, occurredOn: '2026-07-20', accountId: account.id }),
    )

    expect((await req<LendingBody[]>('/api/lendings')).body).toHaveLength(1)
    expect((await req<LendingBody[]>('/api/lendings?outstanding=true')).body).toHaveLength(0)
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
  it('現金 + 未回収立替 - 確定支出。投資は別枠', async () => {
    const cash = await createAccount(910_000)
    await createAccount(350_000, 'investment')

    await req(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: cash.id,
      }),
    )
    // 立替の登録で現金が 12,000 減っている。残高を戻して 910,000 に揃える。
    await req(`/api/accounts/${cash.id}`, jsonRequest('PATCH', { balance: 910_000 }))

    const wish = await req<WishBody>(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    await req(`/api/wishes/${wish.body.id}/commit`, authed({ method: 'POST' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.breakdown).toEqual({
      cashTotal: 910_000,
      outstandingLendings: 12_000,
      commitments: 80_000,
    })
    expect(body.netAsset).toBe(842_000)
    expect(body.investmentTotal).toBe(350_000)
  })

  it('月次収支から平均余剰と到達見込みを出す', async () => {
    await createAccount(500_000)
    await req('/api/monthly-balances/2026-05', jsonRequest('PUT', { income: 300_000, expense: 240_000 }))
    await req('/api/monthly-balances/2026-06', jsonRequest('PUT', { income: 300_000, expense: 250_000 }))
    await req('/api/monthly-balances/2026-07', jsonRequest('PUT', { income: 300_000, expense: 230_000 }))

    await req('/api/wishes', jsonRequest('POST', { title: '目標', amount: 800_000, category: 'goal' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.hasAverageSurplus).toBe(true)
    expect(body.averageSurplus).toBe(60_000) // (60k + 50k + 70k) / 3
    expect(body.wishes[0].shortfall).toBe(300_000)
    expect(body.wishes[0].monthsToReach).toBe(5) // 300,000 / 60,000
  })

  it('月次収支が無ければ到達見込みは算出不可', async () => {
    await createAccount(500_000)
    await req('/api/wishes', jsonRequest('POST', { title: '目標', amount: 800_000, category: 'goal' }))

    const { body } = await req<DashboardBody>('/api/dashboard')

    expect(body.hasAverageSurplus).toBe(false)
    expect(body.wishes[0].monthsToReach).toBeNull()
  })
})

describe('月次収支', () => {
  it('同じ年月への PUT は冪等で、id が変わらない', async () => {
    const first = await req<{ id: string; surplus: number }>(
      '/api/monthly-balances/2026-07',
      jsonRequest('PUT', { income: 300_000, expense: 230_000 }),
    )
    const second = await req<{ id: string; surplus: number }>(
      '/api/monthly-balances/2026-07',
      jsonRequest('PUT', { income: 310_000, expense: 200_000 }),
    )

    expect(second.body.id).toBe(first.body.id)
    expect(second.body.surplus).toBe(110_000)
    expect((await req<unknown[]>('/api/monthly-balances')).body).toHaveLength(1)
  })
})

describe('口座の削除', () => {
  it('取引履歴が残っていれば 422', async () => {
    const account = await createAccount(500_000)
    await req(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: account.id,
      }),
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
  it('無い立替の回収は 404', async () => {
    const account = await createAccount(500_000)
    const res = await req(
      '/api/lendings/00000000-0000-4000-8000-00000000dead/collect',
      jsonRequest('POST', { amount: 1, occurredOn: '2026-07-12', accountId: account.id }),
    )
    expect(res.status).toBe(404)
  })

  it('無い口座への立替は 404', async () => {
    const res = await req(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 1_000,
        occurredOn: '2026-07-12',
        accountId: '00000000-0000-4000-8000-00000000dead',
      }),
    )
    expect(res.status).toBe(404)
  })
})
