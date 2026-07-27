# 設計書

個人資産・ウィッシュ管理アプリ

| 項目 | 内容 |
| --- | --- |
| 版数 | 0.1 |
| 作成日 | 2026-07-26 |
| 対応要件 | 要件定義書 v1.0 |
| 対象範囲 | データモデル、ドメイン層、API、パッケージ構成、テスト方針 |
| 対象外 | Terraform コード、画面ワイヤーフレーム（別途） |

> **注記：** 本書は概観・方針レベルの設計。実装時のシグネチャ・エラーコード・テストケースは `docs/detailed-design.md` を正とする。両者に齟齬があれば詳細設計書に従う。

---

## 1. 全体構成

```
┌──────────────┐   HTTPS    ┌──────────────┐          ┌──────────┐
│  ブラウザ    │ ─────────▶ │  Cloud Run   │ ───────▶ │  Neon    │
│  (front/SPA) │            │  (server/Go) │          │ Postgres │
└──────────────┘            └──────────────┘          └──────────┘
      ▲                            ▲
      │ 静的ホスティング           │ deploy
      │                            │
┌─────────────────────────────────────────────┐
│  GitHub（モノレポ） / GitHub Actions        │
└─────────────────────────────────────────────┘
                     │
                     │ terraform apply
                     ▼
              GCP（Cloud Run / Artifact Registry / Budget）
```

---

## 2. データモデル

### 2.1 方針

- 主キーは UUID。クライアント側で採番できるため、オフライン対応を後から入れる余地が残る
- 金額は `BIGINT`（円単位の整数）。浮動小数点は使わない
- **導出できる値はカラムに持たない。** 立替の回収状態は `amount` と `collected_amount` から判定できるため `status` カラムを持たない
- 制約は DB 側にも書く。ドメイン層のバリデーションと二重になるが、DB は最後の砦として扱う

### 2.2 DDL

```sql
-- 口座
CREATE TABLE accounts (
    id          UUID PRIMARY KEY,
    name        TEXT        NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('cash', 'investment')),
    balance     BIGINT      NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 立替
CREATE TABLE lendings (
    id               UUID        PRIMARY KEY,
    counterparty     TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    amount           BIGINT      NOT NULL CHECK (amount > 0),
    collected_amount BIGINT      NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
    occurred_on      DATE        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT lendings_collected_within_amount
        CHECK (collected_amount <= amount)
);

CREATE INDEX idx_lendings_outstanding
    ON lendings (occurred_on DESC)
    WHERE collected_amount < amount;

-- ウィッシュ
CREATE TABLE wishes (
    id         UUID        PRIMARY KEY,
    title      TEXT        NOT NULL,
    amount     BIGINT      NOT NULL CHECK (amount > 0),
    category   TEXT        NOT NULL CHECK (category IN ('item', 'experience', 'goal')),
    status     TEXT        NOT NULL CHECK (status IN ('considering', 'committed', 'done', 'dropped')),
    priority   INTEGER     NOT NULL DEFAULT 0,
    deadline   DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wishes_status_priority ON wishes (status, priority);

-- 月次収支
CREATE TABLE monthly_balances (
    id         UUID        PRIMARY KEY,
    year_month DATE        NOT NULL UNIQUE,
    income     BIGINT      NOT NULL CHECK (income  >= 0),
    expense    BIGINT      NOT NULL CHECK (expense >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT monthly_balances_is_first_day
        CHECK (year_month = date_trunc('month', year_month)::date)
);

-- 取引履歴
CREATE TABLE transactions (
    id          UUID        PRIMARY KEY,
    account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      BIGINT      NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN (
                    'lending_created', 'lending_collected', 'wish_paid', 'adjustment')),
    ref_id      UUID,
    occurred_on DATE        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, occurred_on DESC);
```

### 2.3 補足

**`year_month` を DATE で持つ理由**

`'2026-07'` のような文字列や `202607` のような整数ではなく、月初日の DATE として持つ。範囲検索がそのまま書け、「直近3ヶ月」の取得が `ORDER BY year_month DESC LIMIT 3` で済む。月初日であることは CHECK 制約で保証する。

