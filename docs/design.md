# 設計書

個人資産・ウィッシュ管理アプリ

| 項目 | 内容 |
| --- | --- |
| 版数 | 0.1 |
| 作成日 | 2026-07-26 |
| 対応要件 | 要件定義書 v1.0 |
| 対象範囲 | データモデル、ドメイン層、API、パッケージ構成、テスト方針 |
| 対象外 | 画面ワイヤーフレーム（別途） |

> **注記：** 本書は概観・方針レベルの設計。実装時のシグネチャ・エラーコード・テストケースは `docs/detailed-design.md` を正とする。両者に齟齬があれば詳細設計書に従う。

> **実装言語の変更について（2026-07）：** サーバーの実装は Go + PostgreSQL + Cloud Run から **TypeScript + Cloudflare Workers + D1** に移行した。**この文書が定める設計——データモデル、レイヤ構成、API、用語——はそのまま有効。** 変わったのは言語とランタイムだけである。
>
> ただし、**3章のコード例は Go 版の記述**であり、実際のシグネチャは `worker/src/domain/` を見ること。移行で変わった点（`year_month` の型、時刻の持ち方、トランザクションの扱い）は `docs/migration-cloudflare.md` に集約してある。

> **仕様変更について（2026-07-30）：** **貸し借りを実質資産の計算から外した。** 実質資産は `現金・預金 − 確定支出` になり、未精算の貸し借りは投資資産と同じ別枠の参考値になった。貸し借りの登録・精算で口座残高は動かず、取引履歴も残らない。**この文書のうち 3.5 の計算式、4.4 のダッシュボード応答、4.4 の `/api/loans` の入力、6.1 のテストケース表が影響を受ける**（該当箇所に注記を入れてある）。要件定義書は v1.1 が正。経緯と理由は `docs/spec-changes.md` の2章。

---

## 1. 全体構成

```
                    ┌────────────────────────────────┐
                    │  Cloudflare Worker             │
┌──────────────┐    │                                │      ┌──────────┐
│  ブラウザ    │───▶│  /            静的アセット     │      │          │
│  (front/SPA) │    │               （front/dist）   │      │    D1    │
└──────────────┘    │  /api/*       Hono のルート    │─────▶│ (SQLite) │
                    │                                │      │          │
                    └────────────────────────────────┘      └──────────┘
                                    ▲
                                    │ wrangler deploy（手動）
                    ┌─────────────────────────────────────┐
                    │  GitHub（モノレポ） / Actions（CI） │
                    └─────────────────────────────────────┘
```

**front と API は同一オリジン。** 同じ Worker が両方を返すため、CORS の設定は存在しない。静的アセットのリクエストは無料枠を消費しない。

---

## 2. データモデル

### 2.1 方針

- 主キーは UUID。クライアント側で採番できるため、オフライン対応を後から入れる余地が残る
- 金額は整数（円単位）。浮動小数点は使わない。SQLite の `INTEGER` は最大8バイトで足りる
- **導出できる値はカラムに持たない。** 貸し借りの精算状態は `amount` と `settled_amount` から判定できるため `status` カラムを持たない
- 制約は DB 側にも書く。ドメイン層のバリデーションと二重になるが、DB は最後の砦として扱う

### 2.2 DDL

**正は `migrations/` 配下。** ここは読みやすさのために要点だけを写したもので、齟齬があればマイグレーションに従う。`loans` は `0002_loans.sql` で `lendings` から作り直したもの（`direction` の追加とカラム名の変更を含む）。

