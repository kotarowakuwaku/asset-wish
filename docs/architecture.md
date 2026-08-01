# アーキテクチャ

**構造については、この文書が唯一の正。** レイヤの責務・依存の向き・書き込みの原子性・命名・テストの方針で迷ったらここを見る。他の文書と食い違ったらこちらを取る。

ドメインの側は `docs/domain.md`。守るべきルールそのものは `CLAUDE.md` の「絶対に守る不変条件」にあり、この文書はその背景と詳細を持つ。

---

## 1. 全体構成

front と API を**同一の Worker から配信する**。同一オリジンなので CORS は無い。

```
ブラウザ
   │  同一オリジン
   ▼
Cloudflare Worker
   ├─ /api/*  以外 → front/dist の静的アセット
   └─ /api/*       → Hono のルータ
                       │
                       ▼
                    D1（SQLite）
```

| 領域 | 技術 |
| --- | --- |
| フロント | Vite + React + TypeScript（SPA） |
| サーバー | TypeScript（Cloudflare Workers）+ Hono |
| DB | Cloudflare D1（SQLite） |
| クエリ | 生の `db.prepare()` + 手書きの行型（ORM もクエリビルダも使わない） |
| マイグレーション | `wrangler d1 migrations` |
| 認証 | 固定トークン（単一ユーザーのため） |

**月額0円を厳守する**（不変条件15・16）。Cloudflare の Free プランは超過すると課金ではなく停止するので、この性質に依存して0円を担保している。

---

## 2. レイヤと依存の向き

```
handler ──▶ usecase ──▶ domain
   │           │
   └───────────┴──▶ （インターフェース）◀── adapter/repository が実装
```

**依存は必ず内向き。** `domain` は何も知らない。

| 層 | 置き場 | 責務 | 置かないもの |
| --- | --- | --- | --- |
| `domain` | `worker/src/domain/` | 型と純粋関数、エンティティの判断 | **外部依存すべて。** `hono` / `cloudflare:*` / `node:*` / 他の層 |
| `usecase` | `worker/src/usecase/` | 手順の組み立て、ポート（リポジトリの型）の定義、書き込みの原子性の決定 | 状態遷移の可否判定、計算式の再実装 |
| `adapter/handler` | `worker/src/adapter/handler/` | JSON の変換、エラーのステータスコードへの対応づけ | 業務判断 |
| `adapter/repository` | `worker/src/adapter/repository/` | D1 アクセス、行型とドメイン型の相互変換 | 計算・集計 |
| `infra` | `worker/src/infra/` | 設定の読み出しと検証 | |

### 機械的に守られているもの

**`domain` の外部依存ゼロは `.oxlintrc.json` の `no-restricted-imports` が強制する**（不変条件5）。`npm run check` で落ちる。**ルールに引っかかったら、ルールを緩めるのではなく設計を直す。**

### リポジトリのインターフェースは `usecase` に置く（不変条件9）

実装は `adapter/repository`。使う側がインターフェースを持つことで、依存の向きが `handler → usecase → domain` に保たれる。

### 判断は domain のエンティティに置く（不変条件6）

`usecase` や `handler` に `if (status === ...)` を書かない。usecase は「どの遷移を起こしたいか」だけを知り、それが許されるかは知らない。

```ts
// ✕ usecase が判定する
if (wish.status !== 'committed') throw ...

// ○ domain が判定する。usecase は起こしたい遷移を呼ぶだけ
wish.pay()
```

同じ考え方は削除可否にも適用する（`Transaction.ensureDeletable()`）。

### 行をそのまま domain に持ち込まない（不変条件7）

`AccountRow` のような行の型とドメインエンティティの相互変換は `adapter/repository` の責務。冗長でも境界を維持する。

**復元時に検証する。** `restore` が `kind` / `status` / `category` / 年月を検証し、不正なら投げる。CHECK 制約をすり抜けた値をドメインに渡さないための最後の関門。

---

## 3. 書き込みの原子性

### D1 にトランザクションが無い

D1 は `BEGIN TRANSACTION` を受け付けない。代わりに `db.batch()` があり、**1回の呼び出しが1つのトランザクションとして働く**。`batch()` をまたぐ原子性は無い。

読み取りと書き込みの間に JS の判断が挟まるため、「読む → domain が判断する → 書く」を丸ごと `batch()` に入れることはできない。そこで**書き込み部分だけをデータとして組み立て、1回の batch に流す**。

### 実測で分かったこと

**条件付き UPDATE を並べて「更新0件なら競合」と後から判定する書き方は壊れる。** 実際の D1 に対して確かめた結果：

