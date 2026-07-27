package migrations_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/db"
)

// sqlc の生成クエリが実物の PostgreSQL 上で意図どおりに振る舞うかの検証。
//
// カラム名の打ち間違いや型の不一致は sqlc generate がスキーマと突き合わせて
// 静的に弾くため、ここで確かめたいのはそれ以外——制約が実際に効くか、
// ON CONFLICT や FK がどう振る舞うか——に絞る。
//
// このファイルが db パッケージ側にあるのは、スキーマを流す下ごしらえ
// （helper_test.go）を embed_test.go と共有するため。テスト対象は
// internal/db の生成コードで、ドメイン型は一切登場しない。詰め替えは
// 段階3の adapter/repository の責務（不変条件7）。
//
// 値はすべて架空のもの（不変条件17）。

func newQueries(t *testing.T) (*db.Queries, context.Context) {
	t.Helper()
	return db.New(setupDB(t)), context.Background()
}

// date は DATE カラム用の時刻を作る。タイムゾーンを混ぜると
// 月初がずれるため UTC に固定する（design.md 3.2 と同じ理由）。
func date(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// TestUpsertMonthlyBalanceKeepsExistingID は、既存月を上書きしたときに
// 渡した id ではなく既存行の id が返ることを確かめる。
//
// ON CONFLICT DO UPDATE は既存行の id を維持するため、呼び出し側が
// 毎回生成する UUID は競合時に捨てられる。RETURNING で受け取らずに
// 生成した id をレスポンスへ載せると、DB に存在しない id を返すことになる。
// この振る舞いに依存しているので、テストで固定しておく。
func TestUpsertMonthlyBalanceKeepsExistingID(t *testing.T) {
	q, ctx := newQueries(t)

	yearMonth := date(2026, time.July, 1)

	firstID := uuid.New()
	gotFirst, err := q.UpsertMonthlyBalance(ctx, db.UpsertMonthlyBalanceParams{
		ID: firstID, YearMonth: yearMonth, Income: 300000, Expense: 200000,
	})
	if err != nil {
		t.Fatalf("新規登録に失敗: %v", err)
	}
	if gotFirst != firstID {
		t.Errorf("新規登録では渡した id が使われるはず: got %v, want %v", gotFirst, firstID)
	}

	secondID := uuid.New()
	gotSecond, err := q.UpsertMonthlyBalance(ctx, db.UpsertMonthlyBalanceParams{
		ID: secondID, YearMonth: yearMonth, Income: 310000, Expense: 190000,
	})
	if err != nil {
		t.Fatalf("上書きに失敗: %v", err)
	}
	if gotSecond != firstID {
		t.Errorf("上書き時は既存行の id が返るはず: got %v, want %v", gotSecond, firstID)
	}

	// 冪等であること。同じ月に2回入れて2行になっては困る。
	balances, err := q.ListAllMonthlyBalances(ctx)
	if err != nil {
		t.Fatalf("一覧の取得に失敗: %v", err)
	}
	if len(balances) != 1 {
		t.Fatalf("同じ月は1行に集約されるはず: got %d 件", len(balances))
	}
	if balances[0].Income != 310000 || balances[0].Expense != 190000 {
		t.Errorf("上書き後の値が反映されていない: %+v", balances[0])
	}
}

// TestUpdateAccountKeepsKind は、口座の更新で kind が動かないことを確かめる。
//
// kind が cash から investment に変わると、その口座は実質資産の計算から
// 丸ごと外れる（不変条件1）。更新クエリから kind を外した判断が、
// あとで「ついでに足す」形で崩されていないかを見張る。
func TestUpdateAccountKeepsKind(t *testing.T) {
	q, ctx := newQueries(t)

	id := uuid.New()
	updatedAt := date(2026, time.July, 1)
	if err := q.CreateAccount(ctx, db.CreateAccountParams{
		ID: id, Name: "生活用", Kind: "cash", Balance: 500000, UpdatedAt: updatedAt,
	}); err != nil {
		t.Fatalf("口座の作成に失敗: %v", err)
	}

	if err := q.UpdateAccount(ctx, db.UpdateAccountParams{
		ID: id, Name: "生活用（改名）", Balance: 450000, UpdatedAt: updatedAt.AddDate(0, 0, 1),
	}); err != nil {
		t.Fatalf("口座の更新に失敗: %v", err)
	}

	got, err := q.GetAccount(ctx, id)
	if err != nil {
		t.Fatalf("口座の取得に失敗: %v", err)
	}
	if got.Kind != "cash" {
		t.Errorf("更新で kind が変わってはならない: got %q, want %q", got.Kind, "cash")
	}
	if got.Name != "生活用（改名）" || got.Balance != 450000 {
		t.Errorf("名称と残高は更新されるはず: %+v", got)
	}
}

// TestUpdateAccountRejectsUnknownKind は kind の CHECK 制約を確かめる。
// 列挙値が黙って増えると、実質資産の対象判定が Go 側と食い違う。
func TestAccountRejectsUnknownKind(t *testing.T) {
	q, ctx := newQueries(t)

	err := q.CreateAccount(ctx, db.CreateAccountParams{
		ID: uuid.New(), Name: "謎の口座", Kind: "crypto", Balance: 1,
		UpdatedAt: date(2026, time.July, 1),
	})
	if err == nil {
		t.Error("kind に未知の値が通ってしまった。CHECK 制約が効いていない")
	}
}

// TestLendingCollectedAmountBoundary は回収額の上限が DB 側でも
// 守られていることを確かめる（不変条件4）。
//
// 過回収を弾く責務は domain にあるが、そこを通らない経路で書き込まれた
// ときの最後の防波堤として CHECK 制約が要る。境界（全額回収）は
// 通り、1円でも超えたら落ちること。
func TestLendingCollectedAmountBoundary(t *testing.T) {
	q, ctx := newQueries(t)

	const amount = 5000

	tests := []struct {
		name      string
		collected int64
		wantErr   bool
	}{
		{name: "一部回収", collected: 3000, wantErr: false},
		{name: "全額回収（境界）", collected: amount, wantErr: false},
		{name: "1円の過回収", collected: amount + 1, wantErr: true},
		{name: "負の回収額", collected: -1, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id := uuid.New()
			if err := q.CreateLending(ctx, db.CreateLendingParams{
				ID: id, Counterparty: "友人A", Description: "チケット代",
				Amount: amount, CollectedAmount: 0, OccurredOn: date(2026, time.June, 10),
			}); err != nil {
				t.Fatalf("立替の作成に失敗: %v", err)
			}

			err := q.UpdateLendingCollectedAmount(ctx, db.UpdateLendingCollectedAmountParams{
				ID: id, CollectedAmount: tt.collected,
			})
			if tt.wantErr && err == nil {
				t.Errorf("回収額 %d は拒否されるはずが通ってしまった", tt.collected)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("回収額 %d は通るはずが失敗した: %v", tt.collected, err)
			}
		})
	}
}

