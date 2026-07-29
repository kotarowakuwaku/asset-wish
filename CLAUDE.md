# CLAUDE.md

このリポジトリで作業する際の前提。**作業を始める前に必ず読むこと。**

## プロジェクト概要

個人用の資産・ウィッシュ管理アプリ。単一ユーザー（作者本人）専用。

口座残高だけでは「本当に自由に使えるお金」が分からない、という課題を解く。友人へ立て替えた金額は残高から抜けており、支払いが確定した支出は残高に残ったままのため、実感と残高がズレる。この2つを加味した**実質資産**を出すことが、このアプリの存在理由である。

あわせて、欲しいもの・やりたいこと・目標を登録し、それぞれに対して**あといくら足りないか**と**あと何ヶ月で届くか**を表示する。

詳細は以下を参照する。設計判断で迷ったらまずこれを読むこと。

- `docs/requirements.md` — 要件定義書 v1.0（決定事項と、却下した選択肢の理由を含む）
- `docs/design.md` — 設計書（DDL、ドメイン型、API、パッケージ構成、テスト方針）

## 開発上の目的

このプロジェクトは**アーキテクチャとテスト設計の学習**を主目的としている。機能の豊富さより設計の筋の良さを優先する。

そのため、以下の姿勢で臨むこと。

- 動けばよい実装より、レイヤ境界が守られた実装を選ぶ
- 「なぜその構造にしたか」を説明できない実装は提案しない
- 便利なライブラリで済ませる前に、まず素直な実装を検討する
- ユーザーが自分で考えるべき設計判断を、勝手に決めて先に進まない。選択肢とトレードオフを示して確認を取る

## 技術スタック

| 領域 | 技術 |
| --- | --- |
| フロント | Vite + React + TypeScript（SPA） |
| フロントのテスト | Vitest（ロジック）、Playwright（E2E）、oxlint |
| 配信 | 静的ホスティング（着手時に確定）。ネイティブアプリとしては配布しない |
| サーバー | Go |
| DB | PostgreSQL（Neon 無料枠） |
| クエリ | sqlc（ORM は使わない） |
| 実行環境 | Cloud Run（us-central1） |
| IaC | Terraform |

## リポジトリ構成

モノレポ。

```
front/     Vite + React + TypeScript
server/    Go（go.mod はこの階層）
infra/     Terraform
docs/      要件定義書・設計書
```

## 命名規約

### ブランチ

以下のプレフィクスに絞る。迷ったら `feat/`。

| prefix | 用途 |
| --- | --- |
| `feat/` | 新機能 |
| `fix/` | バグ修正 |
| `refactor/` | 挙動を変えない改修 |
| `docs/` | ドキュメントのみ |
| `chore/` | ビルド・CI・依存関係など |

例：`feat/domain-networth`

### コミットメッセージ

ブランチと同じプレフィクスを使い、`prefix: 要約` の形にする。日本語でよい。詳細が必要な場合は本文で補足する。

例：
- `feat: domain 層に Money/YearMonth と実質資産計算を追加`
- `docs: MonthsToReach の切り上げ除算を明記`

---

## 絶対に守る不変条件

**以下に反する実装・提案をしてはならない。** レビュー時もここを最優先で確認する。

### ドメインルール

1. **実質資産の計算に、`kind = 'investment'` の口座を含めない。** 投資資産は別枠の参考値として表示するだけ。ここが壊れるとアプリの目的が消える。
2. **月次支出とウィッシュ由来の確定支出を二重計上しない。** 生活費等は `monthly_balances` に、ライブや旅行などは `wishes` に登録する。同じ支出を両方に入れる実装・UI を作らない。
3. **実質資産から控除されるウィッシュは `status = 'committed'` のみ。** 検討中・完了・見送りは控除しない。
4. **立替の未回収残高は `amount - collected_amount`。** 回収額が未回収残高を超える操作は必ずエラーにする。

### アーキテクチャ

