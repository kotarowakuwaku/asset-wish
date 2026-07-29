// Money は日本円を円単位で表す。小数は扱わない。
//
// Go 版の `type Money int64` に対応する。number の安全整数は 2^53-1（約9007兆円）
// で、円単位の個人資産には十分。bigint にすると JSON 変換の各所で手当てが要る
// わりに得るものが無い。
//
// 裸の number を持ち回らないため branded type にする（不変条件11）。
// 加減算に関数を経由させているのは、`a + b` が number に戻ってしまい
// ブランドが外れるのを型で検出させるため。
export type Money = number & { readonly __brand: 'Money' }

export const ZERO_MONEY = 0 as Money

/**
 * number を Money にする。境界（DB・JSON）でのみ使う。
 *
 * 安全整数でない値は投げる。これは業務ルール違反ではなく、円に小数を
 * 渡したという呼び出し側の誤りなので DomainError にはしない。
 * 外部入力の検査は handler の責務（形式エラー＝400）。
 */
export function money(yen: number): Money {
  if (!Number.isSafeInteger(yen)) {
    throw new TypeError(`Money は安全整数の範囲の円単位の値である必要がある: ${yen}`)
  }
  return yen as Money
}

export function addMoney(a: Money, b: Money): Money {
  return (a + b) as Money
}

export function subMoney(a: Money, b: Money): Money {
  return (a - b) as Money
}

export function isPositiveMoney(m: Money): boolean {
  return m > 0
}

export function isNegativeMoney(m: Money): boolean {
  return m < 0
}

export function isZeroMoney(m: Money): boolean {
  return m === 0
}
