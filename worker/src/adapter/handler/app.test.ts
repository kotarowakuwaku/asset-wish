import { describe, expect, it } from 'vitest'
import { authed, jsonRequest, OTHER_ID, stubDeps, TEST_ID, TEST_TOKEN } from '../../../test/stubs'
import { yen } from '../../../test/support'
import { domainError } from '../../domain/errors'
import { ConflictError, NotFoundError } from '../../usecase/port'
import { createApp } from './app'
import type { Deps } from './services'

/** スタブを差し替えたアプリと、その呼び出し記録を返す。 */
function makeApp(overrides: Partial<Deps> = {}) {
  const deps = stubDeps(overrides)
  return { app: createApp(deps), deps }
}

async function call(path: string, init: RequestInit = authed()) {
  const res = await createApp(stubDeps()).request(path, init)
  return { status: res.status, body: await res.json() }
}

describe('認証', () => {
  it('トークンが無ければ 401', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: '認証が必要です' },
    })
  })

  it('トークンが違えば 401', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts', {
      headers: { Authorization: 'Bearer wrong-token-but-same-length-32ch' },
    })
    expect(res.status).toBe(401)
  })

  it('長さが違うトークンでも 401（比較で落ちない）', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts', {
      headers: { Authorization: 'Bearer short' },
    })
    expect(res.status).toBe(401)
  })

  it('正しいトークンなら通る', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts', authed())
    expect(res.status).toBe(200)
  })

  it('Bearer が無い形式は 401', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts', {
      headers: { Authorization: TEST_TOKEN },
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/dashboard', () => {
  it('front の型と同じ形で返す', async () => {
    const { status, body } = await call('/api/dashboard')

    expect(status).toBe(200)
    expect(body).toEqual({
      netAsset: 830_000,
      breakdown: { cashTotal: 910_000, commitments: 80_000 },
      investmentTotal: 350_000,
      outstandingLendings: 12_000,
      averageSurplus: 60_000,
      hasAverageSurplus: true,
      wishes: [
        {
          id: TEST_ID,
          title: 'テスト',
          amount: 80_000,
          category: 'item',
          status: 'considering',
          priority: 3,
          deadline: null,
          shortfall: 358_000,
          monthsToReach: 6,
          monthlySavingNeeded: 59_667,
        },
      ],
    })
  })

  // null は「算出不可」。0 として返しても hasAverageSurplus が false なら
  // クライアントは表示しない。
  it('平均月間余剰が算出不可なら hasAverageSurplus は false', async () => {
    const { app } = makeApp({
      dashboard: {
        get: async () => ({
          breakdown: { cashTotal: yen(0), commitments: yen(0) },
          netAsset: yen(0),
          investmentTotal: yen(0),
          outstandingLendings: yen(0),
          averageSurplus: null,
          wishes: [],
        }),
      },
    })

    const res = await app.request('/api/dashboard', authed())
    const body = (await res.json()) as { averageSurplus: number; hasAverageSurplus: boolean }
    expect(body.hasAverageSurplus).toBe(false)
    expect(body.averageSurplus).toBe(0)
  })
})