5. **`internal/domain` は外部依存ゼロ。** `database/sql`、`net/http`、HTTP フレームワーク、sqlc 生成コード、`internal/adapter`、`internal/infra` を import しない。これは `.golangci.yml` の depguard で機械的に強制されている。ルールに引っかかったら、ルールを緩めるのではなく設計を直す。
6. **状態遷移の可否判定は `domain` のエンティティメソッドに置く。** `usecase` や `handler` に `if status == ...` を書かない。usecase は「どの遷移を起こしたいか」だけを知る。
7. **sqlc が生成した構造体を `domain` に持ち込まない。** 相互変換は `adapter/repository` の責務。冗長でも境界を維持する。
8. **計算ロジックを SQL に書かない。** 実質資産・不足額・到達見込みは Go の純粋関数で計算する。集計クエリで済ませない（テストに DB が必要になるため）。データ規模は年間数百件なので全件取得で問題ない。
9. **リポジトリのインターフェースは `usecase` パッケージに定義する。** 実装は `adapter/repository`。依存の向きは `handler → usecase → domain`。
10. **トランザクション境界は `usecase` 層で張る。** handler や repository に散らさない。

### 実装規約

11. **金額は `domain.Money` 型で扱う。** `int64` を裸で持ち回らない。DB とのやり取りの境界でのみ変換する。
12. **導出できる値をカラムに持たない。** 例：立替の回収状態は `amount` と `collected_amount` から判定する。`status` カラムを追加しない。
13. **ドメインエラーは HTTP 422 に対応させる。** 形式エラー（400）と業務ルール違反（422）を区別する。
14. **設計書 `docs/design.md` の用語をそのままコードの名前に使う。** 実質資産＝`NetAsset`、月間余剰＝`Surplus`、不足額＝`Shortfall`、未回収＝`Outstanding`。勝手に言い換えない。

### 運用

15. **月額0円を厳守する。** 有料プラン・有料サービスを前提とした提案をしない。無料枠を超える構成を導入しない。
16. **Cloud Run は `max_instance_count` を必ず明示する。** 既定値は100であり、絞らないと課金が青天井になる。
17. **秘密情報をリポジトリに入れない。** 接続文字列・トークンは環境変数から読む。`internal/infra/config.go` に集約する。**このリポジトリは public。** 1度 push したものは bot に数秒で拾われ、履歴から消しても手遅れになる。実データ（金額・口座名・人名）もコードやドキュメントに書かない。テストで使う値はすべて架空のものにする。

---

## コマンド

```bash
# server
cd server
go test ./...                  # テスト
go test ./internal/domain/...  # ドメイン層のみ（DB不要・高速）
gofmt -l .                     # フォーマット差分の検出
go vet ./...
golangci-lint run              # depguard によるレイヤ境界検証を含む
sqlc generate                  # クエリからコード生成
sqlc diff                      # 生成コードが最新かの確認

# ローカル DB（server ディレクトリで）
docker compose up -d           # postgres:16。CI の services と同じ版
export DATABASE_URL='postgres://test:test@localhost:5432/test?sslmode=disable'
goose -dir db/migrations postgres "$DATABASE_URL" up      # マイグレーション適用
goose -dir db/migrations postgres "$DATABASE_URL" status  # 適用状況
goose -dir db/migrations postgres "$DATABASE_URL" down    # 1つ戻す

# worker（Cloudflare 移行中。リポジトリのルートで実行する）
npm run check                  # typecheck + oxlint + vitest。ループの停止条件
npm run test                   # vitest のみ。workerd の中で走る
npm run types                  # worker-configuration.d.ts を生成（typecheck の前に自動で走る）
npm run migrate:local          # ローカル D1 にマイグレーションを当てる
npm run dev                    # wrangler dev。AUTH_TOKEN は .dev.vars に置く
npx wrangler d1 execute asset-wish --local --command "SELECT ..."

# front
cd front
npm run check                  # typecheck + oxlint + vitest + playwright。ループの停止条件
npm run dev                    # 開発サーバー
npx playwright test --ui       # E2E を目視で追う
```

