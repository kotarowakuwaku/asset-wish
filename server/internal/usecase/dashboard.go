package usecase

import (
	"context"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// Dashboard はトップ画面に必要な値をまとめたもの。
// ラウンドトリップを減らすため1本にまとめる（design.md 4.3）。
type Dashboard struct {
	Breakdown         domain.NetAssetBreakdown
	NetAsset          domain.Money
	InvestmentTotal   domain.Money
	AverageSurplus    domain.Money
	HasAverageSurplus bool
	Wishes            []DashboardWish
}

// DashboardWish はウィッシュ1件と、それに対する導出値。
type DashboardWish struct {
	Wish      domain.Wish
	Shortfall domain.Money
	// MonthsToReach は HasMonthsToReach が false のとき意味を持たない。
	// 平均月間余剰が 0 以下、またはデータが無い場合に「算出不可」となる。
	MonthsToReach    int
	HasMonthsToReach bool
}

type DashboardUsecase struct {
	accounts AccountRepository
	lendings LendingRepository
	wishes   WishRepository
	balances MonthlyBalanceRepository
}

func NewDashboardUsecase(
	accounts AccountRepository,
	lendings LendingRepository,
	wishes WishRepository,
	balances MonthlyBalanceRepository,
) *DashboardUsecase {
	return &DashboardUsecase{accounts: accounts, lendings: lendings, wishes: wishes, balances: balances}
}

// Get はダッシュボードを組み立てる（detailed-design 3.2.4）。
//
// 計算は必ず domain の関数を呼ぶ。ここで式を再実装しない（不変条件8）。
func (u *DashboardUsecase) Get(ctx context.Context) (Dashboard, error) {
	accounts, err := u.accounts.List(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	// 未回収のみ。回収済みの立替は実質資産に足さない。
	lendings, err := u.lendings.List(ctx, true)
	if err != nil {
		return Dashboard{}, err
	}
	wishes, err := u.wishes.List(ctx, nil)
	if err != nil {
		return Dashboard{}, err
	}
	balances, err := u.balances.ListRecent(ctx, domain.AverageSurplusMonths)
	if err != nil {
		return Dashboard{}, err
	}

	breakdown := domain.CalculateBreakdown(accounts, lendings, wishes)
	netAsset := breakdown.NetAsset()
	avgSurplus, hasAvg := domain.AverageSurplus(balances, domain.AverageSurplusMonths)

	dashboardWishes := make([]DashboardWish, 0, len(wishes))
	for _, w := range wishes {
		// 終わったもの・やめたものは並べない（detailed-design 6.1）。
		if w.Status.IsTerminal() {
			continue
		}

		shortfall := domain.CalculateShortfall(w, netAsset)
		months, ok := domain.MonthsToReach(shortfall, avgSurplus)

		dashboardWishes = append(dashboardWishes, DashboardWish{
			Wish:             w,
			Shortfall:        shortfall,
			MonthsToReach:    months,
			HasMonthsToReach: ok,
		})
	}

	return Dashboard{
		Breakdown:         breakdown,
		NetAsset:          netAsset,
		InvestmentTotal:   domain.CalculateInvestmentTotal(accounts),
		AverageSurplus:    avgSurplus,
		HasAverageSurplus: hasAvg,
		Wishes:            dashboardWishes,
	}, nil
}
