import { useEffect, useState } from 'react'

// 画面の切り替えは hash で行う。ルーティングのライブラリは入れない。
//
// 画面は5つ、入れ子も動的な経路も無い。この規模なら、履歴 API を
// 直に触る数十行のほうが把握しやすい（CLAUDE.md「便利なライブラリで
// 済ませる前に、まず素直な実装を検討する」）。
//
// hash を選んだのは、静的ホスティングに置いたときにサーバー側の
// 書き換え設定が要らないため。/wishes を直接開いても 404 にならない。
// 戻る・進むもそのまま効く。

export const routes = [
  { path: 'dashboard', label: 'ダッシュボード' },
  { path: 'accounts', label: '口座' },
  { path: 'lendings', label: '立替' },
  { path: 'wishes', label: 'ウィッシュ' },
  { path: 'monthly-balances', label: '月次収支' },
] as const

export type RoutePath = (typeof routes)[number]['path']

const defaultRoute: RoutePath = 'dashboard'

/** parseHash は location.hash を画面名に変換する。未知の値は既定の画面。 */
export function parseHash(hash: string): RoutePath {
  const path = hash.replace(/^#\/?/, '')
  const found = routes.find((r) => r.path === path)
  return found ? found.path : defaultRoute
}

/** useRoute は現在の画面と、遷移する関数を返す。 */
export function useRoute(): [RoutePath, (path: RoutePath) => void] {
  const [route, setRoute] = useState<RoutePath>(() =>
    parseHash(window.location.hash),
  )

  useEffect(() => {
    // 戻る・進むで hash が変わったときに追随する。
    const onHashChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = (path: RoutePath) => {
    window.location.hash = `#/${path}`
    // hashchange は非同期に飛ぶため、ここでも更新しておく。
    // 同じ hash への遷移ではイベントが発火しない点にも対応できる。
    setRoute(path)
  }

  return [route, navigate]
}