`npm run check` が front の検証の入口。個別に走らせるより、まずこれを通す。

ツールの版は `mise.toml` で固定してある（`sqlc` / `goose`）。**`sqlc` の版は `.github/workflows/ci.yml` の `setup-sqlc` と必ず揃えること。** ずれると `sqlc diff` が生成コードの差分ではなく版差を検出して落ちる。

## ループ協議 — 「完了」の定義

**チェックが緑になっていない状態を「完了」と呼んではならない。** 以下を1周として回す。

1. 変更を書く
2. 触った領域のチェックを走らせる

   | 触った場所 | 走らせるもの |
   | --- | --- |
   | `server/` | `gofmt -l .` / `go vet ./...` / `go test ./...` / `golangci-lint run` |
   | `server/db/`（スキーマ・クエリ） | 上記に加えて `sqlc generate` → `sqlc diff`、および `DATABASE_URL` を設定した状態での `go test ./db/...` |
   | `worker/` | ルートで `npm run check`（typecheck + oxlint + vitest） |
   | `migrations/`（D1 スキーマ） | 上記に加えて `npm run migrate:local` が通ること |
   | `front/` | `npm run check`（typecheck + oxlint + vitest + playwright） |
   | `infra/` | `terraform fmt -check -recursive` / `terraform validate` |

3. 落ちたら、出力を最後まで読み、**原因を1文で言語化してから**直して 2 に戻る
4. 周回は最大5回

### 停止条件

| 状況 | 振る舞い |
| --- | --- |
| 全チェック通過 | 「完了」と報告する。**チェックの出力を証拠として添える** |
| 5周を使い切った | 何が残っているか、何を試して駄目だったかを報告して止まる |
| 同じエラーが2周続いた | 自力で粘らず `fixer` サブエージェントを呼ぶ |

### 禁止

- チェックの出力を示さずに「完了」と報告する
- テストの削除・スキップ・アサーションの緩和で緑にする
- `.golangci.yml` の depguard を緩めてレイヤ違反を通す（不変条件5）
- 「本質的でない」としてチェックを回さずに済ませる

1周で触る範囲は原則1パッケージまで。範囲が広いほど、落ちたときに原因を特定できなくなる。

## Cloudflare への移行（進行中）

**実装言語を Go から TypeScript に変え、Cloudflare Workers + D1 に移す作業を進めている。**
計画・決定事項・実装の順序はすべて `docs/migration-cloudflare.md` にある。**worker/ を触る前に必ず読むこと。**

背景は「クレジットカードを登録しない」という制約。GCP は無料枠を使うだけでも請求先アカウントが必須のため、Cloud Run が選択肢から落ちた。

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| 1 | `wrangler.jsonc`・`migrations/0001_init.sql` | 完了 |
| 2 | `worker/src/domain` の移植とテスト | 完了 |
| 3 | `repository`（D1 アクセス） | 完了 |
| 4 | `usecase` | 完了 |
| 5 | `handler`（19経路） | 完了 |
| 6 | front の接続と静的アセット配信 | ← 次はここ |
| 7 | `wrangler deploy`・CI の更新 | |
| 8 | `server/` の削除、`CLAUDE.md` と `docs/` の更新 | |

**`server/`（Go）は段階8まで残す。** 移植元として参照するためであり、まだ動く。上の「技術スタック」表と下の「開発の進め方」は Go 版のもので、移行が終わるまでは両方が有効。

移行にあたって特に効いている決定は以下。詳細と理由は移行計画の10章にある。

