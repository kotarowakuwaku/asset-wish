# 詳細設計書

個人資産・ウィッシュ管理アプリ

| 項目 | 内容 |
| --- | --- |
| 版数 | 0.1 |
| 作成日 | 2026-07-26 |
| 上位文書 | `docs/requirements.md` v1.0、`docs/design.md` v0.1 |
| 位置づけ | 実装時に設計判断が発生しないレベルまで具体化する。`design.md` と矛盾する場合は本書が正 |

`design.md` からの変更点：

- `MonthlyBalance.YearMonth` を `time.Time` ではなく値オブジェクト `YearMonth` とする（2.2）
- `AverageSurplus` の引数ソート前提を撤廃し、関数内部でソートする（2.9.4）
- 各エンティティにコンストラクタを設け、不正な値を持つ構造体を作れなくする

---

## 1. パッケージとファイル

```
server/internal/domain/
├── errors.go           ドメインエラーの型と定義
├── money.go            Money
├── year_month.go       YearMonth
├── account.go          Account, AccountKind
├── lending.go          Lending, CollectionStatus
├── wish.go             Wish, WishStatus, WishCategory
├── monthly_balance.go  MonthlyBalance
└── networth.go         計算関数（本アプリの中核）
```

テストは各ファイルに対応する `_test.go` を置く。

---

## 2. ドメイン層

### 2.1 Money

```go
// Money は日本円を円単位で表す。
// 小数は扱わない。int64 の範囲は約 9.2 京円であり、桁あふれは考慮しない。
type Money int64

func (m Money) Add(o Money) Money { return m + o }
func (m Money) Sub(o Money) Money { return m - o }

func (m Money) IsPositive() bool { return m > 0 }
func (m Money) IsNegative() bool { return m < 0 }
func (m Money) IsZero() bool     { return m == 0 }

// String は表示用。"¥1,234,567" の形式。負値は "-¥1,234"。
func (m Money) String() string
```

**設計判断**

構造体ではなく `int64` の named type とする。ゼロ値がそのまま「0円」として意味を持ち、`==` `<` `>` がそのまま使えるため。通貨が複数になった時点で構造体に変える。

`Mul` `Div` は定義しない。本アプリに金額の乗除算は登場しない。平均の計算（`AverageSurplus`）でのみ除算が必要になるが、そこは関数内でローカルに行う。

### 2.2 YearMonth

```go
// YearMonth は年月を表す。日・時刻・タイムゾーンを持たない。
// ゼロ値は不正な値であり、必ずコンストラクタを経由して生成する。
type YearMonth struct {
    year  int
    month time.Month
}

// NewYearMonth は年月を生成する。
// year が 1900〜9999 の範囲外、または month が 1〜12 の範囲外なら
// ErrInvalidYearMonth を返す。
func NewYearMonth(year int, month time.Month) (YearMonth, error)

// ParseYearMonth は "2026-07" 形式の文字列を解釈する。
// 形式が異なる場合は ErrInvalidYearMonth を返す。
func ParseYearMonth(s string) (YearMonth, error)

// FromTime は time.Time の年月部分を取り出す。
// 与えられた時刻のロケーションをそのまま用いる。DB からの復元に使う。
func FromTime(t time.Time) YearMonth

func (ym YearMonth) Year() int         { return ym.year }
func (ym YearMonth) Month() time.Month { return ym.month }

// String は "2026-07" 形式を返す。月は必ず2桁。
func (ym YearMonth) String() string

// FirstDay はその月の1日を UTC の 00:00:00 で返す。DB の DATE 列との変換に使う。
func (ym YearMonth) FirstDay() time.Time

// AddMonths は n ヶ月後を返す。n は負でもよい。
func (ym YearMonth) AddMonths(n int) YearMonth

func (ym YearMonth) Before(o YearMonth) bool
func (ym YearMonth) After(o YearMonth) bool
func (ym YearMonth) Equal(o YearMonth) bool

// Compare は ym < o なら負、等しければ 0、ym > o なら正を返す。
// slices.SortFunc に渡す用途。
func (ym YearMonth) Compare(o YearMonth) int

// IsZero はゼロ値（未初期化）かどうかを返す。
func (ym YearMonth) IsZero() bool { return ym.year == 0 }
```

**設計判断**

`time.Time` を使わない理由は3つ。

1. 月初でない日付（`2026-07-15`）を代入できてしまい、不変条件を型で守れない
2. タイムゾーンが入り込む。JST の月初は UTC では前月末日であり、DB との変換で確実に事故る
3. 同じ月でも時刻が異なれば `!=` になり、比較の意味が曖昧になる

フィールドを非公開にし、コンストラクタでのみ生成できるようにすることで、**不正な `YearMonth` が存在しない**状態を作る。`Money` を `int64` の裸で扱わないのと同じ方針。

`FirstDay()` が UTC 固定なのは、DB 側が `DATE` 型（時刻を持たない）であり、変換時にタイムゾーンを介在させないため。

### 2.3 エラー

```go
// DomainError は業務ルール違反を表す。HTTP 422 に対応する。
// 形式エラー（HTTP 400）とは区別する。
type DomainError struct {
    Code    string // 機械可読。API のエラーコードとしてそのまま返す
    Message string // 人間向け。日本語
}

func (e *DomainError) Error() string { return e.Message }

// IsDomainError は err が DomainError かどうかを判定する。
// handler でのステータスコード決定に用いる。
func IsDomainError(err error) bool {
    var de *DomainError
    return errors.As(err, &de)
}
```

定義するエラー：

