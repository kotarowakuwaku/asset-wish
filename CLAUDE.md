# CLAUDE.md

このリポジトリで作業する際の前提。**作業を始める前に必ず読むこと。**

## プロジェクト概要

個人用の資産・ウィッシュ管理アプリ。単一ユーザー（作者本人）専用。

口座残高だけでは「本当に自由に使えるお金」が分からない、という課題を解く。支払いが確定した支出は残高に残ったままのため、実感と残高がズレる。これを差し引いた**実質資産**を出すことが、このアプリの存在理由である。

**貸し借り（Loan）は実質資産に含めない。** 別枠の参考値として、貸している額と借りている額を分けて表示するだけ。カードで立て替えた場合は現金がまだ出ていないため、「立て替えた ＝ 現金が出た」と決め打ちできない、というのが理由（2026-07-30 の仕様変更）。

あわせて、欲しいもの・やりたいこと・目標を登録し、それぞれに対して**あといくら足りないか**と**あと何ヶ月で届くか**を表示する。

詳細は以下を参照する。設計判断で迷ったらまずこれを読むこと。

- `docs/requirements.md` — 要件定義書 v1.0（決定事項と、却下した選択肢の理由を含む）
- `docs/design.md` — 設計書（DDL、ドメイン型、API、パッケージ構成、テスト方針）
- `docs/migration-cloudflare.md` — Go から TypeScript への移行の記録。**実測で分かった D1 の癖はここに集約されている**
- `docs/spec-changes.md` — **使ってみて出た仕様変更。進行中。** 残り2本の計画と、着手前に決めるべき論点がある

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
| サーバー | TypeScript（Cloudflare Workers） |
| HTTP ルータ | Hono |
| DB | Cloudflare D1（SQLite） |
| クエリ | 生の `db.prepare()` + 手書きの行型（ORM もクエリビルダも使わない） |
| サーバーのテスト | Vitest（`@cloudflare/vitest-pool-workers`。workerd の中で走る） |
| マイグレーション | `wrangler d1 migrations` |
| 配信 | front と API を同一 Worker から配信（同一オリジン。CORS は無い） |
| デプロイ | `main` へのマージで自動。手元からは `npm run deploy` |

**本番は `https://asset-wish.mochiya.workers.dev` で稼働中。** 認証は固定トークン方式。

**`main` に入ると自動でデプロイされる**（`.github/workflows/deploy.yml`）。D1 のマイグレーションもデプロイ前に自動で当たる。手元から出したいときは `npm run deploy`。

## リポジトリ構成

```
wrangler.jsonc     Worker 定義。D1 binding、静的アセット
migrations/        D1 のスキーマ。wrangler d1 migrations が管理
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
docs/              要件定義書・設計書・移行の記録
```

`package.json` はルートと `front/` の2つ。ルートが Worker 側で、front は独立している。

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
- `feat: domain に Money/YearMonth と実質資産計算を追加`
- `docs: monthsToReach の切り上げを明記`

---

## 絶対に守る不変条件

**以下に反する実装・提案をしてはならない。** レビュー時もここを最優先で確認する。

**番号は変えないこと。** コード中のコメントが番号で参照している。

### ドメインルール

1. **実質資産の計算に、`kind = 'investment'` の口座を含めない。** 投資資産は別枠の参考値として表示するだけ。ここが壊れるとアプリの目的が消える。
2. **月次支出とウィッシュ由来の確定支出を二重計上しない。** 生活費等は `monthly_balances` に、ライブや旅行などは `wishes` に登録する。同じ支出を両方に入れる実装・UI を作らない。
3. **実質資産から控除されるウィッシュは `status = 'committed'` のみ。** 検討中・完了・見送りは控除しない。
4. **貸し借りは実質資産に加算しない。** 未精算残高は `amount - settled_amount` で、**投資資産と同じ別枠の参考値**として返す。貸し借りの登録・精算で口座残高を動かしてはならず、取引履歴も作らない。精算額が未精算残高を超える操作は必ずエラーにする。**金額は向き（`direction`）によらず常に正で持つ。** 負の金額で「借りた」を表さない。符号に意味を持たせると `amount > 0` の検査が片方向に効かなくなる。**貸しと借りを差額にまとめない。** 引き算すると、誰にいくら貸しているのかが消える。

