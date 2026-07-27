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
  name = kotarowakuwaku
  email = 103411974+kotarowakuwaku@users.noreply.github.com
```

**末尾のスラッシュは必須**（配下すべてに適用する意味）。

**メールアドレスには GitHub の noreply アドレスを使う。** このリポジトリは public であり、コミットの Author はそのまま公開される。実アドレスを入れると `git log` から誰でも読める。noreply でも GitHub 上の紐付け（コントリビューショングラフ、アバター表示）は正しく働く。

自分の noreply アドレスは GitHub の Settings → Emails で確認できる（`<ID>+<ユーザー名>@users.noreply.github.com` の形式）。同じ画面で以下も有効にしておく。

- **Keep my email addresses private**
- **Block command line pushes that expose my email** — 実アドレスでコミットした場合に push 自体を止めてくれる。事故を後から履歴書き換えで直すのは高くつくので、入口で止める

---

## 2. GitHub でリポジトリを作る

個人アカウントで、**Public** で作成する。

- リポジトリ名：任意（例 `asset-wish`）
- README、.gitignore、ライセンス：**いずれも追加しない**（こちらで用意したものを置くため）

`gh` コマンドを使う場合は、アクティブなアカウントが個人になっていることを確認してから実行する。

```bash
gh auth status          # どのアカウントがアクティブか確認
gh auth switch          # 違っていれば切り替え
gh repo create asset-wish --public
```

### なぜ public か

**GitHub Actions の実行時間が無制限で無料になる。** private だと Free プランは月2,000分で、しかもジョブごとに分単位で切り上げられる。このプロジェクトは AI エージェントにループを回させる前提であり、CI を回す回数が読めない。分数を気にしながら検証を削るのは本末転倒なので、public を選ぶ。

副次的に、**secret scanning と push protection が無料で使える**（有効化は後述）。

### public であることの代償

**秘密情報の事故が即座に致命的になる。** private なら気付いて消せば済むが、public リポジトリは bot が数秒でスクレイプする。このアプリは最終的に自分の資産額を扱い、認証は環境変数の固定トークン1本（設計書 4.5）なので、**それが1度でも漏れたら他人に資産を読まれる。**

そのため、以下を必ず有効にする。

```bash
gh api -X PATCH repos/<自分のアカウント>/asset-wish \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

**push protection が本命。** 検出ではなく、そもそも push させない。`.gitignore` は「うっかり `git add .` した」を防げないが、これは防げる。

コードとドキュメントには実データを一切置かない。金額も口座名も人名も、すべて DB 側にある。この境界を崩さない限り、public であることのリスクは秘密情報の事故だけに閉じる。

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

## 8. front（構築済み。クローン後に必要な作業のみ）

Vite + React + TypeScript の SPA として構築済み。リポジトリをクローンした環境では以下を行う。

```bash
cd front
npm ci
npx playwright install chromium
```

### Linux / WSL では OS 側のライブラリも要る

`npx playwright install chromium` はブラウザ本体を落とすだけで、それが依存する共有ライブラリ（`libnspr4` など）は入らない。無いと `error while loading shared libraries: libnspr4.so` で起動に失敗する。**sudo が要るため手動で実行する。**

```bash
sudo npx playwright install-deps chromium
```

macOS では不要。CI では `--with-deps` を付けているので自動で入る。