```sql
CREATE TABLE accounts (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('cash', 'investment')),
    balance    INTEGER NOT NULL,
    updated_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE loans (
    id             TEXT    PRIMARY KEY,
    direction      TEXT    NOT NULL CHECK (direction IN ('lent', 'borrowed')),
    counterparty   TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    amount         INTEGER NOT NULL CHECK (amount > 0),
    settled_amount INTEGER NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
    occurred_on    TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT loans_settled_within_amount
        CHECK (settled_amount <= amount)
);

CREATE INDEX idx_loans_outstanding
    ON loans (occurred_on DESC)
    WHERE settled_amount < amount;

CREATE TABLE wishes (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    category   TEXT    NOT NULL CHECK (category IN ('item', 'experience', 'goal')),
    status     TEXT    NOT NULL CHECK (status IN ('considering', 'committed', 'done', 'dropped')),
    priority   INTEGER NOT NULL DEFAULT 0,
    deadline   TEXT
        CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_wishes_status_priority ON wishes (status, priority);

CREATE TABLE monthly_balances (
    id         TEXT    PRIMARY KEY,
    year_month TEXT    NOT NULL UNIQUE
        CHECK (year_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    income     INTEGER NOT NULL CHECK (income  >= 0),
    expense    INTEGER NOT NULL CHECK (expense >= 0),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transactions (
    id          TEXT    PRIMARY KEY,
    account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      INTEGER NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN (
                    'lending_created', 'lending_collected', 'wish_paid', 'adjustment')),
    ref_id      TEXT,
    occurred_on TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, occurred_on DESC);
```

SQLite には `UUID` / `DATE` / `TIMESTAMPTZ` の型が無い。**Postgres では型そのものが日付らしさを保証していたが、`TEXT` には何の保証も無いため、型が担っていた検査を `CHECK` + `GLOB` で埋め直している。**

### 2.3 補足

**`year_month` を `TEXT 'YYYY-MM'` で持つ理由**

当初は月初日の `DATE` として持ち、`date_trunc` の CHECK で月初日であることを保証していた。SQLite に `date_trunc` が無いこと、および domain・API・front がいずれも `'2026-07'` 形式で年月を扱っていることから、`TEXT` の `'YYYY-MM'` に変更した。

**日を持たなければ、日がずれる余地そのものが消える。** 格納形式とドメイン型 `YearMonth` の表現も一致する。文字列比較で年月順に並ぶため、「直近3ヶ月」は `ORDER BY year_month DESC LIMIT 3` のまま書ける。

**貸し借りの部分インデックス**

未精算の一覧が主要な参照パターンのため、`settled_amount < amount` の部分インデックスを張る。精算済みのレコードが積み上がっても未精算の検索速度が落ちない。個人利用の規模では過剰だが、部分インデックスを書く練習として入れている。

**`transactions.ref_id` に外部キーを張らない理由**

参照先が `loans` と `wishes` の両方になるポリモーフィックな参照のため、FK 制約は付けられない。整合性はアプリケーション側で担保する。ここは設計上の妥協点として認識しておく。

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
// LoanDirection は貸借の向き。金額は向きによらず常に正で持ち、
// 向きはこの型だけが表す（2026-07-30 の変更）。
type LoanDirection string

const (
    LoanLent     LoanDirection = "lent"     // 貸した（立て替えた）
    LoanBorrowed LoanDirection = "borrowed" // 借りた
)

type Loan struct {
    ID            uuid.UUID
    Direction     LoanDirection
    Counterparty  string
    Description   string
    Amount        Money // 向きによらず正。負の金額で「借りた」を表さない
    SettledAmount Money
    OccurredOn    time.Time
}

// 未精算残高。**実質資産には加算しない**（2026-07-30 の変更）。別枠の参考値。
func (l Loan) Outstanding() Money {
    return l.Amount.Sub(l.SettledAmount)
}

func (l Loan) IsFullySettled() bool {
    return l.Outstanding().IsZero()
}