### アーキテクチャ

5. **`worker/src/domain` は外部依存ゼロ。** `hono`、`cloudflare:*`、`node:*`、`adapter`、`usecase`、`infra` を import しない。`.oxlintrc.json` の `no-restricted-imports` で機械的に強制されている。ルールに引っかかったら、ルールを緩めるのではなく設計を直す。
6. **状態遷移の可否判定は `domain` のエンティティメソッドに置く。** `usecase` や `handler` に `if status === ...` を書かない。usecase は「どの遷移を起こしたいか」だけを知る。
7. **D1 が返す行をそのまま `domain` に持ち込まない。** 行の型（`AccountRow` など）とドメインエンティティの相互変換は `adapter/repository` の責務。冗長でも境界を維持する。
8. **計算ロジックを SQL に書かない。** 実質資産・不足額・到達見込みは TypeScript の純粋関数で計算する。集計クエリで済ませない（テストに DB が必要になるため）。データ規模は年間数百件なので全件取得で問題ない。
9. **リポジトリのインターフェースは `usecase` に定義する。** 実装は `adapter/repository`。依存の向きは `handler → usecase → domain`。これも oxlint で強制されている。
10. **書き込みの原子性は `usecase` が決める。** 複数行にまたがる書き込みは `WriteOperation` の配列として usecase が組み立て、`AtomicWriter` が1回の `db.batch()` に流す。handler や repository が個別に書き込みの順序を決めない。

### 実装規約

11. **金額は `Money` 型で扱う。** 裸の `number` を持ち回らない。DB・JSON との境界でのみ `money()` を通す。
12. **導出できる値をカラムに持たない。** 例：貸し借りの精算状態は `amount` と `settled_amount` から判定する。`status` カラムを追加しない。
13. **ドメインエラーは HTTP 422 に対応させる。** 形式エラー（400）と業務ルール違反（422）を区別する。
14. **設計書 `docs/design.md` の用語をそのままコードの名前に使う。** 実質資産＝`NetAsset`、月間余剰＝`Surplus`、不足額＝`Shortfall`、未精算＝`Outstanding`。勝手に言い換えない。

### 運用

15. **月額0円を厳守する。** 有料プラン・有料サービスを前提とした提案をしない。無料枠を超える構成を導入しない。
16. **Cloudflare の Free プランから出ない。** Workers Paid に切り替えない。無料枠を持たない機能を導入しない。**Free プランは超過すると課金ではなく停止する**（確認済み）。この性質に依存して月額0円を担保している。
17. **秘密情報をリポジトリに入れない。** `AUTH_TOKEN` は `wrangler secret put` で登録し、手元は `.dev.vars`（gitignore 済み）に置く。読み出しは `worker/src/infra/config.ts` に集約する。**このリポジトリは public。** 1度 push したものは bot に数秒で拾われ、履歴から消しても手遅れになる。実データ（金額・口座名・人名）もコードやドキュメントに書かない。テストで使う値はすべて架空のものにする。

---

## コマンド

```bash
# worker（リポジトリのルートで実行する）
npm run check                  # typecheck + oxlint + vitest。ループの停止条件
npm run test                   # vitest のみ。workerd の中で走る
npm run types                  # worker-configuration.d.ts を生成（typecheck の前に自動で走る）
npm run migrate:local          # ローカル D1 にマイグレーションを当てる
npm run migrate:remote         # 本番 D1 に当てる
npm run dev                    # wrangler dev。localhost:8787 で front ごと動く
                               # 事前に front のビルドと .dev.vars の AUTH_TOKEN が要る
npm run deploy                 # 本番へ配置
npx wrangler d1 execute asset-wish --local --command "SELECT ..."

# front
cd front
npm run check                  # typecheck + oxlint + vitest + playwright。ループの停止条件
npm run dev                    # 開発サーバー（API は繋がらない。通しで見るならルートの npm run dev）
npm run build                  # front/dist を作る。Worker が配信するのはこれ
npx playwright test --ui       # E2E を目視で追う
```