// TestListOutstandingLendingsExcludesCollected は未回収の絞り込みを確かめる。
//
// 未回収残高は amount - collected_amount から導出する（不変条件12）。
// status カラムを持たない設計なので、絞り込みが正しいかは
// このクエリでしか確認できない。
func TestListOutstandingLendingsExcludesCollected(t *testing.T) {
	q, ctx := newQueries(t)

	lendings := []struct {
		counterparty string
		amount       int64
		collected    int64
	}{
		{counterparty: "友人A", amount: 5000, collected: 0},    // 未回収
		{counterparty: "友人B", amount: 8000, collected: 3000}, // 一部回収 → まだ未回収
		{counterparty: "友人C", amount: 2000, collected: 2000}, // 全額回収 → 対象外
	}

	for i, l := range lendings {
		if err := q.CreateLending(ctx, db.CreateLendingParams{
			ID: uuid.New(), Counterparty: l.counterparty, Description: "立替",
			Amount: l.amount, CollectedAmount: l.collected,
			OccurredOn: date(2026, time.June, 1+i),
		}); err != nil {
			t.Fatalf("立替の作成に失敗: %v", err)
		}
	}

	all, err := q.ListLendings(ctx)
	if err != nil {
		t.Fatalf("立替一覧の取得に失敗: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("全件は3件のはず: got %d", len(all))
	}

	outstanding, err := q.ListOutstandingLendings(ctx)
	if err != nil {
		t.Fatalf("未回収一覧の取得に失敗: %v", err)
	}
	if len(outstanding) != 2 {
		t.Fatalf("未回収は2件のはず: got %d", len(outstanding))
	}
	for _, l := range outstanding {
		if l.CollectedAmount >= l.Amount {
			t.Errorf("全額回収済みが未回収一覧に混ざっている: %+v", l)
		}
	}
}

// TestWishContentAndStatusAreSeparate は、内容の更新と状態遷移が
// 互いに干渉しないことを確かめる。
//
// クエリを2本に割った目的は、内容更新の経路から status を書けなくすること
// （不変条件6）。片方がもう片方の列を巻き込んで上書きしていないかを見る。
func TestWishContentAndStatusAreSeparate(t *testing.T) {
	q, ctx := newQueries(t)

	id := uuid.New()
	if err := q.CreateWish(ctx, db.CreateWishParams{
		ID: id, Title: "旅行", Amount: 120000, Category: "experience",
		Status: "considering", Priority: 1,
		Deadline: sql.NullTime{Time: date(2026, time.December, 31), Valid: true},
	}); err != nil {
		t.Fatalf("ウィッシュの作成に失敗: %v", err)
	}

	// 内容だけ更新しても status は動かない。
	if err := q.UpdateWishContent(ctx, db.UpdateWishContentParams{
		ID: id, Title: "旅行（行き先変更）", Amount: 150000, Priority: 2,
		Deadline: sql.NullTime{Valid: false},
	}); err != nil {
		t.Fatalf("内容の更新に失敗: %v", err)
	}

	got, err := q.GetWish(ctx, id)
	if err != nil {
		t.Fatalf("ウィッシュの取得に失敗: %v", err)
	}
	if got.Status != "considering" {
		t.Errorf("内容の更新で status が変わってはならない: got %q", got.Status)
	}
	if got.Title != "旅行（行き先変更）" || got.Amount != 150000 || got.Priority != 2 {
		t.Errorf("内容が更新されていない: %+v", got)
	}
	if got.Deadline.Valid {
		t.Error("deadline の解除が反映されていない")
	}
	if got.Category != "experience" {
		t.Errorf("category は内容更新の対象外のはず: got %q", got.Category)
	}

	// 状態だけ更新しても内容は動かない。
	if err := q.UpdateWishStatus(ctx, db.UpdateWishStatusParams{
		ID: id, Status: "committed",
	}); err != nil {
		t.Fatalf("状態の更新に失敗: %v", err)
	}

	got, err = q.GetWish(ctx, id)
	if err != nil {
		t.Fatalf("ウィッシュの取得に失敗: %v", err)
	}
	if got.Status != "committed" {
		t.Errorf("status が更新されていない: got %q", got.Status)
	}
	if got.Title != "旅行（行き先変更）" || got.Amount != 150000 {
		t.Errorf("状態の更新で内容が巻き込まれている: %+v", got)
	}
}

// TestListWishesByStatus は status での絞り込みを確かめる。
// 実質資産から控除するのは committed のみ（不変条件3）で、
// その候補をここで絞る。
func TestListWishesByStatus(t *testing.T) {
	q, ctx := newQueries(t)

	statuses := []string{"considering", "committed", "committed", "done", "dropped"}
	for i, s := range statuses {
		if err := q.CreateWish(ctx, db.CreateWishParams{
			ID: uuid.New(), Title: "ウィッシュ", Amount: int64(10000 * (i + 1)),
			Category: "item", Status: s, Priority: int32(i),
			Deadline: sql.NullTime{Valid: false},
		}); err != nil {
			t.Fatalf("ウィッシュの作成に失敗: %v", err)
		}
	}

	committed, err := q.ListWishesByStatus(ctx, "committed")
	if err != nil {
		t.Fatalf("絞り込みに失敗: %v", err)
	}
	if len(committed) != 2 {
		t.Fatalf("committed は2件のはず: got %d", len(committed))
	}
	for _, w := range committed {
		if w.Status != "committed" {
			t.Errorf("committed 以外が混ざっている: %+v", w)
		}
	}

	// 0件のときに nil ではなく空スライスが返ること（sqlc の emit_empty_slices）。
	// 呼び出し側で nil 判定を書かずに済ませる前提なので、崩れていないか見る。
	none, err := q.ListWishesByStatus(ctx, "considering")
	if err != nil {
		t.Fatalf("絞り込みに失敗: %v", err)
	}
	if len(none) != 1 {
		t.Errorf("considering は1件のはず: got %d", len(none))
	}
	empty, err := q.ListWishesByStatus(ctx, "committed_typo")
	if err != nil {
		t.Fatalf("絞り込みに失敗: %v", err)
	}
	if empty == nil {
		t.Error("0件のときは nil ではなく空スライスが返るはず")
	}
}

// TestDeleteAccountWithTransactionsIsRestricted は、履歴の残る口座を
// 消せないことを確かめる。
//
// transactions.account_id は ON DELETE RESTRICT。口座を消して履歴が
// 宙に浮くと、過去の残高の裏付けが取れなくなる。
func TestDeleteAccountWithTransactionsIsRestricted(t *testing.T) {
	q, ctx := newQueries(t)

	accountID := uuid.New()
	if err := q.CreateAccount(ctx, db.CreateAccountParams{
		ID: accountID, Name: "生活用", Kind: "cash", Balance: 100000,
		UpdatedAt: date(2026, time.July, 1),
	}); err != nil {
		t.Fatalf("口座の作成に失敗: %v", err)
	}

	// 履歴が無いうちは消せる。
	spare := uuid.New()
	if err := q.CreateAccount(ctx, db.CreateAccountParams{
		ID: spare, Name: "予備", Kind: "cash", Balance: 0,
		UpdatedAt: date(2026, time.July, 1),
	}); err != nil {
		t.Fatalf("口座の作成に失敗: %v", err)
	}
	if err := q.DeleteAccount(ctx, spare); err != nil {
		t.Fatalf("履歴の無い口座は消せるはず: %v", err)
	}

	if err := q.CreateTransaction(ctx, db.CreateTransactionParams{
		ID: uuid.New(), AccountID: accountID, Amount: -5000,
		Kind: "lending_created", RefID: uuid.NullUUID{UUID: uuid.New(), Valid: true},
		OccurredOn: date(2026, time.June, 10),
	}); err != nil {
		t.Fatalf("取引の作成に失敗: %v", err)
	}

	if err := q.DeleteAccount(ctx, accountID); err == nil {
		t.Error("履歴の残る口座が消せてしまった。ON DELETE RESTRICT が効いていない")
	}
}

// TestCreateTransactionRequiresExistingAccount は、存在しない口座を
// 参照する取引を作れないことを確かめる。
func TestCreateTransactionRequiresExistingAccount(t *testing.T) {
	q, ctx := newQueries(t)

	err := q.CreateTransaction(ctx, db.CreateTransactionParams{
		ID: uuid.New(), AccountID: uuid.New(), Amount: -1000,
		Kind: "adjustment", RefID: uuid.NullUUID{Valid: false},
		OccurredOn: date(2026, time.June, 10),
	})
	if err == nil {
		t.Error("存在しない口座を参照する取引が作れてしまった。外部キーが効いていない")
	}
}
