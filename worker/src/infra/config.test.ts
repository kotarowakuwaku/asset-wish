import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, MIN_TOKEN_LENGTH } from './config'

const VALID_TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH)

function envWith(authToken?: string): Env {
  return { DB: null as never, AUTH_TOKEN: authToken }
}

describe('loadConfig', () => {
  it('十分な長さのトークンがあれば通る', () => {
    expect(loadConfig(envWith(VALID_TOKEN)).authToken).toBe(VALID_TOKEN)
  })

  // 起動の瞬間が無いランタイムなので、リクエストのたびにここで落とす。
  // 認証を素通りさせないことのほうが、動くことより優先される。
  it('未設定なら投げる', () => {
    expect(() => loadConfig(envWith(undefined))).toThrow(ConfigError)
    expect(() => loadConfig(envWith(''))).toThrow(ConfigError)
  })

  // 公開エンドポイントに短いトークンを置くと総当たりが現実的になる。
  it('短すぎれば投げる', () => {
    expect(() => loadConfig(envWith('a'.repeat(MIN_TOKEN_LENGTH - 1)))).toThrow(ConfigError)
  })

  it('何が足りないかはメッセージに残す（ログ用。クライアントには返さない）', () => {
    expect(() => loadConfig(envWith(undefined))).toThrow(/AUTH_TOKEN が未設定/)
    expect(() => loadConfig(envWith('short'))).toThrow(/短すぎる/)
  })
})
