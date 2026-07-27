package handler

import (
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// レスポンスのキーは lowerCamelCase、金額は整数（円）、日付は YYYY-MM-DD
// （detailed-design 6）。金額を文字列にしないのは、クライアント側で
// 数値として扱うため。JavaScript の安全な整数の範囲に十分収まる。

// dateLayout は日付のみの表現。
const dateLayout = "2006-01-02"

type accountResponse struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	Balance   int64     `json:"balance"`
	UpdatedAt time.Time `json:"updatedAt"`
	// IsStale は残高の更新を促すための導出値。
	IsStale bool `json:"isStale"`
}

func newAccountResponse(a domain.Account, now time.Time) accountResponse {
	return accountResponse{
		ID:        a.ID,
		Name:      a.Name,
		Kind:      string(a.Kind),
		Balance:   int64(a.Balance),
		UpdatedAt: a.UpdatedAt,
		IsStale:   a.IsStale(now, domain.StaleBalanceThreshold),
	}
}

type lendingResponse struct {
	ID           uuid.UUID `json:"id"`
	Counterparty string    `json:"counterparty"`
	Description  string    `json:"description"`
	Amount       int64     `json:"amount"`
	// CollectedAmount / Outstanding / Status のうち、DB が持つのは
	// CollectedAmount だけ。残りは導出値（不変条件12）。
	CollectedAmount int64  `json:"collectedAmount"`
	Outstanding     int64  `json:"outstanding"`
	Status          string `json:"status"`
	OccurredOn      string `json:"occurredOn"`
}

func newLendingResponse(l domain.Lending) lendingResponse {
	return lendingResponse{
		ID:              l.ID,
		Counterparty:    l.Counterparty,
		Description:     l.Description,
		Amount:          int64(l.Amount),
		CollectedAmount: int64(l.CollectedAmount),
		Outstanding:     int64(l.Outstanding()),
		Status:          string(l.Status()),
		OccurredOn:      l.OccurredOn.Format(dateLayout),
	}
}

type wishResponse struct {
	ID       uuid.UUID `json:"id"`
	Title    string    `json:"title"`
	Amount   int64     `json:"amount"`
	Category string    `json:"category"`
	Status   string    `json:"status"`
	Priority int       `json:"priority"`
	// Deadline は未設定なら null。
	Deadline *string `json:"deadline"`
}

func newWishResponse(w domain.Wish) wishResponse {
	return wishResponse{
		ID:       w.ID,
		Title:    w.Title,
		Amount:   int64(w.Amount),
		Category: string(w.Category),
		Status:   string(w.Status),
		Priority: w.Priority,
		Deadline: formatDatePtr(w.Deadline),
	}
}

type monthlyBalanceResponse struct {
	ID        uuid.UUID `json:"id"`
	YearMonth string    `json:"yearMonth"`
	Income    int64     `json:"income"`
	Expense   int64     `json:"expense"`
	// Surplus は導出値。クライアントは符号で黒字・赤字を判定する。
	Surplus int64 `json:"surplus"`
}

func newMonthlyBalanceResponse(m domain.MonthlyBalance) monthlyBalanceResponse {
	return monthlyBalanceResponse{
		ID:        m.ID,
		YearMonth: m.YearMonth.String(),
		Income:    int64(m.Income),
		Expense:   int64(m.Expense),
		Surplus:   int64(m.Surplus()),
	}
}

type transactionResponse struct {
	ID         uuid.UUID  `json:"id"`
	AccountID  uuid.UUID  `json:"accountId"`
	Amount     int64      `json:"amount"`
	Kind       string     `json:"kind"`
	RefID      *uuid.UUID `json:"refId"`
	OccurredOn string     `json:"occurredOn"`
}

func newTransactionResponse(t domain.Transaction) transactionResponse {
	return transactionResponse{
		ID:         t.ID,
		AccountID:  t.AccountID,
		Amount:     int64(t.Amount),
		Kind:       string(t.Kind),
		RefID:      t.RefID,
		OccurredOn: t.OccurredOn.Format(dateLayout),
	}
}

type dashboardResponse struct {
	NetAsset        int64             `json:"netAsset"`
	Breakdown       breakdownResponse `json:"breakdown"`
	InvestmentTotal int64             `json:"investmentTotal"`
	// AverageSurplus は HasAverageSurplus が false のとき 0 を返すが、
	// クライアントは表示しない（detailed-design 6.1）。
	AverageSurplus    int64              `json:"averageSurplus"`
	HasAverageSurplus bool               `json:"hasAverageSurplus"`
	Wishes            []dashboardWishRes `json:"wishes"`
}

type breakdownResponse struct {
	CashTotal           int64 `json:"cashTotal"`
	OutstandingLendings int64 `json:"outstandingLendings"`
	Commitments         int64 `json:"commitments"`
}

type dashboardWishRes struct {
	wishResponse
	Shortfall int64 `json:"shortfall"`
	// MonthsToReach は算出不可なら null。クライアントは null を
	// 「算出不可」と表示する。0 を返すと「今月中に届く」と誤読される。
	MonthsToReach *int `json:"monthsToReach"`
}

func newDashboardResponse(d usecase.Dashboard) dashboardResponse {
	wishes := make([]dashboardWishRes, 0, len(d.Wishes))
	for _, w := range d.Wishes {
		var months *int
		if w.HasMonthsToReach {
			m := w.MonthsToReach
			months = &m
		}
		wishes = append(wishes, dashboardWishRes{
			wishResponse:  newWishResponse(w.Wish),
			Shortfall:     int64(w.Shortfall),
			MonthsToReach: months,
		})
	}

	return dashboardResponse{
		NetAsset: int64(d.NetAsset),
		Breakdown: breakdownResponse{
			CashTotal:           int64(d.Breakdown.CashTotal),
			OutstandingLendings: int64(d.Breakdown.OutstandingLendings),
			Commitments:         int64(d.Breakdown.Commitments),
		},
		InvestmentTotal:   int64(d.InvestmentTotal),
		AverageSurplus:    int64(d.AverageSurplus),
		HasAverageSurplus: d.HasAverageSurplus,
		Wishes:            wishes,
	}
}

func formatDatePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(dateLayout)
	return &s
}

// parseDate は YYYY-MM-DD を UTC の 00:00 として解釈する。
// タイムゾーンを持ち込むと、DB の DATE 列との往復で日がずれる。
func parseDate(s string) (time.Time, error) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return time.Time{}, newBadRequest("INVALID_DATE", "日付は YYYY-MM-DD 形式で指定してください")
	}
	return t, nil
}
