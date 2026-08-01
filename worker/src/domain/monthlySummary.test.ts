import { describe, expect, it } from 'vitest'
import { entry, id, mb, SOME_DATE, txn, yen } from '../../test/support'
import { summarizeMonths } from './monthlySummary'
import { Transaction } from './transaction'

// 値はすべて架空のもの（不変条件17）。

describe('summarizeMonths', () => {
  it('出金は支出に、入金は収入に足す', () => {
    const [summary] = summarizeMonths(
      [
        entry('2026-07-03', -3_000),
        entry('2026-07-25', 250_000),
        entry('2026-07-28', -12_000),
      ],
      [],
    )

    expect(summary.yearMonth.toString()).toBe('2026-07')
    expect(summary.income).toBe(250_000)
    // 支出は正で持つ。表示が「支出 15,000円」になるため。
    expect(summary.expense).toBe(15_000)
    expect(summary.surplus()).toBe(235_000)
    expect(summary.source).toBe('entries')
  })

  it('月ごとに分かれ、年月の降順で返る', () => {
    const summaries = summarizeMonths(
      [entry('2026-06-10', -1_000), entry('2026-08-01', -3_000), entry('2026-07-10', -2_000)],
      [],
    )

    expect(summaries.map((s) => s.yearMonth.toString())).toEqual(['2026-08', '2026-07', '2026-06'])
    expect(summaries.map((s) => s.expense)).toEqual([3_000, 2_000, 1_000])
  })

  // ライブ代のような臨時支出を月の余剰に混ぜると、何か買うたびに他の目標の
  // 到達見込みが悪化する（不変条件2の考え方）。
  it.each(['wish_paid', 'lending_created', 'lending_collected'] as const)(
    '%s は足さない',
    (kind) => {
      const summaries = summarizeMonths([txn('2026-07-10', -80_000, kind)], [])
      expect(summaries).toEqual([])
    },
  )

  it('手入力の明細だけを足す（混ざっていても抜き出す）', () => {
    const [summary] = summarizeMonths(
      [entry('2026-07-03', -3_000), txn('2026-07-10', -80_000, 'wish_paid')],
      [],
    )

    expect(summary.expense).toBe(3_000)
  })

  it('収入だけの月も支出だけの月も出る', () => {
    const summaries = summarizeMonths(
      [entry('2026-07-25', 250_000), entry('2026-06-03', -3_000)],
      [],
    )

    expect(summaries.map((s) => [s.income, s.expense])).toEqual([
      [250_000, 0],
      [0, 3_000],
    ])
  })

  it('明細が1件も無ければ空配列', () => {
    expect(summarizeMonths([], [])).toEqual([])
  })
})

describe('summarizeMonths（手入力での補完）', () => {
  // 明細を打ち始める前の月は手入力しか残っていない。切り捨てると、平均月間
  // 余剰が3ヶ月分貯まるまで到達見込みが出せなくなる。
  it('明細が1件も無い月は手入力の値を使う', () => {
    const summaries = summarizeMonths([entry('2026-07-03', -3_000)], [mb(2026, 5, 300_000, 240_000)])

    expect(summaries.map((s) => [s.yearMonth.toString(), s.source])).toEqual([
      ['2026-07', 'entries'],
      ['2026-05', 'manual'],
    ])
    expect(summaries[1].surplus()).toBe(60_000)
  })

  // 同じ月について両方を足すと二重計上になる。月単位でどちらか一方に決める。
  it('明細が1件でもある月は手入力を使わない', () => {
    const summaries = summarizeMonths(
      [entry('2026-07-03', -3_000)],
      [mb(2026, 7, 300_000, 240_000)],
    )

    expect(summaries).toHaveLength(1)
    expect(summaries[0].source).toBe('entries')
    expect(summaries[0].surplus()).toBe(-3_000)
  })

  it('手入力しか無ければ全部 manual で返る', () => {
    const summaries = summarizeMonths([], [mb(2026, 6, 300_000, 250_000), mb(2026, 5, 300_000, 240_000)])

    expect(summaries.map((s) => s.yearMonth.toString())).toEqual(['2026-06', '2026-05'])
    expect(summaries.every((s) => s.source === 'manual')).toBe(true)
  })
})

describe('MonthlySummary', () => {
  // 画面は符号をそのまま見て黒字・赤字の色を決める。
  it('余剰の符号が黒字・赤字を表す', () => {
    const [black] = summarizeMonths([entry('2026-07-25', 250_000)], [])
    const [red] = summarizeMonths([entry('2026-06-03', -3_000)], [])

    expect(black.surplus()).toBe(250_000)
    expect(red.surplus()).toBe(-3_000)
  })

  // 保存された行ではなく導出値。ID を付けると更新できるように見える（不変条件12）。
  it('ID を持たない', () => {
    const [summary] = summarizeMonths([entry(SOME_DATE, -3_000)], [])
    expect('id' in summary).toBe(false)
  })
})

describe('Transaction.isManualEntry', () => {
  it('adjustment だけが手入力の明細', () => {
    expect(Transaction.create(id(), id(), yen(-300), 'adjustment', null, SOME_DATE, '').isManualEntry()).toBe(true)
    for (const kind of ['wish_paid', 'lending_created', 'lending_collected'] as const) {
      expect(Transaction.create(id(), id(), yen(-300), kind, id(), SOME_DATE, '').isManualEntry()).toBe(false)
    }
  })
})
