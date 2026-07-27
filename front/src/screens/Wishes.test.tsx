import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '../api/client'
import type { Wish, WishStatus } from '../api/types'
import { Wishes } from './Wishes'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

function wish(status: WishStatus): Wish {
  return {
    id: 'wish-1',
    title: 'カメラ',
    amount: 120000,
    category: 'item',
    status,
    priority: 0,
    deadline: null,
  }
}

function stubClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listWishes: () => Promise.resolve([]),
    listAccounts: () => Promise.resolve([]),
    ...overrides,
  } as unknown as ApiClient
}

describe('状態ごとの操作', () => {
  // 遷移の可否はサーバーが判定する（不変条件6）。ここでの出し分けは
  // 操作の見通しのためで、防御ではない。
  it.each([
    ['considering', ['確定する', '見送る', '削除'], ['支払う']],
    ['committed', ['支払う', '見送る', '削除'], ['確定する']],
    ['done', ['削除'], ['確定する', '支払う', '見送る']],
    ['dropped', ['削除'], ['確定する', '支払う', '見送る']],
  ] as const)('%s では %j を出す', async (status, shown, hidden) => {
    render(
      <Wishes client={stubClient({ listWishes: () => Promise.resolve([wish(status)]) })} />,
    )

    await waitFor(() => {
      expect(screen.getByText('カメラ')).toBeInTheDocument()
    })
    for (const label of shown) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    for (const label of hidden) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
  })

  it('確定するとその遷移だけを呼ぶ', async () => {
    const commitWish = vi.fn(() => Promise.resolve(wish('committed')))
    render(
      <Wishes
        client={stubClient({
          listWishes: () => Promise.resolve([wish('considering')]),
          commitWish,
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '確定する' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '確定する' }))

    await waitFor(() => {
      expect(commitWish).toHaveBeenCalledWith('wish-1')
    })
  })
})

describe('エラーの表示', () => {
  // 業務ルール違反（422）はサーバーの文言をそのまま出す。
  // front で言い換えると、原因が伝わらなくなる。
  it('不正な遷移のメッセージをそのまま出す', async () => {
    render(
      <Wishes
        client={stubClient({
          listWishes: () => Promise.resolve([wish('considering')]),
          commitWish: () =>
            Promise.reject(
              new ApiError(422, 'INVALID_TRANSITION', 'この状態からは実行できない操作です'),
            ),
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '確定する' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '確定する' }))

    await waitFor(() => {
      expect(
        screen.getByText('この状態からは実行できない操作です'),
      ).toBeInTheDocument()
    })
  })
})

describe('絞り込み', () => {
  it('状態を選ぶとサーバーに渡す', async () => {
    const listWishes = vi.fn(() => Promise.resolve([]))
    render(<Wishes client={stubClient({ listWishes })} />)

    await waitFor(() => {
      expect(listWishes).toHaveBeenCalledWith(undefined)
    })

    fireEvent.click(screen.getByRole('button', { name: '確定' }))

    await waitFor(() => {
      expect(listWishes).toHaveBeenCalledWith('committed')
    })
  })
})

describe('登録フォーム', () => {
  it('金額が整数でなければ送らない', async () => {
    const createWish = vi.fn(() => Promise.resolve(wish('considering')))
    render(<Wishes client={stubClient({ createWish })} />)

    await waitFor(() => {
      expect(screen.getByLabelText('タイトル')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: 'カメラ' },
    })
    fireEvent.change(screen.getByLabelText('金額'), {
      target: { value: '12.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => {
      expect(
        screen.getByText('金額は1以上の整数で入力してください'),
      ).toBeInTheDocument()
    })
    expect(createWish).not.toHaveBeenCalled()
  })

  // 新規は必ず検討中から始まる（不変条件3）。状態を選ばせない。
  it('状態を選ばせない', async () => {
    render(<Wishes client={stubClient()} />)

    await waitFor(() => {
      expect(screen.getByLabelText('タイトル')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('状態')).not.toBeInTheDocument()
  })

  it('入力どおりに登録する', async () => {
    const createWish = vi.fn(() => Promise.resolve(wish('considering')))
    render(<Wishes client={stubClient({ createWish })} />)

    await waitFor(() => {
      expect(screen.getByLabelText('タイトル')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('タイトル'), {
      target: { value: 'カメラ' },
    })
    fireEvent.change(screen.getByLabelText('金額'), {
      target: { value: '120000' },
    })
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => {
      expect(createWish).toHaveBeenCalledWith({
        title: 'カメラ',
        amount: 120000,
        category: 'item',
        priority: 0,
        deadline: null,
      })
    })
  })
})
