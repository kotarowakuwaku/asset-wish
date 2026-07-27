package domain

import "slices"

// AverageSurplusMonths は平均月間余剰の算出に用いる遡及月数。
const AverageSurplusMonths = 3

// NetAssetBreakdown は実質資産の内訳。
// ダッシュボードで内訳表示するため、合計値だけでなく構成要素も保持する。
type NetAssetBreakdown struct {
	CashTotal           Money // 現金・預金の残高合計
	OutstandingLendings Money // 未回収立替の合計
	Commitments         Money // 確定支出の合計（正の値で保持）
}

// NetAsset は実質資産を返す。CashTotal + OutstandingLendings - Commitments。
// Commitments を正で保持して減算するのは、表示時に「確定支出: 80,000円」と出したいため。
// 符号反転を1箇所に閉じ込める。
func (b NetAssetBreakdown) NetAsset() Money {
	return b.CashTotal.Add(b.OutstandingLendings).Sub(b.Commitments)
}

// CalculateBreakdown は実質資産の内訳を算出する。
// 引数のスライスは変更しない。空スライス・nil はいずれも 0 として扱う。
//
// 不変条件:
//   - kind が investment の口座は CashTotal に含めない
//   - status が committed 以外のウィッシュは Commitments に含めない
//   - 立替は回収済みの分を除いた未回収残高のみを加算する
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

// CalculateInvestmentTotal は投資区分の口座の合計を返す。
// これは実質資産には含めず、参考値として別枠で表示する。
func CalculateInvestmentTotal(accounts []Account) Money {
	var total Money
	for _, a := range accounts {
		if a.Kind == AccountKindInvestment {
			total = total.Add(a.Balance)
		}
	}
	return total
}

// CalculateShortfall は不足額を返す。負値ならすでに達成可能。
// ウィッシュごとに独立して算出する。複数ウィッシュの合計とは比較しない。
func CalculateShortfall(wish Wish, netAsset Money) Money {
	return wish.Amount.Sub(netAsset)
}

// AverageSurplus は直近 months ヶ月の月間余剰の平均を返す。
//
// balances は年月の昇降順を問わない。関数内部でコピーして降順に整列するため、
// 引数のスライスは変更しない。件数が months 未満なら存在する分だけで平均する。
// 件数が 0 の場合は ok=false。
// 平均は整数除算（0方向への切り捨て）。
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

// MonthsToReach は目標到達までの月数を返す。切り上げ除算。
//
//	shortfall  <= 0 → ok=false（すでに達成可能）
//	avgSurplus <= 0 → ok=false（積み上がらないため到達しない）
//
// (a + b - 1) / b が正の整数に対する切り上げ除算。浮動小数点は経由しない。
func MonthsToReach(shortfall, avgSurplus Money) (int, bool) {
	if !shortfall.IsPositive() || !avgSurplus.IsPositive() {
		return 0, false
	}
	return int((shortfall + avgSurplus - 1) / avgSurplus), true
}
