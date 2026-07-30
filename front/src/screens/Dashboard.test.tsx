import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../api/client'
import type { Dashboard as DashboardData } from '../api/types'
import { Dashboard } from './Dashboard'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。
//
// ここで確かめるのは「受け取った値をどう見せるか」だけ。
// 実質資産や不足額の計算はサーバーの domain が持ち、front は
// 一切計算しない（不変条件8）。計算の正しさをここで再検証しない。

function stubClient(data: DashboardData): ApiClient {
  return {
    getDashboard: () => Promise.resolve(data),
  } as unknown as ApiClient
}

const base: DashboardData = {
  netAsset: 830000,
  breakdown: {
    cashTotal: 910000,
    commitments: 80000,
  },
  investmentTotal: 350000,
  outstandingLendings: 12000,
  averageSurplus: 65000,
  hasAverageSurplus: true,
  wishes: [],
}

describe('実質資産', () => {
  it('内訳とあわせて表示する', async () => {
    render(<Dashboard client={stubClient(base)} />)

    await waitFor(() => {
      expect(screen.getByText('¥830,000')).toBeInTheDocument()
    })
    expect(screen.getByText('¥910,000')).toBeInTheDocument()
    expect(screen.getByText('¥80,000')).toBeInTheDocument()
  })

  // 投資は実質資産に含めないため（不変条件1）、そもそも見たい値ではなかった。
  // API は返し続けるが、画面には出さない。
  it('投資資産は表示しない', async () => {
    render(<Dashboard client={stubClient(base)} />)

    await waitFor(() => {
      expect(screen.getByText('¥830,000')).toBeInTheDocument()
    })
    expect(screen.queryByText('¥350,000')).not.toBeInTheDocument()
    expect(screen.queryByText(/投資/)).not.toBeInTheDocument()
  })

  // 立替は実質資産の内訳ではない（不変条件4）。内訳の dl に混ぜると
  // 「合計に足されている」と読める。
  it('未回収の立替は内訳ではなく別枠に出す', async () => {
    render(<Dashboard client={stubClient(base)} />)

    await waitFor(() => {
      expect(screen.getByText('¥830,000')).toBeInTheDocument()
    })

    expect(
      screen.getByRole('heading', { name: '未回収の立替' }),
    ).toBeInTheDocument()
    expect(screen.getByText('¥12,000')).toBeInTheDocument()

    // 内訳に並ぶのは現金・預金と確定した支出だけ。
    const terms = screen.getAllByRole('term').map((t) => t.textContent)
    expect(terms).toEqual(['現金・預金', '確定した支出'])
  })

  // 0 を「¥0」と出すと、立替が1件あって全額回収済みなのか、
  // そもそも無いのかが読み取れない。
  it('未回収が0なら金額を出さない', async () => {
    render(<Dashboard client={stubClient({ ...base, outstandingLendings: 0 })} />)

    await waitFor(() => {
      expect(screen.getByText('未回収の立替はありません。')).toBeInTheDocument()
    })
    expect(screen.queryByText('¥0')).not.toBeInTheDocument()
  })
})

describe('平均月間余剰', () => {
  it('算出できるときは金額を出す', async () => {
    render(<Dashboard client={stubClient(base)} />)

    await waitFor(() => {
      expect(screen.getByText('¥65,000')).toBeInTheDocument()
    })
  })

  // hasAverageSurplus が false のとき averageSurplus には 0 が入るが、
  // 表示してはいけない（detailed-design 6.1）。「余剰0円」と読めてしまう。
  it('算出できないときは金額を出さない', async () => {
    render(
      <Dashboard
        client={stubClient({
          ...base,
          averageSurplus: 0,
          hasAverageSurplus: false,
        })}
      />,
    )

    await waitFor(() => {
      expect(
        screen.getByText('月次収支がまだ登録されていません。'),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText('¥0')).not.toBeInTheDocument()
  })
})

describe('ウィッシュ', () => {
  it('不足額と到達見込みを並べる', async () => {
    render(
      <Dashboard
        client={stubClient({
          ...base,
          wishes: [
            {
              id: '1',
              title: 'カメラ',
              amount: 1200000,
              category: 'item',
              status: 'considering',
              priority: 0,
              deadline: null,
              shortfall: 358000,
              monthsToReach: 6,
              monthlySavingNeeded: null,
            },
          ],
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('カメラ')).toBeInTheDocument()
    })
    expect(screen.getByText('あと¥358,000')).toBeInTheDocument()
    expect(screen.getByText('あと6ヶ月')).toBeInTheDocument()
  })

  // 算出不可を 0 として出すと「今月中に届く」と誤読される。
  it('到達見込みが null なら算出不可と出す', async () => {
    render(
      <Dashboard
        client={stubClient({
          ...base,
          wishes: [
            {
              id: '1',
              title: '旅行',
              amount: 300000,
              category: 'experience',
              status: 'committed',
              priority: 0,
              deadline: null,
              shortfall: -1000,
              monthsToReach: null,
              monthlySavingNeeded: null,
            },
          ],
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('算出不可')).toBeInTheDocument()
    })
    // 不足額が 0 以下ならすでに手が届いている。
    expect(screen.getByText('到達済み')).toBeInTheDocument()
    expect(screen.queryByText('あと0ヶ月')).not.toBeInTheDocument()
  })

  // 平均月間余剰に依存しないため、月次収支が未登録でもこちらは出せる。
  it('期限があれば毎月いくら貯めればよいかを出す', async () => {
    render(
      <Dashboard
        client={stubClient({
          ...base,
          hasAverageSurplus: false,
          averageSurplus: 0,
          wishes: [
            {
              id: '1',
              title: 'カメラ',
              amount: 1200000,
              category: 'item',
              status: 'considering',
              priority: 0,
              deadline: '2026-12-31',
              shortfall: 358000,
              monthsToReach: null,
              monthlySavingNeeded: 59667,
            },
          ],
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('毎月¥59,667')).toBeInTheDocument()
    })
    expect(screen.getByText('算出不可')).toBeInTheDocument()
  })

  // 期限が無いものに「毎月—」と出すと、欄だけあって意味が無い。
  it('期限が無ければ毎月いくらの行を出さない', async () => {
    render(
      <Dashboard
        client={stubClient({
          ...base,
          wishes: [
            {
              id: '1',
              title: 'カメラ',
              amount: 1200000,
              category: 'item',
              status: 'considering',
              priority: 0,
              deadline: null,
              shortfall: 358000,
              monthsToReach: 6,
              monthlySavingNeeded: null,
            },
          ],
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('カメラ')).toBeInTheDocument()
    })
    expect(screen.queryByText('期限までに')).not.toBeInTheDocument()
  })

  it('1件も無ければその旨を出す', async () => {
    render(<Dashboard client={stubClient(base)} />)

    await waitFor(() => {
      expect(
        screen.getByText('登録されているウィッシュはありません。'),
      ).toBeInTheDocument()
    })
  })
})
