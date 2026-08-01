import { useState } from 'react'
import { errorMessage } from '../api/client'

// 書き込みの状態を1箇所にまとめる。`useAsync`（読み取り側）と対になる。
//
// 同じ形——実行中フラグ、エラーの文言、try / catch / finally——が
// 画面に14回並んでいたのをここへ寄せた。**寄せる理由は行数ではなく、
// finally を1箇所にすること。** 書き忘れた画面ではボタンが押せないまま
// 戻らなくなるが、その症状からは原因が読めない。

export type SubmitState = {
  /** 実行中か。ボタンの disabled に使う。 */
  busy: boolean
  /** 失敗したときの表示用の文言。成功すると null に戻る。 */
  message: string | null
  /** 送信前の検証で弾いたときに、自分で文言を出す。 */
  setMessage: (message: string | null) => void
  submit: () => void
}

/**
 * useSubmit は書き込みを1回実行し、その状態を返す。
 *
 * 業務ルール違反（422）はサーバーの文言をそのまま出す。`errorMessage` が
 * それを引き受けており、front で言い換えない。
 *
 * 二重送信は `busy` で防ぐ。**押した瞬間に実行中へ倒すのではなく、
 * 実行中なら何もしない形にしている。** disabled は描画のタイミングに
 * 依存するので、それだけに頼ると連打を取りこぼす。
 */
export function useSubmit(
  action: () => Promise<unknown>,
  onDone?: () => void,
): SubmitState {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (busy) return
    setBusy(true)
    action()
      .then(() => {
        setMessage(null)
        onDone?.()
      })
      .catch((e: unknown) => setMessage(errorMessage(e)))
      .finally(() => setBusy(false))
  }

  return { busy, message, setMessage, submit }
}
