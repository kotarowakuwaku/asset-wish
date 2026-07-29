# Cloudflare 移行の記録

Go + PostgreSQL + Cloud Run から、Cloudflare Workers + D1 へ移した記録。

**状態：移行完了（2026-07）。** 全8段階が終わり、`server/`（Go 版）は削除した。

| | |
| --- | --- |
| URL | `https://asset-wish.mochiya.workers.dev` |
| D1 | `asset-wish`（APAC）。`database_id` は `wrangler.jsonc` にある |
| 認証 | `AUTH_TOKEN` を `wrangler secret put` で登録済み |
| デプロイ | 手動（`npm run deploy`）。CI からの自動デプロイは未設定 |

**本書は以後、移行の記録として読む。** 現在の構成と手順は `CLAUDE.md` と `SETUP.md` を正とする。この文書の価値は、**実測して分かった D1 の癖**（4章）と、**なぜその形にしたかの理由**（10章）にある。Go 版の実装を読みたい場合は `git log -- server/` から辿れる。

---

## 1. 決定と背景

### 決めたこと

**運用の最適化を最優先とし、実装言語を Go から TypeScript に変える。**

### なぜ

判断の前提が途中で変わった。

| 時点 | 前提 | 結論 |
| --- | --- | --- |
| 当初 | 学習目的が最優先。言語は Go 固定 | Cloud Run + Neon（`CLAUDE.md` 技術スタック表） |
| 現在 | **クレジットカード登録をしない**。運用の最適化が最優先。言語は問わない | Cloudflare Workers + D1 |

クレカ不可という制約で Cloud Run が落ちる。GCP は無料枠を使うだけでも請求先アカウント（＝カード登録）が必須のため。

そこから「カード不要 × 月額0円（不変条件15）× Go」で探すと、残るのは Render Free 程度で、15分無操作でスリープし復帰に30〜60秒かかる。**言語の縛りを外した瞬間に、この制約群を全部満たす構成が現れる**というのが今回の結論。

### Cloudflare を選ぶ理由

「良いから」ではなく、**通常なら必ず発生する問題がまとめて消滅するから**。

- **CORS が消える** — front と API が同一オリジンになる。`handler/middleware.go` の `CORS` と `ParseOrigins`、および `ALLOWED_ORIGINS` の設定・検証がすべて不要になる
- **接続文字列という概念が消える** — D1 は bindings で `env.DB` として渡る。`DATABASE_URL` も、コネクションプールも、コールドスタート時の接続確立も無い
- **コールドスタートが無い** — V8 isolate なので数ms
- **静的アセットのリクエストは無料かつ無制限** — SPA を開くたびに10万req/日の枠が減ることにならない。枠を消費するのは API 呼び出しだけ
- **デプロイ対象が1つ** — front と API のデプロイがズレて壊れる事故が構造的に起きない

### 無料枠

| 対象 | 枠 |
| --- | --- |
| Workers リクエスト | 10万/日、1000/分 |
| Worker サイズ | 圧縮後 3MB |
| 静的アセット | 2万ファイル/バージョン |
| D1 ストレージ | 5GB |
| D1 行読み取り | 500万/日 |
| D1 行書き込み | 10万/日 |

単一ユーザー・年間数百件というデータ規模に対して過剰。**カード登録は不要。**

---

## 2. これは「移行」ではなく「作り直し」

**本番環境が存在しないため、移行すべきデータが無い。**

段階5（インフラ）は未着手で、`infra/` は空。アプリは一度もデプロイされていない。手元の PostgreSQL にあるのは開発用のダミーデータだけで、これは捨ててよい。

この事実が計画全体を大幅に簡単にする。

- 無停止移行の考慮が不要
- 二重書き込み期間が不要
- ロールバック計画が不要（`git revert` で足りる）
- データ変換スクリプトが不要

**やることは、確立済みの設計を別の言語とランタイムに写し直すことだけ。**

---

## 3. 移行後の構成