| 変数名 | Code | Message |
| --- | --- | --- |
| `ErrInvalidAmount` | `INVALID_AMOUNT` | 金額は1円以上である必要があります |
| `ErrNegativeAmount` | `NEGATIVE_AMOUNT` | 金額に負の値は指定できません |
| `ErrEmptyTitle` | `EMPTY_TITLE` | 名称は必須です |
| `ErrEmptyCounterparty` | `EMPTY_COUNTERPARTY` | 立替の相手は必須です |
| `ErrInvalidAccountKind` | `INVALID_ACCOUNT_KIND` | 口座種別が不正です |
| `ErrInvalidWishCategory` | `INVALID_WISH_CATEGORY` | ウィッシュ種別が不正です |
| `ErrInvalidWishStatus` | `INVALID_WISH_STATUS` | ウィッシュ状態が不正です |
| `ErrInvalidTransition` | `INVALID_TRANSITION` | この状態からは実行できない操作です |
| `ErrCollectExceedsOutstanding` | `COLLECT_EXCEEDS_OUTSTANDING` | 回収額が未回収残高を超えています |
| `ErrInvalidYearMonth` | `INVALID_YEAR_MONTH` | 年月の指定が不正です |

すべて `*DomainError` のパッケージ変数として定義し、`errors.Is` で比較できるようにする。

### 2.4 Account

```go
type AccountKind string

const (
    AccountKindCash       AccountKind = "cash"       // 現金・預金。実質資産に算入する
    AccountKindInvestment AccountKind = "investment" // 投資。実質資産に算入しない
)

func (k AccountKind) Valid() bool

type Account struct {
    ID        uuid.UUID
    Name      string
    Kind      AccountKind
    Balance   Money
    UpdatedAt time.Time
}

// NewAccount は口座を生成する。
// name が空、または kind が不正なら error を返す。
// balance は負値を許容する（当座借越などを想定）。
func NewAccount(id uuid.UUID, name string, kind AccountKind, balance Money, now time.Time) (Account, error)

// CountsTowardNetAsset は実質資産の計算に算入すべきかを返す。
// 【不変条件】investment は必ず false を返すこと。
func (a Account) CountsTowardNetAsset() bool {
    return a.Kind == AccountKindCash
}

// UpdateBalance は残高を更新し、更新日時を now にする。
func (a *Account) UpdateBalance(balance Money, now time.Time)

// ApplyDelta は残高を増減させる。立替の発生・回収、ウィッシュの支払いで用いる。
func (a *Account) ApplyDelta(delta Money, now time.Time)

// IsStale は最終更新から threshold 以上経過しているかを返す。
// 残高更新の催促表示に用いる。
func (a Account) IsStale(now time.Time, threshold time.Duration) bool
```

`Balance` に負値を許すのは、口座が一時的にマイナスになる状況を表現できるようにするため。DDL にも CHECK 制約を置いていない。

### 2.5 Lending

```go
// CollectionStatus は回収状態。DB には保存せず、金額から導出する。
type CollectionStatus string

const (
    CollectionUncollected CollectionStatus = "uncollected" // 未回収
    CollectionPartial     CollectionStatus = "partial"     // 一部回収
    CollectionCollected   CollectionStatus = "collected"   // 回収済
)

type Lending struct {
    ID              uuid.UUID
    Counterparty    string
    Description     string
    Amount          Money
    CollectedAmount Money
    OccurredOn      time.Time // 日付のみ。時刻部分は 00:00:00 UTC
}

// NewLending は立替を生成する。CollectedAmount は 0 で初期化される。
// counterparty が空、または amount が 1 未満なら error を返す。
func NewLending(id uuid.UUID, counterparty, description string, amount Money, occurredOn time.Time) (Lending, error)

// Outstanding は未回収残高を返す。実質資産への加算対象。
// 【不変条件】Amount - CollectedAmount であること。
func (l Lending) Outstanding() Money {
    return l.Amount.Sub(l.CollectedAmount)
}

func (l Lending) IsFullyCollected() bool

// Status は回収状態を導出する。
//   CollectedAmount == 0        → uncollected
//   0 < CollectedAmount < Amount → partial
//   CollectedAmount == Amount    → collected
func (l Lending) Status() CollectionStatus

// Collect は回収を記録する。
//   amount が 1 未満        → ErrInvalidAmount
//   amount > Outstanding() → ErrCollectExceedsOutstanding
// 【不変条件】過回収を絶対に許さないこと。
func (l *Lending) Collect(amount Money) error
```

### 2.6 Wish

```go
type WishCategory string

const (
    WishCategoryItem       WishCategory = "item"       // もの
    WishCategoryExperience WishCategory = "experience" // 体験
    WishCategoryGoal       WishCategory = "goal"       // 目標
)

func (c WishCategory) Valid() bool

type WishStatus string

const (
    WishConsidering WishStatus = "considering" // 検討中
    WishCommitted   WishStatus = "committed"   // 確定（＝確定支出）
    WishDone        WishStatus = "done"        // 完了
    WishDropped     WishStatus = "dropped"     // 見送り
)

func (s WishStatus) Valid() bool

// IsTerminal は終端状態かを返す。done / dropped が true。
func (s WishStatus) IsTerminal() bool

type Wish struct {
    ID       uuid.UUID
    Title    string
    Amount   Money
    Category WishCategory
    Status   WishStatus
    Priority int
    Deadline *time.Time // 任意
}

// NewWish は検討中の状態でウィッシュを生成する。
// title が空、amount が 1 未満、category が不正なら error を返す。
func NewWish(id uuid.UUID, title string, amount Money, category WishCategory, priority int, deadline *time.Time) (Wish, error)

// IsCommitment は確定支出として実質資産から控除されるかを返す。
// 【不変条件】committed のときのみ true。他の状態では必ず false。
func (w Wish) IsCommitment() bool {
    return w.Status == WishCommitted
}
```

