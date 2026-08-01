import { describe, expect, it } from 'vitest'
import { acct, borrow, id, lend, wish, yen } from '../../test/support'
import type { Account } from './account'
import type { Loan } from './loan'
import { RecurringEntry } from './recurring'
import { YearMonth } from './yearMonth'
import {
  calculateBreakdown,
  calculateInvestmentTotal,
  calculateOutstandingLoans,
  netAsset,
  projectedBalance,
} from './netAsset'
import type { Wish } from './wish'

describe('calculateBreakdown', () => {
  const cases: {
    name: string
    accounts?: Account[]
    wishes?: Wish[]
    wantCash?: number
    wantCommit?: number
    wantNet?: number
  }[] = [
    {
      name: 'A-1: cash only',
      accounts: [acct('cash', 500_000), acct('cash', 300_000)],
      wantCash: 800_000,
      wantNet: 800_000,
    },
    {
      name: 'A-2: investment excluded',
      accounts: [acct('cash', 500_000), acct('investment', 400_000)],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-6: committed wish deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'committed')],
      wantCash: 500_000,
      wantCommit: 80_000,
      wantNet: 420_000,
    },
    {
      name: 'A-7: considering wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'considering')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-8: done wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'done')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-9: dropped wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'dropped')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    { name: 'A-10: all empty' },
    {
      name: 'A-11: combined dashboard example',
      accounts: [acct('cash', 910_000), acct('investment', 350_000)],
      wishes: [wish(80_000, 'committed')],
      wantCash: 910_000,
      wantCommit: 80_000,
      wantNet: 830_000,
    },
  ]

  it.each(cases)('$name', (c) => {
    const b = calculateBreakdown(c.accounts ?? [], c.wishes ?? [])
    expect(b.cashTotal).toBe(c.wantCash ?? 0)
    expect(b.commitments).toBe(c.wantCommit ?? 0)
    expect(netAsset(b)).toBe(c.wantNet ?? 0)
  })
})

describe('calculateInvestmentTotal', () => {
  it('投資区分だけを合計する', () => {
    const accounts = [acct('cash', 500_000), acct('investment', 350_000), acct('investment', 100_000)]
    expect(calculateInvestmentTotal(accounts)).toBe(450_000)
  })

  it('空なら 0', () => {
    expect(calculateInvestmentTotal([])).toBe(0)
  })
})

// 貸し借りは実質資産の外の参考値（不変条件4）。ここが壊れると、カードで
// 立て替えた分だけ資産が多く見える。
describe('calculateOutstandingLoans', () => {
  const cases: {
    name: string
    loans: Loan[]
    wantLent?: number
    wantBorrowed?: number
  }[] = [
    { name: 'A-3: 未精算は全額が残高になる', loans: [lend(12_000, 0)], wantLent: 12_000 },
    { name: 'A-4: 一部精算なら残りだけ', loans: [lend(12_000, 5_000)], wantLent: 7_000 },
    { name: 'A-5: 全額精算なら 0', loans: [lend(12_000, 12_000)] },
    {
      name: 'A-12: 同じ向きは合計する',
      loans: [lend(12_000, 0), lend(8_000, 3_000)],
      wantLent: 17_000,
    },
    { name: 'A-13: 空なら 0', loans: [] },
    { name: 'A-14: 借りた分は borrowed に入る', loans: [borrow(5_000, 0)], wantBorrowed: 5_000 },
    // 差額にすると、誰にいくら貸しているのかが消える。
    {
      name: 'A-15: 貸しと借りを混ぜず、別々に持つ',
      loans: [lend(12_000, 0), borrow(5_000, 1_000)],
      wantLent: 12_000,
      wantBorrowed: 4_000,
    },
  ]

  it.each(cases)('$name', (c) => {
    expect(calculateOutstandingLoans(c.loans)).toEqual({
      lent: c.wantLent ?? 0,
      borrowed: c.wantBorrowed ?? 0,
    })
  })
})

describe('projectedBalance', () => {
  // 7月まで適用済み ＝ 8月分がこれから来る、という状態を既定にする。
  const JULY = YearMonth.of(2026, 7)
  const AUGUST = YearMonth.of(2026, 8)
  const SEPT_1 = YearMonth.of(2026, 9).firstDay()

  /** 適用済み年月を指定して定期入出金を置く。 */
  function entry(amount: number, dayOfMonth: number, appliedThrough: YearMonth = JULY) {
    return RecurringEntry.restore(id(), '定期', 'acc-1', yen(amount), dayOfMonth, appliedThrough)
  }

  it('翌月1日までに来る定期を足し引きする', () => {
    const entries = [entry(250_000, 25), entry(-80_000, 27)]
    expect(projectedBalance(yen(500_000), entries, SEPT_1)).toBe(670_000)
  })

  it('定期が無ければ今ある額のまま', () => {
    expect(projectedBalance(yen(500_000), [], SEPT_1)).toBe(500_000)
  })

  // 適用日が翌月1日より後なら、その月はまだ来ていない。
  it('翌月1日を過ぎる分は含めない', () => {
    // 8月まで適用済みで適用日が2日なら、次は 2026-09-02。9月1日時点では来ていない。
    const later = entry(250_000, 2, YearMonth.of(2026, 8))
    expect(projectedBalance(yen(500_000), [later], SEPT_1)).toBe(500_000)
  })

  // 適用日がちょうど翌月1日なら、その時点では適用済み。
  it('適用日が翌月1日ならその分は含める', () => {
    // 8月まで適用済みで適用日が1日なら、次は 2026-09-01。ちょうど境界。
    const boundary = entry(-80_000, 1, YearMonth.of(2026, 8))
    expect(projectedBalance(yen(500_000), [boundary], SEPT_1)).toBe(420_000)
  })

  // 適用日が来ているのに適用していないだけで、起きているはずのこと。
  it('未適用のまま残っている過去の分も足す', () => {
    const stale = entry(250_000, 25, YearMonth.of(2026, 6))
    // 7月分と8月分。9月分（9/25）は9月1日時点ではまだ来ていない。
    expect(projectedBalance(yen(500_000), [stale], SEPT_1)).toBe(1_000_000)
  })

  // **適用は「いつ反映するか」を変えるだけで、翌月1日時点の額は動かない。**
  // ここが壊れると「適用ボタンを押したら見込みが増えた」ように見える。
  it('適用の前後で見込みは変わらない', () => {
    const before = projectedBalance(yen(500_000), [entry(250_000, 25)], SEPT_1)
    // 8月分を適用した状態＝残高が増え、未適用が1ヶ月減る。
    const after = projectedBalance(yen(750_000), [entry(250_000, 25, AUGUST)], SEPT_1)
    expect(after).toBe(before)
  })

  // 見込みの材料は現金・預金だけ。投資は実質資産にもここにも足さない。
  it('投資は材料に入らない', () => {
    const accounts = [acct('cash', 500_000), acct('investment', 350_000)]
    const cashTotal = calculateBreakdown(accounts, []).cashTotal
    expect(projectedBalance(cashTotal, [], SEPT_1)).toBe(500_000)
  })

  it('残高が負でもそのまま返す', () => {
    expect(projectedBalance(yen(10_000), [entry(-80_000, 25)], SEPT_1)).toBe(-70_000)
  })
})
