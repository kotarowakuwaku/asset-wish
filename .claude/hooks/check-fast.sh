#!/usr/bin/env bash
# PostToolUse(Write|Edit) フック。
#
# TypeScript を書いた直後に、秒で終わるチェックだけを回す。
# 目的は「書き終えてから壊れていたと気付く」のを防ぐこと。
# 失敗時は exit 2 で stderr を会話に押し戻し、その場で直させる。
#
# テストはここでは回さない。Stop フック（check-full.sh）の担当。

set -uo pipefail

input=$(cat)

# 触ったのが TypeScript でなければ何もしない。
# jq に依存したくないので、JSON を素朴に文字列一致で見る。
case "$input" in
  *.ts\"*|*.tsx\"*) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-.}"

# front と worker で tsconfig が別。触ったほうだけ見る。
case "$input" in
  */front/*) target="front" ;;
  *) target="worker" ;;
esac

if [ "$target" = "front" ]; then
  cd "$root/front" || exit 0
  # tsc -b は tsbuildinfo を使うため2回目以降は速い。
  if ! out=$(npx tsc -b --noEmit 2>&1); then
    {
      echo "front の型チェックに失敗:"
      echo "$out" | head -30
    } >&2
    exit 2
  fi
  exit 0
fi

cd "$root" || exit 0

# wrangler types は走らせない（遅い）。worker-configuration.d.ts は
# npm run typecheck が作り直す。ここでは既存のものを使う。
[ -f worker-configuration.d.ts ] || exit 0

if ! out=$(npx tsc --noEmit 2>&1); then
  {
    echo "worker の型チェックに失敗:"
    echo "$out" | head -30
  } >&2
  exit 2
fi

# レイヤ境界の検証を含む。不変条件5・9の機械的な守り手。
if ! out=$(npx oxlint worker 2>&1); then
  {
    echo "oxlint に失敗:"
    echo "$out" | head -30
    echo "→ no-restricted-imports で落ちたなら、ルールではなく設計を直す"
  } >&2
  exit 2
fi

exit 0
