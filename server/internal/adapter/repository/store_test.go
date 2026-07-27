package repository_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// トランザクション境界の検証。
//
// 立替の回収は「立替の更新 → 口座残高の更新 → 履歴の記録」を一息で
// 行う（detailed-design 3.2.2）。途中で失敗したときに一部だけ残ると、
// 残高と履歴が食い違ったまま気付けない。境界そのものをここで確かめる。

var errRollback = errors.New("巻き戻しの合図")

func TestStore_RunInTxCommits(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)
	lendingRepo := repository.NewLendingRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	lending := newLending(t, "友人A", 12000)

	err := store.RunInTx(ctx, func(ctx context.Context) error {
		if err := accountRepo.Create(ctx, account); err != nil {
			return err
		}
		return lendingRepo.Create(ctx, lending)
	})
	if err != nil {
		t.Fatalf("RunInTx: %v", err)
	}

	if _, err := accountRepo.Get(ctx, account.ID); err != nil {
		t.Errorf("コミット後に口座が読めない: %v", err)
	}
	if _, err := lendingRepo.Get(ctx, lending.ID); err != nil {
		t.Errorf("コミット後に立替が読めない: %v", err)
	}
}

// TestStore_RunInTxRollsBackOnError は、途中で失敗したときに
// それまでの書き込みが残らないことを確かめる。
func TestStore_RunInTxRollsBackOnError(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)
	lendingRepo := repository.NewLendingRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	lending := newLending(t, "友人A", 12000)

	err := store.RunInTx(ctx, func(ctx context.Context) error {
		if err := accountRepo.Create(ctx, account); err != nil {
			return err
		}
		if err := lendingRepo.Create(ctx, lending); err != nil {
			return err
		}
		return errRollback
	})
	if !errors.Is(err, errRollback) {
		t.Fatalf("fn の error がそのまま返るはず: got %v", err)
	}

	accounts, err := accountRepo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(accounts) != 0 {
		t.Errorf("巻き戻ったはずの口座が残っている: %d 件", len(accounts))
	}

	lendings, err := lendingRepo.List(ctx, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(lendings) != 0 {
		t.Errorf("巻き戻ったはずの立替が残っている: %d 件", len(lendings))
	}
}

// TestStore_RunInTxRollsBackOnPanic は、panic でも巻き戻すことを確かめる。
//
// ここで握りつぶすと、中途半端に書き込まれた状態が残ったまま
// プロセスが動き続ける。巻き戻したうえで panic は投げ直す。
func TestStore_RunInTxRollsBackOnPanic(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)

	func() {
		defer func() {
			if p := recover(); p == nil {
				t.Error("panic が投げ直されていない")
			}
		}()

		_ = store.RunInTx(ctx, func(ctx context.Context) error {
			if err := accountRepo.Create(ctx, account); err != nil {
				return err
			}
			panic("途中で落ちた")
		})
	}()

	accounts, err := accountRepo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(accounts) != 0 {
		t.Errorf("panic 後も口座が残っている: %d 件", len(accounts))
	}
}

// TestStore_RunInTxSeesOwnWrites は、同一トランザクションの中で
// 書いたものを読めることを確かめる。
//
// 立替の回収は Get してから Update するため、ここが成り立たないと
// 手順そのものが組めない（detailed-design 3.2.2）。
func TestStore_RunInTxSeesOwnWrites(t *testing.T) {
	store, _, ctx := newStore(t)
	lendingRepo := repository.NewLendingRepository(store)

	lending := newLending(t, "友人A", 12000)

	err := store.RunInTx(ctx, func(ctx context.Context) error {
		if err := lendingRepo.Create(ctx, lending); err != nil {
			return err
		}

		got, err := lendingRepo.Get(ctx, lending.ID)
		if err != nil {
			return err
		}
		if err := got.Collect(5000); err != nil {
			return err
		}
		return lendingRepo.UpdateCollected(ctx, got)
	})
	if err != nil {
		t.Fatalf("RunInTx: %v", err)
	}

	got, err := lendingRepo.Get(ctx, lending.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.CollectedAmount != 5000 {
		t.Errorf("CollectedAmount=%d want 5000", got.CollectedAmount)
	}
}

// TestStore_RunInTxNestedJoinsOuter は、入れ子にしたときに内側が
// 独立したトランザクションを張らないことを確かめる。
//
// 内側で別のトランザクションが始まると、外側が巻き戻っても内側の
// 書き込みだけが残る。usecase を組み合わせたときに起きうるので、
// 内側は外側に相乗りする。
func TestStore_RunInTxNestedJoinsOuter(t *testing.T) {
	store, _, ctx := newStore(t)
	accountRepo := repository.NewAccountRepository(store)

	account := newAccount(t, "生活用", domain.AccountKindCash, 500000)

	err := store.RunInTx(ctx, func(ctx context.Context) error {
		if err := store.RunInTx(ctx, func(ctx context.Context) error {
			return accountRepo.Create(ctx, account)
		}); err != nil {
			return err
		}
		return errRollback
	})
	if !errors.Is(err, errRollback) {
		t.Fatalf("外側の error がそのまま返るはず: got %v", err)
	}

	accounts, err := accountRepo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(accounts) != 0 {
		t.Errorf("内側の書き込みが独立して残っている: %d 件", len(accounts))
	}
}
