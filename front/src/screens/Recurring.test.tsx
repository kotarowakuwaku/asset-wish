import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client'
import type { Account, RecurringEntry } from '../api/types'
import { Recurring } from './Recurring'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

const account: Account = {
  id: 'account-1',
  name: '生活用',
  kind: 'cash',
  balance: 500000,
  updatedAt: '2026-07-27T10:00:00Z',
  isStale: false,
}

function entry(overrides: Partial<RecurringEntry> = {}): RecurringEntry {
  return {
    id: 'rec-1',
    name: '給料',
    accountId: 'account-1',
    amount: 250000,
    dayOfMonth: 25,
    appliedThrough: '2026-07',
    ...overrides,
  }
}

function stubClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listRecurringEntries: () => Promise.resolve([]),
    listAccounts: () => Promise.resolve([account]),
    ...overrides,
  } as unknown as ApiClient
}

async function waitForForm(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText('名称')).toBeInTheDocument()
  })
}

describe('一覧', () => {
  it('名称・金額・適用日・適用済み年月を出す', async () => {
    render(
      <Recurring client={stubClient({ listRecurringEntries: () => Promise.resolve([entry()]) })} />,
    )

    await waitFor(() => {
      expect(screen.getByText('給料')).toBeInTheDocument()
    })
    const item = screen.getByRole('listitem')
    expect(item).toHaveTextContent('¥250,000')
    expect(item).toHaveTextContent('毎月25日')
    expect(item).toHaveTextContent('2026-07 まで適用済み')
  })

  // 符号がそのまま向きを表す。出金は負で届く。
  it('出金は負の金額で出る', async () => {
    render(
      <Recurring
        client={stubClient({
          listRecurringEntries: () => Promise.resolve([entry({ name: '家賃', amount: -80000 })]),
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('-¥80,000')).toBeInTheDocument()
    })
  })

  it('削除は id だけを渡す', async () => {
    const deleteRecurringEntry = vi.fn(() => Promise.resolve())
    render(
      <Recurring
        client={stubClient({
          listRecurringEntries: () => Promise.resolve([entry()]),
          deleteRecurringEntry,
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => {
      expect(deleteRecurringEntry).toHaveBeenCalledWith('rec-1')
    })
  })

  it('空なら促す文言を出す', async () => {
    render(<Recurring client={stubClient()} />)

    await waitFor(() => {
      expect(screen.getByText('定期入出金がまだありません。')).toBeInTheDocument()
    })
  })
})

describe('登録フォーム', () => {
  it('出金は負の金額で送る', async () => {
    const createRecurringEntry = vi.fn(() => Promise.resolve(entry()))
    render(<Recurring client={stubClient({ createRecurringEntry })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '家賃' } })
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '80000' } })
    fireEvent.change(screen.getByLabelText('適用日'), { target: { value: '27' } })
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => {
      expect(createRecurringEntry).toHaveBeenCalledWith({
        name: '家賃',
        accountId: 'account-1',
        amount: -80000,
        dayOfMonth: 27,
      })
    })
  })

  it('入金は正の金額で送る', async () => {
    const createRecurringEntry = vi.fn(() => Promise.resolve(entry()))
    render(<Recurring client={stubClient({ createRecurringEntry })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('どちら'), { target: { value: 'in' } })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '給料' } })
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '250000' } })
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => {
      expect(createRecurringEntry).toHaveBeenCalledWith({
        name: '給料',
        accountId: 'account-1',
        amount: 250000,
        dayOfMonth: 25,
      })
    })
  })

  it.each(['0', '32', 'abc'])('適用日 %s は送らない', async (day) => {
    const createRecurringEntry = vi.fn(() => Promise.resolve(entry()))
    render(<Recurring client={stubClient({ createRecurringEntry })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '給料' } })
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '250000' } })
    fireEvent.change(screen.getByLabelText('適用日'), { target: { value: day } })
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => {
      expect(screen.getByText('適用日は1〜31で入力してください')).toBeInTheDocument()
    })
    expect(createRecurringEntry).not.toHaveBeenCalled()
  })

  // 適用はダッシュボードから行う。残高を動かす入り口を1箇所に絞っている。
  it('この画面では適用しない', async () => {
    render(
      <Recurring client={stubClient({ listRecurringEntries: () => Promise.resolve([entry()]) })} />,
    )
    await waitForForm()

    expect(screen.queryByRole('button', { name: '適用する' })).not.toBeInTheDocument()
  })
})
