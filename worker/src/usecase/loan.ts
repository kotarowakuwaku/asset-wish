import { Loan, type LoanDirection } from '../domain/loan'
import type { Money } from '../domain/money'
import type { IsoDate } from '../domain/time'
import type { AtomicWriter, IDGenerator, LoanRepository, WriteOperation } from './port'

/**
 * 貸し借りの手順。
 *
 * **口座残高も取引履歴も触らない（不変条件4）。** 立て替えた時点で現金が
 * 出たとは限らないため（カード払いなら引き落としはまだ）、「貸し借り ＝ 現金が
 * 出た」という決め打ちをやめた。未精算額は実質資産の外の参考値として出す。
 *
 * 書き込みが1行だけになっても AtomicWriter を通し続けているのは、精算に
 * 楽観ロックが要るため。読み取り時の精算額を条件にしないと、同時に2回
 * 精算したときに両方が未精算残高の範囲内に見えて過精算が成立する。
 * その仕組みは AtomicWriter が持っている（不変条件10）。
 */
export class LoanUsecase {
  readonly #writer: AtomicWriter
  readonly #loans: LoanRepository
  readonly #newID: IDGenerator

  constructor(writer: AtomicWriter, loans: LoanRepository, newID: IDGenerator) {
    this.#writer = writer
    this.#loans = loans
    this.#newID = newID
  }

  list(outstandingOnly: boolean): Promise<Loan[]> {
    return this.#loans.list(outstandingOnly)
  }

  /**
   * 貸し借りを登録する。口座残高は動かさない。
   *
   * direction の妥当性は domain が判定する（不正なら 422）。ここで弾くと、
   * 同じ判断が2箇所に散る。
   */
  async create(
    direction: LoanDirection,
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Promise<Loan> {
    const loan = Loan.create(
      this.#newID(),
      direction,
      counterparty,
      description,
      amount,
      occurredOn,
    )
    await this.#writer.writeAll([{ kind: 'createLoan', loan }])
    return loan
  }

  /**
   * 精算を記録する。入金先の口座は指定しない。
   *
   * 「読み取った時点から精算額が変わっていないこと」を条件に書き込む。取得と
   * 書き込みの間に別の精算が入ると、どちらも未精算残高の範囲内に見えて
   * 過精算が成立しうるため（不変条件4）。
   *
   * 精算日を受け取らないのは、記録する先が無くなったため。以前は取引履歴の
   * occurred_on に入れていたが、口座を触らなくなった今それは作られない。
   * 使わない引数を残すと「日付を渡したのに残らない」ことになる。
   */
  async settle(loanId: string, amount: Money): Promise<Loan> {
    const loan = await this.#loans.get(loanId)
    const expectedSettledAmount = loan.settledAmount
    // 精算してよいかの判定は domain が持つ。usecase は結果を書くだけ。
    loan.settle(amount)

    const ops: WriteOperation[] = [
      { kind: 'updateLoanSettled', loan, expectedSettledAmount },
    ]
    await this.#writer.writeAll(ops)
    return loan
  }

  /** 貸し借りを削除する。無ければ NotFoundError。 */
  async delete(id: string): Promise<void> {
    await this.#loans.get(id)
    await this.#loans.delete(id)
  }
}