**立替の部分インデックス**

未回収の一覧が主要な参照パターンのため、`collected_amount < amount` の部分インデックスを張る。回収済みのレコードが積み上がっても未回収の検索速度が落ちない。個人利用の規模では過剰だが、部分インデックスを書く練習として入れている。

**`transactions.ref_id` に外部キーを張らない理由**

参照先が `lendings` と `wishes` の両方になるポリモーフィックな参照のため、FK 制約は付けられない。整合性はアプリケーション側で担保する。ここは設計上の妥協点として認識しておく。

---

## 3. ドメイン層

### 3.1 Money

```go
package domain

// Money は日本円を円単位で表す。
type Money int64

func (m Money) Add(o Money) Money  { return m + o }
func (m Money) Sub(o Money) Money  { return m - o }
func (m Money) IsPositive() bool   { return m > 0 }
func (m Money) IsNegative() bool   { return m < 0 }
func (m Money) IsZero() bool       { return m == 0 }
```

`int64` の型エイリアスにメソッドを生やす形とする。構造体にしないのは、ゼロ値がそのまま「0円」として意味を持ち、比較演算子がそのまま使えるため。通貨が複数になったら構造体に変える。

### 3.2 YearMonth

月単位の識別子。`time.Time` を裸で扱うと以下の事故が避けられない。

- 月初以外の日（`2026-07-15` など）を代入できてしまう
- タイムゾーンが持ち込まれる。JST の月初は UTC では前月末日になり、DB との変換で必ず事故る
- 比較・ソートの意味が曖昧になる（同じ月でも時刻が違えば `!=`）

Money を `int64` の裸で扱わないのと同じ理由で、専用の値オブジェクトにする。

```go
package domain

type YearMonth struct {
    year  int
    month time.Month
}

// 月が [1, 12] の範囲外なら ErrInvalidYearMonth。
func NewYearMonth(y int, m time.Month) (YearMonth, error)

func (ym YearMonth) Year() int         { return ym.year }
func (ym YearMonth) Month() time.Month { return ym.month }

// "2026-07" 形式。
func (ym YearMonth) String() string

// 年月の昇順比較。
func (ym YearMonth) Before(o YearMonth) bool

// n ヶ月加算（n が負なら減算）。繰り上がり・繰り下がりを含む。
func (ym YearMonth) AddMonths(n int) YearMonth
```

**非公開フィールド + コンストラクタの意図：** 不正な値を持つインスタンスを構造的に作れなくする。タイムゾーンを型に持ち込まない。等値比較は値レシーバなので `==` がそのまま使える。DB との変換（月初 DATE ⇔ YearMonth）は `adapter/repository` の責務。

### 3.3 エンティティ

```go
type AccountKind string

const (
    AccountKindCash       AccountKind = "cash"
    AccountKindInvestment AccountKind = "investment"
)

type Account struct {
    ID        uuid.UUID
    Name      string
    Kind      AccountKind
    Balance   Money
    UpdatedAt time.Time
}

// 実質資産に算入するかどうか。
func (a Account) CountsTowardNetAsset() bool {
    return a.Kind == AccountKindCash
}
```

```go
type Lending struct {
    ID              uuid.UUID
    Counterparty    string
    Description     string
    Amount          Money
    CollectedAmount Money
    OccurredOn      time.Time
}

// 未回収残高。実質資産への加算対象。
func (l Lending) Outstanding() Money {
    return l.Amount.Sub(l.CollectedAmount)
}

func (l Lending) IsFullyCollected() bool {
    return l.Outstanding().IsZero()
}

// 回収を記録する。過回収は許さない。
func (l *Lending) Collect(amount Money) error {
    if !amount.IsPositive() {
        return ErrInvalidAmount
    }
    if amount > l.Outstanding() {
        return ErrCollectExceedsOutstanding
    }
    l.CollectedAmount = l.CollectedAmount.Add(amount)
    return nil
}
```

