import { domainError } from './errors'
import {
  addMoney,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  subMoney,
  ZERO_MONEY,
  type Money,
} from './money'
import type { IsoDate } from './time'

/**
 * 貸借の向き。
 *
 * 金額は向きによらず常に正で持ち、向きはこの型だけが表す。負の金額で
 * 「借りた」を表さないのは、`amount > 0` の検査を両方向に効かせ続けるため。
 * 符号に意味を持たせると、金額の妥当性と向きの判定が絡み合う。
 */
export const LOAN_DIRECTIONS = ['lent', 'borrowed'] as const

export type LoanDirection = (typeof LOAN_DIRECTIONS)[number]

export function isLoanDirection(v: string): v is LoanDirection {
  return (LOAN_DIRECTIONS as readonly string[]).includes(v)
}

/** 精算の状態。DB には保存せず、金額から導出する（不変条件12）。 */
export type SettlementStatus = 'unsettled' | 'partial' | 'settled'

/**
 * 貸借。貸した金と借りた金の両方を表す。
 *
 * settledAmount は #private にして settle() 経由に限定している。
 * 直接代入できると、過精算を拒否する検査（不変条件4）を型検査ごと迂回できる。
 * amount が readonly なのは、書き換わると未精算残高の意味が変わるため。
 * direction が readonly なのは、向きが変われば貸しと借りが入れ替わるため。
 */
export class Loan {
  readonly id: string
  readonly direction: LoanDirection
  readonly counterparty: string
  readonly description: string
  readonly amount: Money
  readonly occurredOn: IsoDate
  #settledAmount: Money

  private constructor(
    id: string,
    direction: LoanDirection,
    counterparty: string,
    description: string,
    amount: Money,
    settledAmount: Money,
    occurredOn: IsoDate,
  ) {
    this.id = id
    this.direction = direction
    this.counterparty = counterparty
    this.description = description
    this.amount = amount
    this.occurredOn = occurredOn
    this.#settledAmount = settledAmount
  }

  get settledAmount(): Money {
    return this.#settledAmount
  }

  /**
   * 貸借を生成する。settledAmount は 0 で初期化される。
   * counterparty が空、amount が 1 未満、direction が不正なら投げる。
   */
  static create(
    id: string,
    direction: LoanDirection,
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Loan {
    if (!isLoanDirection(direction)) throw domainError('INVALID_LOAN_DIRECTION')
    if (counterparty.trim() === '') throw domainError('EMPTY_COUNTERPARTY')
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    return new Loan(id, direction, counterparty, description, amount, ZERO_MONEY, occurredOn)
  }

  /**
   * DB から復元する。
   *
   * 過精算・負の精算額・不正な向きの行は CHECK 制約で入らないが、すり抜けた
   * 場合はここで止める。CHECK 制約をすり抜けた値を domain に渡さないための
   * 最後の関門（docs/design.md「D1 の扱い」）。
   */
  static restore(
    id: string,
    direction: string,
    counterparty: string,
    description: string,
    amount: Money,
    settledAmount: Money,
    occurredOn: IsoDate,
  ): Loan {
    if (!isLoanDirection(direction)) throw domainError('INVALID_LOAN_DIRECTION')
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (isNegativeMoney(settledAmount)) throw domainError('NEGATIVE_AMOUNT')
    if (settledAmount > amount) throw domainError('SETTLE_EXCEEDS_OUTSTANDING')
    return new Loan(id, direction, counterparty, description, amount, settledAmount, occurredOn)
  }

  /**
   * 未精算残高。
   *
   * 実質資産には加算しない。向きごとに集計して、別枠の参考値として表示する
   * だけ（不変条件4）。過精算を拒む判定にも使う。
   */
  outstanding(): Money {
    return subMoney(this.amount, this.#settledAmount)
  }

  isFullySettled(): boolean {
    return isZeroMoney(this.outstanding())
  }

  /** 精算の状態を導出する。 */
  status(): SettlementStatus {
    if (isZeroMoney(this.#settledAmount)) return 'unsettled'
    if (this.#settledAmount < this.amount) return 'partial'
    return 'settled'
  }

  /**
   * 精算を記録する。貸した側では回収、借りた側では返済にあたる。
   *
   * 向きによって処理は変わらない。**どちらも「未精算残高が減る」だけ**で、
   * 口座残高は動かない（不変条件4）。向きで分岐させると、同じ計算が2本に
   * 増えて片方だけ直す事故が起きる。
   *
   * 過精算は絶対に許さない（不変条件4）。
   */
  settle(amount: Money): void {
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (amount > this.outstanding()) throw domainError('SETTLE_EXCEEDS_OUTSTANDING')
    this.#settledAmount = addMoney(this.#settledAmount, amount)
  }
}
