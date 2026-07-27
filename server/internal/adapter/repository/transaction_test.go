package repository_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func newTransaction(
	t *testing.T,
	accountID uuid.UUID,
	amount domain.Money,
	kind domain.TransactionKind,
	refID *uuid.UUID,
	occurredOn time.Time,
) domain.Transaction {
	t.Helper()

	tr, err := domain.NewTransaction(uuid.New(), accountID, amount, kind, refID, occurredOn)
	if err != nil {
		t.Fatalf("NewTransaction: %v", err)
	}
	return tr
}

// TestTransactionRepository_RefIDRoundTrip は ref_id の NULL 往復を確かめる。
//
// 参照先は立替とウィッシュの両方になりうるため外部キーを張れない
// （design.md 2.3）。*uuid.UUID と uuid.NullUUID の変換を取り違えても
// 型では落ちないので、往復で確かめる。
func TestTransactionRepository_RefIDRoundTrip(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)
	repo := repository.NewTransactionRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	if err := accountRepo.Create(ctx, account); err != nil {
		t.Fatalf("Create(account): %v", err)
	}

	ref := uuid.New()
	occurredOn := date(2026, time.June, 10)

	withRef := newTransaction(t, account.ID, -12000, domain.TransactionLendingCreated, &ref, occurredOn)
	adjustment := newTransaction(t, account.ID, -300, domain.TransactionAdjustment, nil, occurredOn)

	for _, tr := range []domain.Transaction{withRef, adjustment} {
		if err := repo.Create(ctx, tr); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	got, err := repo.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("2件のはず: got %d", len(got))
	}

	byID := make(map[uuid.UUID]domain.Transaction, len(got))
	for _, tr := range got {
		byID[tr.ID] = tr
	}

	gotWithRef, ok := byID[withRef.ID]
	if !ok {
		t.Fatal("参照先ありの取引が見つからない")
	}
	if gotWithRef.RefID == nil || *gotWithRef.RefID != ref {
		t.Errorf("RefID=%v want %v", gotWithRef.RefID, ref)
	}
	if gotWithRef.Amount != -12000 {
		t.Errorf("Amount=%d want -12000", gotWithRef.Amount)
	}
	if gotWithRef.Kind != domain.TransactionLendingCreated {
		t.Errorf("Kind=%s want lending_created", gotWithRef.Kind)
	}
	if !gotWithRef.OccurredOn.Equal(occurredOn) {
		t.Errorf("OccurredOn=%v want %v", gotWithRef.OccurredOn, occurredOn)
	}

	gotAdjustment, ok := byID[adjustment.ID]
	if !ok {
		t.Fatal("調整の取引が見つからない")
	}
	if gotAdjustment.RefID != nil {
		t.Errorf("adjustment は参照先を持たないはず: got %v", *gotAdjustment.RefID)
	}
}

// TestTransactionRepository_ListOrderAndLimit は降順と件数制限を確かめる。
func TestTransactionRepository_ListOrderAndLimit(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)
	repo := repository.NewTransactionRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	if err := accountRepo.Create(ctx, account); err != nil {
		t.Fatalf("Create(account): %v", err)
	}

	// 登録順と発生日の順序をわざとずらす。
	days := []int{10, 25, 3, 18}
	for _, d := range days {
		tr := newTransaction(t, account.ID, -1000, domain.TransactionAdjustment, nil, date(2026, time.June, d))
		if err := repo.Create(ctx, tr); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	got, err := repo.List(ctx, 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("2件のはず: got %d", len(got))
	}
	if !got[0].OccurredOn.Equal(date(2026, time.June, 25)) {
		t.Errorf("先頭=%v want 2026-06-25", got[0].OccurredOn)
	}
	if !got[1].OccurredOn.Equal(date(2026, time.June, 18)) {
		t.Errorf("2番目=%v want 2026-06-18", got[1].OccurredOn)
	}

	all, err := repo.List(ctx, 0)
	if err != nil {
		t.Fatalf("List(0): %v", err)
	}
	if len(all) != 4 {
		t.Errorf("limit 0 は全件相当に丸める: got %d", len(all))
	}
}

func TestTransactionRepository_ListEmpty(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewTransactionRepository(store)

	got, err := repo.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}
}

// TestTransactionRepository_RejectsBrokenKind は、DB に壊れた種別が
// 入っていたときにドメイン層へ渡さないことを確かめる。
func TestTransactionRepository_RejectsBrokenKind(t *testing.T) {
	store, conn, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)
	repo := repository.NewTransactionRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	if err := accountRepo.Create(ctx, account); err != nil {
		t.Fatalf("Create(account): %v", err)
	}

	if _, err := conn.Exec(`ALTER TABLE transactions DROP CONSTRAINT transactions_kind_check`); err != nil {
		t.Fatalf("CHECK 制約の解除に失敗（制約名が変わった可能性）: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO transactions (id, account_id, amount, kind, occurred_on)
		 VALUES (gen_random_uuid(), $1, -100, 'refund', '2026-06-10')`, account.ID); err != nil {
		t.Fatalf("壊れた行の作成に失敗: %v", err)
	}

	if _, err := repo.List(ctx, 10); err == nil {
		t.Error("不正な kind がそのままドメイン層へ渡ってしまった")
	}
}