#### 状態遷移

```go
// Commit は 検討中 → 確定 に遷移させる。
// 検討中以外からの呼び出しは ErrInvalidTransition。
func (w *Wish) Commit() error

// Pay は 確定 → 完了 に遷移させる。
// 確定以外からの呼び出しは ErrInvalidTransition。
func (w *Wish) Pay() error

// Drop は 検討中 または 確定 → 見送り に遷移させる。
// 終端状態からの呼び出しは ErrInvalidTransition。
func (w *Wish) Drop() error
```

遷移可否表。空欄は `ErrInvalidTransition`。

| From \ 操作 | Commit | Pay | Drop |
| --- | --- | --- | --- |
| considering | → committed | ✕ | → dropped |
| committed | ✕ | → done | → dropped |
| done | ✕ | ✕ | ✕ |
| dropped | ✕ | ✕ | ✕ |

**終端状態からの復帰は用意しない。** 誤操作時は削除して作り直す。取り消しを許すと「完了したはずの支出が確定支出に戻る」といった、実質資産が過去に遡って変わる状況が生まれるため。

**【不変条件】この判定を `usecase` や `handler` に書かない。** 呼び出し側は「どの遷移を起こしたいか」だけを知り、可否は知らない。

### 2.7 MonthlyBalance

```go
type MonthlyBalance struct {
    ID        uuid.UUID
    YearMonth YearMonth
    Income    Money
    Expense   Money
}

// NewMonthlyBalance は月次収支を生成する。
//   ym がゼロ値               → ErrInvalidYearMonth
//   income または expense が負 → ErrNegativeAmount
func NewMonthlyBalance(id uuid.UUID, ym YearMonth, income, expense Money) (MonthlyBalance, error)

// Surplus は月間余剰を返す。負値なら赤字。
func (m MonthlyBalance) Surplus() Money {
    return m.Income.Sub(m.Expense)
}

// IsSurplus は黒字（余剰が正）かを返す。
func (m MonthlyBalance) IsSurplus() bool { return m.Surplus().IsPositive() }

// IsDeficit は赤字（余剰が負）かを返す。
func (m MonthlyBalance) IsDeficit() bool { return m.Surplus().IsNegative() }
```

余剰がちょうど 0 の月は、黒字でも赤字でもない。表示上は「±0」とする。

`UpdatedAt` は持たない。ドメイン層の判断に用いないため。`Account` が `UpdatedAt` を持つのは、残高の古さが催促表示の判断材料になるからであり、**ドメインが判断に使うかどうか**が基準となる。

### 2.8 定数

```go
// AverageSurplusMonths は平均月間余剰の算出に用いる遡及月数。
const AverageSurplusMonths = 3

// StaleBalanceThreshold は残高が古いと判断する閾値。
const StaleBalanceThreshold = 45 * 24 * time.Hour
```

### 2.9 計算関数（networth.go）

**本アプリの中核。外部依存を持たない純粋関数として実装する。**

#### 2.9.1 NetAssetBreakdown

```go
// NetAssetBreakdown は実質資産の内訳。
// ダッシュボードで内訳を表示するため、合計値だけでなく構成要素も保持する。
type NetAssetBreakdown struct {
    CashTotal           Money // 現金・預金の残高合計
    OutstandingLendings Money // 未回収の立替の合計
    Commitments         Money // 確定支出の合計（正の値で保持）
}

// NetAsset は実質資産を返す。
//   CashTotal + OutstandingLendings - Commitments
func (b NetAssetBreakdown) NetAsset() Money {
    return b.CashTotal.Add(b.OutstandingLendings).Sub(b.Commitments)
}
```

`Commitments` を正の値で保持し、`NetAsset()` で減算する。負値で保持して加算する形にしないのは、表示時に「確定支出：80,000円」と出したいため。符号の反転を1箇所に閉じ込める。

#### 2.9.2 CalculateBreakdown

```go
// CalculateBreakdown は実質資産の内訳を算出する。
//
// 【不変条件】
//   - kind が investment の口座は CashTotal に含めない
//   - status が committed 以外のウィッシュは Commitments に含めない
//   - 立替は回収済みの分を除いた未回収残高のみを加算する
//
// 引数のスライスは変更しない。空スライス・nil はいずれも 0 として扱う。
func CalculateBreakdown(accounts []Account, lendings []Lending, wishes []Wish) NetAssetBreakdown
```

実装：

```go
func CalculateBreakdown(accounts []Account, lendings []Lending, wishes []Wish) NetAssetBreakdown {
    var b NetAssetBreakdown
    for _, a := range accounts {
        if a.CountsTowardNetAsset() {
            b.CashTotal = b.CashTotal.Add(a.Balance)
        }
    }
    for _, l := range lendings {
        b.OutstandingLendings = b.OutstandingLendings.Add(l.Outstanding())
    }
    for _, w := range wishes {
        if w.IsCommitment() {
            b.Commitments = b.Commitments.Add(w.Amount)
        }
    }
    return b
}
```

#### 2.9.3 その他の集計

```go
// CalculateInvestmentTotal は投資区分の口座の合計を返す。
// これは実質資産には含めず、参考値として別枠で表示する。
func CalculateInvestmentTotal(accounts []Account) Money

// CalculateShortfall は不足額を返す。
//   wish.Amount - netAsset
// 負値ならすでに達成可能であることを意味する。
// 【不変条件】ウィッシュごとに独立して算出する。複数ウィッシュの合計とは比較しない。
func CalculateShortfall(wish Wish, netAsset Money) Money
```