- **D1 にトランザクションが無い。** 書き込みは `usecase.WriteOperation` の配列として組み立て、`AtomicWriter` が1回の `db.batch()` に流す。**条件付き UPDATE を並べて後から更新件数を見る書き方は部分書き込みを残す**（実測済み）。先頭に番人の文を置き、以降を `changes() = 1` で塞ぐ。詳細は移行計画の4章
- **金額は `Money`（branded number）、日付は `IsoDate`、時刻は `Instant`、年月は `YearMonth`。** `Date` を domain に持ち込まない。タイムゾーンを持つ値は日付の意味を壊す
- **`year_month` は `TEXT 'YYYY-MM'`。** 月初日の `DATE` ではない
- **「算出不可」は例外ではなく `null`。** `averageSurplus` と `monthsToReach` が該当する。0 と混同しない
- **不変条件5 の強制は `.oxlintrc.json` の `no-restricted-imports`。** depguard の置き換え。引っかかったらルールではなく設計を直す

## 開発の進め方

設計書 7章の順序に従う。**インフラは最後**に回す。

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| 1 | `domain` パッケージとそのテスト | 完了（PR #1） |
| 2 | DDL・マイグレーション・sqlc 設定 | 完了 |
| 3 | `repository` 実装 | 完了 |
| 4 | `usecase`・`handler` | 完了 |
| 5 | Terraform / GCP | ← 残りはここだけ。実運用したくなった時点で着手 |
| 6 | front（Vite + React SPA） | 完了 |

段階2で入った決定は以下。いずれも設計書が決めていなかったもの。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| マイグレーション | `goose`（`server/db/migrations/`） | 1ファイルに up/down を書け、`embed.FS` から呼べる。段階3のテストでスキーマを流すのが数行で済む |
| sqlc のドライバ | `database/sql` + `pgx/v5` stdlib | `docs/detailed-design.md` 4.1 の型変換表が `sql.NullTime` 前提。ドライバ実体は pgx |
| 生成コードの置き場 | `server/internal/db/` | `.golangci.yml` の depguard が domain からの import を禁じているパスと一致させる |
| ローカル DB | `server/compose.yaml` の `postgres:16` | CI の `services.postgres` と同一版。「手元では通るのに CI で落ちる」を構造的に潰す |
| 更新クエリの粒度 | **操作別に分ける**（全カラム上書きの `Update*` を置かない） | 下記 |

### 更新クエリを操作別に分ける

`UpdateWish` のような全カラム上書きのクエリを置かず、API の操作単位でクエリを割る。

| テーブル | 置くクエリ | 置かないもの |
| --- | --- | --- |
| `accounts` | `UpdateAccount`（名称・残高のみ） | `kind` を書けるクエリ |
| `wishes` | `UpdateWishContent` / `UpdateWishStatus` | 両方を1本で書けるクエリ |
| `lendings` | `UpdateLendingCollectedAmount` | 内容を編集するクエリ（API に無い） |

**理由は、不変条件を型やレビューではなくスキーマ側で支えるため。**

- `kind` を `cash` → `investment` に書けると、その口座が実質資産から丸ごと消える（不変条件1）
- `status` を内容更新のついでに書けると、遷移の可否を判定する domain のメソッドを迂回できる（不変条件6）
- `amount` を回収のついでに書けると、未回収残高（`amount - collected_amount`）の意味が変わる（不変条件4）

**SQL に無い操作は、上の層がどう間違えても起こせない。** 冗長さと引き換えに、迂回路そのものを消す。

作成系（`CreateWish` など）は全カラムを引数に取ったままでよい。初期状態が `considering` であるといったルールは domain が持つべきで、SQL に定数で書き込むと逆にルールが散る。

**新しい更新操作が要るときは、既存の `Update*` に列を足さず、クエリを1本足す。**

段階3で入った決定は以下。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| トランザクションの引き回し | `context.Context` に `*sql.Tx` を載せ、`Store.queries(ctx)` が解決する | リポジトリのメソッドが「いまトランザクションの中か」を意識せずに済む。境界を usecase 層だけに置ける（不変条件10） |
| `RunInTx` の入れ子 | 内側は新しく張らず外側に相乗りする | 内側が独立して張ると、外側が巻き戻っても内側の書き込みだけが残る |
| 復元時の検証 | `kind` / `status` / `category` を `Valid()` で検証し、不正なら error | CHECK 制約をすり抜けた値をドメイン層に渡さないための最後の関門 |
| DB を使うテストの直列化 | `internal/dbtest` がアドバイザリロックを取る | go test はパッケージを並行実行する。DB を使うテストが2パッケージ以上になると、同じ public スキーマを同時に作り直して壊し合う |

