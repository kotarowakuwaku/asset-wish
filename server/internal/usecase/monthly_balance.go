package usecase

import (
	"context"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type MonthlyBalanceUsecase struct {
	balances MonthlyBalanceRepository
	newID    IDGenerator
}

func NewMonthlyBalanceUsecase(balances MonthlyBalanceRepository, newID IDGenerator) *MonthlyBalanceUsecase {
	return &MonthlyBalanceUsecase{balances: balances, newID: newID}
}

// List は年月の降順で全件返す。
func (u *MonthlyBalanceUsecase) List(ctx context.Context) ([]domain.MonthlyBalance, error) {
	return u.balances.ListAll(ctx)
}

// Upsert は同じ年月への再登録を上書きとして扱う（冪等）。
//
// 戻り値は保存後の姿。既存の月を上書きした場合、ID は既存行のものに
// なるため、採番した ID をそのまま返すと DB に無い ID を返すことになる。
func (u *MonthlyBalanceUsecase) Upsert(
	ctx context.Context,
	ym domain.YearMonth,
	income, expense domain.Money,
) (domain.MonthlyBalance, error) {
	m, err := domain.NewMonthlyBalance(u.newID(), ym, income, expense)
	if err != nil {
		return domain.MonthlyBalance{}, err
	}
	return u.balances.Upsert(ctx, m)
}
