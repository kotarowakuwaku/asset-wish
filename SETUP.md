# セットアップ手順

GitHub リポジトリの作成から、最初のコミットまで。

**前提：このプロジェクトは個人アカウントで作る。** 会社の GitHub アカウント・Google アカウントは使わない。規約上の問題に加えて、退職時にリポジトリも GCP プロジェクトも失う。

---

## 1. Git のアカウント切り替えを確認する

普段が会社アカウントの場合、先にこれを済ませる。**設定済みなら 1-3 の確認だけでよい。**

### 1-1. 個人用の SSH 鍵を作る

```bash
ssh-keygen -t ed25519 -C "個人のメールアドレス" -f ~/.ssh/id_ed25519_personal
```

生成された `~/.ssh/id_ed25519_personal.pub` の中身を、個人の GitHub アカウントの Settings → SSH and GPG keys に登録する。

### 1-2. SSH のホストエイリアスを作る

`~/.ssh/config` に追記する。

```
Host github.com                              # 会社用（既存のまま）
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_work
  IdentitiesOnly yes

Host github-personal                         # 個人用のエイリアス
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  IdentitiesOnly yes
```

`github-personal` は実在するホスト名ではなく単なる別名で、接続先は `HostName` の github.com。`IdentitiesOnly yes` は必須で、これがないと会社の鍵で認証が通ってしまうことがある。

### 1-3. 動作確認

```bash
ssh -T git@github-personal
# → Hi <個人アカウント名>! と出れば成功
```

### 1-4. コミット作者情報をディレクトリ単位で切り替える

個人の開発物を置く場所を決める（例：`~/personal/`）。`~/.gitconfig` に追記する。

```
[user]
  name = 会社での名前
  email = work@company.co.jp

[includeIf "gitdir:~/personal/"]
  path = ~/.gitconfig-personal
```

`~/.gitconfig-personal` を新規作成する。

```
[user]
  name = Kotaro
  email = 個人のメールアドレス
```

**末尾のスラッシュは必須**（配下すべてに適用する意味）。

---

## 2. GitHub でリポジトリを作る

個人アカウントで、**Private** で作成する。

- リポジトリ名：任意（例 `asset-wish`）
- README、.gitignore、ライセンス：**いずれも追加しない**（こちらで用意したものを置くため）

`gh` コマンドを使う場合は、アクティブなアカウントが個人になっていることを確認してから実行する。

```bash
gh auth status          # どのアカウントがアクティブか確認
gh auth switch          # 違っていれば切り替え
gh repo create asset-wish --private
```

## 3. ローカルに用意する

```bash
mkdir -p ~/personal/asset-wish
cd ~/personal/asset-wish
git init -b main
git remote add origin git@github-personal:<自分のアカウント>/asset-wish.git
```

**リモート URL のホスト部分が `github-personal` になっていること。** ここを `github.com` にすると会社の鍵で push しようとして失敗する。

作者情報が個人のものになっているか、この時点で確認する。

```bash
git config user.email
# → 個人のメールアドレスが出ればよい
```

## 4. ディレクトリを作り、ファイルを配置する

```bash
mkdir -p .claude/skills/architecture-review
mkdir -p .github/workflows
mkdir -p docs server front infra
```

渡したファイルを以下に置く。

```
asset-wish/
├── CLAUDE.md                                    ← そのまま配置
├── .gitignore                                   ← そのまま配置
├── SETUP.md                                     ← この文書
├── .claude/
│   ├── settings.json                            ← フックの登録
│   ├── skills/
│   │   └── architecture-review/
│   │       └── SKILL.md
│   ├── hooks/
│   │   ├── check-go-fast.sh                     ← 実行権限を付けること
│   │   └── check-go-full.sh
│   └── agents/
│       └── fixer.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── requirements.md                          ← 要件定義書 v1.0
│   └── design.md                                ← 設計書 v0.1
├── server/
│   └── .golangci.yml
├── front/
└── infra/
```

## 5. Go モジュールを初期化する

```bash
cd server
go mod init github.com/<自分のアカウント>/asset-wish/server
```

## 6. `.golangci.yml` の `MODULE_PATH` を置換する

**この手順を飛ばすと depguard が一切機能しない。** レイヤ境界の強制がこのプロジェクトの要なので、必ず行う。

```bash
# server ディレクトリ内で
MODULE=$(head -1 go.mod | cut -d' ' -f2)

# macOS
sed -i '' "s|MODULE_PATH|$MODULE|g" .golangci.yml
# Linux
# sed -i "s|MODULE_PATH|$MODULE|g" .golangci.yml

grep MODULE_PATH .golangci.yml   # 何も出なければ置換完了
```

## 7. depguard が効いているか確かめる

CI に頼る前に、ローカルでわざと落としてみる。

```bash
mkdir -p internal/domain
cat > internal/domain/tmp_check.go <<'EOF'
package domain

import _ "database/sql"
EOF

golangci-lint run
# → "domain は永続化を知らない" というエラーが出れば成功

rm internal/domain/tmp_check.go
```

エラーが出ない場合は、6 の置換が効いていないか、`golangci-lint` が未インストール。

```bash
# 未インストールの場合
brew install golangci-lint
```

## 8. front を初期化する

段階6（front 実装）に入るまで後回しでよい。