describe('口座', () => {
  it('GET は isStale を導出して返す', async () => {
    const { status, body } = await call('/api/accounts')
    expect(status).toBe(200)
    expect(body).toEqual([
      {
        id: TEST_ID,
        name: 'テスト口座',
        kind: 'cash',
        balance: 500_000,
        updatedAt: '2026-07-29T00:00:00.000Z',
        isStale: false,
      },
    ])
  })

  it('POST は 201 を返す', async () => {
    const { status } = await call(
      '/api/accounts',
      jsonRequest('POST', { name: 'テスト口座', kind: 'cash', balance: 1_000 }),
    )
    expect(status).toBe(201)
  })

  it('POST は名称・種別・残高をそのまま渡す', async () => {
    const { app, deps } = makeApp()
    await app.request(
      '/api/accounts',
      jsonRequest('POST', { name: '新しい口座', kind: 'investment', balance: 1_234 }),
    )
    expect(deps.calls['accounts.create']).toEqual(['新しい口座', 'investment', 1_234])
  })

  // 種別が変わると、その口座が実質資産の計算から丸ごと外れる（不変条件1）。
  it('PATCH で kind を送ると 400（黙って無視しない）', async () => {
    const { status, body } = await call(
      `/api/accounts/${TEST_ID}`,
      jsonRequest('PATCH', { kind: 'investment' }),
    )
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_BODY')
  })

  it('PATCH は渡された項目だけを input に載せる', async () => {
    const { app, deps } = makeApp()
    await app.request(`/api/accounts/${TEST_ID}`, jsonRequest('PATCH', { name: '新名' }))
    expect(deps.calls['accounts.update']).toEqual([TEST_ID, { name: '新名', balance: undefined }])
  })

  it('DELETE は 204 を返す', async () => {
    const res = await createApp(stubDeps()).request(
      `/api/accounts/${TEST_ID}`,
      authed({ method: 'DELETE' }),
    )
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('ID の形式が不正なら 400', async () => {
    const { status, body } = await call('/api/accounts/not-a-uuid', jsonRequest('PATCH', {}))
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_ID')
  })
})

describe('立替', () => {
  it('GET は導出値を含めて返す', async () => {
    const { body } = await call('/api/lendings')
    expect(body).toEqual([
      {
        id: TEST_ID,
        counterparty: 'テスト相手',
        description: 'メモ',
        amount: 12_000,
        collectedAmount: 5_000,
        outstanding: 7_000,
        status: 'partial',
        occurredOn: '2026-07-12',
      },
    ])
  })

  it('?outstanding=true で絞り込みを渡す', async () => {
    const { app, deps } = makeApp()
    await app.request('/api/lendings?outstanding=true', authed())
    expect(deps.calls['lendings.list']).toEqual([true])

    await app.request('/api/lendings', authed())
    expect(deps.calls['lendings.list']).toEqual([false])
  })

  it('POST は 201 を返す', async () => {
    const { status } = await call(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        description: '',
        amount: 12_000,
        occurredOn: '2026-07-12',
      }),
    )
    expect(status).toBe(201)
  })

  it('POST は相手・内容・金額・日付をそのまま渡す', async () => {
    const { app, deps } = makeApp()
    await app.request(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        description: 'メモ',
        amount: 12_000,
        occurredOn: '2026-07-12',
      }),
    )
    expect(deps.calls['lendings.create']).toEqual(['テスト相手', 'メモ', 12_000, '2026-07-12'])
  })

  it('日付の形式が不正なら 400', async () => {
    const { status, body } = await call(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026/07/12',
      }),
    )
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_DATE')
  })

  it('存在しない日付も 400', async () => {
    const { status } = await call(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-02-31',
      }),
    )
    expect(status).toBe(400)
  })

  // 金額に小数を渡すのは形式の誤り（400）。業務ルール違反（422）ではない。
  it('金額が小数なら 400', async () => {
    const { status, body } = await call(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 100.5,
        occurredOn: '2026-07-12',
      }),
    )
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_BODY')
  })

  // 立替は口座残高を動かさない（不変条件4）。黙って無視すると
  // 「口座を指定したのに残高が変わらない」と読める。
  it('POST で accountId を送ると 400（黙って無視しない）', async () => {
    const { status, body } = await call(
      '/api/lendings',
      jsonRequest('POST', {
        counterparty: 'テスト相手',
        amount: 12_000,
        occurredOn: '2026-07-12',
        accountId: OTHER_ID,
      }),
    )
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_BODY')
  })

  it('回収は 200 を返し、金額だけを渡す', async () => {
    const { app, deps } = makeApp()
    const res = await app.request(
      `/api/lendings/${TEST_ID}/collect`,
      jsonRequest('POST', { amount: 5_000 }),
    )
    expect(res.status).toBe(200)
    expect(deps.calls['lendings.collect']).toEqual([TEST_ID, 5_000])
  })

  // 回収日を残す先が無い（取引履歴が作られない）。
  it('回収で accountId や occurredOn を送ると 400', async () => {
    for (const extra of [{ accountId: OTHER_ID }, { occurredOn: '2026-07-12' }]) {
      const { status } = await call(
        `/api/lendings/${TEST_ID}/collect`,
        jsonRequest('POST', { amount: 5_000, ...extra }),
      )
      expect(status).toBe(400)
    }
  })
})