#### 2.9.4 AverageSurplus

```go
// AverageSurplus は直近 months ヶ月の月間余剰の平均を返す。
//
// balances は年月の昇降順を問わない。関数内部でコピーして降順に整列する
// （引数のスライスは変更しない）。
//
// 件数が months 未満の場合は、存在する分だけで平均する。
// 件数が 0 の場合は ok=false を返す。
//
// 平均は整数除算（0方向への切り捨て）。端数は捨てる。
func AverageSurplus(balances []MonthlyBalance, months int) (Money, bool)
```

実装方針：

```go
func AverageSurplus(balances []MonthlyBalance, months int) (Money, bool) {
    if len(balances) == 0 || months <= 0 {
        return 0, false
    }
    sorted := slices.Clone(balances)
    slices.SortFunc(sorted, func(a, b MonthlyBalance) int {
        return b.YearMonth.Compare(a.YearMonth) // 降順
    })
    n := min(months, len(sorted))
    var sum Money
    for _, m := range sorted[:n] {
        sum = sum.Add(m.Surplus())
    }
    return sum / Money(n), true
}
```

**設計判断**

`design.md` では「呼び出し側が降順に整列済みであること」を前提としていたが、これを撤廃した。前提条件をドキュメントでしか保証できない設計は壊れる。データ件数が最大でも数十件のため、内部でのソートコストは無視できる。

平均が負値になる場合（赤字続き）もそのまま返す。判断は `MonthsToReach` に委ねる。

#### 2.9.5 MonthsToReach

```go
// MonthsToReach は目標到達までの月数を返す。
//
//   shortfall  <= 0 → ok=false（すでに達成可能）
//   avgSurplus <= 0 → ok=false（積み上がらないため到達しない）
//
// 割り切れない場合は切り上げる。6.2ヶ月なら 7 を返す。
// 6ヶ月時点ではまだ足りず、7ヶ月目に到達するため。
//
// 【不変条件】浮動小数点数を経由しないこと。
func MonthsToReach(shortfall, avgSurplus Money) (int, bool) {
    if !shortfall.IsPositive() || !avgSurplus.IsPositive() {
        return 0, false
    }
    return int((shortfall + avgSurplus - 1) / avgSurplus), true
}
```

`(a + b - 1) / b` が正の整数に対する切り上げ除算。ちょうど割り切れる場合は切り上がらない（600000 ÷ 100000 = 6）。

---

## 3. usecase 層

### 3.1 リポジトリインターフェース（port.go）

```go
package usecase

type AccountRepository interface {
    List(ctx context.Context) ([]domain.Account, error)
    Get(ctx context.Context, id uuid.UUID) (domain.Account, error)
    Create(ctx context.Context, a domain.Account) error
    Update(ctx context.Context, a domain.Account) error
    Delete(ctx context.Context, id uuid.UUID) error
}

type LendingRepository interface {
    List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error)
    Get(ctx context.Context, id uuid.UUID) (domain.Lending, error)
    Create(ctx context.Context, l domain.Lending) error
    Update(ctx context.Context, l domain.Lending) error
    Delete(ctx context.Context, id uuid.UUID) error
}

type WishRepository interface {
    List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error)
    Get(ctx context.Context, id uuid.UUID) (domain.Wish, error)
    Create(ctx context.Context, w domain.Wish) error
    Update(ctx context.Context, w domain.Wish) error
    Delete(ctx context.Context, id uuid.UUID) error
}

type MonthlyBalanceRepository interface {
    // ListRecent は年月の降順で最大 limit 件を返す。
    ListRecent(ctx context.Context, limit int) ([]domain.MonthlyBalance, error)
    ListAll(ctx context.Context) ([]domain.MonthlyBalance, error)
    // Upsert は同一年月のレコードがあれば更新、なければ作成する。
    Upsert(ctx context.Context, m domain.MonthlyBalance) error
}

type TransactionRepository interface {
    List(ctx context.Context, limit int) ([]domain.Transaction, error)
    Create(ctx context.Context, t domain.Transaction) error
}

// TxManager はトランザクション境界を提供する。
// fn の中で使うリポジトリは、同一トランザクションに参加する。
type TxManager interface {
    RunInTx(ctx context.Context, fn func(ctx context.Context) error) error
}
```

**インターフェースは `usecase` パッケージに置く。** 実装は `adapter/repository` にあるが、使う側が定義することで依存の向きを保つ（依存性逆転）。

`Get` で対象が存在しない場合は `usecase.ErrNotFound` を返す。これは `DomainError` ではなく、handler で 404 にマッピングする。

### 3.2 主要ユースケースの処理手順

複数テーブルを更新するものは、`TxManager.RunInTx` の中で実行する。

#### 3.2.1 立替の登録（CreateLending）

立て替えた時点で自分の口座からは金が出ているため、残高を減らす。

```
入力: counterparty, description, amount, occurredOn, accountID

1. domain.NewLending(...) で生成（バリデーションはここ）
2. RunInTx:
   a. accountRepo.Get(accountID)
   b. account.ApplyDelta(-amount, now)
   c. accountRepo.Update(account)
   d. lendingRepo.Create(lending)
   e. txRepo.Create(Transaction{
        AccountID: accountID, Amount: -amount,
        Kind: "lending_created", RefID: lending.ID, OccurredOn: occurredOn})
```

#### 3.2.2 立替の回収（CollectLending）

