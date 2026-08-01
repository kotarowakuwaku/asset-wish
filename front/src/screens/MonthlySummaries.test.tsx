import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../api/client'
import type { MonthlySummary } from '../api/types'
import { MonthlySummaries } from './MonthlySummaries'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

function summary(overrides: Partial<MonthlySummary> = {}): MonthlySummary {
  return {
    yearMonth: '2026-07',
    income: 300000,
    expense: 230000,
    surplus: 70000,
    source: 'entries',
    ...overrides,
  }
}

function stubClient(summaries: MonthlySummary[] = []): ApiClient {
  return {
    listMonthlySummaries: () => Promise.resolve(summaries),
  } as unknown as ApiClient
}

describe('一覧', () => {
  it('収入・支出・余剰を並べる', async () => {
    render(<MonthlySummaries client={stubClient([summary()])} />)

    await waitFor(() => {
      expect(screen.getByText('2026-07')).toBeInTheDocument()
    })
    const item = screen.getByRole('listitem')
    expect(item).toHaveTextContent('¥300,000')
    expect(item).toHaveTextContent('¥230,000')
    // 符号で黒字・赤字が一目で分かること（要件 F-17）。
    expect(item).toHaveTextContent('+¥70,000')
  })

  it('赤字は符号付きで出る', async () => {
    render(<MonthlySummaries client={stubClient([summary({ surplus: -3000 })])} />)

    await waitFor(() => {
      expect(screen.getByText('-¥3,000')).toBeInTheDocument()
    })
  })

  // 明細が1件も無い月は、廃止前に手入力した値で埋まる。示さないと
  // 「明細を打ったのに反映されない」ように見える。
  it('手入力で埋めた月にはバッジを出す', async () => {
    render(<MonthlySummaries client={stubClient([summary({ source: 'manual' })])} />)

    await waitFor(() => {
      expect(screen.getByText('手入力')).toBeInTheDocument()
    })
  })

  it('明細から出た月にはバッジを出さない', async () => {
    render(<MonthlySummaries client={stubClient([summary()])} />)

    await waitFor(() => {
      expect(screen.getByText('2026-07')).toBeInTheDocument()
    })
    expect(screen.queryByText('手入力')).not.toBeInTheDocument()
  })

  it('空なら促す文言を出す', async () => {
    render(<MonthlySummaries client={stubClient()} />)

    await waitFor(() => {
      expect(screen.getByText('入出金の明細がまだありません。')).toBeInTheDocument()
    })
  })
})

// 同じ数字を明細と月次の2箇所に入れさせない。手入力の経路はサーバー側にも無い。
describe('入力の経路', () => {
  it('登録フォームを出さない', async () => {
    render(<MonthlySummaries client={stubClient([summary()])} />)

    await waitFor(() => {
      expect(screen.getByText('2026-07')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('年月')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('収入')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('支出')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存する' })).not.toBeInTheDocument()
  })
})
