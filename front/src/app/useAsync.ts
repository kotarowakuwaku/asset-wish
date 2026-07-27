import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'

// データ取得の状態を1箇所にまとめる。取得ライブラリは入れない。
//
// 単一ユーザーの画面で、キャッシュも楽観更新も要らない。必要なのは
// 「読み込み中か」「失敗したか」「再読み込み」の3つだけで、それは
// この30行で足りる。

export type AsyncState<T> = {
  data: T | null
  loading: boolean
  error: ApiError | null
  /** reload は再取得する。登録・更新のあとに呼ぶ。 */
  reload: () => void
}

/**
 * useAsync は fetcher を実行し、その状態を返す。
 *
 * fetcher は useCallback などで安定させて渡すこと。毎回新しい関数を
 * 渡すと、取得が止まらなくなる。
 */
export function useAsync<T>(fetcher: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    // 取得が終わる前に画面が切り替わった場合、結果を捨てる。
    // 破棄済みの画面に状態を書き込まないため。
    let alive = true

    setLoading(true)
    fetcher()
      .then((result) => {
        if (!alive) return
        setData(result)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(
          e instanceof ApiError
            ? e
            : new ApiError(0, 'UNKNOWN', '予期しないエラーが発生しました'),
        )
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [fetcher, nonce])

  return { data, loading, error, reload }
}
