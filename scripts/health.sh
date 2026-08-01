#!/usr/bin/env bash
# セッション開始時に、リポジトリの健全性を数秒で見る。
#
# **直すのが目的ではなく、気付くのが目的。** 出た項目をその場で直させると、
# ユーザーが本来やりたかった作業が始まらない。ここでは事実だけを並べる。
#
# 「週に1回まとめてリファクタする」より、開くたびに小さく気付くほうが、
# 溜まらない。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 0

notes=()

# --- 未マージのまま置き去りになっていないか --------------------------------

if command -v gh >/dev/null 2>&1; then
  open_prs=$(gh pr list --state open --json number,title --jq \
    '.[] | "  #\(.number) \(.title)"' 2>/dev/null)
  [ -n "$open_prs" ] && notes+=("未マージの PR:"$'\n'"$open_prs")
fi

# --- 作業が中途半端に残っていないか ----------------------------------------

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null | head -5)
if [ -n "$dirty" ]; then
  count=$(git status --porcelain | wc -l | tr -d ' ')
  notes+=("コミットされていない変更が ${count} 件（${branch}）")
fi

if [ "$branch" != "main" ] && [ -n "$branch" ]; then
  ahead=$(git rev-list --count main.."$branch" 2>/dev/null)
  [ "${ahead:-0}" -gt 0 ] && notes+=("${branch} が main より ${ahead} コミット先行している")
fi

# --- 制約が破れていないか ---------------------------------------------------

if ! constraints=$(./scripts/check-constraints.sh 2>&1); then
  notes+=("制約チェックに違反あり（npm run constraints で詳細）:"$'\n'"$(echo "$constraints" | head -12 | sed 's/^/  /')")
fi

# --- テストが実装に追いついているか ----------------------------------------

# domain のファイルにテストが無いものを挙げる。domain のテストは例外なく必須。
missing=""
for f in worker/src/domain/*.ts; do
  case "$f" in *.test.ts) continue ;; esac
  t="${f%.ts}.test.ts"
  [ -f "$t" ] || missing="${missing}  ${f}"$'\n'
done
[ -n "$missing" ] && notes+=("テストの無い domain のファイル:"$'\n'"${missing%$'\n'}")

# --- 出力 -------------------------------------------------------------------

if [ ${#notes[@]} -eq 0 ]; then
  exit 0
fi

echo "## リポジトリの状態"
echo
for n in "${notes[@]}"; do
  echo "- ${n}"
done
echo
echo "（気付きのための一覧。**ユーザーが頼んだ作業を先に進めること。**"
echo "  直すかどうかは、頼まれた作業の区切りで聞く）"