| 確かめたこと | 結果 |
| --- | --- |
| 条件に合わず0件だった UPDATE の後ろの INSERT は実行されるか | **される**（部分書き込みが残る） |
| `changes()` は batch の中で文をまたいで直前の結果を引き継ぐか | **引き継ぐ** |
| 文がエラーになれば batch 全体が巻き戻るか | **巻き戻る** |
| 外部キー違反はどう出るか | `FOREIGN KEY constraint failed` を含むエラー |

`batch()` が原子的なのは「文がエラーになったとき」であって、「条件に合わず0件だったとき」ではない。

### 採用した形：先頭に番人を置く

1. 先頭に「読み取り時の値が今も変わっていないか」だけを見る**番人の文**を置く（値を変えない UPDATE）
2. 以降のすべての文を `changes() = 1` で塞ぐ

番人が0件なら、後続はすべて素通りして**1件も書き込まれない**。番人が「値を変えない UPDATE」なのは、`changes()` を1にできる文が UPDATE / INSERT / DELETE しか無く、SELECT では動かないため。

**前提条件を後続の文にばらして持たせない。** 先に走った UPDATE が対象の行を書き換え、あとの条件がその新しい値を見てしまう。判定は必ず「何も書き換えていない時点」で済ませる。

実装は `worker/src/adapter/repository/writer.ts`。上の性質は `writer.test.ts` が**実 D1 に対して固定している**。

### usecase が組み立てる（不変条件10）

複数行にまたがる書き込みは、usecase が `WriteOperation` の配列として組み立て、`AtomicWriter` が1回の `db.batch()` に流す。handler や repository が個別に順序を決めない。

**同じ行への更新を2本並べない。** 2本目の「読み取り時の値」が1本目の適用後の値と食い違い、番人が必ず失敗する。定期入出金の適用では、口座ごとに増減を合算してから1本にしている。

### 競合はリトライせず 409

握り潰して書き換えるより、気付けるほうがよい。単一ユーザーでも PC とスマホ、あるいは複数タブで起こりうる。

---

## 4. 更新は操作別に分ける

**全カラムを上書きする文を置かず、API の操作単位で分ける。**

| テーブル | 置く文 | 置かないもの |
| --- | --- | --- |
| `accounts` | `updateAccountStatement`（名称・残高のみ） | `kind` を書ける文 |
| `wishes` | `updateWishContentStatement` / `updateWishStatusStatement` | 両方を1本で書ける文 |
| `loans` | `updateLoanSettledStatement` | `amount` を書ける文 |
| `recurring_entries` | `updateRecurringAppliedStatement`（適用済み年月のみ） | 金額・適用日・口座を書ける文 |
| `monthly_balances` | 無し（読み取り専用） | すべて |

**理由は、不変条件を型やレビューではなくスキーマ側で支えるため。**

- `kind` を書けると、その口座が実質資産から丸ごと消える（不変条件1）
- `status` を内容更新のついでに書けると、遷移の可否を判定する domain のメソッドを迂回できる（不変条件6）
- `amount` を精算のついでに書けると、未精算残高の意味が変わる（不変条件4）

**SQL に無い操作は、上の層がどう間違えても起こせない。** 冗長さと引き換えに、迂回路そのものを消す。

**新しい更新操作が要るときは、既存の文に列を足さず、文を1本足す。**

作成系は全カラムを引数に取ったままでよい。初期状態が `considering` であるといったルールは domain が持つべきで、SQL に定数で書き込むと逆にルールが散る。

---

## 5. 型と値

| 対象 | 型 | 理由 |
| --- | --- | --- |
| 金額 | `Money`（branded number） | 裸の `number` を持ち回らない（不変条件11）。境界でのみ `money()` を通す |
| 日付 | `IsoDate`（`'YYYY-MM-DD'`） | `Date` はタイムゾーンを持つ。日付だけを扱いたい値で事故る |
| 時刻 | `Instant`（ISO8601 の UTC） | 同上。文字列比較で時系列順に並ぶ |
| 年月 | `YearMonth` | 日を持たなければ、日がずれる余地が消える |

**`Date` を domain に持ち込まない。** 唯一の例外は `parseIsoDate` で、存在しない日付（`2026-02-31`）を弾く検査にだけ使い、値としては保持しない。`YearMonth.daysInMonth()` は `Date` を使わずに閏年を判定する。

**計算を SQL に書かない**（不変条件8）。実質資産・不足額・到達見込み・月次の集計は TypeScript の純粋関数で出す。集計クエリで済ませると、計算のテストに DB が要る。データ規模は年間数百件なので全件取得で足りる。

**導出できる値をカラムに持たない**（不変条件12）。貸借の精算状態は `amount` と `settledAmount` から出す。月次の集計は明細から出す。

---