```
asset-wish/
├── wrangler.jsonc        Worker 定義。D1 binding、静的アセット、secrets
├── migrations/           wrangler d1 migrations が管理（goose の置き換え）
│   └── 0001_init.sql
├── worker/               ← server/ の置き換え
│   ├── src/
│   │   ├── domain/       純粋関数と型。外部依存ゼロ（不変条件5）
│   │   ├── usecase/      手順の組み立て。ポート定義
│   │   ├── adapter/
│   │   │   ├── handler/  Hono のルート
│   │   │   └── repository/ D1 アクセスとドメイン型への詰め替え
│   │   ├── infra/        設定の読み出しと検証
│   │   └── index.ts      エントリポイント
│   └── test/
└── front/                ほぼそのまま（5章参照）
```

**レイヤ構成は変えない。** `handler → usecase → domain` の依存の向きも、リポジトリのインターフェースを usecase 側に置くことも、そのまま持ち込む。移行で捨てるのは言語とランタイムであって、設計ではない。

`front/` はディレクトリ位置を変えない。ビルド成果物 `front/dist` を `wrangler.jsonc` の静的アセットとして指定するだけで、同一 Worker から配信される。

---

## 4. 最大の論点：D1 にトランザクションが無い

**これが移行計画で唯一、設計判断を要する箇所。** 他はすべて機械的な移植で済む。

### 何が起きるか

D1 は `BEGIN TRANSACTION` / `SAVEPOINT` を受け付けない。SQLite は書き込みトランザクションを同時に1つしか開けず、Worker の JS コードと SQL が別の場所で動くため、`BEGIN` を許すと任意のリクエストが DB 全体をブロックできてしまう、というのが Cloudflare 側の説明。

代わりに `db.batch()` がある。**1回の `batch()` 呼び出しは1つのトランザクションとして原子的に実行される**（途中の文が失敗すれば全体がロールバックされる）。ただし **`batch()` をまたぐ原子性は無い。** 2回に分ければ、2つ目が失敗しても1つ目の書き込みは確定済み。

### 何が壊れるか

現行の `repository/store.go` の `Store.RunInTx` と、`ctx` に `*sql.Tx` を載せて `Store.queries(ctx)` が解決する仕組みは**そのままでは成立しない**。

影響を受ける usecase は3つ。いずれも「読んで、計算して、書く」という形をしている。

| usecase | 手順 |
| --- | --- |
| 立替の作成 | 口座を取得 → 残高を減算 → 立替を作成 + 口座を更新 + 取引を記録 |
| 立替の回収 | 立替と口座を取得 → 回収可否を domain が判定 → 回収額を更新 + 口座を更新 + 取引を記録 |
| ウィッシュの支払 | ウィッシュと口座を取得 → 遷移可否を domain が判定 → 状態を更新 + 口座を更新 + 取引を記録 |

読み取りと書き込みの間に JS の判断が挟まるため、`batch()` に丸ごと入らない。**不変条件10（トランザクション境界は usecase 層）をどう読み替えるかを決める必要がある。**

### 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A. batch + 条件付き UPDATE** | 読みは事前に行い、書き込み3件を1回の `batch()` にまとめる。UPDATE の WHERE 句に読み取り時の値を含め（`WHERE id = ? AND collected_amount = ?`）、更新件数が0なら競合として弾く | 追加コストゼロ。無料枠のまま。楽観ロックとして正しい | 実装が `RunInTx` より明示的になる。競合時のリトライを書くか、エラーにするかの判断が要る |
| **B. Durable Object で直列化** | 書き込み系を単一の Durable Object に通し、そこで直列実行する。DO は単一スレッドのアクターで、SQLite ストレージを持つ | 真の直列化が得られる。DO は無料枠で使え、SQLite ストレージも Free プランは課金対象外 | 構成が1段複雑になる。単一ユーザーのアプリに対して過剰な可能性が高い |
| **C. 競合を考慮しない** | 読んで書くだけ。楽観ロックも入れない | 最も単純 | 同時実行が起きた場合に残高がずれる。単一ユーザーでも、2つのタブを開けば起こりうる |

### 検討にあたっての事実

