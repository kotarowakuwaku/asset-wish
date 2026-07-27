// toBeInTheDocument などのマッチャを expect に生やす。
// import しただけで型拡張も効く。
import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// テストごとに描画した DOM を片付ける。
//
// Testing Library の自動クリーンアップは vitest の globals が有効な
// ときにしか働かない。ここを入れないと前のテストの DOM が残り、
// getByRole が「同じ名前の要素が複数ある」と言って落ちる。
// しかも落ち方が実装のせいに見えるので、原因を探す時間が丸ごと無駄になる。
afterEach(cleanup)