describe('ウィッシュ', () => {
  it('GET は status で絞り込める', async () => {
    const { app, deps } = makeApp()
    await app.request('/api/wishes?status=committed', authed())
    expect(deps.calls['wishes.list']).toEqual(['committed'])

    await app.request('/api/wishes', authed())
    expect(deps.calls['wishes.list']).toEqual([null])
  })

  // 存在しない状態で空配列を返すと、絞り込めているように見えてしまう。
  it('未知の status は 400', async () => {
    const { status, body } = await call('/api/wishes?status=paid')
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_WISH_STATUS')
  })

  it('POST は 201 を返し、priority の既定は 0', async () => {
    const { app, deps } = makeApp()
    const res = await app.request(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 80_000, category: 'item' }),
    )
    expect(res.status).toBe(201)
    expect(deps.calls['wishes.create']).toEqual(['テスト', 80_000, 'item', 0, null])
  })

  // 新規は必ず検討中から始まる（不変条件3）。
  it('POST で status を送ると 400', async () => {
    const { status } = await call(
      '/api/wishes',
      jsonRequest('POST', { title: 'テスト', amount: 1, category: 'item', status: 'committed' }),
    )
    expect(status).toBe(400)
  })

  // 状態遷移は専用の経路に限る（不変条件6）。
  it('PATCH で status を送ると 400', async () => {
    const { status } = await call(
      `/api/wishes/${TEST_ID}`,
      jsonRequest('PATCH', { status: 'committed' }),
    )
    expect(status).toBe(400)
  })

  // キーが無い＝変更しない、null＝期限を外す。区別しないと、期限を消したいのか
  // 触っていないのか分からなくなる。
  it('PATCH の deadline は「キー無し」と null を区別する', async () => {
    const { app, deps } = makeApp()

    await app.request(`/api/wishes/${TEST_ID}`, jsonRequest('PATCH', { title: 'x' }))
    expect((deps.calls['wishes.updateContent'][1] as { deadline: unknown }).deadline).toBeUndefined()

    await app.request(`/api/wishes/${TEST_ID}`, jsonRequest('PATCH', { deadline: null }))
    expect((deps.calls['wishes.updateContent'][1] as { deadline: unknown }).deadline).toBeNull()

    await app.request(`/api/wishes/${TEST_ID}`, jsonRequest('PATCH', { deadline: '2026-12-31' }))
    expect((deps.calls['wishes.updateContent'][1] as { deadline: unknown }).deadline).toBe('2026-12-31')
  })

  it('deadline が文字列でも null でもなければ 400', async () => {
    const { status, body } = await call(`/api/wishes/${TEST_ID}`, jsonRequest('PATCH', { deadline: 20261231 }))
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_DATE')
  })

  it('commit / drop は本文なしで 200', async () => {
    for (const op of ['commit', 'drop']) {
      const res = await createApp(stubDeps()).request(
        `/api/wishes/${TEST_ID}/${op}`,
        authed({ method: 'POST' }),
      )
      expect(res.status).toBe(200)
    }
  })

  it('pay は口座と日付を渡す', async () => {
    const { app, deps } = makeApp()
    const res = await app.request(
      `/api/wishes/${TEST_ID}/pay`,
      jsonRequest('POST', { accountId: OTHER_ID, occurredOn: '2026-07-12' }),
    )
    expect(res.status).toBe(200)
    expect(deps.calls['wishes.pay']).toEqual([TEST_ID, OTHER_ID, '2026-07-12'])
  })
})