- **既存の CHECK 制約が最後の防波堤として機能する。** `lendings_collected_within_amount`（`collected_amount <= amount`）は SQLite でもそのまま使える。仮に案 C で競合が起きても、不変条件4（回収額が未回収残高を超える操作はエラー）は DB が弾く
- 一方で **`accounts.balance` には CHECK 制約が無い**（マイナス残高を許容する設計のため）。口座残高の更新だけは、DB が守ってくれない
- 単一ユーザーだが、**同時実行が「起きない」とは言えない**。PC とスマホ、あるいは複数タブ

**案 A を採用した。** 追加コストがゼロで、DB が守れない `accounts.balance` の部分をちょうど埋める（10章 #1）。

### 実装で分かったこと：素朴な案 A は壊れる

**条件付き UPDATE を並べて「更新0件なら競合」と後から判定する書き方は、部分書き込みを残す。** 実際の D1 に対して確かめた結果が以下。

| 確かめたこと | 結果 |
| --- | --- |
| 条件に合わず0件だった UPDATE の後ろの INSERT は実行されるか | **される。** `changes` は `[0, 1]` で、立替の行だけが残った |
| `changes()` は batch の中で文をまたいで直前の結果を引き継ぐか | **引き継ぐ** |
| 文がエラーになれば batch 全体が巻き戻るか | **巻き戻る** |
| 外部キー違反はどう出るか | `FOREIGN KEY constraint failed` を含むエラー |

`batch()` が原子的なのは「文がエラーになったとき」であって、「条件に合わず0件だったとき」ではない。放置すると、立替だけが増えて残高が動かない状態が残り、利用者が再実行すれば立替が二重に入る。

### 採用した形：先頭に番人を置く

1. 先頭に「読み取り時の値が今も変わっていないか」だけを見る**番人の文**を置く（値を変えない UPDATE）
2. 以降のすべての文を `changes() = 1` で塞ぐ

番人が0件なら、後続はすべて素通りして**1件も書き込まれない**。番人が「値を変えない UPDATE」なのは、`changes()` を1にできる文が UPDATE / INSERT / DELETE しか無く、SELECT では動かないため。

**前提条件を後続の文にばらして持たせてはならない。** 先に走った UPDATE が対象の行を書き換え、あとの条件がその新しい値を見てしまう。判定は必ず「何も書き換えていない時点」で済ませる。

実装は `worker/src/adapter/repository/writer.ts`。上記の性質は `writer.test.ts` が実 D1 に対して固定している。

---

## 5. 資産の棚卸し

### そのまま設計として引き継ぐ（言語だけ変わる）

**`internal/domain` の全ファイルとそのテスト。** ここが移行で最も価値が保たれる部分で、純粋関数の集まりなので写経に近い作業になる。

| 現行 | 移行後 | 備考 |
| --- | --- | --- |
| `CalculateBreakdown` | 同名 | 不変条件1・3・4がここに集約されている |
| `CalculateInvestmentTotal` | 同名 | |
| `CalculateShortfall` | 同名 | |
| `AverageSurplus` | 同名 | 引数のスライスを変更しない性質を維持する |
| `MonthsToReach` | `monthsToReach` | 切り上げ。JavaScript の除算は必ず浮動小数点を経由するため `(a + b - 1) / b` は再現できず、`Math.ceil` にした。Money は安全整数の範囲の円額であり、この規模では整数除算と一致する |
| `Wish.Commit` / `Pay` / `Drop` | 同名 | 状態遷移の可否判定（不変条件6） |
| `Lending.Outstanding` | 同名 | `amount - collected_amount`（不変条件4） |
| `Account.CountsTowardNetAsset` | 同名 | 投資口座を除外（不変条件1） |
| `YearMonth` | 同名 | 日・時刻・タイムゾーンを持たない性質を維持 |
| `Money` | 同名 | 6章参照 |

**`docs/design.md` の用語をそのまま名前に使う規約（不変条件14）は継続する。** `NetAsset` / `Surplus` / `Shortfall` / `Outstanding`。

