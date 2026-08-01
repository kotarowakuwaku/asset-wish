import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, instantOf, yen } from '../../test/support'
import { pendingTotal } from '../domain/recurring'
import { Account } from '../domain/account'
import { RecurringEntry } from '../domain/recurring'
import { YearMonth } from '../domain/yearMonth'
import { isConflictError, isNotFoundError } from './port'
import { RecurringUsecase } from './recurring'

// 値はすべて架空のもの（不変条件17）。
const NOW = instantOf('2026-08-26T00:00:00Z')

let fakes: ReturnType<typeof newFakes>
let usecase: RecurringUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new RecurringUsecase(
    fakes.writer,
    fakes.recurring,
    fakes.accounts,
    fixedClock(NOW),
    sequentialIds(),
  )
})

function givenAccount(id: string, balance: number): Account {
  const a = Account.create(id, 'テスト口座', 'cash', yen(balance), NOW)
  fakes.accounts.seed(a)
  return a
}

/** 適用済み年月を指定して定期入出金を置く。 */
function givenEntry(
  id: string,
  name: string,
  amount: number,
  dayOfMonth: number,
  appliedThrough: string,
  accountId = 'acc-1',
): void {
  fakes.recurring.seed(
    RecurringEntry.restore(
      id,
      name,
      accountId,
      yen(amount),
      dayOfMonth,
      YearMonth.parse(appliedThrough),
    ),
  )
}

describe('create', () => {
  it('登録しても口座残高は動かない', async () => {
    givenAccount('acc-1', 500_000)

    const e = await usecase.create('給料', 'acc-1', yen(250_000), 25)

    expect(e.name).toBe('給料')
    expect(e.amount).toBe(250_000)
    // 起点は登録月。当月の適用日を過ぎていれば次の apply で当月分が入る。
    expect(e.appliedThrough.toString()).toBe('2026-07')
    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.transactions.items).toHaveLength(0)
  })

  it('存在しない口座なら NotFoundError。何も作らない', async () => {
    await expect(usecase.create('給料', 'acc-1', yen(250_000), 25)).rejects.toSatisfy(
      isNotFoundError,
    )
    expect(await usecase.list()).toEqual([])
  })

  it('金額0は domain が弾く', async () => {
    givenAccount('acc-1', 500_000)
    await expectRejectedDomainError(
      usecase.create('給料', 'acc-1', yen(0), 25),
      'INVALID_AMOUNT',
    )
  })

  it('適用日が範囲外なら domain が弾く', async () => {
    givenAccount('acc-1', 500_000)
    await expectRejectedDomainError(
      usecase.create('給料', 'acc-1', yen(250_000), 32),
      'INVALID_DAY_OF_MONTH',
    )
  })
})

describe('pending', () => {
  it('適用日を過ぎた月だけを古い順に返す', async () => {
    givenEntry('r-1', '給料', 250_000, 25, '2026-06')

    const pending = await usecase.pending()

    expect(pending.map((p) => p.month.toString())).toEqual(['2026-07', '2026-08'])
  })

  it('適用日の前なら空', async () => {
    givenEntry('r-1', '給料', 250_000, 27, '2026-07')
    expect(await usecase.pending()).toEqual([])
  })

  it('何も書き込まない', async () => {
    givenEntry('r-1', '給料', 250_000, 25, '2026-06')

    await usecase.pending()

    expect(fakes.writer.ops).toHaveLength(0)
    expect((await fakes.recurring.get('r-1')).appliedThrough.toString()).toBe('2026-06')
  })

  it('合計は符号付きで相殺される', async () => {
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')
    givenEntry('r-2', '家賃', -80_000, 25, '2026-07')

    expect(pendingTotal(await usecase.pending())).toBe(170_000)
  })
})

describe('apply', () => {
  it('残高を動かし、履歴を残し、適用済みを進める', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')

    expect(await usecase.apply()).toBe(1)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(750_000)
    expect((await fakes.recurring.get('r-1')).appliedThrough.toString()).toBe('2026-08')
    const [t] = fakes.transactions.items
    expect(t.kind).toBe('recurring_applied')
    expect(t.amount).toBe(250_000)
    expect(t.refId).toBe('r-1')
    expect(t.occurredOn).toBe('2026-08-25')
    // 名称を写しておく。定期入出金を消しても履歴が読める。
    expect(t.note).toBe('給料')
  })

  // 2ヶ月開かなかったら、開いた時点で2ヶ月分をまとめて適用する。
  it('開かなかった月をまとめて適用する', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-06')

    expect(await usecase.apply()).toBe(2)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(1_000_000)
    expect(fakes.transactions.items.map((t) => t.occurredOn)).toEqual([
      '2026-07-25',
      '2026-08-25',
    ])
    // 適用済みは最後の月まで一度に進む。
    expect((await fakes.recurring.get('r-1')).appliedThrough.toString()).toBe('2026-08')
  })

  // 同じ口座への更新を2本並べると、2本目の「読み取り時の残高」が1本目の
  // 適用後の値と食い違い、番人が必ず失敗する。
  it('同じ口座への増減は1本にまとめる', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')
    givenEntry('r-2', '家賃', -80_000, 25, '2026-07')

    expect(await usecase.apply()).toBe(2)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(670_000)
    expect(fakes.writer.ops.filter((o) => o.kind === 'updateAccount')).toHaveLength(1)
  })

  it('口座が違えば別々に更新する', async () => {
    givenAccount('acc-1', 500_000)
    givenAccount('acc-2', 100_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07', 'acc-1')
    givenEntry('r-2', '家賃', -80_000, 25, '2026-07', 'acc-2')

    await usecase.apply()

    expect((await fakes.accounts.get('acc-1')).balance).toBe(750_000)
    expect((await fakes.accounts.get('acc-2')).balance).toBe(20_000)
  })

  it('適用済みの分は二度適用しない', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')

    await usecase.apply()
    expect(await usecase.apply()).toBe(0)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(750_000)
    expect(fakes.transactions.items).toHaveLength(1)
  })

  it('未適用が無ければ何も書き込まない', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 27, '2026-07')

    expect(await usecase.apply()).toBe(0)
    expect(fakes.writer.ops).toHaveLength(0)
  })

  // 途中で切れると、残高だけ動いて「適用済み」にならず、次に開いたときに
  // 二重に適用される（不変条件10）。
  it('残高・履歴・適用済みを1回の書き込みにまとめる', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')

    await usecase.apply()

    expect(fakes.writer.ops.map((o) => o.kind)).toEqual([
      'createTransaction',
      'updateRecurringApplied',
      'updateAccount',
    ])
  })

  // 適用で怖いのは、2つのタブから同時に開いて残高が二重に動くこと。
  it('同時に適用しても残高は二重に動かない', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')

    const first = usecase.apply()
    const second = usecase.apply()

    expect(await first).toBe(1)
    await expect(second).rejects.toSatisfy(isConflictError)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(750_000)
    expect(fakes.transactions.items).toHaveLength(1)
  })
})

describe('delete', () => {
  it('消しても適用済みの履歴は残る', async () => {
    givenAccount('acc-1', 500_000)
    givenEntry('r-1', '給料', 250_000, 25, '2026-07')
    await usecase.apply()

    await usecase.delete('r-1')

    expect(await usecase.list()).toEqual([])
    expect(fakes.transactions.items).toHaveLength(1)
    // 名称は履歴側に写してあるので、消えても何だったか読める。
    expect(fakes.transactions.items[0].note).toBe('給料')
  })

  it('無ければ NotFoundError', async () => {
    await expect(usecase.delete('r-1')).rejects.toSatisfy(isNotFoundError)
  })
})
