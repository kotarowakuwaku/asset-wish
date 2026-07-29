import { isDomainError } from '../../domain/errors'
import { ConfigError } from '../../infra/config'
import { isConflictError, isNotFoundError } from '../../usecase/port'

/**
 * 形式の誤りを表す。400 に対応する。
 *
 * 業務ルール違反（422）と区別するために型を分ける。「送られた形がおかしい」
 * のか「形は正しいが受け付けられない」のかは、クライアント側の直し方が違う。
 */
export class BadRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
  }
}

export function badRequest(code: string, message: string): BadRequestError {
  return new BadRequestError(code, message)
}

export type ErrorBody = {
  error: { code: string; message: string }
}

export type ErrorResponse = {
  status: 400 | 401 | 404 | 409 | 422 | 500
  body: ErrorBody
}

/**
 * エラーをステータスコードに対応づける。
 *
 *   形式の誤り        400
 *   認証失敗          401（middleware が直接返す）
 *   対象が無い        404
 *   競合              409
 *   業務ルール違反    422
 *   それ以外          500
 *
 * **業務ルール違反を 400 に混ぜない。** 形式は正しいが受け付けられない、という
 * 区別をクライアントに伝えるため。
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof BadRequestError) {
    return { status: 400, body: { error: { code: err.code, message: err.message } } }
  }
  if (isNotFoundError(err)) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } } }
  }
  if (isConflictError(err)) {
    return { status: 409, body: { error: { code: 'CONFLICT', message: err.message } } }
  }
  if (isDomainError(err)) {
    return { status: 422, body: { error: { code: err.code, message: err.message } } }
  }

  // 内部の事情はクライアントに出さない。原因はログに残す。
  // 設定不備（ConfigError）もここに落ちる。理由を返すと、何が足りないかを
  // 外から探れてしまう。
  const reason = err instanceof ConfigError ? err.message : String(err)
  console.error('リクエストの処理に失敗', reason)
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'サーバー内部でエラーが発生しました' } },
  }
}
