import type { Context } from 'hono'
import { money, type Money } from '../../domain/money'
import { parseIsoDate, type IsoDate } from '../../domain/time'
import { badRequest } from './errors'

/** 受け付ける本文の上限。単一ユーザーの家計データに 1MB を超える本文は無い。 */
const MAX_BODY_BYTES = 1 << 20

export type JsonObject = Record<string, unknown>

/**
 * 本文を読み取る。
 *
 * 未知のフィールドを拒否する。PATCH で status を送るような「受け付けたつもりが
 * 黙って無視されていた」を防ぐため。送れない項目は、黙って落とすのではなく
 * 送れないと伝える。
 */
export async function readBody(c: Context, allowed: readonly string[]): Promise<JsonObject> {
  const length = Number(c.req.header('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    throw badRequest('BODY_TOO_LARGE', 'リクエスト本文が大きすぎます')
  }

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw badRequest('INVALID_BODY', 'リクエスト本文を解釈できません')
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('INVALID_BODY', 'リクエスト本文は JSON のオブジェクトである必要があります')
  }

  const body = raw as JsonObject
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw badRequest('INVALID_BODY', `送れない項目が含まれています: ${key}`)
    }
  }
  return body
}

/** 文字列を読む。省略時は fallback。型が違えば 400。 */
export function readString(body: JsonObject, key: string, fallback: string): string {
  const v = body[key]
  if (v === undefined) return fallback
  if (typeof v !== 'string') throw badRequest('INVALID_BODY', `${key} は文字列で指定してください`)
  return v
}

/** 省略可能な文字列を読む。キーが無ければ undefined。 */
export function readOptionalString(body: JsonObject, key: string): string | undefined {
  if (!(key in body)) return undefined
  return readString(body, key, '')
}

/**
 * 整数を読む。省略時は fallback。
 *
 * 小数や数値でない値は 400。金額に小数を渡すのは形式の誤りであって、
 * 業務ルール違反ではない。
 */
export function readInteger(body: JsonObject, key: string, fallback: number): number {
  const v = body[key]
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw badRequest('INVALID_BODY', `${key} は整数で指定してください`)
  }
  return v
}

/** 省略可能な整数を読む。キーが無ければ undefined。 */
export function readOptionalInteger(body: JsonObject, key: string): number | undefined {
  if (!(key in body)) return undefined
  return readInteger(body, key, 0)
}

/** 金額を読む。円単位の整数（不変条件11）。 */
export function readMoney(body: JsonObject, key: string, fallback: number): Money {
  return money(readInteger(body, key, fallback))
}

export function readOptionalMoney(body: JsonObject, key: string): Money | undefined {
  const v = readOptionalInteger(body, key)
  return v === undefined ? undefined : money(v)
}

/**
 * 日付を読む。'YYYY-MM-DD' 形式。
 *
 * 形式の誤りは 400。タイムゾーンを持ち込まないため、時刻付きの表現は受けない。
 */
export function readDate(body: JsonObject, key: string): IsoDate {
  return parseDateString(readString(body, key, ''), key)
}

/**
 * 期限のように「変更しない」「外す」「設定する」を区別する項目を読む。
 *
 *   キー自体が無い → undefined（変更しない）
 *   null           → null（外す）
 *   '2026-12-31'   → IsoDate（設定する）
 *
 * キーの有無を見ない実装にすると、「期限を外したい」が「変更しない」に
 * なってしまう。
 */
export function readNullableDate(body: JsonObject, key: string): IsoDate | null | undefined {
  if (!(key in body)) return undefined
  const v = body[key]
  if (v === null) return null
  if (typeof v !== 'string') {
    throw badRequest('INVALID_DATE', `${key} は文字列または null で指定してください`)
  }
  return parseDateString(v, key)
}

export function parseDateString(s: string, field: string): IsoDate {
  const d = parseIsoDate(s)
  if (d === null) {
    throw badRequest('INVALID_DATE', `${field} は YYYY-MM-DD 形式で指定してください`)
  }
  return d
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ID を解釈する。形式の誤りは 400。 */
export function parseUuid(s: string, field: string): string {
  if (!UUID_PATTERN.test(s)) {
    throw badRequest('INVALID_ID', `${field} の形式が不正です`)
  }
  return s
}

/** 本文中の ID を読む。 */
export function readUuid(body: JsonObject, key: string): string {
  return parseUuid(readString(body, key, ''), key)
}
