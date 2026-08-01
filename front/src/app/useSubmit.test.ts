import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { useSubmit } from './useSubmit'

describe('useSubmit', () => {
  it('成功したら onDone を呼び、実行中が戻る', async () => {
    const onDone = vi.fn()
    const { result } = renderHook(() => useSubmit(() => Promise.resolve(), onDone))

    act(() => result.current.submit())

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(result.current.busy).toBe(false)
    expect(result.current.message).toBeNull()
  })

  // 業務ルール違反（422）はサーバーの文言をそのまま出す。front で言い換えない。
  it('失敗したらサーバーの文言を出す', async () => {
    const { result } = renderHook(() =>
      useSubmit(() =>
        Promise.reject(new ApiError(422, 'SETTLE_EXCEEDS_OUTSTANDING', '精算額が未精算残高を超えています')),
      ),
    )

    act(() => result.current.submit())

    await waitFor(() =>
      expect(result.current.message).toBe('精算額が未精算残高を超えています'),
    )
  })

  // finally を1箇所にするのがこのフックの目的。失敗しても押せる状態に戻す。
  it('失敗しても実行中が戻る', async () => {
    const { result } = renderHook(() =>
      useSubmit(() => Promise.reject(new ApiError(0, 'NETWORK_ERROR', '繋がりません'))),
    )

    act(() => result.current.submit())

    await waitFor(() => expect(result.current.busy).toBe(false))
  })

  it('成功すると前回の文言が消える', async () => {
    let fail = true
    const { result } = renderHook(() =>
      useSubmit(() =>
        fail ? Promise.reject(new ApiError(0, 'X', '失敗')) : Promise.resolve(),
      ),
    )

    act(() => result.current.submit())
    await waitFor(() => expect(result.current.message).toBe('失敗'))

    fail = false
    act(() => result.current.submit())
    await waitFor(() => expect(result.current.message).toBeNull())
  })

  // disabled は描画のタイミングに依存するので、それだけに頼ると連打を取りこぼす。
  it('実行中は二重に実行しない', async () => {
    let resolve: () => void = () => {}
    const action = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    const { result } = renderHook(() => useSubmit(action))

    act(() => result.current.submit())
    act(() => result.current.submit())

    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => { resolve() })
  })

  // 送信前の検証で弾いたときに、画面側から文言を出せる。
  it('外から文言を設定できる', async () => {
    const { result } = renderHook(() => useSubmit(() => Promise.resolve()))

    act(() => result.current.setMessage('金額は1以上の整数で入力してください'))

    expect(result.current.message).toBe('金額は1以上の整数で入力してください')
  })
})
