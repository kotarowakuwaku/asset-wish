import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from './client'

// 検証するのは通信まわりの約束事だけ。
//
//   認証ヘッダを付けるか
//   エラー本文をどう ApiError に変換するか
//   204 に本文が無いことを扱えるか
//
// 業務ルールの正しさはサーバー側のテストが担保している。
// ここで同じことを検証しない（docs/design.md 6章）。

const token = 'test-token'

function stubFetch(response: Response | Error) {
  const spy = vi.fn((_url: string, _init?: RequestInit) =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('認証', () => {
  it('Bearer トークンを付ける', async () => {
    const spy = stubFetch(jsonResponse(200, []))

    await createClient(token).listAccounts()

    const [, init] = spy.mock.calls[0]
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('401 は認証切れとして判別できる', async () => {
    stubFetch(
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: '認証が必要です' } }),
    )

    const err = await createClient(token)
      .getDashboard()
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).isUnauthorized).toBe(true)
  })
})

describe('エラーの変換', () => {
  // 422 は業務ルール違反。入力の形式は正しいので、フォームの
  // バリデーションエラーとは別に扱う必要がある。
  it('422 は業務ルール違反として判別でき、メッセージをそのまま使える', async () => {
    stubFetch(
      jsonResponse(422, {
        error: {
          code: 'COLLECT_EXCEEDS_OUTSTANDING',
          message: '回収額が未回収残高を超えています',
        },
      }),
    )

    const err = (await createClient(token)
      .collectLending('id', { amount: 1 })
      .catch((e: unknown) => e)) as ApiError

    expect(err.isDomainError).toBe(true)
    expect(err.code).toBe('COLLECT_EXCEEDS_OUTSTANDING')
    expect(err.message).toBe('回収額が未回収残高を超えています')
  })

  it('404 は業務ルール違反ではない', async () => {
    stubFetch(jsonResponse(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } }))

    const err = (await createClient(token)
      .getDashboard()
      .catch((e: unknown) => e)) as ApiError

    expect(err.status).toBe(404)
    expect(err.isDomainError).toBe(false)
  })

  // 502 などで前段が HTML を返すことがある。JSON でない本文で
  // 例外を投げると、画面に何も出せなくなる。
  it('JSON でないエラー本文でも落ちない', async () => {
    stubFetch(new Response('<html>502</html>', { status: 502 }))

    const err = (await createClient(token)
      .getDashboard()
      .catch((e: unknown) => e)) as ApiError

    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.message).toContain('502')
  })

  it('通信そのものが失敗した場合も ApiError にする', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    const err = (await createClient(token)
      .getDashboard()
      .catch((e: unknown) => e)) as ApiError

    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('NETWORK_ERROR')
  })
})

describe('レスポンスの扱い', () => {
  it('204 は本文なしとして扱う', async () => {
    stubFetch(new Response(null, { status: 204 }))

    await expect(createClient(token).deleteAccount('id')).resolves.toBeUndefined()
  })

  it('JSON をそのまま返す', async () => {
    stubFetch(jsonResponse(200, [{ id: 'a', name: '生活用' }]))

    const accounts = await createClient(token).listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe('生活用')
  })
})

describe('経路の組み立て', () => {
  it.each([
    [true, '/api/lendings?outstanding=true'],
    [false, '/api/lendings'],
  ])('未回収のみ=%s のとき %s を呼ぶ', async (outstandingOnly, wantPath) => {
    const spy = stubFetch(jsonResponse(200, []))

    await createClient(token).listLendings(outstandingOnly)

    const [url] = spy.mock.calls[0]
    expect(url).toContain(wantPath)
  })

  it('状態での絞り込みを query に載せる', async () => {
    const spy = stubFetch(jsonResponse(200, []))

    await createClient(token).listWishes('committed')

    const [url] = spy.mock.calls[0]
    expect(url).toContain('/api/wishes?status=committed')
  })

  // 状態遷移は専用の経路。PATCH に status を混ぜない（不変条件6）。
  it('状態遷移は専用の経路を呼ぶ', async () => {
    const spy = stubFetch(jsonResponse(200, {}))

    await createClient(token).commitWish('wish-id')

    const [url, init] = spy.mock.calls[0]
    expect(url).toContain('/api/wishes/wish-id/commit')
    expect(init?.method).toBe('POST')
  })
})