```go
type WishStatus string

const (
    WishConsidering WishStatus = "considering"
    WishCommitted   WishStatus = "committed"
    WishDone        WishStatus = "done"
    WishDropped     WishStatus = "dropped"
)

type Wish struct {
    ID       uuid.UUID
    Title    string
    Amount   Money
    Category WishCategory
    Status   WishStatus
    Priority int
    Deadline *time.Time
}

// 確定支出として実質資産から控除されるか。
func (w Wish) IsCommitment() bool {
    return w.Status == WishCommitted
}
```

```go
type MonthlyBalance struct {
    ID        uuid.UUID
    YearMonth YearMonth
    Income    Money
    Expense   Money
}

// Income / Expense が負なら ErrNegativeAmount、ym がゼロ値なら ErrInvalidYearMonth。
// 詳細は detailed-design.md 2.7 を参照。
func NewMonthlyBalance(id uuid.UUID, ym YearMonth, income, expense Money) (MonthlyBalance, error)

// 月間余剰。負にもなり得る（支出過多）。
func (m MonthlyBalance) Surplus() Money { return m.Income.Sub(m.Expense) }
```

各エンティティにはコンストラクタを設け、不正な値を持つ構造体を作れないようにする。フィールドは公開のまま置くが、生成経路はコンストラクタに一本化する（Go 慣用に沿わせつつ、DDL の CHECK 制約と対をなす）。`UpdatedAt` を持たないのは、ドメインが判断に用いない値だから。`Account` が `UpdatedAt` を持つのは、残高の古さが催促表示の判断材料だからで、**ドメインが判断に使うかどうかが基準**となる。

### 3.4 状態遷移

**遷移ルールはエンティティのメソッドに閉じ込める。** usecase 層は「どの遷移を起こしたいか」だけを知り、その遷移が許されるかは知らない。

```go
// 検討中 → 確定
func (w *Wish) Commit() error {
    if w.Status != WishConsidering {
        return ErrInvalidTransition
    }
    w.Status = WishCommitted
    return nil
}

// 確定 → 完了
func (w *Wish) Pay() error {
    if w.Status != WishCommitted {
        return ErrInvalidTransition
    }
    w.Status = WishDone
    return nil
}

// 検討中 or 確定 → 見送り
func (w *Wish) Drop() error {
    if w.Status != WishConsidering && w.Status != WishCommitted {
        return ErrInvalidTransition
    }
    w.Status = WishDropped
    return nil
}
```

遷移表：

| From \ To | considering | committed | done | dropped |
| --- | --- | --- | --- | --- |
| considering | — | Commit | ✕ | Drop |
| committed | ✕ | — | Pay | Drop |
| done | ✕ | ✕ | — | ✕ |
| dropped | ✕ | ✕ | ✕ | — |

完了と見送りは終端状態。取り消しは行わない（誤操作は削除して作り直す）。

### 3.5 計算ロジック

**本アプリの中核。外部依存を一切持たない純粋関数として実装する。**

```go
// networth.go

// 実質資産 = 現金預金 + 未回収立替 − 確定支出
func CalculateNetAsset(accounts []Account, lendings []Lending, wishes []Wish) Money {
    var total Money
    for _, a := range accounts {
        if a.CountsTowardNetAsset() {
            total = total.Add(a.Balance)
        }
    }
    for _, l := range lendings {
        total = total.Add(l.Outstanding())
    }
    for _, w := range wishes {
        if w.IsCommitment() {
            total = total.Sub(w.Amount)
        }
    }
    return total
}

// 投資資産の合計（参考値。実質資産には含めない）
func CalculateInvestmentTotal(accounts []Account) Money

// 不足額 = ウィッシュ金額 − 実質資産
func CalculateShortfall(wish Wish, netAsset Money) Money

// 直近 n ヶ月の平均月間余剰。データが n 未満なら存在する分だけで平均する。
// データが 0 件なら ok=false。
func AverageSurplus(balances []MonthlyBalance, months int) (Money, bool)

// 到達見込み月数。切り上げ除算。
// 平均余剰が 0 以下、または不足額が 0 以下（既に達成）なら ok=false。
// 浮動小数点は使わない。金額計算に float を持ち込むと型の一貫性が崩れる。
func MonthsToReach(shortfall, avgSurplus Money) (int, bool) {
    if shortfall <= 0 || avgSurplus <= 0 {
        return 0, false
    }
    return int((shortfall + avgSurplus - 1) / avgSurplus), true
}
```

