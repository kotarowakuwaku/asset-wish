import { describe, expect, it } from 'vitest'
import { entry, id, mb, SOME_DATE, txn, yen } from '../../test/support'
import { YearMonth } from './yearMonth'
import { averageSurplus, summarizeMonths } from './monthlySummary'
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

describe('averageSurplus', () => {
  // 検証したい月（2026-04〜07）がすべて「完了した月」になるように当月を置く。
  const CURRENT = YearMonth.of(2026, 8)

  it('B-1: 3ヶ月を平均する', () => {
    const bals = [
      mb(2026, 5, 300_000, 240_000), // +60k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_000)
  })

  it('B-2: 2件しか無ければ2件で平均する', () => {
    const bals = [mb(2026, 6, 300_000, 250_000), mb(2026, 7, 300_000, 230_000)]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_000)
  })

  it('B-3: 空なら null（算出不可。0 ではない）', () => {
    expect(averageSurplus([], 3, CURRENT)).toBeNull()
  })

  it('B-4: 4件あっても直近3件だけを見る', () => {
    const bals = [
      mb(2026, 4, 300_000, 300_000), // +0 （除外されるはず）
      mb(2026, 5, 300_000, 240_000), // +60k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_000)
  })

  it('B-5: 順不同で渡しても内部で整列する', () => {
    const bals = [
      mb(2026, 7, 300_000, 230_000),
      mb(2026, 5, 300_000, 240_000),
      mb(2026, 6, 300_000, 250_000),
    ]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_000)
  })

  it('B-6: 赤字1ヶ月なら負値を返す', () => {
    expect(averageSurplus([mb(2026, 7, 200_000, 250_000)], 3, CURRENT)).toBe(-50_000)
  })

  it('B-7: 割り切れないときは0方向に切り捨てる', () => {
    const bals = [
      mb(2026, 5, 300_000, 239_000), // +61k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    // 合計 181000 / 3 = 60333.33... → 60333
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_333)
  })

  it('B-8: 引数の配列を変更しない', () => {
    const bals = [
      mb(2026, 7, 300_000, 230_000),
      mb(2026, 5, 300_000, 240_000),
      mb(2026, 6, 300_000, 250_000),
    ]
    const before = bals.map((b) => b.yearMonth.toString())
    averageSurplus(bals, 3, CURRENT)
    expect(bals.map((b) => b.yearMonth.toString())).toEqual(before)
  })

  // まだ終わっていない月を混ぜると、余剰が実態より小さく見える。
  // 月初なら家賃だけ引かれて給料がまだ、という状態になる。
  it('B-9: 当月は平均に含めない', () => {
    const bals = [
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
      mb(2026, 8, 0, 80_000), // -80k（当月。まだ給料が入っていない）
    ]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(60_000)
  })

  it('B-10: 当月しか無ければ null（算出不可）', () => {
    expect(averageSurplus([mb(2026, 8, 300_000, 230_000)], 3, CURRENT)).toBeNull()
  })

  it('B-11: 未来の月も含めない', () => {
    const bals = [mb(2026, 7, 300_000, 230_000), mb(2026, 9, 300_000, 0)]
    expect(averageSurplus(bals, 3, CURRENT)).toBe(70_000)
  })
})
