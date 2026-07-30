import { Lending } from '../domain/lending'
import type { Money } from '../domain/money'
import type { IsoDate } from '../domain/time'
import type { AtomicWriter, IDGenerator, LendingRepository, WriteOperation } from './port'

/**
 * 立替の手順。
 *
 * **口座残高も取引履歴も触らない（不変条件4）。** 立て替えた時点で現金が
 * 出たとは限らないため（カード払いなら引き落としはまだ）、「立替 ＝ 現金が
 * 出た」という決め打ちをやめた。未回収額は実質資産の外の参考値として出す。
 *
 * 書き込みが1行だけになっても AtomicWriter を通し続けているのは、回収に
 * 楽観ロックが要るため。読み取り時の回収額を条件にしないと、同時に2回
 * 回収したときに両方が未回収残高の範囲内に見えて過回収が成立する。
 * その仕組みは AtomicWriter が持っている（不変条件10）。
 */
export class LendingUsecase {
  readonly #writer: AtomicWriter
  readonly #lendings: LendingRepository
  readonly #newID: IDGenerator

  constructor(writer: AtomicWriter, lendings: LendingRepository, newID: IDGenerator) {
    this.#writer = writer
    this.#lendings = lendings
    this.#newID = newID
  }

  list(outstandingOnly: boolean): Promise<Lending[]> {
    return this.#lendings.list(outstandingOnly)
  }

  /** 立替を登録する。口座残高は動かさない。 */
  async create(
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Promise<Lending> {
    const lending = Lending.create(this.#newID(), counterparty, description, amount, occurredOn)
    await this.#writer.writeAll([{ kind: 'createLending', lending }])
    return lending
  }

  /**
   * 回収を記録する。入金先の口座は指定しない。
   *
   * 「読み取った時点から回収額が変わっていないこと」を条件に書き込む。取得と
   * 書き込みの間に別の回収が入ると、どちらも未回収残高の範囲内に見えて
   * 過回収が成立しうるため（不変条件4）。
   *
   * 回収日を受け取らないのは、記録する先が無くなったため。以前は取引履歴の
   * occurred_on に入れていたが、口座を触らなくなった今それは作られない。
   * 使わない引数を残すと「日付を渡したのに残らない」ことになる。
   */
  async collect(lendingId: string, amount: Money): Promise<Lending> {
    const lending = await this.#lendings.get(lendingId)
    const expectedCollectedAmount = lending.collectedAmount
    // 回収してよいかの判定は domain が持つ。usecase は結果を書くだけ。
    lending.collect(amount)

    const ops: WriteOperation[] = [
      { kind: 'updateLendingCollected', lending, expectedCollectedAmount },
    ]
    await this.#writer.writeAll(ops)
    return lending
  }

  /** 立替を削除する。無ければ NotFoundError。 */
  async delete(id: string): Promise<void> {
    await this.#lendings.get(id)
    await this.#lendings.delete(id)
  }
}