### 検証は `npm run check` 一本

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview --port 4173 --strictPort",
  "typecheck": "tsc -b --noEmit",
  "lint": "oxlint",
  "test": "vitest run",
  "e2e": "playwright test",
  "check": "npm run typecheck && npm run lint && npm run test && npm run e2e"
}
```

**個別のコマンドを覚えるのではなく、これ一本を通す。** `npm run check` は CI の front ジョブと同一で、AI エージェントにループを回させるときの停止条件でもある（`CLAUDE.md` のループ協議、`docs/requirements.md` 7.2）。**ローカルと CI で検証内容をずらさないこと。** ずれた瞬間に「手元では通る」が始まる。

linter は eslint ではなく **oxlint**。Vite のテンプレートが同梱しており、eslint より桁違いに速い。lint はループの1周ごとに走るため、ここの実行時間が周回速度に直結する（`docs/requirements.md` 9.1 #12）。

E2E は dev サーバーではなく `npm run build && npm run preview` の成果物に対して実行する。実際に配信するのはビルド結果なので、検証対象を本番と揃える。

スマートフォンのホーム画面に置きたくなったら、`vite-plugin-pwa` で manifest と Service Worker を後付けする。現時点では不要。

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
- ブランチの削除と force push を禁止する
- **必須ステータスチェックには `ci` を指定する。** 個別のジョブ名（`server` / `front`）を指定しない

レビュアーが自分ひとりでも PR を挟む意味はある。差分を通しで読む機会が強制的に作られることと、判断の経緯が後から追えるようになること。

### 必須チェックに `ci` を使う理由

`server` / `front` / `infra` は paths フィルタで skip されうる。一方で `changes`（paths-filter そのもの）を必須にすると、**テストが落ちていてもマージできてしまう。** 実際に一度この状態になっていた。

そこで、全ジョブの結果を集約する `ci` ジョブを置き、保護ルールからはこれだけを参照する。skip は通過扱い、それ以外の非 success は落とす。

**CI にジョブを追加したら、`ci` ジョブの `needs` にも必ず足すこと。** 忘れるとそのジョブは保護の対象外になり、静かに検証の網から漏れる。落ちているのに気付けない検証は、無いより悪い。

---

## 11. ローカル DB を用意する（段階2以降）

段階1（`domain`）までは DB 不要だった。段階2からは要る。

ツールの版は `mise.toml` に固定してある。クローン直後は次で揃う。

```bash
mise install     # sqlc 1.27.0 / goose 3.27.3
```

### 11-1. Docker を入れる

WSL2 の Ubuntu に docker engine を入れる。Docker Desktop は要らない。

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
# グループ変更を反映するため WSL を再起動する（PowerShell から wsl --shutdown）
```

**イメージは `postgres:16` を使う。** Ubuntu 26.04 の apt が入れる PostgreSQL は 18 で、CI の `services.postgres`（16）とずれる。手元と CI でバージョンが違うと、`手元では通るのに CI で落ちる` が起きたときに原因の切り分けができなくなる。Docker を挟むのはこれを避けるため。

### 11-2. 起動してマイグレーションを流す

```bash
cd server
docker compose up -d

export DATABASE_URL='postgres://test:test@localhost:5432/test?sslmode=disable'
goose -dir db/migrations postgres "$DATABASE_URL" up
goose -dir db/migrations postgres "$DATABASE_URL" status
```

### 11-3. スキーマが本当に流れるかを検証する

`server/db/embed_test.go` が、まっさらな DB にマイグレーションを適用して戻すところまでを確かめる。

```bash
go test ./db/...
```

**`DATABASE_URL` が未設定なら SKIP する。** 段階1までと同じく「DB 無しで `go test ./...` が通る」状態を壊さないため。CI では `services.postgres` と `DATABASE_URL` が用意されているので、そこでは実際に走る。

このテストは `DROP SCHEMA public CASCADE` を実行する。**接続先が localhost でなければ失敗させている。** Neon の本番 URL を export したまま `go test` を打つ事故は、放っておけばいずれ必ず起きるため。

sqlc のパーサを通ることは構文の正しさしか保証しない。CHECK 制約に IMMUTABLE でない関数を書いた、といった意味解析のエラーは実物に流して初めて出る。**ここが段階2の検証ゲートになる。**

資格情報 `test:test` はローカル専用の使い捨て。**本番の接続文字列は環境変数から読む**（`CLAUDE.md` 不変条件17）。`compose.yaml` に書いてよいのは、この値が漏れても何も起きないから。

### 11-4. スキーマを変えたとき

```bash
goose -dir db/migrations create <名前> sql   # 新しいマイグレーションを作る
sqlc generate                                # 生成コードを作り直す
sqlc diff                                    # 差分が無いことを確認（CI と同じ検証）
```

**生成コード `server/internal/db/` はコミットする。** CI の `sqlc diff` はコミット漏れの検出が目的なので、無視すると意味が消える。