`(a + b - 1) / b` は正の整数に対する切り上げ除算。ちょうど割り切れる場合（例：不足120万 ÷ 月余剰20万 = 6.0）も6を返す。テストは割り切れるケースと割り切れないケースの両方を必ず含める。境界を1つ間違えると全部ずれる。

`AverageSurplus` に渡す `balances` は **年月の降順にソート済み**であることを前提とする。ソートは呼び出し側（usecase）の責務。

**全件をメモリに載せて計算する方針を取る。** SQL の集計関数で実質資産を出すこともできるが、計算ロジックが SQL に漏れるとテストに DB が必要になる。データ規模が年間数百件のため、全件取得のコストは問題にならない。性能が問題になった時点で集計クエリに寄せる。

---

## 4. API 設計

### 4.1 方針

- ベースパス `/api`。バージョニングは行わない（単一クライアントのため）
- 金額は JSON 上も整数（円）。文字列にはしない
- 日付は `YYYY-MM-DD`、日時は RFC3339
- **状態遷移は `PATCH /wishes/:id { status: ... }` ではなく、専用のエンドポイントにする。** 遷移ルールの判断をサーバー側に閉じ込め、クライアントが不正な状態を組み立てられないようにするため

### 4.2 エンドポイント一覧

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/dashboard` | ダッシュボード用の集約データ |
| GET | `/api/accounts` | 口座一覧 |
| POST | `/api/accounts` | 口座作成 |
| PATCH | `/api/accounts/{id}` | 口座の更新（名称・残高。種別は変更不可） |
| DELETE | `/api/accounts/{id}` | 口座削除 |
| GET | `/api/lendings` | 立替一覧（`?outstanding=true` で未回収のみ） |
| POST | `/api/lendings` | 立替登録 |
| POST | `/api/lendings/{id}/collect` | 回収の記録 |
| DELETE | `/api/lendings/{id}` | 立替削除 |
| GET | `/api/wishes` | ウィッシュ一覧（`?status=` で絞り込み） |
| POST | `/api/wishes` | ウィッシュ登録 |
| PATCH | `/api/wishes/{id}` | 内容の更新（title / amount / category / priority / deadline） |
| POST | `/api/wishes/{id}/commit` | 検討中 → 確定 |
| POST | `/api/wishes/{id}/pay` | 確定 → 完了 |
| POST | `/api/wishes/{id}/drop` | → 見送り |
| DELETE | `/api/wishes/{id}` | ウィッシュ削除 |
| GET | `/api/monthly-balances` | 月次収支一覧（降順） |
| PUT | `/api/monthly-balances/{yearMonth}` | 月次収支の登録・更新（冪等） |
| GET | `/api/transactions` | 取引履歴 |

### 4.3 主要なリクエスト／レスポンス

**`GET /api/dashboard`**

ラウンドトリップを減らすため、トップ画面に必要な値をまとめて返す。

```json
{
  "netAsset": 842000,
  "breakdown": {
    "cashTotal": 910000,
    "outstandingLendings": 12000,
    "commitments": 80000
  },
  "investmentTotal": 350000,
  "averageSurplus": 65000,
  "wishes": [
    {
      "id": "…",
      "title": "…",
      "amount": 1200000,
      "status": "considering",
      "shortfall": 358000,
      "monthsToReach": 6
    }
  ]
}
```

`monthsToReach` は算出不可の場合 `null` を返す。クライアント側は `null` を「算出不可」と表示する。

**`POST /api/lendings/{id}/collect`**

```json
{ "amount": 5000, "occurredOn": "2026-07-26", "accountId": "…" }
```

回収額が未回収残高を超える場合は 422 を返す。`accountId` は入金先の口座で、残高への反映と取引履歴の記録に使う。

**`PUT /api/monthly-balances/{yearMonth}`**

`yearMonth` は `2026-07` 形式。同じ月への再送信は上書きとなる（冪等）。

```json
{ "income": 320000, "expense": 255000 }
```

### 4.4 エラーレスポンス

```json
{ "error": { "code": "INVALID_TRANSITION", "message": "…" } }
```

| HTTP | 用途 |
| --- | --- |
| 400 | リクエスト形式の誤り |
| 401 | 認証失敗 |
| 404 | 対象が存在しない |
| 422 | ドメインルール違反（不正な状態遷移、過回収など） |
| 500 | サーバー内部エラー |

ドメインエラーは 422 に寄せる。形式は正しいが業務ルール上受け付けられない、という区別を明示するため。

### 4.5 認証

単一ユーザーのため、環境変数に設定した固定トークンを `Authorization: Bearer <token>` で検証する方式とする。ユーザー管理・パスワード・セッションは実装しない。

Cloud Run のサービスは公開（未認証呼び出し許可）とし、認可はアプリケーション側で行う。トークンはブラウザの `localStorage` に保管する。XSS があれば読まれる置き場所だが、単一ユーザーかつ自分の端末のみという前提のもとで許容する（要件定義書 6章）。

front は別オリジンから API を呼ぶため、CORS の許可オリジンを環境変数で受け取る。ワイルドカードは使わない。

---

## 5. パッケージ構成

```
server/
├── cmd/
│   └── api/
│       └── main.go              依存の組み立て（手書き DI）、HTTP サーバ起動
├── internal/
│   ├── domain/                  外部依存ゼロ。ここだけで完結してテストできること
│   │   ├── money.go
│   │   ├── account.go
│   │   ├── lending.go
│   │   ├── wish.go
│   │   ├── monthly_balance.go
│   │   ├── transaction.go       残高が動いた記録。実質資産の計算には使わない
│   │   ├── networth.go          実質資産・不足額・到達見込みの純粋関数
│   │   └── errors.go            ドメインエラーの定義
│   ├── usecase/
│   │   ├── port.go              リポジトリのインターフェース定義
│   │   ├── account.go
│   │   ├── lending.go
│   │   ├── wish.go
│   │   ├── monthly_balance.go
│   │   └── dashboard.go
│   ├── adapter/
│   │   ├── handler/             HTTP ハンドラ、JSON 変換、エラー→ステータス変換
│   │   └── repository/          sqlc 生成コードを usecase のインターフェースに適合させる
│   └── infra/
│       ├── db.go                DB 接続
│       └── config.go            環境変数の読み込み
├── db/
│   ├── migrations/              マイグレーション SQL
│   └── queries/                 sqlc の入力となる SQL
├── sqlc.yaml
└── go.mod
```

### 5.1 依存の向き

```
handler ──▶ usecase ──▶ domain
              ▲
              │ （インターフェース）
         repository