domain のテストは 6ファイルあり、すべて DB 不要の純粋なテスト。Vitest にほぼ機械的に移せる。**移行の正しさを最も安く検証できる場所なので、ここから着手する。**

### 書き直しになる

| 現行 | 移行後 |
| --- | --- |
| `internal/usecase/*.go`（7本） | `worker/src/usecase/*.ts`。手順は同一。トランザクションの扱いのみ4章の決定に従う |
| `internal/adapter/handler/*.go`（8本） | Hono のルート。19本の API 経路は変えない |
| `internal/adapter/repository/*.go`（7本） | D1 アクセス。sqlc 生成型との相互変換が、D1 の行オブジェクトとの変換に変わる |
| `db/queries/*.sql`（5本） | 7章の方針に従う |
| `db/migrations/00001_init.sql` | `migrations/0001_init.sql`（8章の差分を反映） |
| `internal/infra/config.go` | 環境変数から `env` binding へ |

### 捨てる

| 対象 | 理由 |
| --- | --- |
| sqlc（`sqlc.yaml`、`internal/db/` 生成コード6本） | D1 に対応しない |
| goose（`db/embed.go`、`db/embed_test.go`） | `wrangler d1 migrations` が置き換える |
| pgx / `database/sql` | D1 binding に置き換わる |
| `internal/dbtest/dbtest.go` | アドバイザリロックによる直列化が不要になる。D1 のローカルテストは分離されたインスタンスで走る |
| `server/compose.yaml`（postgres:16） | ローカル DB が不要になる |
| `handler.CORS` / `handler.ParseOrigins` | 同一オリジンになる |
| `.golangci.yml`（depguard） | 10章で代替を決める |
| `infra/`（Terraform / GCP 前提） | `wrangler.jsonc` が役割を引き継ぐ |
| `mise.toml` の sqlc / goose 固定 | 対象が消える |

### 大きく変わらない

**`front/` はほぼそのまま動く。** これは移行の中で最も良い知らせ。

---

## 6. 型と値の移植

### Money

現行は `type Money int64`（円単位、小数なし）。

TypeScript では `number` を使う。IEEE754 の安全整数は 2^53-1 ≒ **9007兆円**で、円単位の個人資産には十分。`bigint` にすると JSON 変換の各所で手当てが要るのに、得るものが無い。

ただし **不変条件11（`int64` を裸で持ち回らない）を維持するため、branded type にする。**

```ts
export type Money = number & { readonly __brand: 'Money' }
```

`Money.String()`（`"¥1,234,567"` 形式）は front の `src/lib/format.ts` に既に相当する実装があるため、**domain 側には持ち込まない**。表示整形は front の責務。

### YearMonth

現行の設計（year と month のみ保持、日・時刻・タイムゾーンを持たない）をそのまま維持する。`ParseYearMonth("2026-07")` / `String()` / `AddMonths` / `Compare` も同じ。

`FirstDay()`（DATE 列との変換用）は、8章で `year_month` を `TEXT 'YYYY-MM'` にするなら**不要になる**。

### UUID

`google/uuid` の代わりに Workers 組み込みの `crypto.randomUUID()` を使う。D1 には `TEXT` で格納する。

### 時刻

現行は `TIMESTAMPTZ` と `time.Time`。SQLite にネイティブの日時型が無いため、格納形式の決定が要る（10章）。

---

## 7. クエリ層の方針

### 「更新クエリを操作別に分ける」は維持する

`CLAUDE.md` の該当節はそのまま有効。むしろ D1 では**より重要になる**。全カラム上書きの `UPDATE` を置かないことで、以下の迂回路を SQL レベルで塞いでいる。

| テーブル | 置くもの | 置かないもの |
| --- | --- | --- |
| `accounts` | `updateAccount`（名称・残高のみ） | `kind` を書ける文（不変条件1） |
| `wishes` | `updateWishContent` / `updateWishStatus` | 両方を1本で書ける文（不変条件6） |
| `lendings` | `updateLendingCollectedAmount` | `amount` を書ける文（不変条件4） |

**SQL に無い操作は、上の層がどう間違えても起こせない。** この性質は言語に依存しない。

