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
  /**
   * 何に使ったかの覚書。分類（カテゴリ）は持たない。
   *
   * 参照先を持つ種別では空になる。何の取引かは refId をたどれば分かるため。
   */
  readonly note: string

  private constructor(
    id: string,
    accountId: string,
    amount: Money,
    kind: TransactionKind,
    refId: string | null,
    occurredOn: IsoDate,
    note: string,
  ) {
    this.id = id
    this.accountId = accountId
    this.amount = amount
    this.kind = kind
    this.refId = refId
    this.occurredOn = occurredOn
    this.note = note
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
    note: string,
  ): Transaction {
    if (isZeroMoney(amount)) throw domainError('INVALID_AMOUNT')
    if (!isTransactionKind(kind)) throw domainError('INVALID_TRANSACTION_KIND')
    if (requiresReference(kind) && refId === null) throw domainError('MISSING_REFERENCE')
    return new Transaction(
      id,
      accountId,
      amount,
      kind,
      // adjustment に参照先を持たせない。渡されても落とす。
      requiresReference(kind) ? refId : null,
      occurredOn,
      // 参照先を持つ種別にメモを持たせない。落とす理由は参照先と同じで、
      // 「メモがあるのに手入力ではない」行を後から疑わずに済むようにするため。
      requiresReference(kind) ? '' : note,
    )
  }

  /** DB から復元する。kind は CHECK 制約をすり抜けた値を通さないため検証する。 */
  static restore(
    id: string,
    accountId: string,
    amount: Money,
    kind: string,
    refId: string | null,
    occurredOn: IsoDate,
    note: string,
  ): Transaction {
    if (!isTransactionKind(kind)) throw domainError('INVALID_TRANSACTION_KIND')
    return new Transaction(id, accountId, amount, kind, refId, occurredOn, note)
  }

  /**
   * 手で打った入出金の明細か。
   *
   * 参照先を持つ履歴（ウィッシュの支払い・過去の貸し借り）は、それぞれの
   * 操作の副産物であって、自分で打った記録ではない。**消せるのも、月次の
   * 集計に足すのも、これが true のものだけ。**
   */
  isManualEntry(): boolean {
    return !requiresReference(this.kind)
  }

  /**
   * 削除して良いかを判定する（不変条件6）。
   *
   * 消せるのは手入力の明細だけ。参照先を持つ履歴は、ウィッシュの完了や
   * 貸し借りの発生と対になっている。履歴だけ消すと、残高を戻した結果が
   * ウィッシュの状態と食い違う。
   *
   * usecase に `if (kind === 'adjustment')` を書かせないため、判定と
   * エラーの選択をここに閉じる。
   */
  ensureDeletable(): void {
    if (!this.isManualEntry()) throw domainError('TRANSACTION_NOT_DELETABLE')
  }
}
