# セットアップ手順

GitHub リポジトリの作成から、最初のコミットまで。

**前提：このプロジェクトは個人アカウントで作る。** 会社の GitHub アカウント・Google アカウントは使わない。規約上の問題に加えて、退職時にリポジトリも Cloudflare のアカウントも失う。

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
mkdir -p docs worker/src front migrations
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
│   │   ├── check-fast.sh                        ← 実行権限を付けること
│   │   └── check-full.sh
│   └── agents/
│       └── fixer.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── requirements.md                          ← 要件定義書 v1.0
│   └── design.md                                ← 設計書 v0.1
├── .oxlintrc.json                               ← レイヤ境界の強制を含む
├── wrangler.jsonc
├── migrations/
├── worker/
└── front/
```

## 5. front（構築済み。クローン後に必要な作業のみ）

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

**個別のコマンドを覚えるのではなく、これ一本を通す。** `npm run check` は CI の front ジョブと同一で、AI エージェントにループを回させるときの停止条件でもある（`CLAUDE.md` のループ協議）。**ローカルと CI で検証内容をずらさないこと。** ずれた瞬間に「手元では通る」が始まる。

linter は eslint ではなく **oxlint**。Vite のテンプレートが同梱しており、eslint より桁違いに速い。lint はループの1周ごとに走るため、ここの実行時間が周回速度に直結する（`docs/decisions.md` 1章 #12）。

E2E は dev サーバーではなく `npm run build && npm run preview` の成果物に対して実行する。実際に配信するのはビルド結果なので、検証対象を本番と揃える。

スマートフォンのホーム画面に置きたくなったら、`vite-plugin-pwa` で manifest と Service Worker を後付けする。現時点では不要。

## 6. 最初のコミットと push

```bash
cd ~/personal/asset-wish
git add .
git status          # .env や鍵ファイルが含まれていないことを目視確認
git commit -m "chore: プロジェクトの初期構成とドキュメントを追加"
git push -u origin main
```

**`git status` の確認は省略しない。** 一度履歴に入った秘密情報の除去は非常に面倒になる。

## 7. ブランチ保護を設定する

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

## 8. 手元で動かす

**Cloudflare のアカウントもログインも要らない。** `wrangler` は CLI であって、`--remote` や `deploy` を付けない限りネットワークに出ない。D1 も `.wrangler/state/` の SQLite ファイルとして手元に作られる。DB を別途起動する必要も無い。

### 14-1. 依存を入れてスキーマを流す

```bash
# リポジトリのルートで
npm install
npm run migrate:local          # .wrangler/state/ 配下に SQLite ができる
```

### 14-2. `.dev.vars` に認証トークンを置く

```bash
cp .dev.vars.example .dev.vars
# AUTH_TOKEN= の右に32文字以上の値を書く。生成例:
openssl rand -base64 48
```

`.dev.vars` は `.gitignore` に入っている。**このリポジトリは public。実際のトークンをコミットしない（不変条件17）。**

32文字未満だと起動を拒否する（`worker/src/infra/config.ts`）。公開エンドポイントに短いトークンを置くと総当たりが現実的になるため。

### 14-3. front をビルドして起動する

```bash
cd front && npm run build && cd ..   # front/dist を作る
npm run dev                          # http://localhost:8787
```

`front/dist` は `wrangler.jsonc` の `assets.directory` に指定してある。**front と API が同じオリジンから出る**ため、CORS の設定は存在しない。

front を書き換えたら `npm run build` を打ち直す。`wrangler dev` は `worker/` の変更は拾うが、`front/dist` はビルド成果物なので自動では作り直されない。

### 14-4. 動いているかの確認

```bash
TOKEN=$(grep AUTH_TOKEN .dev.vars | cut -d= -f2)

# SPA が返る
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:8787/

# 認証なしの API は 401
curl -s http://localhost:8787/api/accounts