### 「計算ロジックを SQL に書かない」も維持する

不変条件8。実質資産・不足額・到達見込みは TypeScript の純粋関数で計算する。集計クエリにしない。データ規模は年間数百件で、全件取得で足りる。

### sqlc の代替

sqlc は「ORM を使わず、SQL を書いて型を得る」ために選んだ。同じ性質を保つ手段の選定は10章。

---

## 8. スキーマの移植（PostgreSQL → SQLite）

### そのまま移せるもの

- `CHECK (kind IN ('cash', 'investment'))` など、値を列挙する CHECK 制約はすべて使える
- **部分インデックスも使える。** `idx_lendings_outstanding`（`WHERE collected_amount < amount`）はそのまま
- `UNIQUE` 制約、複合インデックス

### 手当てが要るもの

| Postgres | SQLite / D1 | 対応 |
| --- | --- | --- |
| `UUID PRIMARY KEY` | 型が無い | `TEXT PRIMARY KEY`。採番は `crypto.randomUUID()` |
| `BIGINT` | `INTEGER` | SQLite の INTEGER は最大8バイト。金額に十分 |
| `TIMESTAMPTZ` | 型が無い | 10章で決定 |
| `DATE` | 型が無い | `TEXT` の `'YYYY-MM-DD'`。文字列比較で日付順に並ぶ |
| `DEFAULT now()` | `CURRENT_TIMESTAMP` | |
| **`CHECK (year_month = date_trunc('month', year_month)::date)`** | **`date_trunc` が無い** | 下記 |
| `REFERENCES accounts(id) ON DELETE RESTRICT` | 使えるが注意 | D1 は外部キーを既定で強制する。マイグレーション時は `PRAGMA defer_foreign_keys` が要る場合がある |

### `monthly_balances.year_month` の扱い

現行は `DATE` に月初日を入れ、`date_trunc` の CHECK でそれを保証している。SQLite には `date_trunc` が無い。

**`TEXT` の `'YYYY-MM'` に変える案を推す。**

```sql
year_month TEXT NOT NULL UNIQUE
    CHECK (year_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
```

理由は3つ。

- `domain.YearMonth` の `String()` が既に `"2026-07"` を返す。**格納形式とドメイン型の表現が一致する**
- API の経路も `PUT /api/monthly-balances/{yearMonth}` で `"2026-07"` を受けている。front も同じ形式
- 「月初日である」という制約を保つための CHECK が不要になる。**そもそも日を持たなければ、日がずれる余地が消える**

`YearMonth.FirstDay()` が不要になるのはこの変更による。

これは `docs/design.md` 2.2 の DDL からの逸脱にあたるため、**採用する場合は設計書側も直す。**

### マイグレーションツール

`wrangler d1 migrations` が goose を置き換える。連番のファイルを `migrations/` に置き、`wrangler d1 migrations apply` で適用する。ローカルと本番の両方に同じコマンドで当てられる。

---

## 9. front の変更

**変更は極めて小さい。** 20ファイル中、手を入れるのは実質1ファイル。

### 変えるもの

**`src/api/client.ts` の `baseUrl` を空文字にする。**

```ts
// 変更前
const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '')

// 変更後：同一オリジンから配信されるため相対パスで足りる
const baseUrl = ''
```

`VITE_API_BASE_URL` の設定が不要になる。`ApiError` のコメントにある「CORS で弾かれた」ケースも実質的に消える（コメントの手直しは要る）。

### 変えないもの

| 対象 | 理由 |
| --- | --- |
| `src/domain` に相当するロジック | **元々存在しない。** front で金額の計算をしていない（不変条件8） |
| `src/lib/format.ts` | 表示整形のみ。`formatMonths` の `null` 対応（「算出不可」を0と混同しない）も含めそのまま |
| `src/app/router.ts` | hash ルーティング。Workers Static Assets でも同じく動く |
| `src/app/useAsync.ts` | |
| 5つの画面 | API の形が変わらないため |
| `src/api/types.ts` | **API のレスポンス形状を変えないことを移行の制約とする** |
| `e2e/smoke.spec.ts` | `page.route` で API を差し替えており、サーバーもDBも起動しない。**移行の影響を受けない** |
| `src/test/setup.ts` の `afterEach(cleanup)` | 消すと前のテストの DOM が残る |

