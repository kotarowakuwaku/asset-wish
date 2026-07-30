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

/** 回収状態。DB には保存せず、金額から導出する（不変条件12）。 */
export type CollectionStatus = 'uncollected' | 'partial' | 'collected'

/**
 * 立替。
 *
 * collectedAmount は #private にして collect() 経由に限定している。
 * 直接代入できると、過回収を拒否する検査（不変条件4）を型検査ごと迂回できる。
 * amount が readonly なのは、書き換わると未回収残高の意味が変わるため。
 */
export class Lending {
  readonly id: string
  readonly counterparty: string
  readonly description: string
  readonly amount: Money
  readonly occurredOn: IsoDate
  #collectedAmount: Money

  private constructor(
    id: string,
    counterparty: string,
    description: string,
    amount: Money,
    collectedAmount: Money,
    occurredOn: IsoDate,
  ) {
    this.id = id
    this.counterparty = counterparty
    this.description = description
    this.amount = amount
    this.occurredOn = occurredOn
    this.#collectedAmount = collectedAmount
  }

  get collectedAmount(): Money {
    return this.#collectedAmount
  }

  /**
   * 立替を生成する。collectedAmount は 0 で初期化される。
   * counterparty が空、または amount が 1 未満なら投げる。
   */
  static create(
    id: string,
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Lending {
    if (counterparty.trim() === '') throw domainError('EMPTY_COUNTERPARTY')
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    return new Lending(id, counterparty, description, amount, ZERO_MONEY, occurredOn)
  }

  /**
   * DB から復元する。
   * 過回収・負の回収額の行は CHECK 制約で入らないが、すり抜けた場合はここで止める。
   */
  static restore(
    id: string,
    counterparty: string,
    description: string,
    amount: Money,
    collectedAmount: Money,
    occurredOn: IsoDate,
  ): Lending {
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (isNegativeMoney(collectedAmount)) throw domainError('NEGATIVE_AMOUNT')
    if (collectedAmount > amount) throw domainError('COLLECT_EXCEEDS_OUTSTANDING')
    return new Lending(id, counterparty, description, amount, collectedAmount, occurredOn)
  }

  /**
   * 未回収残高。
   *
   * 実質資産には加算しない。別枠の参考値として表示するだけ（不変条件4）。
   * 過回収を拒む判定にも使う。
   */
  outstanding(): Money {
    return subMoney(this.amount, this.#collectedAmount)
  }

  isFullyCollected(): boolean {
    return isZeroMoney(this.outstanding())
  }

  /** 回収状態を導出する。 */
  status(): CollectionStatus {
    if (isZeroMoney(this.#collectedAmount)) return 'uncollected'
    if (this.#collectedAmount < this.amount) return 'partial'
    return 'collected'
  }

  /** 回収を記録する。過回収は絶対に許さない（不変条件4）。 */
  collect(amount: Money): void {
    if (!isPositiveMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (amount > this.outstanding()) throw domainError('COLLECT_EXCEEDS_OUTSTANDING')
    this.#collectedAmount = addMoney(this.#collectedAmount, amount)
  }
}