# 認証ありなら通る
curl -s http://localhost:8787/api/dashboard -H "Authorization: Bearer $TOKEN"
```

`/api/*` が Worker に届くのは `wrangler.jsonc` の `assets.run_worker_first` があるため。これが無いと `not_found_handling` が働いて、API 呼び出しに `index.html` が返る。

### 14-5. 検証は `npm run check` 一本

```bash
npm run check                  # typecheck + oxlint + vitest
```

テストは workerd の中で走る。リポジトリ層と統合テストは miniflare のローカル D1 に対して実行され、`migrations/` の DDL をそのまま流す。**別途 DB を起動する必要は無い。**

---

## セットアップ後：どこから書くか

`worker/src/domain/` から。**DB もアカウントも不要**で、今すぐ書ける。

```bash
cd server
mkdir -p internal/domain
# money.go → networth.go → networth_test.go の順
go test ./internal/domain/...
```

テストケースは `worker/src/domain/netAsset.test.ts` にある。特にケース2・6・7（投資を含めない、二重計上しない）は、このアプリの存在意義そのものを守るテストなので最優先で書く。

**先にインフラを整えようとしないこと。** アプリの中身に到達する前に消耗する。デプロイは、実運用したくなった時点で着手すればよい。

---

## 補足

### CI の構成

- `dorny/paths-filter` で `server` / `front` / `infra` の変更を判定し、該当するジョブだけ走らせる。E2E はブラウザを起動するぶん時間がかかるため、front を触っていない PR で回さない意味は大きい
- **`permissions: pull-requests: read` は必須。** 既定の `GITHUB_TOKEN` は `contents:read` のみに絞られており、これが無いと paths-filter が PR の変更ファイル一覧を取れず `Resource not accessible by integration` で初手から落ちる
- `npm run check` は `wrangler types` を先に走らせる。生成された型が古いまま通ることを構造的に防いでいる
- `infra` ジョブは `terraform validate` までで、`plan` や `apply` は行わない。認証情報を CI に持たせないため

**検証ゲートは、赤が意味を持つ状態に保たなければ機能しない。** 常時赤い CI は「赤いのはいつものこと」という慣れを生み、ゲートとして働かなくなる。

### ループを回す前提の構成

`.claude/` に以下を置いてある。AI エージェントに作業させる際、人手を介さずに検証が回るようにするためのもの。

| ファイル | 役割 |
| --- | --- |
| `.claude/settings.json` | フックの登録 |
| `.claude/hooks/check-fast.sh` | `Write`/`Edit` の直後に型チェックと oxlint。壊れたまま先に進ませない |
| `.claude/hooks/check-full.sh` | 作業を終えようとした瞬間に `npm run check`（触った側だけ）。落ちていれば差し戻す |
| `.claude/agents/fixer.md` | 同じエラーで2周足踏みしたときに呼ぶ、別コンテキストの担当 |

`CLAUDE.md` の「ループ協議」が完了の定義（＝チェックが緑であること）を担い、フックがそれを機械的に強制する。**片方だけでは効かない。** 規約だけならエージェントは自己申告で完了を宣言できてしまうし、フックだけでは何を直すべきかの方針が伝わらない。

### レビュースキルの使い方

`.claude/skills/` に置けば Claude Code が認識する。実装が一区切りついたタイミングで自主的に適用されるよう記述してあるが、明示的に呼びたい場合は「アーキテクチャレビューして」と伝える。

スキルは固定ではなく育てるもの。**レビューで指摘されなかった不具合を見つけたら、それをチェック項目として足す**のが一番効く。

### Cloudflare のアカウントについて

**アプリを実際に公開するまで不要。** テストも `wrangler dev` もローカルで完結する。

公開する段になったら、**個人のメールアドレス**でアカウントを作る（<https://dash.cloudflare.com/sign-up>）。**カード登録は求められない。**

```bash
npx wrangler login              # ブラウザが開いて OAuth
npx wrangler d1 create asset-wish
# 出力された database_id を wrangler.jsonc に貼る
npm run migrate:remote
npx wrangler secret put AUTH_TOKEN   # 32文字以上。別ターミナルで生成して貼る
npm run deploy
```

**「Workers Paid」への導線を押さないこと。** 既定は Free で、Free は無料枠を超えると課金ではなく停止する。この性質が月額0円を担保している（要件定義書 7.5）。

`workers.dev` のサブドメインはアカウントに一度だけ登録する。**公開 URL の一部として誰にでも見えるため、本名やメールのローカル部を使わない。**