### 検討の余地があるもの

同一オリジンになるため、**認証トークンを `localStorage` から HttpOnly Cookie に移せる**（`src/app/token.ts`）。XSS で読まれない分だけ安全になる。

ただし現行方針は「単一ユーザーかつ自分の端末のみという前提で `localStorage` を許容する」（`docs/design.md` 4.5）であり、移行と同時にやる必要は無い。**別件として切り離す。**

---

## 10. 決定事項

**8件すべて決定済み。** 以下を前提に11章の順序で実装する。

| # | 論点 | 決定 | 理由 |
| --- | --- | --- | --- |
| 1 | トランザクションの扱い | **案 A：`batch()` + 条件付き UPDATE** | 追加コストゼロ。`accounts.balance` には CHECK 制約が無く DB が守れないため、そこを楽観ロックで埋める |
| 2 | クエリ層 | **生の `db.prepare()` + 手書きの行型** | 依存ゼロで sqlc に最も近い。「ORM は使わない」方針をそのまま引き継ぐ。型と SQL のズレは repository のテスト（#8）が検出する |
| 3 | 時刻の格納形式 | **`TEXT` の ISO8601** | D1 コンソールでそのまま読め、文字列比較で時系列順に並ぶ |
| 4 | `year_month` の型 | **`TEXT 'YYYY-MM'`（8章の案を採用）** | domain・API・front がすべて `'2026-07'` 形式。日を持たなければ日がずれる余地が消える。`docs/design.md` 2.2 も直す |
| 5 | レイヤ境界の機械的強制 | **oxlint の `no-restricted-imports`** | front で既に使っているため新しいツールが増えない。depguard と同じく CI で落ちる |
| 6 | HTTP ルータ | **Hono** | `app.request()` でハンドラを HTTP サーバー無しに単体テストできる |
| 7 | ディレクトリ配置 | **`worker/` を新設**（`server/` は段階8まで残す） | 移行中に Go の実装を参照でき、途中で止めてもリポジトリが壊れない |
| 8 | repository のテスト | **`@cloudflare/vitest-pool-workers` でローカル D1 に対して走らせる** | #1 の条件付き UPDATE が本当に効くかは、実際の D1 に当てないと確認できない |

### 決定から派生した設計

**#1（案 A）の適用範囲。** 楽観ロックの条件は「読み取った時点の値」を WHERE に含める形にする。`accounts` は `balance`、`lendings` は `collected_amount`、`wishes` は `status`。更新件数が0なら競合として扱い、`batch()` 全体がロールバックされる。競合時はリトライせずエラーを返す（単一ユーザーで、握り潰すより気付けるほうがよい）。

**#3・#4 による domain 型の変更。** Go の `time.Time` を `Date` に置き換えず、**用途別の branded string にする。**

| 用途 | 型 | 形式 |
| --- | --- | --- |
| 日付（`occurred_on` / `deadline`） | `IsoDate` | `'YYYY-MM-DD'` |
| 時刻（`updated_at` / `created_at`） | `Instant` | ISO8601（UTC） |
| 年月（`year_month`） | `YearMonth` | `'YYYY-MM'` |

`Date` はタイムゾーンを持つ。UTC 深夜0時の `Date` を JST で表示すると前日になり、日付だけを扱いたい列で必ず事故る。`YearMonth` が「日・時刻・タイムゾーンを持たない」設計になっているのと同じ理由を、日付にも適用する。DB の格納形式・API の受け渡し形式とも一致するため、境界での変換も消える。

**#4 により `YearMonth.FirstDay()` は移植しない。** `DATE` 列との変換専用のメソッドで、変換先が消える。

**`IsZero()` も移植しない。** Go の構造体にはゼロ値があるため未初期化の検出が要ったが、TypeScript では `YearMonth` を生成する経路がコンストラクタしか無い。`NewMonthlyBalance` の `ym.IsZero()` 検査も同時に消える（型が保証する）。