**`docs/design.md` 2.2 の DDL も同時に直すこと。** マイグレーションだけ直すと設計書が嘘になる。

### 11-5. `-race` を手元で走らせる（段階4で必要になる）

CI は `go test -race ./...` を使う。手元で同じものを走らせるには C コンパイラが要る。

```bash
sudo apt install -y build-essential   # 無いと go test -race が cgo 不足で落ちる
```

**段階3までは入れなくてよい。** `-race` は複数の goroutine が同じメモリを同期なしで触る箇所を実行時に捕まえるもので、`domain` の純粋関数と逐次実行のマイグレーションテストしか無いうちは検出対象が存在しない。

要るのは**段階4以降**。`net/http` はリクエストごとに goroutine を立てるため、パッケージ変数に状態を持たせた、リポジトリ実装が map を共有した、といったバグがそこで初めて成立する。この種のバグはテストがたまたま緑になるので `-race` 以外では見つからない。**入れないまま段階4に進むと、CI だけが赤くなってログから推測する羽目になる。**

入れると `CGO_ENABLED` の既定が 0 から 1 に変わり、手元の `go build` が動的リンクのバイナリを吐くようになる。デプロイ用のビルドは段階5でコンテナの中でやるため実害は無いが、変わること自体は知っておく。

## 12. API サーバーを手元で動かす（段階4以降）

必要な環境変数は4つ。**足りなければ起動しない。** 起動してから「認証が素通りだった」と気付くより安全側に倒す。

```bash
cd server
export DATABASE_URL='postgres://test:test@localhost:5432/test?sslmode=disable'
export AUTH_TOKEN="$(openssl rand -hex 16)"   # 32文字以上。短いと起動を拒否する
export ALLOWED_ORIGINS='http://localhost:5173'  # front の開発サーバー。ワイルドカード不可
export PORT=8080                                # 省略時 8080

go run ./cmd/api
```

呼ぶときは Bearer トークンを付ける。

```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:8080/api/dashboard
```

**`AUTH_TOKEN` をシェル履歴やファイルに残さない。** このリポジトリは public（`CLAUDE.md` 不変条件17）。

## 13. front を動かす（段階6以降）

API の場所はビルド時の環境変数で決める。**トークンはここに入れない**（成果物ごと公開される）。

```bash
cd front
echo 'VITE_API_BASE_URL=http://localhost:8080' > .env.local   # .gitignore 済み
npm run dev
```

初回はトークンの入力を求められる。サーバーの `AUTH_TOKEN` と同じ値を入れる。この端末の `localStorage` にのみ保存される。

サーバー側の `ALLOWED_ORIGINS` に front のオリジンを入れておくこと。入っていないとブラウザが CORS で弾き、画面には「サーバーに接続できませんでした」とだけ出る。

```bash
export ALLOWED_ORIGINS='http://localhost:5173'   # npm run dev のオリジン
```

### 実物のサーバーとつないで確認する

`npm run check` の E2E は API をブラウザ側で差し替えており、**サーバーも DB も起動しない**。CORS・認証・JSON の噛み合わせはそこでは分からないので、疑わしいときは実物で通す。

```bash
# 1) DB とサーバー
cd server && docker compose up -d
export DATABASE_URL='postgres://test:test@localhost:5432/test?sslmode=disable'
goose -dir db/migrations postgres "$DATABASE_URL" up
AUTH_TOKEN=$(openssl rand -hex 16) ALLOWED_ORIGINS='http://localhost:4173' PORT=8081 go run ./cmd/api

# 2) front（別のシェルで）
cd front && VITE_API_BASE_URL=http://localhost:8081 npm run build && npm run preview
```

### テストを回したあとに 500 が出たら

`go test ./...` のあとで API が `INTERNAL_ERROR` を返すことがある。repository のテストが、**CHECK 制約を外して壊れた行を意図的に作る**ため（復元時の検証が効くことの確認）。その行がローカル DB に残っていると、一覧の取得が「不正な値をドメイン層へ渡さない」判断で止まる。

アプリとしては正しい振る舞いなので、DB を作り直せばよい。

```bash
docker compose down -v && docker compose up -d
goose -dir db/migrations postgres "$DATABASE_URL" up
```

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
