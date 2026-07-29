// 外部との接続まわり。
//
// 秘密情報はここでのみ読む（不変条件17）。**このリポジトリは public。**
// トークンをコードやドキュメントに書かない。1度 push すると数秒で拾われ、
// 履歴から消しても手遅れになる。

/**
 * 固定トークンの最低長。
 *
 * 単一ユーザー向けとはいえ、公開エンドポイントに短いトークンを置くと
 * 総当たりが現実的になる。
 */
export const MIN_TOKEN_LENGTH = 32

export type Config = {
  authToken: string
}

/** 設定が足りない・不正なことを表す。 */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`設定が不正: ${problems.join(' / ')}`)
    this.name = 'ConfigError'
  }
}

/**
 * env から設定を読む。不足があれば投げる。
 *
 * Go 版は起動時に検証して、駄目なら起動しなかった。Workers に起動の瞬間は
 * 無いので、リクエストのたびに検証して 500 で落とす。**認証を素通りさせない
 * ことのほうが、動くことより優先される。**
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = []
  const authToken = env.AUTH_TOKEN ?? ''

  if (authToken === '') {
    problems.push('AUTH_TOKEN が未設定')
  } else if (authToken.length < MIN_TOKEN_LENGTH) {
    problems.push(`AUTH_TOKEN が短すぎる（${MIN_TOKEN_LENGTH} 文字以上が必要）`)
  }

  if (problems.length > 0) throw new ConfigError(problems)
  return { authToken }
}