**エラーの返し方。** Go の `(値, error)` は TypeScript では例外にする。`DomainError` を throw し、handler が捕まえて 422 にする。ただし **「算出不可」を表す `(値, ok bool)` は例外にしない。** `AverageSurplus` と `MonthsToReach` は `null` を返す。これは異常ではなく正常な結果であり、front の `formatMonths` が既に `null` を「算出不可」として扱っている。

---

## 11. 実装の順序

10章の決定を前提とする。`CLAUDE.md` の「ループ協議」（1周＝変更→チェック→原因の言語化、最大5周、1周1パッケージ）はそのまま適用する。

| 段階 | 内容 | 完了の定義 |
| --- | --- | --- |
| 1 | `wrangler.jsonc`、D1 の作成、`migrations/0001_init.sql` | ローカル D1 にスキーマが当たる |
| 2 | **`domain` の移植とテスト** | domain のテストが全数通る。DB 不要 |
| 3 | `repository` と D1 アクセス | リポジトリのテストが通る |
| 4 | `usecase`（4章の決定を反映） | usecase のテストが通る |
| 5 | `handler`（19経路） | ハンドラのテストが通る |
| 6 | front の接続（9章）と静的アセット配信 | `npm run check` が通る。ローカルで5画面が動く |
| 7 | `wrangler deploy`、CI の更新 | 本番 URL で動く |
| 8 | `server/` の削除、`CLAUDE.md` と `docs/` の更新 | 古い記述が残っていない |

**段階2から始めるのが安全。** domain は純粋関数の集まりで外部依存が無いため、移植の正しさを最も安く検証できる。ここが通れば、アプリの存在理由である計算（不変条件1〜4）が保たれたことの確認になる。

### CI の変更

`.github/workflows/ci.yml` から Go のジョブ（`gofmt` / `go vet` / `go test` / `golangci-lint` / `sqlc diff` / postgres サービス）を削除し、Worker 側のテストジョブを追加する。デプロイは `wrangler deploy` を GitHub Actions から実行し、API トークンは Secrets に置く（不変条件17）。

`playwright.config.ts` の存在が front ジョブの切り替えスイッチになっているため、このファイルは動かさない。

---

## 12. 移行後も変わらないこと

**`CLAUDE.md` の不変条件17項は全部そのまま有効。** 言語とランタイムが変わっても、このアプリが何のために存在するかは変わらない。

特に以下は移行中に壊しやすいので、レビュー時に必ず確認する。

1. 実質資産の計算に `kind = 'investment'` の口座を含めない
2. 月次支出とウィッシュ由来の確定支出を二重計上しない
3. 実質資産から控除されるウィッシュは `status = 'committed'` のみ
4. 立替の未回収残高は `amount - collected_amount`。超過する回収は必ずエラー
8. 計算ロジックを SQL に書かない
15. **月額0円を厳守する**
17. 秘密情報と実データをリポジトリに入れない。**このリポジトリは public**

`docs/requirements.md` と `docs/design.md` の要件・API 仕様・用語も維持する。変更が必要になるのは 8章の `year_month` の件（決定次第）と、`docs/design.md` の技術スタック・インフラに関する記述のみ。

---

## 13. 移行しないもの

`CLAUDE.md`「やらないこと」は引き続きスコープ外。加えて、移行を機に持ち込まない。

- **Cloudflare Access / Zero Trust による認証** — 現行の固定トークン方式を維持する。単一ユーザーの前提が変わっていない
- **KV / R2 / Queues / Workers AI** — 使う理由が無い
- **D1 の Time Travel を前提としたバックアップ設計** — 段階として早い
- **Terraform による Cloudflare 管理** — provider は存在するが、Workers は `wrangler` が正道。IaC の学習は今回の優先事項から外れている

---

## 参考

- [Your frontend, backend, and database — now in one Cloudflare Worker](https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/)
- [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [D1 Database — Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)（`batch()` の原子性）
- [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