```bash
cd ../
npm create vite@latest front -- --template react-ts
cd front
npm install
npm install -D vitest @vitejs/plugin-react eslint @playwright/test
npx playwright install chromium
```

`package.json` に検証をまとめたスクリプトを置く。**個別のコマンドを覚えるのではなく、これ一本を通す。**

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "check": "tsc --noEmit && eslint . && vitest run && playwright test"
}
```

`npm run check` は CI の front ジョブと同一で、AI エージェントにループを回させるときの停止条件でもある（`CLAUDE.md` のループ協議、`docs/requirements.md` 7.2）。**ローカルと CI で検証内容をずらさないこと。** ずれた瞬間に「手元では通る」が始まる。

CI の front ジョブは `front/playwright.config.ts` の有無で切り替わる。これを置くまでは型チェックのみが走る。

スマートフォンのホーム画面に置きたくなったら、`vite-plugin-pwa` で manifest と Service Worker を後付けする。初期構築では不要。

## 9. 最初のコミットと push

```bash
cd ~/personal/asset-wish
git add .
git status          # .env や鍵ファイルが含まれていないことを目視確認
git commit -m "chore: プロジェクトの初期構成とドキュメントを追加"
git push -u origin main
```

**`git status` の確認は省略しない。** 一度履歴に入った秘密情報の除去は非常に面倒になる。

## 10. ブランチ保護を設定する

GitHub のリポジトリ設定 → Rules → Rulesets（または Settings → Branches）で、`main` に対して以下を設定する。

- 直接 push を禁止し、Pull Request を必須にする
- ステータスチェック（CI）の成功を必須にする

レビュアーが自分ひとりでも PR を挟む意味はある。差分を通しで読む機会が強制的に作られることと、判断の経緯が後から追えるようになること。

---

## セットアップ後：どこから書くか

`server/internal/domain/` から。**DB も GCP も Terraform も不要**で、今すぐ書ける。

```bash
cd server
mkdir -p internal/domain
# money.go → networth.go → networth_test.go の順
go test ./internal/domain/...
```

テストケースは `docs/design.md` の 6.1 に15件挙げてある。特にケース2・6・7（投資を含めない、二重計上しない）は、このアプリの存在意義そのものを守るテストなので最優先で書く。

**先にインフラを整えようとしないこと。** アプリの中身に到達する前に消耗する。Terraform と GCP は、実運用したくなった時点で着手すればよい。

---

## 補足

### CI の構成

- `dorny/paths-filter` で `server` / `front` / `infra` の変更を判定し、該当するジョブだけ走らせる。E2E はブラウザを起動するぶん時間がかかるため、front を触っていない PR で回さない意味は大きい
- **`permissions: pull-requests: read` は必須。** 既定の `GITHUB_TOKEN` は `contents:read` のみに絞られており、これが無いと paths-filter が PR の変更ファイル一覧を取れず `Resource not accessible by integration` で初手から落ちる
- `sqlc diff` は生成コードのコミット漏れを検出する。事故が多いので入れてある
- `infra` ジョブは `terraform validate` までで、`plan` や `apply` は行わない。認証情報を CI に持たせないため

Terraform に着手するまで `infra` ジョブは走らない。

**まだ存在しない設定ファイルを前提にしたステップは、`hashFiles` で条件付きにしてある。** 現時点では `sqlc diff`（`server/sqlc.yaml` 待ち）と front の `check`（`front/playwright.config.ts` 待ち）がこれに当たる。無条件に走らせると CI が常時赤になり、「CI が赤いのはいつものこと」という状態に慣れてしまう。**検証ゲートは、赤が意味を持つ状態に保たなければ機能しない。**

### ループを回す前提の構成

`.claude/` に以下を置いてある。AI エージェントに作業させる際、人手を介さずに検証が回るようにするためのもの。

| ファイル | 役割 |
| --- | --- |
| `.claude/settings.json` | フックの登録 |
| `.claude/hooks/check-go-fast.sh` | `Write`/`Edit` の直後に `gofmt` と `go build`。壊れたまま先に進ませない |
| `.claude/hooks/check-go-full.sh` | 作業を終えようとした瞬間に `go test` / `go vet` / `golangci-lint`。落ちていれば差し戻す |
| `.claude/agents/fixer.md` | 同じエラーで2周足踏みしたときに呼ぶ、別コンテキストの担当 |

`CLAUDE.md` の「ループ協議」が完了の定義（＝チェックが緑であること）を担い、フックがそれを機械的に強制する。**片方だけでは効かない。** 規約だけならエージェントは自己申告で完了を宣言できてしまうし、フックだけでは何を直すべきかの方針が伝わらない。

### レビュースキルの使い方

`.claude/skills/` に置けば Claude Code が認識する。実装が一区切りついたタイミングで自主的に適用されるよう記述してあるが、明示的に呼びたい場合は「アーキテクチャレビューして」と伝える。

スキルは固定ではなく育てるもの。**レビューで指摘されなかった不具合を見つけたら、それをチェック項目として足す**のが一番効く。

### GCP について

段階5に入る際は、**個人の Google アカウント**でプロジェクトを作る。`gcloud` のプロファイルを分けておくと切り替えが楽になる。

```bash
gcloud config configurations create personal
gcloud config configurations activate personal
```
