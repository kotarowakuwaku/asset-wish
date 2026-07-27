package handler_test

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// handler のテストは usecase をスタブに差し替える。
//
// ここで確かめたいのは HTTP の関心事——ステータスコード、JSON の形、
// エラーの対応づけ——だけ。手順の正しさは usecase のテストが、
// SQL は repository のテストが担当する。同じことを3回検証しない。
//
// 関数フィールドにしているのは、テストごとに戻り値を差し替えるため。
// 未設定なら「呼ばれてはいけない」扱いで、ゼロ値と nil を返す。
//
// 値はすべて架空のもの（不変条件17）。

type stubAccounts struct {
	listFn   func(ctx context.Context) ([]domain.Account, error)
	createFn func(ctx context.Context, name string, kind domain.AccountKind, balance domain.Money) (domain.Account, error)
	updateFn func(ctx context.Context, id uuid.UUID, in usecase.UpdateAccountInput) (domain.Account, error)
	deleteFn func(ctx context.Context, id uuid.UUID) error

	// gotUpdate は Update に渡された入力を記録する。
	// handler が部分更新を正しく組み立てたかを見るため。
	gotUpdate usecase.UpdateAccountInput
}

func (s *stubAccounts) List(ctx context.Context) ([]domain.Account, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx)
}

func (s *stubAccounts) Create(
	ctx context.Context, name string, kind domain.AccountKind, balance domain.Money,
) (domain.Account, error) {
	if s.createFn == nil {
		return domain.Account{}, nil
	}
	return s.createFn(ctx, name, kind, balance)
}

func (s *stubAccounts) Update(
	ctx context.Context, id uuid.UUID, in usecase.UpdateAccountInput,
) (domain.Account, error) {
	s.gotUpdate = in
	if s.updateFn == nil {
		return domain.Account{}, nil
	}
	return s.updateFn(ctx, id, in)
}

func (s *stubAccounts) Delete(ctx context.Context, id uuid.UUID) error {
	if s.deleteFn == nil {
		return nil
	}
	return s.deleteFn(ctx, id)
}

type stubLendings struct {
	listFn    func(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error)
	createFn  func(ctx context.Context, counterparty, description string, amount domain.Money, occurredOn time.Time, accountID uuid.UUID) (domain.Lending, error)
	collectFn func(ctx context.Context, lendingID uuid.UUID, amount domain.Money, occurredOn time.Time, accountID uuid.UUID) (domain.Lending, error)
	deleteFn  func(ctx context.Context, id uuid.UUID) error

	gotOutstandingOnly bool
}

func (s *stubLendings) List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error) {
	s.gotOutstandingOnly = outstandingOnly
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx, outstandingOnly)
}

func (s *stubLendings) Create(
	ctx context.Context, counterparty, description string, amount domain.Money,
	occurredOn time.Time, accountID uuid.UUID,
) (domain.Lending, error) {
	if s.createFn == nil {
		return domain.Lending{}, nil
	}
	return s.createFn(ctx, counterparty, description, amount, occurredOn, accountID)
}

func (s *stubLendings) Collect(
	ctx context.Context, lendingID uuid.UUID, amount domain.Money,
	occurredOn time.Time, accountID uuid.UUID,
) (domain.Lending, error) {
	if s.collectFn == nil {
		return domain.Lending{}, nil
	}
	return s.collectFn(ctx, lendingID, amount, occurredOn, accountID)
}

func (s *stubLendings) Delete(ctx context.Context, id uuid.UUID) error {
	if s.deleteFn == nil {
		return nil
	}
	return s.deleteFn(ctx, id)
}

type stubWishes struct {
	listFn    func(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error)
	createFn  func(ctx context.Context, title string, amount domain.Money, category domain.WishCategory, priority int, deadline *time.Time) (domain.Wish, error)
	updateFn  func(ctx context.Context, id uuid.UUID, in usecase.UpdateWishInput) (domain.Wish, error)
	commitFn  func(ctx context.Context, id uuid.UUID) (domain.Wish, error)
	payFn     func(ctx context.Context, id uuid.UUID, accountID uuid.UUID, occurredOn time.Time) (domain.Wish, error)
	dropFn    func(ctx context.Context, id uuid.UUID) (domain.Wish, error)
	deleteFn  func(ctx context.Context, id uuid.UUID) error
	gotStatus *domain.WishStatus
	gotUpdate usecase.UpdateWishInput
}

func (s *stubWishes) List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error) {
	s.gotStatus = status
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx, status)
}

func (s *stubWishes) Create(
	ctx context.Context, title string, amount domain.Money, category domain.WishCategory,
	priority int, deadline *time.Time,
) (domain.Wish, error) {
	if s.createFn == nil {
		return domain.Wish{}, nil
	}
	return s.createFn(ctx, title, amount, category, priority, deadline)
}

func (s *stubWishes) UpdateContent(
	ctx context.Context, id uuid.UUID, in usecase.UpdateWishInput,
) (domain.Wish, error) {
	s.gotUpdate = in
	if s.updateFn == nil {
		return domain.Wish{}, nil
	}
	return s.updateFn(ctx, id, in)
}

func (s *stubWishes) Commit(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	if s.commitFn == nil {
		return domain.Wish{}, nil
	}
	return s.commitFn(ctx, id)
}

func (s *stubWishes) Pay(
	ctx context.Context, id uuid.UUID, accountID uuid.UUID, occurredOn time.Time,
) (domain.Wish, error) {
	if s.payFn == nil {
		return domain.Wish{}, nil
	}
	return s.payFn(ctx, id, accountID, occurredOn)
}

func (s *stubWishes) Drop(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	if s.dropFn == nil {
		return domain.Wish{}, nil
	}
	return s.dropFn(ctx, id)
}

func (s *stubWishes) Delete(ctx context.Context, id uuid.UUID) error {
	if s.deleteFn == nil {
		return nil
	}
	return s.deleteFn(ctx, id)
}

type stubBalances struct {
	listFn   func(ctx context.Context) ([]domain.MonthlyBalance, error)
	upsertFn func(ctx context.Context, ym domain.YearMonth, income, expense domain.Money) (domain.MonthlyBalance, error)
}

func (s *stubBalances) List(ctx context.Context) ([]domain.MonthlyBalance, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx)
}

func (s *stubBalances) Upsert(
	ctx context.Context, ym domain.YearMonth, income, expense domain.Money,
) (domain.MonthlyBalance, error) {
	if s.upsertFn == nil {
		return domain.MonthlyBalance{}, nil
	}
	return s.upsertFn(ctx, ym, income, expense)
}

type stubTransactions struct {
	listFn   func(ctx context.Context, limit int) ([]domain.Transaction, error)
	gotLimit int
}

func (s *stubTransactions) List(ctx context.Context, limit int) ([]domain.Transaction, error) {
	s.gotLimit = limit
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx, limit)
}

type stubDashboard struct {
	getFn func(ctx context.Context) (usecase.Dashboard, error)
}

func (s *stubDashboard) Get(ctx context.Context) (usecase.Dashboard, error) {
	if s.getFn == nil {
		return usecase.Dashboard{}, nil
	}
	return s.getFn(ctx)
}
