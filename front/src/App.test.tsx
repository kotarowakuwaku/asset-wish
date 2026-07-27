import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// App が持つのは画面の切り替えとトークンの保持だけ。
// 各画面の中身は screens/ のテストが見る。

// ダッシュボードだけは形のある応答を返す。一覧と同じ [] を返すと、
// 描画の途中で undefined を触って落ちる。App のテストが見たいのは
// 画面の切り替えなので、各画面が壊れない程度の応答を用意する。
const emptyDashboard = {
  netAsset: 0,
  breakdown: { cashTotal: 0, outstandingLendings: 0, commitments: 0 },
  investmentTotal: 0,
  averageSurplus: 0,
  hasAverageSurplus: false,
  wishes: [],
}

function stubFetchEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(url.includes('/api/dashboard') ? emptyDashboard : []),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    ),
  )
}

beforeEach(() => {
  localStorage.clear()
  window.location.hash = ''
  stubFetchEmpty()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('トークン未設定のとき', () => {
  it('入力を求め、画面のナビは出さない', () => {
    render(<App />)

    expect(screen.getByLabelText('トークン')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'ダッシュボード' }),
    ).not.toBeInTheDocument()
  })

  it('入力するとアプリに入る', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('トークン'), {
      target: { value: 'test-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'ダッシュボード' }),
      ).toBeInTheDocument()
    })
    // この端末にのみ保存する（docs/design.md 4.5）。
    expect(localStorage.getItem('asset-wish.token')).toBe('test-token')
  })
})

describe('トークン設定済みのとき', () => {
  beforeEach(() => {
    localStorage.setItem('asset-wish.token', 'test-token')
  })

  it('要件 5.1 の画面がすべて選べる', () => {
    render(<App />)

    for (const label of [
      'ダッシュボード',
      '口座',
      '立替',
      'ウィッシュ',
      '月次収支',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('選んだ画面が現在地として示される', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '月次収支' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '月次収支' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })
    expect(
      screen.getByRole('heading', { name: '月次収支', level: 2 }),
    ).toBeInTheDocument()
  })

  // hash で画面を持つので、直接開いた URL がそのまま効く。
  it('hash で指定した画面から始まる', () => {
    window.location.hash = '#/wishes'

    render(<App />)

    expect(screen.getByRole('button', { name: 'ウィッシュ' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('トークンを消すと入力画面に戻る', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'トークンを消す' }))

    await waitFor(() => {
      expect(screen.getByLabelText('トークン')).toBeInTheDocument()
    })
    expect(localStorage.getItem('asset-wish.token')).toBeNull()
  })
})
