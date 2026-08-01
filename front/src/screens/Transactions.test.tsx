import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '../api/client'
import type { Account, Transaction, TransactionKind } from '../api/types'
import { Transactions } from './Transactions'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

const account: Account = {
  id: 'account-1',
  name: '生活用',
  kind: 'cash',
  balance: 500000,
  updatedAt: '2026-07-27T10:00:00Z',
  isStale: false,
}

function entry(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'account-1',
    amount: -3000,
    kind: 'adjustment',
    refId: null,
    occurredOn: '2026-07-12',
    note: 'コンビニ',
    ...overrides,
  }
}

function stubClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listTransactions: () => Promise.resolve([]),
    listAccounts: () => Promise.resolve([account]),
    ...overrides,
  } as unknown as ApiClient
}

/** フォームが描かれるまで待つ。口座の取得が終わらないと select が出ない。 */
async function waitForForm(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText('金額')).toBeInTheDocument()
  })
}

describe('一覧', () => {
  it('メモと金額と口座名を出す', async () => {
    render(<Transactions client={stubClient({ listTransactions: () => Promise.resolve([entry()]) })} />)

    await waitFor(() => {
      expect(screen.getByText('コンビニ')).toBeInTheDocument()
    })
    // 口座名はフォームの選択肢にも出る。一覧の中だけを見る。
    const item = screen.getByRole('listitem')
    // 符号がそのまま向きを表す。出金は負で届く。
    expect(item).toHaveTextContent('-¥3,000')
    expect(item).toHaveTextContent('生活用')
  })

  it('メモが無ければ種別を見出しにする', async () => {
    render(
      <Transactions
        client={stubClient({
          listTransactions: () => Promise.resolve([entry({ note: '' })]),
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('入出金').length).toBeGreaterThan(0)
    })
  })

  // 消せるのは手入力の明細だけ。判定はサーバーが持つが、押せる形で
  // 出しておいて 422 を見せるより、出さないほうが分かりやすい。
  it.each([
    ['adjustment', true],
    ['wish_paid', false],
    ['lending_created', false],
  ] as [TransactionKind, boolean][])('%s の削除ボタンは %s', async (kind, shown) => {
    render(
      <Transactions
        client={stubClient({
          listTransactions: () =>
            Promise.resolve([entry({ kind, refId: kind === 'adjustment' ? null : 'ref-1' })]),
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('listitem')).toBeInTheDocument()
    })
    const button = screen.queryByRole('button', { name: '削除' })
    expect(button === null).toBe(!shown)
  })

  it('削除は id だけを渡す', async () => {
    const deleteTransaction = vi.fn(() => Promise.resolve())
    render(
      <Transactions
        client={stubClient({
          listTransactions: () => Promise.resolve([entry()]),
          deleteTransaction,
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => {
      expect(deleteTransaction).toHaveBeenCalledWith('tx-1')
    })
  })

  // 業務ルール違反（422）はサーバーの文言をそのまま出す。
  it('消せない履歴のメッセージをそのまま出す', async () => {
    render(
      <Transactions
        client={stubClient({
          listTransactions: () => Promise.resolve([entry()]),
          deleteTransaction: () =>
            Promise.reject(
              new ApiError(
                422,
                'TRANSACTION_NOT_DELETABLE',
                'ウィッシュや貸し借りに紐づく履歴は削除できません',
              ),
            ),
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => {
      expect(
        screen.getByText('ウィッシュや貸し借りに紐づく履歴は削除できません'),
      ).toBeInTheDocument()
    })
  })
})

describe('入出金を打つ', () => {
  // 入力欄は常に正の数。符号は送る直前に付ける。API も domain も
  // 符号付きで統一されており、一覧も符号付きで返る。
  it('出金は負の金額で送る', async () => {
    const createTransaction = vi.fn(() => Promise.resolve(entry()))
    render(<Transactions client={stubClient({ createTransaction })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '3000' } })
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-07-12' } })
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: 'コンビニ' } })
    fireEvent.click(screen.getByRole('button', { name: '打つ' }))

    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith({
        accountId: 'account-1',
        amount: -3000,
        occurredOn: '2026-07-12',
        note: 'コンビニ',
      })
    })
  })

  it('入金は正の金額で送る', async () => {
    const createTransaction = vi.fn(() => Promise.resolve(entry({ amount: 250000 })))
    render(<Transactions client={stubClient({ createTransaction })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('どちら'), { target: { value: 'in' } })
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '250000' } })
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-07-12' } })
    fireEvent.click(screen.getByRole('button', { name: '打つ' }))

    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith({
        accountId: 'account-1',
        amount: 250000,
        occurredOn: '2026-07-12',
        note: '',
      })
    })
  })

  // 負の数を入力欄に書いて向きを表せると、select と符号のどちらが効くのかが
  // 決まらない。向きは select だけが持つ。
  it('金額が整数でなければ送らない', async () => {
    const createTransaction = vi.fn(() => Promise.resolve(entry()))
    render(<Transactions client={stubClient({ createTransaction })} />)
    await waitForForm()

    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '-3000' } })
    fireEvent.click(screen.getByRole('button', { name: '打つ' }))

    await waitFor(() => {
      expect(screen.getByText('金額は1以上の整数で入力してください')).toBeInTheDocument()
    })
    expect(createTransaction).not.toHaveBeenCalled()
  })

  // 分類（カテゴリ）は持たない。持たせると家計簿に寄る。
  it('分類を選ばせない', async () => {
    render(<Transactions client={stubClient()} />)
    await waitForForm()

    expect(screen.queryByLabelText('分類')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('カテゴリ')).not.toBeInTheDocument()
  })
})