```

**リポジトリのインターフェースは `usecase` パッケージに置く。** 実装は `adapter/repository` にあるが、インターフェースを使う側が定義することで、usecase が adapter に依存しない形になる（依存性逆転）。

```go
// internal/usecase/port.go
package usecase

type WishRepository interface {
    List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error)
    Get(ctx context.Context, id uuid.UUID) (domain.Wish, error)
    Create(ctx context.Context, w domain.Wish) error
    // 内容の更新と状態遷移を1本にまとめない。まとめると、遷移の可否を
    // 判定する domain のメソッドを迂回して status を書ける経路ができる。
    UpdateContent(ctx context.Context, w domain.Wish) error
    UpdateStatus(ctx context.Context, w domain.Wish) error
    Delete(ctx context.Context, id uuid.UUID) error
}
```

全インターフェースの定義は `docs/detailed-design.md` 3.1 を参照する。

### 5.2 変換の責務

sqlc が生成する構造体（`db.Wish` など）と、ドメインのエンティティ（`domain.Wish`）は別物として扱う。相互変換は `adapter/repository` の責務とし、生成コードをドメイン層に持ち込まない。

冗長に見えるが、この境界があることで DB スキーマの変更がドメイン層に波及しなくなる。学習目的の中心にあたる部分。

### 5.3 トランザクション境界

複数テーブルを更新する操作（立替の回収 → 口座残高の更新 → 取引履歴の記録）は、usecase 層でトランザクションを張る。トランザクションの制御を handler や repository に散らさない。

---

## 6. テスト方針

| 層 | 手法 | 対象 |
| --- | --- | --- |
| domain | ユニットテスト（テーブル駆動） | 計算ロジック、状態遷移。DB 不要 |
| usecase | 手書きの fake リポジトリ | オーケストレーション、トランザクション境界 |
| handler | `net/http/httptest` | ステータスコード、JSON 形式 |
| repository | 実 DB（ローカル Postgres） | SQL の正しさ、制約 |
| front（ロジック） | Vitest | 表示整形、入力バリデーション |
| front（E2E） | Playwright | 主要導線が実際に動くこと |

モックライブラリは導入せず、インターフェースを手書きの fake で満たす。定義したインターフェースが実装しやすいかどうかが、そのまま設計の良し悪しのフィードバックになるため。

front 側は、上記すべてを単一のコマンドに束ねる。開発を AI エージェントのループで進めるため、**エージェントに渡す停止条件が一本のコマンドで表現できること**を要件とする（要件定義書 7.2）。

```json
"check": "npm run typecheck && npm run lint && npm run test && npm run e2e"
```

計算ロジックの正しさはサーバー側（domain のユニットテスト）で担保済みである。front の E2E で計算結果を再検証しない。E2E は導線 — 登録できる、一覧に出る、状態遷移のボタンが効く — に絞る。ここを混ぜると、遅くて壊れやすいテストで同じことを二度検証することになる。

### 6.1 最初に書くべきテストケース

`domain/networth_test.go` から着手する。DB もサーバーも不要で、今日から書ける。

| # | ケース | 期待 |
| --- | --- | --- |
| 1 | 現金のみ | 残高の合計がそのまま実質資産 |
| 2 | 投資口座を含む | **投資分は加算されない** |
| 3 | 未回収の立替あり | 未回収残高が加算される |
| 4 | 一部回収済みの立替 | 未回収分のみ加算される |
| 5 | 確定ウィッシュあり | その金額が控除される |
| 6 | 検討中ウィッシュのみ | 控除されない |
| 7 | 完了・見送りのウィッシュ | 控除されない |
| 8 | 全要素の組み合わせ | 式どおりの結果 |
| 9 | 平均余剰：3ヶ月分あり | 3ヶ月の平均 |
| 10 | 平均余剰：2ヶ月分のみ | 2ヶ月の平均 |
| 11 | 平均余剰：0件 | ok=false |
| 12 | 到達見込み：平均余剰が0以下 | ok=false |
| 13 | 到達見込み：不足額が0以下 | ok=false（既に達成済み） |
| 14 | 状態遷移：完了から確定へ | エラー |
| 15 | 回収：未回収残高を超える額 | エラー |
| 16 | 到達見込み：ちょうど割り切れる（例：120万 ÷ 月余剰20万） | 6 |
| 17 | 到達見込み：割り切れない（例：121万 ÷ 月余剰20万） | 7（切り上げ） |

ケース2、6、7は、要件定義書 3.1 の「二重計上しない」「投資は別枠」というルールが守られているかを直接検証するもの。ここが壊れるとアプリの存在意義が消えるため、最優先で書く。

ケース16、17は切り上げ除算の境界検証。片方だけだと `(a + b - 1) / b` の `- 1` を落としても気付けない。両方あってはじめて off-by-one を検出できる。

---

## 7. 実装の進め方

| 段階 | 内容 | 前提 |
| --- | --- | --- |
| 1 | `domain` パッケージと 6.1 のテスト | なし。今すぐ着手できる |
| 2 | DDL とマイグレーション、sqlc の設定 | ローカル Postgres |
| 3 | `repository` 実装とテスト | 同上 |
| 4 | `usecase`、`handler` | — |
| 5 | Terraform（Cloud Run / Artifact Registry / 予算アラート / GCS backend） | GCP プロジェクト |
| 6 | front（Vite + React SPA） | API が動くこと |

段階1はインフラを一切用意せずに進められる。**先に Terraform や GCP の設定から入ると、アプリの中身に到達する前に消耗しやすい。** ドメイン層が固まってからインフラに向かう順序を推奨する。