describe('月次収支', () => {
  it('PUT は 200 を返す', async () => {
    const { status, body } = await call(
      '/api/monthly-balances/2026-07',
      jsonRequest('PUT', { income: 300_000, expense: 230_000 }),
    )
    expect(status).toBe(200)
    expect(body).toEqual({
      id: TEST_ID,
      yearMonth: '2026-07',
      income: 300_000,
      expense: 230_000,
      surplus: 70_000,
    })
  })

  // 形式の誤りは組み立て直す話、範囲外は値を見直す話。対処がまるで違う。
  it('形が違えば 400', async () => {
    for (const raw of ['2026-7', '202607', 'abc-de']) {
      const { status, body } = await call(
        `/api/monthly-balances/${raw}`,
        jsonRequest('PUT', { income: 1, expense: 1 }),
      )
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_YEAR_MONTH')
    }
  })

  it('形は合っていて範囲外なら 422', async () => {
    const { status, body } = await call(
      '/api/monthly-balances/2026-13',
      jsonRequest('PUT', { income: 1, expense: 1 }),
    )
    expect(status).toBe(422)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_YEAR_MONTH')
  })
})

describe('取引履歴', () => {
  it('limit を渡す', async () => {
    const { app, deps } = makeApp()
    await app.request('/api/transactions?limit=5', authed())
    expect(deps.calls['transactions.list']).toEqual([5])

    await app.request('/api/transactions', authed())
    expect(deps.calls['transactions.list']).toEqual([0])
  })

  it('limit が数値でなければ 400', async () => {
    const { status, body } = await call('/api/transactions?limit=abc')
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_LIMIT')
  })

  it('limit が負なら 400', async () => {
    const { status } = await call('/api/transactions?limit=-1')
    expect(status).toBe(400)
  })
})

// 形式の誤り（400）は組み立て直す話、業務ルール違反（422）は値や状態を
// 見直す話で、クライアント側の対処がまるで違う（不変条件13）。
describe('エラーの対応づけ', () => {
  it('DomainError は 422', async () => {
    const { app } = makeApp({
      accounts: {
        ...stubDeps().accounts,
        create: async () => {
          throw domainError('INVALID_ACCOUNT_KIND')
        },
      },
    })
    const res = await app.request(
      '/api/accounts',
      jsonRequest('POST', { name: 'x', kind: 'crypto', balance: 0 }),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: { code: 'INVALID_ACCOUNT_KIND', message: '口座種別が不正です' },
    })
  })

  it('NotFoundError は 404', async () => {
    const { app } = makeApp({
      wishes: {
        ...stubDeps().wishes,
        commit: async () => {
          throw new NotFoundError('ウィッシュ')
        },
      },
    })
    const res = await app.request(`/api/wishes/${TEST_ID}/commit`, authed({ method: 'POST' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '対象が見つかりません' },
    })
  })

  it('ConflictError は 409', async () => {
    const { app } = makeApp({
      wishes: {
        ...stubDeps().wishes,
        commit: async () => {
          throw new ConflictError()
        },
      },
    })
    const res = await app.request(`/api/wishes/${TEST_ID}/commit`, authed({ method: 'POST' }))
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'CONFLICT' },
    })
  })

  // 内部の事情はクライアントに出さない。
  it('想定外の失敗は 500 で、原因を返さない', async () => {
    const { app } = makeApp({
      dashboard: {
        get: async () => {
          throw new Error('DB のパスワードが違います')
        },
      },
    })
    const res = await app.request('/api/dashboard', authed())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'サーバー内部でエラーが発生しました' },
    })
  })

  it('本文が空なら 400', async () => {
    const res = await createApp(stubDeps()).request(
      '/api/accounts',
      authed({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    )
    expect(res.status).toBe(400)
  })

  it('本文が JSON でなければ 400', async () => {
    const res = await createApp(stubDeps()).request(
      '/api/accounts',
      authed({ method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } }),
    )
    expect(res.status).toBe(400)
  })

  it('本文が配列なら 400', async () => {
    const res = await createApp(stubDeps()).request('/api/accounts', jsonRequest('POST', [1, 2]))
    expect(res.status).toBe(400)
  })

  it('知らない経路は 404', async () => {
    const { status } = await call('/api/unknown')
    expect(status).toBe(404)
  })
})