// 精算を記録する。貸した側では回収、借りた側では返済にあたる。
// **向きで処理を分けない。** どちらも未精算残高が減るだけ。
// 過精算は許さない。
func (l *Loan) Settle(amount Money) error {
    if !amount.IsPositive() {
        return ErrInvalidAmount
    }
    if amount > l.Outstanding() {
        return ErrSettleExceedsOutstanding
    }
    l.SettledAmount = l.SettledAmount.Add(amount)
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

> **2026-07-30 の変更：** 下のコードは貸し借りを加算していたときの記述。**現在は貸し借りを加算しない。** 実際のシグネチャは `worker/src/domain/netAsset.ts` を見ること。`calculateBreakdown` は貸し借りを引数に取らず、未精算の合計は `calculateOutstandingLoans` が別に返す。

```go
// networth.go

// 実質資産 = 現金預金 − 確定支出
// （2026-07-30 より前は、ここに未精算貸し借りも加算していた）
func CalculateNetAsset(accounts []Account, wishes []Wish) Money {
    var total Money
    for _, a := range accounts {
        if a.CountsTowardNetAsset() {
            total = total.Add(a.Balance)
        }
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

// 未精算の貸し借りを向きごとに合計（参考値。実質資産には含めない）
//
// 差額にまとめない。引き算すると、誰にいくら貸しているのかが消える。
type OutstandingLoans struct {
    Lent     Money // 貸していて、まだ返ってきていない額
    Borrowed Money // 借りていて、まだ返していない額
}

func CalculateOutstandingLoans(loans []Loan) OutstandingLoans

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
| GET | `/api/loans` | 貸し借り一覧（`?outstanding=true` で未精算のみ） |
| POST | `/api/loans` | 貸し借り登録 |
| POST | `/api/loans/{id}/settle` | 精算の記録 |
| DELETE | `/api/loans/{id}` | 貸し借り削除 |
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
  "netAsset": 830000,
  "breakdown": {
    "cashTotal": 910000,
    "commitments": 80000
  },
  "investmentTotal": 350000,
  "outstandingLent": 12000,
  "outstandingBorrowed": 5000,
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

`breakdown` に並ぶのは実質資産を構成する項目だけ。`investmentTotal` と `outstanding*` はどちらも実質資産の外の参考値なので、`breakdown` の外に置く。**合計に足されない値を内訳に混ぜない**という形で示している。

**貸しと借りは差額にせず分けて返す。** 引き算して1つにすると、誰にいくら貸しているのかが消える。どちらも正の値。

**`POST /api/loans`**

```json
{
  "direction": "lent",
  "counterparty": "…",
  "description": "…",
  "amount": 12000,
  "occurredOn": "2026-07-26"
}
```

`direction` は `'lent'`（貸した）または `'borrowed'`（借りた）。**金額は向きによらず正で送る。** 符号で向きを表さない。不正な向きは domain が判定するため **422**（`INVALID_LOAN_DIRECTION`）で、400 ではない。

**`accountId` は受け取らない。** 貸し借りは口座残高を動かさない（2026-07-30 の変更）。送ると 400 を返す。黙って無視すると「口座を指定したのに残高が変わらない」と読める。

**`POST /api/loans/{id}/settle`**

```json
{ "amount": 5000 }
```

精算額が未精算残高を超える場合は 422 を返す。**`accountId` も `occurredOn` も受け取らない。** 口座を触らないため取引履歴が作られず、精算日を残す先が無い。

**向きごとに経路を分けない。** 貸した側では回収、借りた側では返済にあたるが、domain の処理はどちらも「未精算残高が減る」だけで同じ。`/settle` と `/repay` に割ると同じ手順が2本に増え、さらに「`lent` に `/repay` を投げたら 422 か」という判定が新たに要る。

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
| 422 | ドメインルール違反（不正な状態遷移、過精算など） |
| 500 | サーバー内部エラー |

ドメインエラーは 422 に寄せる。形式は正しいが業務ルール上受け付けられない、という区別を明示するため。

### 4.5 認証

単一ユーザーのため、固定トークンを `Authorization: Bearer <token>` で検証する方式とする。ユーザー管理・パスワード・セッションは実装しない。

トークンは `wrangler secret put AUTH_TOKEN` で登録し、`worker/src/infra/config.ts` でのみ読む。**32文字未満なら起動を拒む。** 公開エンドポイントに短いトークンを置くと総当たりが現実的になるため。Workers に起動の瞬間が無いので、検証はリクエストのたびに行い、不足していれば 500 で落とす。**認証を素通りさせないことのほうが、動くことより優先される。**

Worker は公開（誰でも到達できる）とし、認可はアプリケーション側で行う。トークンはブラウザの `localStorage` に保管する。XSS があれば読まれる置き場所だが、単一ユーザーかつ自分の端末のみという前提のもとで許容する（要件定義書 6章）。

**front と API は同一オリジンのため CORS の設定は無い。**

#### 将来の検討：ログイン方式を変える

**現状の不満は「64文字のランダム文字列を保管して、新しい端末で貼り付けるのが面倒」という点にある。** 着手する場合の前提を、調べた事実とともに残しておく。**現時点では未着手で、固定トークン方式を維持する。**

まず、使えないと分かっている選択肢がある。

**Cloudflare Access（Google ログインを設定だけで実現する仕組み）は使えない。** Access は自分が管理するゾーンのホスト名に適用するもので、`*.workers.dev` には掛けられない。使うには独自ドメインが必要で、購入費がかかる（不変条件15）。

残る選択肢は3つ。上から順に軽い。

| 案 | 内容 | 影響範囲 |
| --- | --- | --- |
| **A. 合言葉に変える** | トークンを覚えられるパスフレーズにする。32文字以上という制約は満たす | **コード変更ゼロ。** `wrangler secret put` で入れ直すだけ |
| **B. パスワードでログイン（単一ユーザーのまま）** | 初回にパスワードを設定し、以降はログイン画面から入る。利用者は1人のまま | `credentials` テーブル1行、パスワードのハッシュ（PBKDF2）、署名つきセッション、handler の認証差し替え、front のログイン画面。**domain / usecase / repository の既存ロジックは変わらない** |
| **C. メール＋パスワードで登録（マルチユーザー）** | 他の人も自分のデータを持てる | 全テーブルに `user_id`、全クエリに絞り込み、全 usecase に利用者、テストのほぼ全部。**`CLAUDE.md`「やらないこと」と要件定義の単一ユーザー前提を書き換える必要がある** |

C を採るなら、あわせて必ず決めることが2つある。

- **登録の制限。** 公開 URL でオープンな登録を許すと、D1 のストレージ5GB・書き込み10万行/日を見知らぬ人に消費される。招待コードか、登録できるメールアドレスの許可リストが要る
- **他人の資産データを預かる責任。** バグの重さが変わる。単一ユーザーなら自分が困るだけで済んでいたものが、そうではなくなる

B なら同一オリジンになった利点を活かして、セッションを `localStorage` ではなく HttpOnly Cookie に置ける。XSS で読まれなくなる分だけ安全になる。

**A で足りるなら A が最善。** 動機が「保管が面倒」だけなら、コードを1行も足さずに解決する。

---

## 5. パッケージ構成

```
wrangler.jsonc                   Worker 定義。D1 binding、静的アセット
migrations/
└── 0001_init.sql                D1 のスキーマ。wrangler d1 migrations が管理
worker/
├── src/
│   ├── domain/                  外部依存ゼロ。ここだけで完結してテストできること
│   │   ├── money.ts
│   │   ├── time.ts              IsoDate / Instant（Date は持ち込まない）
│   │   ├── yearMonth.ts
│   │   ├── account.ts
│   │   ├── loan.ts
│   │   ├── wish.ts
│   │   ├── monthlyBalance.ts
│   │   ├── transaction.ts       残高が動いた記録。実質資産の計算には使わない
│   │   ├── netAsset.ts          実質資産・不足額・到達見込みの純粋関数
│   │   └── errors.ts            ドメインエラーの定義
│   ├── usecase/
│   │   ├── port.ts              リポジトリのインターフェース、WriteOperation、Clock
│   │   ├── account.ts
│   │   ├── loan.ts
│   │   ├── wish.ts
│   │   ├── monthlyBalance.ts
│   │   ├── transaction.ts
│   │   └── dashboard.ts
│   ├── adapter/
│   │   ├── handler/             Hono のルート、DTO、リクエストの解釈、エラー→ステータス
│   │   └── repository/          D1 アクセス。行とドメイン型の相互変換
│   │       └── writer.ts        書き込みを1回の batch にまとめる（不変条件10）
│   ├── infra/
│   │   └── config.ts            secret の読み出しと検証
│   └── index.ts                 依存の組み立て（手書き DI）とエントリポイント
└── test/                        fake・スタブ・テスト用の道具
```

テストは実装の隣に置く（`money.ts` と `money.test.ts`）。Go の `_test.go` と同じ考え方で、対応が目で追える。

### 5.1 依存の向き

```
handler ──▶ usecase ──▶ domain
              ▲
              │ （インターフェース）
         repository
```

**リポジトリのインターフェースは `usecase` パッケージに置く。** 実装は `adapter/repository` にあるが、インターフェースを使う側が定義することで、usecase が adapter に依存しない形になる（依存性逆転）。

```ts
// worker/src/usecase/port.ts
export interface WishRepository {
  list(status: WishStatus | null): Promise<Wish[]>
  get(id: string): Promise<Wish>
  create(w: Wish): Promise<void>
  // 内容の更新と状態遷移を1本にまとめない。まとめると、遷移の可否を
  // 判定する domain のメソッドを迂回して status を書ける経路ができる。
  updateContent(w: Wish): Promise<void>
  delete(id: string): Promise<void>
}
```

状態遷移はリポジトリのメソッドではなく `WriteOperation` として扱う（5.3）。全インターフェースの定義は `worker/src/usecase/port.ts` を正とする。

### 5.2 変換の責務

D1 が返す行（`WishRow` など）と、ドメインのエンティティ（`Wish`）は別物として扱う。相互変換は `adapter/repository` の責務とし、行の型をドメイン層に持ち込まない。

行から復元するときは `restore` を通し、`kind` / `status` / `category` を検証する。**CHECK 制約をすり抜けた値をドメイン層に渡さないための最後の関門。**

冗長に見えるが、この境界があることで DB スキーマの変更がドメイン層に波及しなくなる。学習目的の中心にあたる部分。

### 5.3 書き込みの原子性

複数テーブルを更新する操作（ウィッシュの支払い → 口座残高の更新 → 取引履歴の記録）は、**usecase が `WriteOperation` の配列として組み立て**、`AtomicWriter` が1回の `db.batch()` に流す。書き込みの制御を handler や repository に散らさない。

貸し借りは 2026-07-30 の変更で口座を触らなくなったため、書き込みは1行だけになった。それでも `AtomicWriter` を通しているのは、**精算に楽観ロックが要る**ため。読み取り時の精算額を条件にしないと、同時に2回精算したときに両方が未精算残高の範囲内に見えて過精算が成立する。その仕組みを持っているのが `AtomicWriter` である。

D1 は `BEGIN` を受け付けないため、Go 版の `RunInTx` に相当するものは無い。`batch()` が1回の呼び出し＝1つのトランザクションとして働く。

読み取りと書き込みの間に判断が挟まるため、**読み取った時点の値を `expected*` として持ち回り、書き込み時に変わっていれば競合（409）にする。** 楽観ロックの実現方法は `adapter/repository/writer.ts` が持ち、usecase は「何を書くか」だけを知る。

**素朴に条件付き UPDATE を並べると部分書き込みが残る。** その実測と対策は `docs/migration-cloudflare.md` 4章にある。

---

## 6. テスト方針

| 層 | 手法 | 対象 |
| --- | --- | --- |
| domain | ユニットテスト（テーブル駆動） | 計算ロジック、状態遷移。DB 不要 |
| usecase | 手書きの fake リポジトリ | 手順、楽観ロックに渡す値 |
| handler | Hono の `app.request()` にスタブを差す | ステータスコード、JSON 形式 |
| handler（統合） | 実 D1 + 実 usecase + 実 repository | 結線。スタブでは落ちない間違いを拾う |
| repository | 実 D1（miniflare のローカル） | SQL の正しさ、制約 |
| front（ロジック） | Vitest | 表示整形、入力バリデーション |
| front（E2E） | Playwright | 主要導線が実際に動くこと |

モックライブラリは導入せず、インターフェースを手書きの fake で満たす。定義したインターフェースが実装しやすいかどうかが、そのまま設計の良し悪しのフィードバックになるため。

サーバー側のテストは **workerd の中で走る**（`@cloudflare/vitest-pool-workers`）。本番と同じランタイムで実行されるため、Node の API に依存した実装が紛れ込めばテストが落ちる。D1 は miniflare がローカルに用意し、`migrations/` の DDL をそのまま流す。**テスト側に DDL を書き写さない。**

front 側も worker 側も、上記すべてを単一のコマンドに束ねる。開発を AI エージェントのループで進めるため、**エージェントに渡す停止条件が一本のコマンドで表現できること**を要件とする（要件定義書 7.2）。

```json
"check": "npm run typecheck && npm run lint && npm run test && npm run e2e"
```

計算ロジックの正しさはサーバー側（domain のユニットテスト）で担保済みである。front の E2E で計算結果を再検証しない。E2E は導線 — 登録できる、一覧に出る、状態遷移のボタンが効く — に絞る。ここを混ぜると、遅くて壊れやすいテストで同じことを二度検証することになる。

### 6.1 最初に書くべきテストケース

`worker/src/domain/netAsset.test.ts` に相当する部分から着手した。DB もサーバーも不要で、最初に書ける。

| # | ケース | 期待 |
| --- | --- | --- |
| 1 | 現金のみ | 残高の合計がそのまま実質資産 |
| 2 | 投資口座を含む | **投資分は加算されない** |
| 3 | 未精算の貸し借りあり | **実質資産は変わらない。** 参考値として未精算残高が返る |
| 4 | 一部精算済みの貸し借り | 参考値は未精算分のみ |
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
| 15 | 精算：未精算残高を超える額 | エラー |
| 16 | 到達見込み：ちょうど割り切れる（例：120万 ÷ 月余剰20万） | 6 |
| 17 | 到達見込み：割り切れない（例：121万 ÷ 月余剰20万） | 7（切り上げ） |

ケース2、6、7は、要件定義書 3.1 の「二重計上しない」「投資は別枠」というルールが守られているかを直接検証するもの。ここが壊れるとアプリの存在意義が消えるため、最優先で書く。

ケース16、17は切り上げ除算の境界検証。片方だけだと `(a + b - 1) / b` の `- 1` を落としても気付けない。両方あってはじめて off-by-one を検出できる。

---

## 7. 実装の進め方

**本文書が定めた設計は実装済み。** 現在の構成と検証方法は `CLAUDE.md` を参照する。

当初は以下の順序で進めた。**インフラを最後に回す**方針は変えていない。先に配置や権限の設定から入ると、アプリの中身に到達する前に消耗するため。

| 段階 | 内容 |
| --- | --- |
| 1 | `domain` と 6.1 のテスト（インフラ不要） |
| 2 | DDL とマイグレーション |
| 3 | `repository` 実装とテスト |
| 4 | `usecase` |
| 5 | `handler` |
| 6 | front |
| 7 | デプロイ |

段階1はインフラを一切用意せずに進められる。ドメイン層が固まってからインフラに向かうこと。
