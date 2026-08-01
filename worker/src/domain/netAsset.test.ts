import { describe, expect, it } from 'vitest'
import { acct, borrow, lend, wish } from '../../test/support'
import type { Account } from './account'
import type { Loan } from './loan'
import {
  calculateBreakdown,
  calculateInvestmentTotal,
  calculateOutstandingLoans,
  netAsset,
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
