#!/usr/bin/env bash
# 不変条件のうち、**機械的に検出できるものだけ**を見る。
#
# 型チェックと oxlint が拾えないものを補う位置づけ。
#   - oxlint … レイヤ境界（不変条件5・9）
#   - tsc   … 型
#   - ここ  … 上の2つでは表現できない「文字列としての約束」
#
# 数秒で終わることを保つ。重い検査はテストの仕事。
#
# **検出できないものをここに書こうとしない。** grep で「それらしい行」を
# 拾うだけの検査は、偽陽性で無視されるようになり、やがて誰も見なくなる。
# 判断が要るものは docs のレビュー（/architecture-review）が受け持つ。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0

# コメント行を落とす。「なぜ使わないか」を説明した文が検出に引っかかると、
# 偽陽性が出る。**偽陽性が出る検査は、やがて誰も見なくなる。**
drop_comments() {
  grep -vE ':[[:space:]]*(\*|//|--|#)'
}

# $1 = 説明, $2 = 不変条件の番号（無ければ -）, $3... = 検出コマンド
# 検出コマンドが1行でも出力したら違反とみなす。
report() {
  local title="$1" invariant="$2"
  shift 2
  local hits
  hits=$("$@" 2>/dev/null | drop_comments)
  if [ -n "$hits" ]; then
    fail=1
    if [ "$invariant" = "-" ]; then
      echo "✗ ${title}"
    else
      echo "✗ ${title}（不変条件${invariant}）"
    fi
    echo "$hits" | sed 's/^/    /'
    echo
  fi
}

# --- 不変条件17: 秘密情報と実データ ---------------------------------------

# .dev.vars が追跡されていないこと。追跡された時点で public に出る。
# .dev.vars.example は値の入っていないテンプレートなので対象外。
tracked_secrets() {
  git ls-files ".dev.vars" ".dev.vars.local" "*.pem" "*.key"
}
report "秘密情報がコミットされている" "17" tracked_secrets

# --- 不変条件8: 計算を SQL に書かない --------------------------------------

# 集計関数を SQL に書いていないこと。計算は domain の純粋関数が持つ。
# COUNT(*) は件数であって金額の計算ではないため除く。
report "SQL に集計関数がある。計算は domain の純粋関数に置く" "8" \
  grep -rInE "(SUM|AVG|TOTAL)[[:space:]]*\(" \
    --include=*.ts worker/src/adapter/repository

# --- 不変条件11: 金額は Money 型 -------------------------------------------

# domain の外で money() を通さず as Money している箇所。境界の変換は
# repository の toMoney と handler の readMoney に限る。
report "as Money で型を作っている。境界の変換関数を通す" "11" \
  grep -rIn "as Money" --include=*.ts \
    worker/src/adapter/handler worker/src/usecase

# --- 不変条件5: domain に Date を持ち込まない ------------------------------

# time.ts の parseIsoDate だけが例外（存在しない日付の検査に使い、値としては
# 保持しない）。それ以外で new Date / Date.now を使わないこと。
report "domain で Date を使っている。タイムゾーンが日付の意味を壊す" "5" \
  grep -rIn --include=*.ts --exclude=*.test.ts --exclude=time.ts \
    -e "new Date" -e "Date\.now" worker/src/domain

# --- front: 金額の計算をしない ---------------------------------------------

# 画面で金額を足し引きしていないこと。サーバーが算出済みの値を並べるだけ。
report "front で金額を計算している。サーバーの値を並べるだけにする" "8" \
  grep -rInE "(netAsset|shortfall|surplus|outstanding|balance)[[:space:]]*[-+*/][[:space:]]*[a-zA-Z0-9_.]" \
    --include=*.tsx --include=*.ts --exclude=*.test.* front/src

# --- 文書の参照切れ ---------------------------------------------------------

# 消した文書への参照が残っていないこと。参照切れは「読めば分かる」を壊す。
report "存在しない文書を参照している" "-" \
  grep -rIn -e "docs/design\.md" -e "docs/detailed-design\.md" \
    -e "docs/migration-cloudflare\.md" -e "docs/spec-changes\.md" \
    --include=*.ts --include=*.tsx --include=*.sql --include=*.md \
    --exclude-dir=node_modules .

# --- テストの無効化 ---------------------------------------------------------

# 緑にするためにテストを飛ばしていないこと。
report "テストがスキップされている。緑にするために飛ばさない" "-" \
  grep -rInE "\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(" \
    --include=*.ts --include=*.tsx worker front/src front/e2e

if [ "$fail" -eq 0 ]; then
  echo "制約チェック: 問題なし"
fi
exit "$fail"