`npm run check` が検証の入口。個別に走らせるより、まずこれを通す。

**front を書き換えたら `cd front && npm run build` を打ち直す。** `wrangler dev` は `worker/` の変更は拾うが、`front/dist` はビルド成果物なので自動では作り直されない。

## ループ協議 — 「完了」の定義

**チェックが緑になっていない状態を「完了」と呼んではならない。** 以下を1周として回す。

1. 変更を書く
2. 触った領域のチェックを走らせる

   | 触った場所 | 走らせるもの |
   | --- | --- |
   | `worker/` | ルートで `npm run check`（typecheck + oxlint + vitest） |
   | `migrations/`（D1 スキーマ） | 上記に加えて `npm run migrate:local` が通ること |
   | `front/` | `cd front && npm run check`（typecheck + oxlint + vitest + playwright） |

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
- `.oxlintrc.json` の `no-restricted-imports` を緩めてレイヤ違反を通す（不変条件5・9）
- 「本質的でない」としてチェックを回さずに済ませる

1周で触る範囲は原則1レイヤまで。範囲が広いほど、落ちたときに原因を特定できなくなる。

---

## 設計上の決定

**すでに決まっていること。** 蒸し返す前に理由を読むこと。

### 更新は操作別に分ける

全カラムを上書きする文を置かず、API の操作単位で分ける。

| テーブル | 置く文 | 置かないもの |
| --- | --- | --- |
| `accounts` | `updateAccountStatement`（名称・残高のみ） | `kind` を書ける文 |
| `wishes` | `updateWishContentStatement` / `updateWishStatusStatement` | 両方を1本で書ける文 |
| `loans` | `updateLoanSettledStatement` | `amount` を書ける文 |

**理由は、不変条件を型やレビューではなくスキーマ側で支えるため。**

- `kind` を `cash` → `investment` に書けると、その口座が実質資産から丸ごと消える（不変条件1）
- `status` を内容更新のついでに書けると、遷移の可否を判定する domain のメソッドを迂回できる（不変条件6）
- `amount` を精算のついでに書けると、未精算残高（`amount - settled_amount`）の意味が変わる（不変条件4）

**SQL に無い操作は、上の層がどう間違えても起こせない。** 冗長さと引き換えに、迂回路そのものを消す。

作成系は全カラムを引数に取ったままでよい。初期状態が `considering` であるといったルールは domain が持つべきで、SQL に定数で書き込むと逆にルールが散る。

**新しい更新操作が要るときは、既存の文に列を足さず、文を1本足す。**

### D1 の扱い

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 書き込みの原子性 | 先頭に「読み取り時の値が変わっていないか」だけを見る番人の文を置き、以降を `changes() = 1` で塞ぐ | **条件付き UPDATE を並べて後から更新件数を見る書き方は部分書き込みを残す**（実測済み）。詳細は移行の記録4章 |
| 競合の扱い | リトライせず `ConflictError`（409） | 握り潰して書き換えるより、気付けるほうがよい |
| クエリ層 | 生の `db.prepare()` + 手書きの行型 | 依存ゼロ。型と SQL のズレは repository のテストが検出する |
| 復元時の検証 | `restore` が `kind` / `status` / `category` を検証し、不正なら投げる | CHECK 制約をすり抜けた値をドメイン層に渡さないための最後の関門 |
| DB を使うテスト | miniflare のローカル D1。`migrations/` をそのまま流す | テスト側に DDL を書き写さない。`resetDb` で毎回消す |
| 型と値 | 金額は `Money`（branded number）、日付は `IsoDate`、時刻は `Instant`、年月は `YearMonth` | `Date` を domain に持ち込まない。タイムゾーンを持つ値は日付の意味を壊す |
| `year_month` | `TEXT 'YYYY-MM'` | 月初日の `DATE` ではない。日を持たなければ日がずれる余地が消える |

