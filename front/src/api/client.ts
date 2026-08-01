import type {
  Account,
  AccountKind,
  Dashboard,
  Loan,
  LoanDirection,
  MonthlySummary,
  Transaction,
  Wish,
  WishStatus,
} from './types'

// サーバーとの通信をここに閉じ込める。画面から fetch を直に呼ばない。
//
// 認証・エラー変換・基底 URL の扱いが各画面に散ると、直すときに
// 全画面を触る羽目になる。server 側で handler を1箇所に寄せているのと
// 同じ理由。

/** ApiError はサーバーが返したエラー、または通信の失敗を表す。 */
export class ApiError extends Error {
  // コンストラクタの引数プロパティ（readonly status: number）は使わない。
  // tsconfig の erasableSyntaxOnly が、型を消すだけでは実行できない
  // 構文を禁じているため。
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** 認証切れ。トークンの入れ直しを促す。 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /**
   * 業務ルール違反（422）。入力そのものは正しいので、
   * フォームの形式エラーとは別に扱う。
   */
  get isDomainError(): boolean {
    return this.status === 422
  }
}

/**
 * baseUrl は API の基底 URL。**空文字＝同一オリジン。**
 *
 * front と API は同じ Worker から配信される（docs/migration-cloudflare.md 9章）。
 * 相対パスで足りるため、環境変数での切り替えも要らない。
 *
 * ここを絶対 URL に戻すと CORS が復活する。**戻さないこと。**
 * なお、**トークンはここに含めない。** ビルド成果物に焼き込むと、
 * 配信された時点で公開される（CLAUDE.md 不変条件17）。
 */
const baseUrl = ''

type ErrorBody = { error?: { code?: string; message?: string } }

async function request<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // サーバーが落ちている、圏外、のいずれか。区別する手段がブラウザ側に
    // 無いので、まとめて扱う。同一オリジンになったため CORS で弾かれる
    // ケースは無くなった。
    throw new ApiError(0, 'NETWORK_ERROR', 'サーバーに接続できませんでした')
  }

  if (res.status === 204) {
    return undefined as T
  }

  const text = await res.text()

  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = `サーバーエラー（${res.status}）`
    try {
      const parsed = JSON.parse(text) as ErrorBody
      code = parsed.error?.code ?? code
      message = parsed.error?.message ?? message
    } catch {
      // エラー本文が JSON でない場合。502 などで前段が返すことがある。
    }
    throw new ApiError(res.status, code, message)
  }

  return JSON.parse(text) as T
}

/** createClient はトークンを固定した API クライアントを作る。 */
export function createClient(token: string) {
  const get = <T>(path: string) => request<T>(token, 'GET', path)
  const post = <T>(path: string, body?: unknown) =>
    request<T>(token, 'POST', path, body ?? {})
  const patch = <T>(path: string, body: unknown) =>
    request<T>(token, 'PATCH', path, body)
  const del = (path: string) => request<void>(token, 'DELETE', path)

  return {
    getDashboard: () => get<Dashboard>('/api/dashboard'),

    listAccounts: () => get<Account[]>('/api/accounts'),
    createAccount: (input: {
      name: string
      kind: AccountKind
      balance: number
    }) => post<Account>('/api/accounts', input),
    // kind は送れない。種別が変わると、その口座が実質資産の計算から
    // 外れるため（不変条件1）。送るとサーバーが 400 を返す。
    updateAccount: (id: string, input: { name?: string; balance?: number }) =>
      patch<Account>(`/api/accounts/${id}`, input),
    deleteAccount: (id: string) => del(`/api/accounts/${id}`),

    listLoans: (outstandingOnly: boolean) =>
      get<Loan[]>(
        `/api/loans${outstandingOnly ? '?outstanding=true' : ''}`,
      ),
    // accountId は送れない。貸し借りは口座残高を動かさない（不変条件4）。
    // 送るとサーバーが 400 を返す。
    createLoan: (input: {
      direction: LoanDirection
      counterparty: string
      description: string
      /** 向きによらず正の値。符号で「借りた」を表さない。 */
      amount: number
      occurredOn: string
    }) => post<Loan>('/api/loans', input),
    // 精算日も送れない。口座を触らないので取引履歴が作られず、残す先が無い。
    settleLoan: (id: string, input: { amount: number }) =>
      post<Loan>(`/api/loans/${id}/settle`, input),
    deleteLoan: (id: string) => del(`/api/loans/${id}`),

    listWishes: (status?: WishStatus) =>
      get<Wish[]>(`/api/wishes${status ? `?status=${status}` : ''}`),
    createWish: (input: {
      title: string
      amount: number
      category: string
      priority?: number
      deadline?: string | null
    }) => post<Wish>('/api/wishes', input),
    // status は送れない。状態遷移は専用の経路のみ（不変条件6）。
    updateWish: (
      id: string,
      input: {
        title?: string
        amount?: number
        category?: string
        priority?: number
        deadline?: string | null
      },
    ) => patch<Wish>(`/api/wishes/${id}`, input),
    commitWish: (id: string) => post<Wish>(`/api/wishes/${id}/commit`),
    payWish: (id: string, input: { accountId: string; occurredOn: string }) =>
      post<Wish>(`/api/wishes/${id}/pay`, input),
    dropWish: (id: string) => post<Wish>(`/api/wishes/${id}/drop`),
    deleteWish: (id: string) => del(`/api/wishes/${id}`),

    // 登録の経路は無い。月次の収支は明細から集計される。同じ数字を明細と
    // 月次の2箇所に入れさせないため、サーバー側から書き込みの口ごと消した。
    listMonthlySummaries: () => get<MonthlySummary[]>('/api/monthly-summaries'),

    listTransactions: () => get<Transaction[]>('/api/transactions'),
    // 金額は符号付き。出金は負、入金は正。kind は送れない（送ると 400）。
    // ここで作れるのは手入力の明細だけで、ウィッシュや貸し借りの履歴は
    // それぞれの経路が作る。
    createTransaction: (input: {
      accountId: string
      amount: number
      occurredOn: string
      note: string
    }) => post<Transaction>('/api/transactions', input),
    // 消せるのは手入力の明細だけ。それ以外はサーバーが 422 を返す。
    deleteTransaction: (id: string) => del(`/api/transactions/${id}`),
  }
}

export type ApiClient = ReturnType<typeof createClient>

/**
 * errorMessage は例外を表示用の文字列にする。
 *
 * 業務ルール違反（422）はサーバーの文言をそのまま出す。「精算額が
 * 未精算残高を超えています」のように、読んで意味が通る文言が返るため
 * front で言い換えない。
 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return e.message
  }
  return '予期しないエラーが発生しました'
}
