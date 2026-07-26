#!/usr/bin/env bash
# PostToolUse(Write|Edit) フック。
#
# Go ファイルを書いた直後に、秒で終わるチェックだけを回す。
# 目的は「書き終えてから壊れていたと気付く」のを防ぐこと。
# 失敗時は exit 2 で stderr を会話に押し戻し、その場で直させる。
#
# テストはここでは回さない。Stop フック（check-go-full.sh）の担当。

set -uo pipefail

input=$(cat)

# 触ったのが Go ファイルでなければ何もしない。
# jq に依存したくないので、JSON を素朴に文字列一致で見る。
case "$input" in
  *.go\"*) ;;
  *) exit 0 ;;
esac

server="${CLAUDE_PROJECT_DIR:-.}/server"
[ -d "$server" ] || exit 0
cd "$server" || exit 0

unformatted=$(gofmt -l . 2>&1)
if [ -n "$unformatted" ]; then
  {
    echo "gofmt が未適用:"
    echo "$unformatted"
    echo "→ cd server && gofmt -w . で直す"
  } >&2
  exit 2
fi

if ! out=$(go build ./... 2>&1); then
  {
    echo "go build に失敗:"
    echo "$out" | head -30
  } >&2
  exit 2
fi

exit 0
