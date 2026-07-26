#!/usr/bin/env bash
# Stop フック。ループにおける「評価役」。
#
# 作業を終えようとした瞬間に本チェックを走らせ、落ちていれば
# exit 2 で出力を会話に押し戻して続行させる。
# これがないと「たぶん通るはず」で完了報告される。
#
# 静かにしておくべき場面では素通しする：
#   - 直前の差し戻しからの再開（stop_hook_active）→ 無限ループ防止
#   - server 配下の Go ファイルに未コミットの変更がない（＝会話だけの往復）

set -uo pipefail

input=$(cat)

case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-.}"
server="$root/server"
[ -d "$server" ] || exit 0

changed=$(git -C "$root" status --porcelain -- server 2>/dev/null | grep -c '\.go$' || true)
[ "${changed:-0}" -eq 0 ] && exit 0

cd "$server" || exit 0

failures=""

if ! test_out=$(go test ./... 2>&1); then
  failures="${failures}
--- go test ---
$(echo "$test_out" | tail -40)"
fi

if ! vet_out=$(go vet ./... 2>&1); then
  failures="${failures}
--- go vet ---
$(echo "$vet_out" | tail -20)"
fi

# depguard によるレイヤ境界の検証を含む。不変条件5の機械的な守り手。
if command -v golangci-lint >/dev/null 2>&1; then
  if ! lint_out=$(golangci-lint run 2>&1); then
    failures="${failures}
--- golangci-lint ---
$(echo "$lint_out" | tail -40)"
  fi
else
  echo "注意: golangci-lint が PATH にないため、レイヤ境界の検証を飛ばした。" >&2
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