**DB を使うテストを新しいパッケージに書くときは、必ず `dbtest.Setup` を通すこと。** 自前で接続を開くと直列化とローカル判定の両方が外れる。

段階4で入った決定は以下。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 時刻と ID 採番 | `usecase.Clock` / `usecase.IDGenerator` として注入する | 実時刻に依存したテストは日付をまたいだ瞬間に落ちる |
| handler が依存する型 | usecase の構造体ではなく handler 側に定義したインターフェース | HTTP の関心事だけをスタブで検証できる。手順は usecase のテストが見る |
| 未知のフィールド | `DisallowUnknownFields` で 400 にする | 送れない項目（`status` / `kind`）を黙って無視すると「変えたつもりが変わっていない」になる |
| `deadline` の指定 | `json.RawMessage` で受け、キー無し／`null`／日付を区別する | `*string` では「変更しない」と「期限を外す」が同じに見える |
| middleware の並び | CORS を認証より**外側** | 事前検査（OPTIONS）に `Authorization` は付かない。内側だと 401 でブラウザが本リクエストを送らなくなる |
| 設定の検証 | 不足・短いトークン・ワイルドカードは起動前に落とす | 公開エンドポイントなので、起動してから「認証が素通り」に気付くのでは遅い |

**エラーは 400 と 422 を必ず分ける。** 形式の誤り（400）は組み立て直す話、業務ルール違反（422）は値や状態を見直す話で、クライアント側の対処がまるで違う。`domain.DomainError` は自動的に 422 になるので、新しい業務ルールを足すときは `domain` にエラーを定義する。

段階6で入った決定は以下。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 画面の切り替え | ライブラリを入れず hash で持つ（`src/app/router.ts`） | 画面は5つ、入れ子も動的な経路も無い。静的ホスティングに置いてもサーバー側の書き換え設定が要らない |
| データ取得 | 取得ライブラリを入れず `useAsync`（30行） | 単一ユーザーの画面にキャッシュも楽観更新も要らない。要るのは読み込み中・失敗・再読み込みの3つだけ |
| 通信の置き場 | `src/api/client.ts` に集約。画面から `fetch` を直に呼ばない | 認証・エラー変換・基底 URL が各画面に散ると、直すときに全画面を触る |
| E2E の API | Playwright の `page.route` で差し替え、サーバーも DB も起動しない | E2E で見たいのは画面の配線。サーバーの正しさは server 側のテストが持つ |

**front で金額の計算をしない。** 実質資産・不足額・到達見込みはサーバーが算出済みの値を受け取って並べるだけ（不変条件8）。ここに式を書くと、同じ計算が2箇所に増えて必ずずれる。`src/lib/format.ts` に置いてよいのは表示整形だけ。

**到達見込みの `null` を 0 と混同しない。** `null` は「算出不可」で、0 として出すと「今月中に届く」と読める。`formatMonths` がこれを引き受けている。

**`src/test/setup.ts` の `afterEach(cleanup)` を消さないこと。** vitest の `globals` を有効にしていないため、Testing Library の自動クリーンアップが働かない。消すと前のテストの DOM が残り、「同じ名前の要素が複数ある」という実装のせいに見える落ち方をする。

**GCP と Terraform は依然として後回し。** アプリの中身に到達する前に消耗する。

## やらないこと

以下は明示的にスコープ外。提案しない。

- 銀行 API 連携、レシート読み取り
- 日々の生活費の項目別記録（家計簿化）
- 複数ユーザー・共有機能
- 外貨・為替
- 確定支出の分割払い
- ウィッシュの合計金額と実質資産の比較（個別に見る方針で確定済み）
- App Store / Google Play への公開
