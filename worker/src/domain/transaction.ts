import { domainError } from './errors'
import { isZeroMoney, type Money } from './money'
import type { IsoDate } from './time'

export const TRANSACTION_KINDS = [
  // 貸し借りの2種は**もう新しく作られない。** 貸し借りは口座残高を動かさなくなった
  // ため（不変条件4）。2026-07-30 より前に作られた行を復元するために残して
  // ある。ここから消すと、既存の履歴が読めなくなる。
  'lending_created', // 貸し借りの発生。口座から出る
  'lending_collected', // 貸し借りの精算。口座に戻る
  'wish_paid', // ウィッシュの支払い。口座から出る
  'adjustment', // 残高の手動調整
] as const

/** DB の CHECK 制約と同じ値を持つ。 */
export type TransactionKind = (typeof TRANSACTION_KINDS)[number]

export function isTransactionKind(v: string): v is TransactionKind {
  return (TRANSACTION_KINDS as readonly string[]).includes(v)
}

/** 参照先（貸し借り・ウィッシュ）を必ず伴う種別か。adjustment だけが参照先を持たない。 */
export function requiresReference(kind: TransactionKind): boolean {
  return kind !== 'adjustment'
}

/**
 * 口座残高が動いた記録。
 *
 * 残高の裏付けを後から追うためのもので、実質資産の計算には使わない
 *（実質資産は accounts.balance から出す）。したがって、この型に
 * 集計のためのメソッドは持たせない。
 */
export class Transaction {
  readonly id: string
  readonly accountId: string
  /** 符号付き。口座から出るときは負、戻るときは正。 */
  readonly amount: Money
  readonly kind: TransactionKind
  /**
   * 貸し借りまたはウィッシュの ID。adjustment のときだけ null。
   * 参照先が2種類あるため DB では外部キーを張れない（docs/design.md 2.3）。
   */
  readonly refId: string | null
  readonly occurredOn: IsoDate

  private constructor(
    id: string,
    accountId: string,
    amount: Money,
    kind: TransactionKind,
    refId: string | null,
    occurredOn: IsoDate,
  ) {
    this.id = id
    this.accountId = accountId
    this.amount = amount
    this.kind = kind
    this.refId = refId
    this.occurredOn = occurredOn
  }

  /**
   * 取引履歴を生成する。
   *
   * amount が 0 なら投げる。残高が動かない記録に意味は無い。
   * kind が不正なら投げる。
   * adjustment 以外で refId が null なら投げる。参照先を失った履歴は、
   * 後から何の取引だったか辿れなくなる。
   */
  static create(
    id: string,
    accountId: string,
    amount: Money,
    kind: TransactionKind,
    refId: string | null,
    occurredOn: IsoDate,
  ): Transaction {
    if (isZeroMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (!isTransactionKind(kind)) throw domainError('INVALID_TRANSACTION_KIND')
    if (requiresReference(kind) && refId === null) throw domainError('MISSING_REFERENCE')
    // adjustment に参照先を持たせない。渡されても落とす。
    return new Transaction(id, accountId, amount, kind, requiresReference(kind) ? refId : null, occurredOn)
  }

  /** DB から復元する。kind は CHECK 制約をすり抜けた値を通さないため検証する。 */
  static restore(
    id: string,
    accountId: string,
    amount: Money,
    kind: string,
    refId: string | null,
    occurredOn: IsoDate,
  ): Transaction {
    if (!isTransactionKind(kind)) throw domainError('INVALID_TRANSACTION_KIND')
    return new Transaction(id, accountId, amount, kind, refId, occurredOn)
  }
}