```
入力: lendingID, amount, occurredOn, accountID

1. RunInTx:
   a. lendingRepo.Get(lendingID)     → 無ければ ErrNotFound
   b. lending.Collect(amount)         → 過回収なら ErrCollectExceedsOutstanding
   c. lendingRepo.Update(lending)
   d. accountRepo.Get(accountID)
   e. account.ApplyDelta(+amount, now)
   f. accountRepo.Update(account)
   g. txRepo.Create(Transaction{
        AccountID: accountID, Amount: +amount,
        Kind: "lending_collected", RefID: lendingID, OccurredOn: occurredOn})
```

**手順 b をトランザクションの内側に置く。** 取得と更新の間に別の回収が入ると過回収が成立しうるため、`Get` から `Update` までを同一トランザクションに含める。

#### 3.2.3 ウィッシュの支払い（PayWish）

```
入力: wishID, accountID, occurredOn

1. RunInTx:
   a. wishRepo.Get(wishID)          → 無ければ ErrNotFound
   b. wish.Pay()                     → 確定以外なら ErrInvalidTransition
   c. wishRepo.Update(wish)
   d. accountRepo.Get(accountID)
   e. account.ApplyDelta(-wish.Amount, now)
   f. accountRepo.Update(account)
   g. txRepo.Create(Transaction{
        AccountID: accountID, Amount: -wish.Amount,
        Kind: "wish_paid", RefID: wishID, OccurredOn: occurredOn})
```

支払い後、そのウィッシュは `done` になり確定支出から外れる。同時に口座残高が実際に減るため、**実質資産は支払い前後で変化しない。** これが正しい挙動であり、テストで検証する（テスト C-8）。

#### 3.2.4 ダッシュボードの取得（GetDashboard）

```
1. accountRepo.List()
2. lendingRepo.List(outstandingOnly: true)
3. wishRepo.List(status: nil)
4. monthlyRepo.ListRecent(domain.AverageSurplusMonths)
5. breakdown := domain.CalculateBreakdown(accounts, lendings, wishes)
6. netAsset := breakdown.NetAsset()
7. investment := domain.CalculateInvestmentTotal(accounts)
8. avg, hasAvg := domain.AverageSurplus(balances, domain.AverageSurplusMonths)
9. 各ウィッシュ（done / dropped を除く）について:
     shortfall := domain.CalculateShortfall(w, netAsset)
     months, ok := domain.MonthsToReach(shortfall, avg)  // hasAvg が false なら ok も false
10. 組み立てて返す
```

**計算は必ず `domain` の関数を呼ぶ。** usecase 内で式を再実装しない。

---

## 4. adapter 層

### 4.1 型変換の対応表

`adapter/repository` の責務。sqlc 生成型とドメイン型を相互変換する。

| ドメイン | DB（sqlc 生成型） | 変換 |
| --- | --- | --- |
| `Money` | `int64` | 直接キャスト |
| `YearMonth` | `time.Time`（DATE） | 保存時 `ym.FirstDay()`、復元時 `domain.FromTime(t)` |
| `AccountKind` | `string` | 復元時に `Valid()` で検証し、不正なら error |
| `WishStatus` | `string` | 同上 |
| `WishCategory` | `string` | 同上 |
| `*time.Time`（Deadline） | `sql.NullTime` | null 相互変換 |
| `CollectionStatus` | — | **DB に列を持たない。** 復元時に導出 |

**復元時の検証を省かない。** DB に不正な値が入っている可能性は CHECK 制約で低いが、ドメイン層に不正な値を渡さないための最後の関門となる。

### 4.2 エラーのマッピング（handler）

| 条件 | HTTP | レスポンス |
| --- | --- | --- |
| JSON の形式不正、必須項目欠落、型不一致 | 400 | `{"error":{"code":"BAD_REQUEST","message":"..."}}` |
| 認証トークン不正・欠落 | 401 | `{"error":{"code":"UNAUTHORIZED",...}}` |
| `errors.Is(err, usecase.ErrNotFound)` | 404 | `{"error":{"code":"NOT_FOUND",...}}` |
| `domain.IsDomainError(err)` | 422 | `{"error":{"code":<DomainError.Code>,"message":<DomainError.Message>}}` |
| その他 | 500 | `{"error":{"code":"INTERNAL","message":"サーバーエラーが発生しました"}}` |

500 のときは内部のエラー詳細をレスポンスに含めない。ログには出す。

---

## 5. sqlc クエリ

`server/db/queries/` に配置する。

### 5.1 accounts.sql

```sql
-- name: ListAccounts :many
SELECT * FROM accounts ORDER BY kind, name;

-- name: GetAccount :one
SELECT * FROM accounts WHERE id = $1;

-- name: CreateAccount :exec
INSERT INTO accounts (id, name, kind, balance, updated_at)
VALUES ($1, $2, $3, $4, $5);

-- name: UpdateAccount :exec
UPDATE accounts SET name = $2, kind = $3, balance = $4, updated_at = $5
WHERE id = $1;

-- name: DeleteAccount :exec
DELETE FROM accounts WHERE id = $1;
```

### 5.2 lendings.sql

```sql
-- name: ListLendings :many
SELECT * FROM lendings ORDER BY occurred_on DESC;

-- name: ListOutstandingLendings :many
SELECT * FROM lendings
WHERE collected_amount < amount
ORDER BY occurred_on DESC;

-- name: GetLending :one
SELECT * FROM lendings WHERE id = $1;

-- name: CreateLending :exec
INSERT INTO lendings (id, counterparty, description, amount, collected_amount, occurred_on)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: UpdateLending :exec
UPDATE lendings
SET counterparty = $2, description = $3, amount = $4,
    collected_amount = $5, occurred_on = $6, updated_at = now()
WHERE id = $1;

-- name: DeleteLending :exec
DELETE FROM lendings WHERE id = $1;
```