### usecase と handler

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 時刻と ID 採番 | `Clock` / `IDGenerator` として注入する | 実時刻に依存したテストは日付をまたいだ瞬間に落ちる |
| handler が依存する型 | usecase のクラスではなく handler 側に定義したインターフェース | HTTP の関心事だけをスタブで検証できる。手順は usecase のテストが見る |
| 未知のフィールド | 受け付けるキーを明示して照合し、外れれば 400 | 送れない項目（`status` / `kind`）を黙って無視すると「変えたつもりが変わっていない」になる |
| `deadline` の指定 | `key in body` でキー無し／`null`／日付を区別する | 区別しないと「変更しない」と「期限を外す」が同じに見える |
| 設定の検証 | リクエストのたびに検証し、不足なら 500 | Workers に起動の瞬間が無い。認証を素通りさせないことのほうが、動くことより優先される |
| 「算出不可」の表現 | 例外ではなく `null` | `averageSurplus` / `monthsToReach` / `monthlySavingNeeded` が該当する。0 と混同しない |

**エラーは 400 / 409 / 422 を必ず分ける。** 形式の誤り（400）は組み立て直す話、競合（409）は読み直してやり直す話、業務ルール違反（422）は値や状態を見直す話で、クライアント側の対処がまるで違う。`DomainError` は自動的に 422 になるので、新しい業務ルールを足すときは `domain` にエラーを定義する。

### front

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 画面の切り替え | ライブラリを入れず hash で持つ（`src/app/router.ts`） | 画面は5つ、入れ子も動的な経路も無い |
| データ取得 | 取得ライブラリを入れず `useAsync`（30行） | 単一ユーザーの画面にキャッシュも楽観更新も要らない。要るのは読み込み中・失敗・再読み込みの3つだけ |
| 通信の置き場 | `src/api/client.ts` に集約。画面から `fetch` を直に呼ばない | 認証・エラー変換・基底 URL が各画面に散ると、直すときに全画面を触る |
| 基底 URL | 空文字（同一オリジン） | **絶対 URL に戻すと CORS が復活する。戻さないこと** |
| E2E の API | Playwright の `page.route` で差し替え、サーバーも DB も起動しない | E2E で見たいのは画面の配線。サーバーの正しさは worker 側のテストが持つ |

**front で金額の計算をしない。** 実質資産・不足額・到達見込みはサーバーが算出済みの値を受け取って並べるだけ（不変条件8）。ここに式を書くと、同じ計算が2箇所に増えて必ずずれる。`src/lib/format.ts` に置いてよいのは表示整形だけ。

**到達見込みの `null` を 0 と混同しない。** `null` は「算出不可」で、0 として出すと「今月中に届く」と読める。`formatMonths` がこれを引き受けている。

**`src/test/setup.ts` の `afterEach(cleanup)` を消さないこと。** vitest の `globals` を有効にしていないため、Testing Library の自動クリーンアップが働かない。消すと前のテストの DOM が残り、「同じ名前の要素が複数ある」という実装のせいに見える落ち方をする。

---

## Go から TypeScript への移行について

**2026年7月に完了した。** 経緯・決定・実測した D1 の癖はすべて `docs/migration-cloudflare.md` にある。

きっかけは「クレジットカードを登録しない」という制約。GCP は無料枠を使うだけでも請求先アカウントが必須で、Cloud Run が選択肢から落ちた。言語の縛りを外した瞬間に、カード不要・月額0円・コールドスタート無しを全部満たす構成が現れた、というのが結論。

**設計は変えていない。** レイヤ構成も依存の向きも、リポジトリのインターフェースを usecase 側に置くことも、API の19経路もそのまま。捨てたのは言語とランタイムであって、設計ではない。

Go 版の実装（`server/`）は削除した。読みたい場合は `git log -- server/` から辿れる。

## やらないこと

以下は明示的にスコープ外。提案しない。

- 銀行 API 連携、レシート読み取り
- 日々の生活費の項目別記録（家計簿化）
- 複数ユーザー・共有機能
- 外貨・為替
- 確定支出の分割払い
- ウィッシュの合計金額と実質資産の比較（個別に見る方針で確定済み）
- App Store / Google Play への公開
- KV / R2 / Queues / Durable Objects / Workers AI（使う理由が無い）
- Cloudflare Access による認証（`*.workers.dev` には適用できず、独自ドメインが要る）
