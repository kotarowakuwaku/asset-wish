// 日付と時刻。Go 版の time.Time を用途別の branded string に置き換えたもの
//（docs/migration-cloudflare.md 10章 #3）。
//
// Date を使わないのは、Date が必ずタイムゾーンを持つため。UTC 深夜0時の Date を
// JST で表示すると前日になり、日付だけを扱いたい列で事故る。YearMonth が
// 「日・時刻・タイムゾーンを持たない」設計になっているのと同じ理由を日付にも適用する。
//
// D1 の格納形式（TEXT）とも API の受け渡し形式とも一致するため、境界での変換が消える。

/** 日付。'YYYY-MM-DD'。occurred_on / deadline に対応する。 */
export type IsoDate = string & { readonly __brand: 'IsoDate' }

/** 時刻。ISO8601 の UTC 表記。created_at / updated_at に対応する。 */
export type Instant = string & { readonly __brand: 'Instant' }

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 'YYYY-MM-DD' を解釈する。形式が違う、または存在しない日付なら null。
 *
 * 例外ではなく null を返すのは、外部入力の形式エラーが 400 であって
 * 業務ルール違反（422）ではないため（不変条件13）。判断は handler が行う。
 */
export function parseIsoDate(s: string): IsoDate | null {
  if (!ISO_DATE_PATTERN.test(s)) return null
  // 2026-02-31 のような「形式は正しいが存在しない日付」を弾く。
  // Postgres の DATE 型が担っていた検査で、TEXT には無い。
  // Date は検査にのみ使い、値としては保持しない。
  const parsed = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  if (parsed.toISOString().slice(0, 10) !== s) return null
  return s as IsoDate
}

/** Date の日付部分を UTC で取り出す。Clock からの生成に使う。 */
export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10) as IsoDate
}

/** ISO8601 を解釈する。解釈できなければ null。DB からの復元に使う。 */
export function parseInstant(s: string): Instant | null {
  const parsed = new Date(s)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString() as Instant
}

/** Date を Instant にする。必ず UTC 表記になる。 */
export function toInstant(d: Date): Instant {
  return d.toISOString() as Instant
}

/**
 * 年月部分を 'YYYY-MM' として取り出す。YearMonth.parse に渡せる。
 *
 * IsoDate も Instant も先頭が 'YYYY-MM-DD' で始まるため、どちらも受けられる。
 */
export function yearMonthOf(value: IsoDate | Instant): string {
  return value.slice(0, 7)
}

/**
 * 時刻から日付部分を取り出す。
 *
 * 定期入出金の「適用日が来たか」の判定に使う。Instant は必ず UTC 表記なので、
 * 切り出した日付も UTC。ここに動作環境のタイムゾーンは入らない。
 */
export function dateOf(instant: Instant): IsoDate {
  return instant.slice(0, 10) as IsoDate
}

/** 2つの時刻の差をミリ秒で返す。a - b。 */
export function instantDiffMillis(a: Instant, b: Instant): number {
  return Date.parse(a) - Date.parse(b)
}