## 6. handler の約束

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 状態遷移 | `PATCH { status }` ではなく専用の経路（`/commit` `/pay` `/drop`） | クライアントが不正な状態を組み立てられないようにする |
| 未知のフィールド | 受け付けるキーを明示して照合し、外れれば 400 | 送れない項目を黙って無視すると「変えたつもりが変わっていない」になる |
| `deadline` の指定 | `key in body` でキー無し／`null`／日付を区別する | 区別しないと「変更しない」と「期限を外す」が同じに見える |
| 時刻と ID 採番 | `Clock` / `IDGenerator` として注入 | 実時刻に依存したテストは日付をまたいだ瞬間に落ちる |
| handler が依存する型 | usecase のクラスではなく handler 側のインターフェース | HTTP の関心事だけをスタブで検証できる |
| 設定の検証 | リクエストのたびに検証し、不足なら 500 | Workers に起動の瞬間が無い。認証を素通りさせないことが優先 |
| 「算出不可」 | 例外ではなく `null` | 0 と混同しない |

### エラーは 400 / 404 / 409 / 422 を必ず分ける

| 状況 | コード | クライアントの対処 |
| --- | --- | --- |
| 形式の誤り（型・桁・未知のキー） | **400** | 組み立て直す |
| 対象が無い | **404** | |
| 読み取りから書き込みの間に競合 | **409** | 読み直してやり直す |
| 業務ルール違反 | **422** | 値や状態を見直す |

`DomainError` は自動的に 422 になる。**新しい業務ルールを足すときは、`domain/errors.ts` にコードを定義する**（不変条件13）。handler で個別に 422 を投げない。

---

## 7. front の約束

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 画面の切り替え | ライブラリを入れず hash で持つ（`src/app/router.ts`） | 画面は7つ、入れ子も動的な経路も無い |
| データ取得 | 取得ライブラリを入れず `useAsync`（30行） | 要るのは読み込み中・失敗・再読み込みの3つだけ |
| 通信の置き場 | `src/api/client.ts` に集約。画面から `fetch` を直に呼ばない | 認証・エラー変換・基底 URL が散ると、直すときに全画面を触る |
| 基底 URL | 空文字（同一オリジン） | **絶対 URL に戻すと CORS が復活する。戻さないこと** |
| E2E の API | Playwright の `page.route` で差し替え、サーバーも DB も起動しない | 見たいのは画面の配線。サーバーの正しさは worker 側が持つ |

**front で金額の計算をしない**（不変条件8）。サーバーが算出済みの値を並べるだけ。`src/lib/format.ts` に置いてよいのは表示整形だけ。

入出金の向き（入金／出金の select から符号を付ける）は計算ではなく、**向きの表し方をサーバーに合わせているだけ**。

**「算出不可」の `null` を 0 と混同しない。** `formatMonths` / `formatMonthlySaving` がこれを引き受ける。

**`src/test/setup.ts` の `afterEach(cleanup)` を消さない。** vitest の `globals` を有効にしていないため、Testing Library の自動クリーンアップが働かない。消すと前のテストの DOM が残り、「同じ名前の要素が複数ある」という実装のせいに見える落ち方をする。

---

## 8. テスト方針

| 層 | 何を見るか | 道具 |
| --- | --- | --- |
| `domain` | 計算と判断。**ここは例外なくテストが要る** | vitest。DB も HTTP も要らない |
| `usecase` | 手順の組み立て、書き込みの中身、競合 | 手書きの fake（`worker/test/fakes.ts`）。モックライブラリは使わない |
| `adapter/repository` | SQL と行型のズレ、CHECK 制約 | miniflare のローカル D1。`migrations/` をそのまま流す |
| `adapter/handler` | ステータスコード、JSON の形、エラーの対応づけ | スタブ（`worker/test/stubs.ts`） |
| 統合（`integration.test.ts`） | 結線。index.ts の組み立て・SQL・計算が API 越しに噛み合うか | 実 D1・実 usecase・実 repository |
| front | 受け取った値をどう見せるか | Testing Library |
| E2E | 画面の配線（登録できる、一覧に出る、ボタンが効く） | Playwright + `page.route` |

**テスト側に DDL を書き写さない。** `migrations/` をそのまま流し、`resetDb` で毎回消す。

**実データを書かない**（不変条件17）。金額・口座名・人名はすべて架空のものにする。**このリポジトリは public。**

境界値を必ず含める：0円、余剰0、データ0件、月末の無い月、終端状態からの遷移、過精算。

---

## 9. 命名規約

### ブランチ

| prefix | 用途 |
| --- | --- |
| `feat/` | 新機能 |
| `fix/` | バグ修正 |
| `refactor/` | 挙動を変えない改修 |
| `docs/` | ドキュメントのみ |
| `chore/` | ビルド・CI・依存関係など |

迷ったら `feat/`。

### コミットメッセージ

