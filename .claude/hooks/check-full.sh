#!/usr/bin/env bash
# Stop フック。ループにおける「評価役」。
#
# 作業を終えようとした瞬間に本チェックを走らせ、落ちていれば
# exit 2 で出力を会話に押し戻して続行させる。
# これがないと「たぶん通るはず」で完了報告される。
#
# 静かにしておくべき場面では素通しする：
#   - 直前の差し戻しからの再開（stop_hook_active）→ 無限ループ防止
#   - TypeScript に未コミットの変更がない（＝会話だけの往復）

set -uo pipefail

input=$(cat)

case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-.}"
changed=$(git -C "$root" status --porcelain 2>/dev/null)

worker_changed=$(echo "$changed" | grep -cE '(worker/|migrations/|wrangler\.jsonc|vitest\.config\.ts|tsconfig\.json|\.oxlintrc\.json)' || true)
front_changed=$(echo "$changed" | grep -cE 'front/' || true)

[ "${worker_changed:-0}" -eq 0 ] && [ "${front_changed:-0}" -eq 0 ] && exit 0

failures=""

if [ "${worker_changed:-0}" -gt 0 ]; then
  if ! out=$(cd "$root" && WRANGLER_SEND_METRICS=false CI=1 npm run check 2>&1); then
    failures="${failures}
--- worker: npm run check ---
$(echo "$out" | tail -40)"
  fi
fi

if [ "${front_changed:-0}" -gt 0 ]; then
  if ! out=$(cd "$root/front" && npm run check 2>&1); then
    failures="${failures}
--- front: npm run check ---
$(echo "$out" | tail -40)"
  fi
fi

if [ -n "$failures" ]; then
  {
    echo "チェックが落ちている。CLAUDE.md のループ協議に従って直すこと。"
    echo "（同じエラーが2周続いたら fixer サブエージェントを呼ぶ）"
    echo "$failures"
  } >&2
  exit 2
fi

exit 0