### 5.3 wishes.sql

```sql
-- name: ListWishes :many
SELECT * FROM wishes ORDER BY priority, created_at;

-- name: ListWishesByStatus :many
SELECT * FROM wishes WHERE status = $1 ORDER BY priority, created_at;

-- name: GetWish :one
SELECT * FROM wishes WHERE id = $1;

-- name: CreateWish :exec
INSERT INTO wishes (id, title, amount, category, status, priority, deadline)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: UpdateWish :exec
UPDATE wishes
SET title = $2, amount = $3, category = $4, status = $5,
    priority = $6, deadline = $7, updated_at = now()
WHERE id = $1;

-- name: DeleteWish :exec
DELETE FROM wishes WHERE id = $1;
```

### 5.4 monthly_balances.sql

```sql
-- name: ListRecentMonthlyBalances :many
SELECT * FROM monthly_balances ORDER BY year_month DESC LIMIT $1;

-- name: ListAllMonthlyBalances :many
SELECT * FROM monthly_balances ORDER BY year_month DESC;

-- name: UpsertMonthlyBalance :exec
INSERT INTO monthly_balances (id, year_month, income, expense)
VALUES ($1, $2, $3, $4)
ON CONFLICT (year_month) DO UPDATE
SET income = EXCLUDED.income, expense = EXCLUDED.expense, updated_at = now();
```

`ON CONFLICT` により `PUT /api/monthly-balances/{yearMonth}` が冪等になる。

### 5.5 transactions.sql

```sql
-- name: ListTransactions :many
SELECT * FROM transactions ORDER BY occurred_on DESC, created_at DESC LIMIT $1;

-- name: CreateTransaction :exec
INSERT INTO transactions (id, account_id, amount, kind, ref_id, occurred_on)
VALUES ($1, $2, $3, $4, $5, $6);
```

**集計クエリは書かない。** 実質資産の計算は Go 側の純粋関数で行う（`CLAUDE.md` 不変条件8）。

---

## 6. API 詳細仕様

共通事項：

- 全エンドポイントで `Authorization: Bearer <token>` を要求する
- 金額は整数（円）。文字列化しない
- 日付は `YYYY-MM-DD`、日時は RFC3339
- レスポンスのキーは lowerCamelCase

### 6.1 GET /api/dashboard

