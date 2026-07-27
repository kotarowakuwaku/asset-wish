// 認証トークンの保管。
//
// localStorage に置く。XSS があれば読まれる場所だが、単一ユーザーかつ
// 自分の端末のみという前提のもとで許容する（要件定義書 6章、
// docs/design.md 4.5）。ユーザー管理・セッションは実装しない。
//
// **ビルド時の環境変数に入れない。** 静的ホスティングに置いた時点で
// 成果物ごと公開される（CLAUDE.md 不変条件17）。

const storageKey = 'asset-wish.token'

export function loadToken(): string | null {
  try {
    const token = localStorage.getItem(storageKey)
    return token && token.trim() !== '' ? token : null
  } catch {
    // プライベートモードなどで localStorage が使えない場合。
    // 未設定として扱えば、トークン入力画面に落ちるだけで済む。
    return null
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(storageKey, token.trim())
  } catch {
    // 保存できなくても、その場の操作は続けられる。
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // 消せなくても、画面上はログアウト扱いにする。
  }
}