ブランチと同じプレフィクスを使い、`prefix: 要約` の形にする。日本語でよい。詳細は本文で補う。

### コードの名前

`docs/domain.md` の用語表をそのまま使う（不変条件14）。

---

## 10. リポジトリ構成

```
wrangler.jsonc     Worker 定義。D1 binding、静的アセット
migrations/        D1 のスキーマ。wrangler d1 migrations が管理
scripts/           制約チェックなどの補助スクリプト
worker/
  src/
    domain/        純粋関数と型。外部依存ゼロ（不変条件5）
    usecase/       手順の組み立てとポート定義
    adapter/
      handler/     Hono のルート、DTO、リクエストの解釈
      repository/  D1 アクセスとドメイン型への詰め替え
    infra/         設定の読み出しと検証
    index.ts       エントリポイント（結線）
  test/            fake・スタブ・テスト用の道具
front/             Vite + React + TypeScript
docs/              この文書と、ドメイン・要件・決定の記録
```

`package.json` はルートと `front/` の2つ。ルートが Worker 側。

**結線は `worker/src/index.ts` に手書きする。** DI コンテナは使わない。依存関係を追うのに別の仕組みを覚える必要がなく、結線が1箇所に見えるほうが学習目的に合う。

---

## 11. API 一覧

正確な入出力は `worker/src/adapter/handler/app.ts` と `dto.ts` を見ること。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/dashboard` | トップに必要な値をまとめて返す |
| GET / POST | `/api/accounts` | 口座の一覧・作成 |
| PATCH / DELETE | `/api/accounts/{id}` | 名称と残高の更新（種別は変更不可）・削除 |
| GET / POST | `/api/loans` | 貸借の一覧（`?outstanding=true`）・登録 |
| POST | `/api/loans/{id}/settle` | 精算の記録 |
| DELETE | `/api/loans/{id}` | 貸借の削除 |
| GET / POST | `/api/wishes` | ウィッシュの一覧（`?status=`）・登録 |
| PATCH / DELETE | `/api/wishes/{id}` | 内容の更新・削除 |
| POST | `/api/wishes/{id}/commit` `/pay` `/drop` | 状態遷移 |
| GET / POST | `/api/transactions` | 取引履歴の一覧（`?limit=`）・入出金の明細を打つ |
| DELETE | `/api/transactions/{id}` | 明細の削除（手入力のもののみ。残高が戻る） |
| GET / POST | `/api/recurring-entries` | 定期入出金の一覧・登録 |
| POST | `/api/recurring-entries/apply` | 未適用分をまとめて適用 |
| DELETE | `/api/recurring-entries/{id}` | 定期入出金の削除（履歴は残る） |
| GET | `/api/monthly-summaries` | 月次の集計（明細から導出） |

---

## 12. 運用

**`main` へのマージで自動デプロイされる**（`.github/workflows/deploy.yml`）。D1 のマイグレーションもデプロイ前に自動で当たる。手元からは `npm run deploy`。

**秘密情報をリポジトリに入れない**（不変条件17）。`AUTH_TOKEN` は `wrangler secret put` で登録し、手元は `.dev.vars`（gitignore 済み）。読み出しは `worker/src/infra/config.ts` に集約する。

### CI の検証の網

**ブランチ保護が必須にするのは `ci` ジョブひとつだけ。**

個別のジョブ名を必須にできないのは、`worker` / `front` が paths-filter で skip されうるため。かといって `changes`（paths-filter そのもの）を必須にすると、**テストが落ちていてもマージできてしまう**（実際に一度この状態になっていた）。

`ci` は全ジョブの結果を集約し、skip は通過扱い、それ以外の非 success は落とす。

**CI にジョブを追加したら、`ci` の `needs` にも必ず足すこと。** 忘れるとそのジョブは保護の対象外になり、静かに検証の網から漏れる。**落ちているのに気付けない検証は、無いより悪い。** `scripts/check-constraints.sh` がこの漏れを検出する（これも一度やった）。

**CI で LLM は回さない。** 従量課金か利用枠の消費が発生し、月額0円の前提が崩れる（不変条件15・16）。読んでの深いレビューは手元の `/architecture-review` が持つ。

### リポジトリを public にしている理由

GitHub Actions の実行時間が無制限で無料になるため。private の Free プランは月2,000分で、ジョブごとに分単位で切り上げられる。エージェントにループを回させる以上 CI の実行回数が読めず、分数を気にして検証を削るのは本末転倒。

**代償として、秘密情報の事故が即座に致命的になる。** push protection を有効にし、コミットの Author には GitHub の noreply アドレスを使う。

### 使わないもの

KV / R2 / Queues / Durable Objects / Workers AI は使う理由が無い。Cloudflare Access は `*.workers.dev` に適用できず、独自ドメインが要るため使えない。