レスポンス 200：

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
  "hasAverageSurplus": true,
  "wishes": [
    {
      "id": "0192f1c0-...",
      "title": "カメラ",
      "amount": 1200000,
      "category": "item",
      "status": "considering",
      "priority": 0,
      "deadline": null,
      "shortfall": 358000,
      "monthsToReach": 6
    }
  ]
}
```

- `wishes` には `done` / `dropped` を含めない
- `monthsToReach` は算出不可の場合 `null`
- `averageSurplus` は `hasAverageSurplus` が `false` のとき `0` を返すが、クライアントは表示しない

### 6.2 口座

| メソッド | パス | ボディ | 成功 |
| --- | --- | --- | --- |
| GET | `/api/accounts` | — | 200 配列 |
| POST | `/api/accounts` | `{name, kind, balance}` | 201 |
| PATCH | `/api/accounts/{id}` | `{name?, kind?, balance?}` | 200 |
| DELETE | `/api/accounts/{id}` | — | 204 |

`kind` は `"cash"` / `"investment"`。不正値は 422（`INVALID_ACCOUNT_KIND`）。

口座に紐づく取引が存在する場合、DELETE は 422 を返す（DDL の `ON DELETE RESTRICT` による）。

### 6.3 立替

| メソッド | パス | ボディ | 成功 |
| --- | --- | --- | --- |
| GET | `/api/lendings?outstanding=true` | — | 200 配列 |
| POST | `/api/lendings` | `{counterparty, description, amount, occurredOn, accountId}` | 201 |
| POST | `/api/lendings/{id}/collect` | `{amount, occurredOn, accountId}` | 200 |
| DELETE | `/api/lendings/{id}` | — | 204 |

レスポンスの立替オブジェクトには、導出値も含める。

```json
{
  "id": "...",
  "counterparty": "田中",
  "description": "◯◯のライブチケット代",
  "amount": 12000,
  "collectedAmount": 5000,
  "outstanding": 7000,
  "status": "partial",
  "occurredOn": "2026-07-12"
}
```

回収額が未回収残高を超える場合は 422（`COLLECT_EXCEEDS_OUTSTANDING`）。

### 6.4 ウィッシュ

| メソッド | パス | ボディ | 成功 |
| --- | --- | --- | --- |
| GET | `/api/wishes?status=considering` | — | 200 配列 |
| POST | `/api/wishes` | `{title, amount, category, priority?, deadline?}` | 201 |
| PATCH | `/api/wishes/{id}` | `{title?, amount?, category?, priority?, deadline?}` | 200 |
| POST | `/api/wishes/{id}/commit` | — | 200 |
| POST | `/api/wishes/{id}/pay` | `{accountId, occurredOn}` | 200 |
| POST | `/api/wishes/{id}/drop` | — | 200 |
| DELETE | `/api/wishes/{id}` | — | 204 |

**PATCH で `status` は変更できない。** 状態遷移は専用エンドポイントのみ。`status` がボディに含まれていた場合は 400 を返す。

不正な遷移は 422（`INVALID_TRANSITION`）。

### 6.5 月次収支

| メソッド | パス | ボディ | 成功 |
| --- | --- | --- | --- |
| GET | `/api/monthly-balances` | — | 200 配列（年月の降順） |
| PUT | `/api/monthly-balances/{yearMonth}` | `{income, expense}` | 200 |

`{yearMonth}` は `2026-07` 形式。形式不正は 400、範囲外（月が13など）は 422（`INVALID_YEAR_MONTH`）。

レスポンス：

```json
{
  "yearMonth": "2026-07",
  "income": 320000,
  "expense": 255000,
  "surplus": 65000
}
```

`surplus` は導出値。クライアントは符号で黒字・赤字を判定する。

---

## 7. テスト仕様

### 7.1 テストの書き方

- テーブル駆動とする
- モックライブラリは使わない。インターフェースは手書きの fake で満たす
- ドメイン層のテストに DB を使わない
- 期待値はリテラルで書く。テスト内で計算しない（式を間違えるとテストも一緒に間違う）

### 7.2 networth_test.go のケース

金額の単位は円。**具体的な値をそのまま使ってよい。**

#### A. CalculateBreakdown / NetAsset

| # | 入力 | 期待 |
| --- | --- | --- |
| A-1 | 現金口座のみ（500,000 と 300,000） | cashTotal=800,000、netAsset=800,000 |
| A-2 | 現金 500,000 + 投資 400,000 | **cashTotal=500,000、netAsset=500,000**（投資は加算されない） |
| A-3 | 現金 500,000、未回収立替 12,000（回収0） | outstandingLendings=12,000、netAsset=512,000 |
| A-4 | 現金 500,000、立替 12,000 のうち 5,000 回収済 | outstandingLendings=7,000、netAsset=507,000 |
| A-5 | 現金 500,000、立替 12,000 全額回収済 | outstandingLendings=0、netAsset=500,000 |
| A-6 | 現金 500,000、committed のウィッシュ 80,000 | commitments=80,000、netAsset=420,000 |
| A-7 | 現金 500,000、considering のウィッシュ 80,000 | **commitments=0、netAsset=500,000** |
| A-8 | 現金 500,000、done のウィッシュ 80,000 | **commitments=0、netAsset=500,000** |
| A-9 | 現金 500,000、dropped のウィッシュ 80,000 | **commitments=0、netAsset=500,000** |
| A-10 | 全部空（nil スライス） | すべて 0 |
| A-11 | 現金 910,000 + 投資 350,000、未回収 12,000、committed 80,000 | cashTotal=910,000、outstanding=12,000、commitments=80,000、netAsset=842,000 |

**A-2、A-7、A-8、A-9 が最重要。** ここが壊れるとアプリの存在意義が消える。

#### B. AverageSurplus

| # | 入力（年月, 収入, 支出） | months | 期待 |
| --- | --- | --- | --- |
| B-1 | 2026-05(300k,240k), 2026-06(300k,250k), 2026-07(300k,230k) | 3 | (60k+50k+70k)/3 = 60,000、ok=true |
| B-2 | 2026-06(300k,250k), 2026-07(300k,230k) | 3 | (50k+70k)/2 = 60,000、ok=true |
| B-3 | 空スライス | 3 | ok=false |
| B-4 | 4ヶ月分（2026-04〜07） | 3 | **直近3ヶ月（05,06,07）のみで平均** |
| B-5 | 順序をシャッフルした3ヶ月分 | 3 | B-1 と同じ結果（内部でソートされる） |
| B-6 | 2026-07(200k,250k) の1件のみ | 3 | -50,000、ok=true（負値もそのまま返す） |
| B-7 | 3件、合計が3で割り切れない（例 61k,50k,70k → 181k） | 3 | 60,333（切り捨て） |
| B-8 | 引数のスライスが変更されていないこと | 3 | 呼び出し後も入力の順序が保たれる |

B-8 は「引数を破壊しない」ことの検証。ソートを内部で行う設計にしたため必須。

#### C. MonthsToReach

| # | shortfall | avgSurplus | 期待 |
| --- | --- | --- | --- |
| C-1 | 600,000 | 100,000 | 6、ok=true（割り切れる） |
| C-2 | 620,000 | 100,000 | **7**、ok=true（切り上げ） |
| C-3 | 1 | 100,000 | 1、ok=true |
| C-4 | 100,000 | 100,000 | 1、ok=true |
| C-5 | 100,001 | 100,000 | 2、ok=true |
| C-6 | 0 | 100,000 | ok=false（達成済み） |
| C-7 | -50,000 | 100,000 | ok=false（達成済み） |
| C-8 | 600,000 | 0 | ok=false |
| C-9 | 600,000 | -30,000 | ok=false |

C-1 と C-2 のペアが切り上げ実装の正しさを担保する。**両方書かないと境界を1つ間違えても気づけない。**

#### D. CalculateShortfall

| # | ウィッシュ金額 | netAsset | 期待 |
| --- | --- | --- | --- |
| D-1 | 1,200,000 | 842,000 | 358,000 |
| D-2 | 500,000 | 842,000 | -342,000（達成可能） |
| D-3 | 842,000 | 842,000 | 0 |

### 7.3 wish_test.go のケース

| # | 初期状態 | 操作 | 期待 |
| --- | --- | --- | --- |
| E-1 | considering | Commit | committed、err=nil |
| E-2 | committed | Commit | ErrInvalidTransition、状態は変化しない |
| E-3 | done | Commit | ErrInvalidTransition |
| E-4 | dropped | Commit | ErrInvalidTransition |
| E-5 | committed | Pay | done、err=nil |
| E-6 | considering | Pay | ErrInvalidTransition |
| E-7 | done | Pay | ErrInvalidTransition |
| E-8 | considering | Drop | dropped |
| E-9 | committed | Drop | dropped |
| E-10 | done | Drop | ErrInvalidTransition |
| E-11 | dropped | Drop | ErrInvalidTransition |

**エラー時に状態が変化していないことも検証する。** 遷移に失敗したのに状態だけ書き換わっていると、最も気づきにくい不具合になる。

### 7.4 lending_test.go のケース

| # | amount | collected | 操作 | 期待 |
| --- | --- | --- | --- | --- |
| F-1 | 12,000 | 0 | Collect(5,000) | collected=5,000、status=partial |
| F-2 | 12,000 | 5,000 | Collect(7,000) | collected=12,000、status=collected |
| F-3 | 12,000 | 5,000 | Collect(8,000) | **ErrCollectExceedsOutstanding**、collected は 5,000 のまま |
| F-4 | 12,000 | 12,000 | Collect(1) | ErrCollectExceedsOutstanding |
| F-5 | 12,000 | 0 | Collect(0) | ErrInvalidAmount |
| F-6 | 12,000 | 0 | Collect(-100) | ErrInvalidAmount |
| F-7 | 12,000 | 0 | Outstanding() | 12,000、status=uncollected |

### 7.5 year_month_test.go のケース

| # | 入力 | 期待 |
| --- | --- | --- |
| G-1 | `NewYearMonth(2026, 7)` | 成功、String() = "2026-07" |
| G-2 | `NewYearMonth(2026, 13)` | ErrInvalidYearMonth |
| G-3 | `NewYearMonth(2026, 0)` | ErrInvalidYearMonth |
| G-4 | `ParseYearMonth("2026-07")` | 成功 |
| G-5 | `ParseYearMonth("2026-7")` | ErrInvalidYearMonth（月は2桁固定） |
| G-6 | `ParseYearMonth("2026/07")` | ErrInvalidYearMonth |
| G-7 | `NewYearMonth(2026,12).AddMonths(1)` | 2027-01（年をまたぐ） |
| G-8 | `NewYearMonth(2026,1).AddMonths(-1)` | 2025-12 |
| G-9 | `NewYearMonth(2026,7).FirstDay()` | 2026-07-01 00:00:00 UTC |
| G-10 | `YearMonth{}.IsZero()` | true |
| G-11 | 2026-07 と 2026-08 の Compare | 負値 |

### 7.6 usecase 層のテスト

| # | ケース | 期待 |
| --- | --- | --- |
| H-1 | CollectLending 正常系 | 立替の回収額、口座残高、取引履歴の3つがすべて更新される |
| H-2 | CollectLending で過回収 | エラーを返し、**口座残高も取引履歴も変化しない**（ロールバック） |
| H-3 | PayWish 正常系の前後で実質資産を比較 | **支払い前後で実質資産が変わらない**（確定支出が消え、同額だけ残高が減るため） |
| H-4 | PayWish を considering のウィッシュに対して実行 | ErrInvalidTransition、副作用なし |
| H-5 | GetDashboard で done / dropped のウィッシュ | レスポンスに含まれない |

**H-2 と H-3 が重要。** H-2 はトランザクション境界が正しいことの検証、H-3 は状態遷移と残高更新の整合性の検証にあたる。

---

## 8. 規約

### 8.1 ブランチ

```
feat/     機能追加
fix/      不具合修正
refactor/ 挙動を変えない構造変更
docs/     ドキュメントのみ
chore/    設定・依存・雑務
```

例：`feat/domain-networth`、`fix/collect-overflow`、`docs/detailed-design`

`main` へは PR 経由のみ。直接 push は禁止（ブランチ保護で強制）。

### 8.2 コミットメッセージ

ブランチと同じ語彙を使う。

```
feat: 実質資産の計算関数を追加
fix: 立替の過回収チェックが境界値で通っていた問題を修正
docs: 詳細設計書を追加
```

日本語でよい。1行目は50文字程度まで。理由や背景は本文に書く。

### 8.3 命名

`docs/design.md` の用語をそのままコードの名前にする。言い換えない。

| 概念 | 使う名前 | 使わない名前 |
| --- | --- | --- |
| 実質資産 | `NetAsset` | `TotalAsset`、`RealAsset` |
| 月間余剰 | `Surplus` | `Balance`、`Diff` |
| 不足額 | `Shortfall` | `Remaining`、`Gap` |
| 未回収残高 | `Outstanding` | `Unpaid`、`Rest` |
| 確定支出 | `Commitment` | `Fixed`、`Planned` |
| 月次収支 | `MonthlyBalance` | `MonthlyPlan`、`Budget` |

---

## 9. 実装順序

`domain` パッケージ内での推奨順序。**上から順に、テストを書きながら進める。**

| 順 | ファイル | 依存 |
| --- | --- | --- |
| 1 | `errors.go` | なし |
| 2 | `money.go` | なし |
| 3 | `year_month.go` | errors |
| 4 | `account.go` | money, errors |
| 5 | `lending.go` | money, errors |
| 6 | `wish.go` | money, errors |
| 7 | `monthly_balance.go` | money, year_month, errors |
| 8 | `networth.go` | 上記すべて |

`networth.go` が最後になるのは、他のすべてに依存するため。ただし**最も重要なのはここ**なので、テストケース（7.2 の A〜D）は先に眺めておくとよい。

段階1が終わった時点で、`go test ./internal/domain/...` が DB もサーバーも GCP もなしに通る状態になる。
