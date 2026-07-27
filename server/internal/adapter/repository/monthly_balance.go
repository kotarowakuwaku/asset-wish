package repository

import (
	"context"
	"fmt"

	sqlc "github.com/kotarowakuwaku/asset-wish/server/internal/db"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type MonthlyBalanceRepository struct {
	store *Store
}

func NewMonthlyBalanceRepository(store *Store) *MonthlyBalanceRepository {
	return &MonthlyBalanceRepository{store: store}
}

// ListRecent は年月の降順で最大 limit 件を返す。
//
// 「直近何ヶ月か」を決めるのは呼び出し側（domain.AverageSurplusMonths）。
// 件数を SQL に埋め込むと、平均月間余剰のルールが SQL 側に漏れる。
func (r *MonthlyBalanceRepository) ListRecent(ctx context.Context, limit int) ([]domain.MonthlyBalance, error) {
	rows, err := r.store.queries(ctx).ListRecentMonthlyBalances(ctx, limitToInt32(limit))
	if err != nil {
		return nil, fmt.Errorf("月次収支の取得に失敗: %w", err)
	}
	return toDomainMonthlyBalances(rows), nil
}

func (r *MonthlyBalanceRepository) ListAll(ctx context.Context) ([]domain.MonthlyBalance, error) {
	rows, err := r.store.queries(ctx).ListAllMonthlyBalances(ctx)
	if err != nil {
		return nil, fmt.Errorf("月次収支の取得に失敗: %w", err)
	}
	return toDomainMonthlyBalances(rows), nil
}

// Upsert は同一年月があれば更新、なければ作成し、保存後の姿を返す。
//
// 返すのは ID のため。既存行を更新した場合、DB は既存の ID を維持する
// ので、引数の m.ID は捨てられる。ここで返さないと、呼び出し側は
// DB に存在しない ID を持ったまま処理を続けることになる。
func (r *MonthlyBalanceRepository) Upsert(ctx context.Context, m domain.MonthlyBalance) (domain.MonthlyBalance, error) {
	id, err := r.store.queries(ctx).UpsertMonthlyBalance(ctx, sqlc.UpsertMonthlyBalanceParams{
		ID:        m.ID,
		YearMonth: m.YearMonth.FirstDay(),
		Income:    int64(m.Income),
		Expense:   int64(m.Expense),
	})
	if err != nil {
		return domain.MonthlyBalance{}, fmt.Errorf("月次収支の保存に失敗: %w", err)
	}

	m.ID = id
	return m, nil
}

func toDomainMonthlyBalances(rows []sqlc.MonthlyBalance) []domain.MonthlyBalance {
	balances := make([]domain.MonthlyBalance, 0, len(rows))
	for _, row := range rows {
		balances = append(balances, toDomainMonthlyBalance(row))
	}
	return balances
}

// toDomainMonthlyBalance は sqlc 生成型をドメインエンティティに詰め替える。
//
// year_month は月初日の DATE として保存されている（CHECK 制約つき）。
// domain.FromTime は年と月だけを取り出すので、日以下は落ちる。
func toDomainMonthlyBalance(row sqlc.MonthlyBalance) domain.MonthlyBalance {
	return domain.MonthlyBalance{
		ID:        row.ID,
		YearMonth: domain.FromTime(row.YearMonth),
		Income:    domain.Money(row.Income),
		Expense:   domain.Money(row.Expense),
	}
}
