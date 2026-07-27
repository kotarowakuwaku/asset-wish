package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/handler"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

var fixedNow = time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)

type stubs struct {
	accounts     *stubAccounts
	lendings     *stubLendings
	wishes       *stubWishes
	balances     *stubBalances
	transactions *stubTransactions
	dashboard    *stubDashboard
}

// newServer は認証を通した状態の経路を返す。
// 認証そのものは middleware_test.go で確かめる。
func newServer(t *testing.T) (http.Handler, *stubs) {
	t.Helper()

	s := &stubs{
		accounts:     &stubAccounts{},
		lendings:     &stubLendings{},
		wishes:       &stubWishes{},
		balances:     &stubBalances{},
		transactions: &stubTransactions{},
		dashboard:    &stubDashboard{},
	}

	h := handler.New(
		s.accounts, s.lendings, s.wishes, s.balances, s.transactions, s.dashboard,
		func() time.Time { return fixedNow },
	)
	return h.Routes(), s
}

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()

	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("レスポンスを解釈できない: %v\nbody=%s", err, rec.Body.String())
	}
}

func assertStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()

	if rec.Code != want {
		t.Fatalf("status=%d want %d\nbody=%s", rec.Code, want, rec.Body.String())
	}
}

// assertErrorCode はエラー本文の code を確かめる。
// クライアントは code で分岐するため、メッセージより重要。
func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()

	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decode(t, rec, &body)

	if body.Error.Code != want {
		t.Errorf("code=%q want %q", body.Error.Code, want)
	}
	if body.Error.Message == "" {
		t.Error("message が空")
	}
}

func TestListAccounts(t *testing.T) {
	h, s := newServer(t)

	// 60日前に更新された残高は古い扱いになる。
	stale := fixedNow.AddDate(0, 0, -60)
	s.accounts.listFn = func(ctx context.Context) ([]domain.Account, error) {
		return []domain.Account{
			{ID: uuid.New(), Name: "生活用", Kind: domain.AccountKindCash, Balance: 500000, UpdatedAt: fixedNow},
			{ID: uuid.New(), Name: "証券", Kind: domain.AccountKindInvestment, Balance: 350000, UpdatedAt: stale},
		}, nil
	}

	rec := do(t, h, http.MethodGet, "/api/accounts", "")
	assertStatus(t, rec, http.StatusOK)

	var got []struct {
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Balance int64  `json:"balance"`
		IsStale bool   `json:"isStale"`
	}
	decode(t, rec, &got)

	if len(got) != 2 {
		t.Fatalf("2件のはず: got %d", len(got))
	}
	if got[0].Balance != 500000 || got[0].IsStale {
		t.Errorf("1件目が合わない: %+v", got[0])
	}
	if !got[1].IsStale {
		t.Error("60日前の残高は古い扱いのはず")
	}
	if got[1].Kind != "investment" {
		t.Errorf("kind=%q want investment", got[1].Kind)
	}
}

// TestListEmptyReturnsArray は、0件のときに null ではなく [] を返すことを
// 確かめる。null だとクライアント側で毎回 null 判定を書く羽目になる。
func TestListEmptyReturnsArray(t *testing.T) {
	h, _ := newServer(t)

	for _, path := range []string{
		"/api/accounts", "/api/lendings", "/api/wishes",
		"/api/monthly-balances", "/api/transactions",
	} {
		t.Run(path, func(t *testing.T) {
			rec := do(t, h, http.MethodGet, path, "")
			assertStatus(t, rec, http.StatusOK)

			if body := strings.TrimSpace(rec.Body.String()); body != "[]" {
				t.Errorf("body=%s want []", body)
			}
		})
	}
}

func TestCreateAccount(t *testing.T) {
	h, s := newServer(t)
	s.accounts.createFn = func(ctx context.Context, name string, kind domain.AccountKind, balance domain.Money) (domain.Account, error) {
		return domain.Account{ID: uuid.New(), Name: name, Kind: kind, Balance: balance, UpdatedAt: fixedNow}, nil
	}

	rec := do(t, h, http.MethodPost, "/api/accounts",
		`{"name":"生活用","kind":"cash","balance":500000}`)
	assertStatus(t, rec, http.StatusCreated)

	var got struct {
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Balance int64  `json:"balance"`
	}
	decode(t, rec, &got)
	if got.Name != "生活用" || got.Kind != "cash" || got.Balance != 500000 {
		t.Errorf("値が合わない: %+v", got)
	}
}

// TestUpdateAccountRejectsKind は、口座種別を送ると 400 になることを
// 確かめる。
//
// 種別が変わると、その口座が実質資産の計算から丸ごと外れる（不変条件1）。
// 黙って無視すると「変えたつもりが変わっていない」になるため、
// 送れないと伝える。
func TestUpdateAccountRejectsKind(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPatch, "/api/accounts/"+uuid.New().String(),
		`{"name":"改名","kind":"investment"}`)
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_BODY")
}

// TestUpdateAccountPartial は、送った項目だけが usecase に渡ることを
// 確かめる。
func TestUpdateAccountPartial(t *testing.T) {
	h, s := newServer(t)

	rec := do(t, h, http.MethodPatch, "/api/accounts/"+uuid.New().String(), `{"balance":450000}`)
	assertStatus(t, rec, http.StatusOK)

	if s.accounts.gotUpdate.Name != nil {
		t.Error("送っていない name が渡っている")
	}
	if s.accounts.gotUpdate.Balance == nil || *s.accounts.gotUpdate.Balance != 450000 {
		t.Errorf("balance が渡っていない: %v", s.accounts.gotUpdate.Balance)
	}
}

func TestDeleteAccountReturnsNoContent(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodDelete, "/api/accounts/"+uuid.New().String(), "")
	assertStatus(t, rec, http.StatusNoContent)

	if rec.Body.Len() != 0 {
		t.Errorf("204 に本文を付けない: %s", rec.Body.String())
	}
}

func TestInvalidPathID(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodDelete, "/api/accounts/not-a-uuid", "")
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_ID")
}

// TestListLendingsOutstandingFilter は ?outstanding=true の扱いを確かめる。
func TestListLendingsOutstandingFilter(t *testing.T) {
	tests := []struct {
		query string
		want  bool
	}{
		{"", false},
		{"?outstanding=true", true},
		{"?outstanding=false", false},
	}

	for _, tt := range tests {
		t.Run("query="+tt.query, func(t *testing.T) {
			h, s := newServer(t)
			rec := do(t, h, http.MethodGet, "/api/lendings"+tt.query, "")
			assertStatus(t, rec, http.StatusOK)

			if s.lendings.gotOutstandingOnly != tt.want {
				t.Errorf("outstandingOnly=%v want %v", s.lendings.gotOutstandingOnly, tt.want)
			}
		})
	}
}

// TestLendingResponseIncludesDerived は、導出値がレスポンスに含まれることを
// 確かめる（detailed-design 6.3）。DB は collectedAmount しか持たない。
func TestLendingResponseIncludesDerived(t *testing.T) {
	h, s := newServer(t)
	s.lendings.listFn = func(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error) {
		return []domain.Lending{{
			ID: uuid.New(), Counterparty: "友人A", Description: "チケット代",
			Amount: 12000, CollectedAmount: 5000,
			OccurredOn: time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC),
		}}, nil
	}

	rec := do(t, h, http.MethodGet, "/api/lendings", "")
	assertStatus(t, rec, http.StatusOK)

	var got []struct {
		Amount          int64  `json:"amount"`
		CollectedAmount int64  `json:"collectedAmount"`
		Outstanding     int64  `json:"outstanding"`
		Status          string `json:"status"`
		OccurredOn      string `json:"occurredOn"`
	}
	decode(t, rec, &got)

	if len(got) != 1 {
		t.Fatalf("1件のはず: got %d", len(got))
	}
	if got[0].Outstanding != 7000 {
		t.Errorf("outstanding=%d want 7000", got[0].Outstanding)
	}
	if got[0].Status != "partial" {
		t.Errorf("status=%q want partial", got[0].Status)
	}
	if got[0].OccurredOn != "2026-07-12" {
		t.Errorf("occurredOn=%q want 2026-07-12", got[0].OccurredOn)
	}
}

func TestCreateLendingInvalidDate(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPost, "/api/lendings",
		`{"counterparty":"友人A","description":"","amount":12000,"occurredOn":"2026/07/12","accountId":"`+uuid.New().String()+`"}`)
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_DATE")
}

func TestCreateLendingInvalidAccountID(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPost, "/api/lendings",
		`{"counterparty":"友人A","description":"","amount":12000,"occurredOn":"2026-07-12","accountId":"xxx"}`)
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_ID")
}

func TestListWishesStatusFilter(t *testing.T) {
	h, s := newServer(t)

	rec := do(t, h, http.MethodGet, "/api/wishes?status=committed", "")
	assertStatus(t, rec, http.StatusOK)

	if s.wishes.gotStatus == nil || *s.wishes.gotStatus != domain.WishCommitted {
		t.Errorf("status が渡っていない: %v", s.wishes.gotStatus)
	}
}

// TestListWishesRejectsUnknownStatus は、存在しない状態での絞り込みを
// 400 にすることを確かめる。空配列を返すと、絞り込めているように見える。
func TestListWishesRejectsUnknownStatus(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodGet, "/api/wishes?status=archived", "")
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_WISH_STATUS")
}

// TestUpdateWishRejectsStatus は、PATCH で status を送ると 400 になることを
// 確かめる（detailed-design 6.4）。
//
// 状態遷移は /commit /pay /drop の専用経路に限る。ここが通ると、
// 遷移の可否を判定する domain のメソッドを迂回できてしまう（不変条件6）。
func TestUpdateWishRejectsStatus(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPatch, "/api/wishes/"+uuid.New().String(),
		`{"title":"カメラ","status":"committed"}`)
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_BODY")
}

// TestUpdateWishDeadline は deadline の3通りの指定を確かめる。
//
//	キーが無い    変更しない
//	null          期限を外す
//	"2026-12-31"  設定する
//
// null と「指定なし」を取り違えると、期限を外す操作が通らなくなる。
func TestUpdateWishDeadline(t *testing.T) {
	tests := []struct {
		name          string
		body          string
		wantClear     bool
		wantDeadline  string
		wantSpecified bool
	}{
		{name: "キーが無い", body: `{"title":"カメラ"}`},
		{name: "null で期限を外す", body: `{"deadline":null}`, wantClear: true},
		{name: "日付を設定", body: `{"deadline":"2026-12-31"}`, wantDeadline: "2026-12-31", wantSpecified: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, s := newServer(t)

			rec := do(t, h, http.MethodPatch, "/api/wishes/"+uuid.New().String(), tt.body)
			assertStatus(t, rec, http.StatusOK)

			got := s.wishes.gotUpdate
			if got.ClearDeadline != tt.wantClear {
				t.Errorf("ClearDeadline=%v want %v", got.ClearDeadline, tt.wantClear)
			}
			if tt.wantSpecified {
				if got.Deadline == nil {
					t.Fatal("Deadline が渡っていない")
				}
				if formatted := got.Deadline.Format("2006-01-02"); formatted != tt.wantDeadline {
					t.Errorf("Deadline=%s want %s", formatted, tt.wantDeadline)
				}
			} else if got.Deadline != nil {
				t.Errorf("Deadline が渡っている: %v", *got.Deadline)
			}
		})
	}
}

func TestUpdateWishInvalidDeadline(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPatch, "/api/wishes/"+uuid.New().String(), `{"deadline":12345}`)
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_DATE")
}

// TestWishTransitionEndpoints は遷移系の経路が通ることを確かめる。
func TestWishTransitionEndpoints(t *testing.T) {
	id := uuid.New()

	tests := []struct {
		path string
		body string
	}{
		{path: "/commit"},
		{path: "/drop"},
		{path: "/pay", body: `{"accountId":"` + uuid.New().String() + `","occurredOn":"2026-07-20"}`},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			h, s := newServer(t)
			s.wishes.commitFn = func(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
				return domain.Wish{ID: id, Title: "カメラ", Amount: 120000,
					Category: domain.WishCategoryItem, Status: domain.WishCommitted}, nil
			}

			rec := do(t, h, http.MethodPost, "/api/wishes/"+id.String()+tt.path, tt.body)
			assertStatus(t, rec, http.StatusOK)
		})
	}
}

func TestUpsertMonthlyBalance(t *testing.T) {
	h, s := newServer(t)
	s.balances.upsertFn = func(ctx context.Context, ym domain.YearMonth, income, expense domain.Money) (domain.MonthlyBalance, error) {
		return domain.MonthlyBalance{ID: uuid.New(), YearMonth: ym, Income: income, Expense: expense}, nil
	}

	rec := do(t, h, http.MethodPut, "/api/monthly-balances/2026-07", `{"income":320000,"expense":255000}`)
	assertStatus(t, rec, http.StatusOK)

	var got struct {
		YearMonth string `json:"yearMonth"`
		Income    int64  `json:"income"`
		Expense   int64  `json:"expense"`
		Surplus   int64  `json:"surplus"`
	}
	decode(t, rec, &got)

	if got.YearMonth != "2026-07" {
		t.Errorf("yearMonth=%q want 2026-07", got.YearMonth)
	}
	// surplus は導出値。クライアントは符号で黒字・赤字を判定する。
	if got.Surplus != 65000 {
		t.Errorf("surplus=%d want 65000", got.Surplus)
	}
}

// TestUpsertMonthlyBalanceYearMonthErrors は、形式の誤り（400）と
// 値の誤り（422）を区別することを確かめる（detailed-design 6.5）。
func TestUpsertMonthlyBalanceYearMonthErrors(t *testing.T) {
	tests := []struct {
		name       string
		yearMonth  string
		wantStatus int
		wantCode   string
	}{
		{"区切りが違う", "2026%2F07", http.StatusBadRequest, "INVALID_YEAR_MONTH"},
		{"桁が足りない", "2026-7", http.StatusBadRequest, "INVALID_YEAR_MONTH"},
		{"数字でない", "20xx-07", http.StatusBadRequest, "INVALID_YEAR_MONTH"},
		{"13月は範囲外", "2026-13", http.StatusUnprocessableEntity, "INVALID_YEAR_MONTH"},
		{"0月は範囲外", "2026-00", http.StatusUnprocessableEntity, "INVALID_YEAR_MONTH"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, _ := newServer(t)

			rec := do(t, h, http.MethodPut, "/api/monthly-balances/"+tt.yearMonth,
				`{"income":1,"expense":1}`)
			assertStatus(t, rec, tt.wantStatus)
			assertErrorCode(t, rec, tt.wantCode)
		})
	}
}

func TestListTransactionsLimit(t *testing.T) {
	h, s := newServer(t)

	rec := do(t, h, http.MethodGet, "/api/transactions?limit=5", "")
	assertStatus(t, rec, http.StatusOK)
	if s.transactions.gotLimit != 5 {
		t.Errorf("limit=%d want 5", s.transactions.gotLimit)
	}

	rec = do(t, h, http.MethodGet, "/api/transactions?limit=-1", "")
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_LIMIT")
}

// TestDashboardResponse はダッシュボードの JSON の形を確かめる
// （detailed-design 6.1）。
func TestDashboardResponse(t *testing.T) {
	h, s := newServer(t)
	s.dashboard.getFn = func(ctx context.Context) (usecase.Dashboard, error) {
		return usecase.Dashboard{
			Breakdown: domain.NetAssetBreakdown{
				CashTotal: 910000, OutstandingLendings: 12000, Commitments: 80000,
			},
			NetAsset:          842000,
			InvestmentTotal:   350000,
			AverageSurplus:    65000,
			HasAverageSurplus: true,
			Wishes: []usecase.DashboardWish{
				{
					Wish:             domain.Wish{ID: uuid.New(), Title: "カメラ", Amount: 1200000, Category: domain.WishCategoryItem, Status: domain.WishConsidering},
					Shortfall:        358000,
					MonthsToReach:    6,
					HasMonthsToReach: true,
				},
				{
					Wish:             domain.Wish{ID: uuid.New(), Title: "旅行", Amount: 300000, Category: domain.WishCategoryExperience, Status: domain.WishCommitted},
					Shortfall:        -1000,
					HasMonthsToReach: false,
				},
			},
		}, nil
	}

	rec := do(t, h, http.MethodGet, "/api/dashboard", "")
	assertStatus(t, rec, http.StatusOK)

	var got struct {
		NetAsset  int64 `json:"netAsset"`
		Breakdown struct {
			CashTotal           int64 `json:"cashTotal"`
			OutstandingLendings int64 `json:"outstandingLendings"`
			Commitments         int64 `json:"commitments"`
		} `json:"breakdown"`
		InvestmentTotal   int64 `json:"investmentTotal"`
		AverageSurplus    int64 `json:"averageSurplus"`
		HasAverageSurplus bool  `json:"hasAverageSurplus"`
		Wishes            []struct {
			Title         string `json:"title"`
			Shortfall     int64  `json:"shortfall"`
			MonthsToReach *int   `json:"monthsToReach"`
		} `json:"wishes"`
	}
	decode(t, rec, &got)

	if got.NetAsset != 842000 || got.InvestmentTotal != 350000 {
		t.Errorf("金額が合わない: %+v", got)
	}
	if got.Breakdown.CashTotal != 910000 || got.Breakdown.Commitments != 80000 {
		t.Errorf("内訳が合わない: %+v", got.Breakdown)
	}
	if !got.HasAverageSurplus || got.AverageSurplus != 65000 {
		t.Errorf("平均月間余剰が合わない: %+v", got)
	}

	if len(got.Wishes) != 2 {
		t.Fatalf("2件のはず: got %d", len(got.Wishes))
	}
	if got.Wishes[0].MonthsToReach == nil || *got.Wishes[0].MonthsToReach != 6 {
		t.Errorf("monthsToReach=%v want 6", got.Wishes[0].MonthsToReach)
	}
	// 算出不可は null。0 を返すと「今月中に届く」と誤読される。
	if got.Wishes[1].MonthsToReach != nil {
		t.Errorf("算出不可は null のはず: %v", *got.Wishes[1].MonthsToReach)
	}
}

// TestUnknownRouteAndMethod は、経路とメソッドの取り違えを確かめる。
func TestUnknownRouteAndMethod(t *testing.T) {
	h, _ := newServer(t)

	if rec := do(t, h, http.MethodGet, "/api/unknown", ""); rec.Code != http.StatusNotFound {
		t.Errorf("未知の経路 status=%d want 404", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/api/dashboard", "{}"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("メソッド違い status=%d want 405", rec.Code)
	}
}

func TestEmptyBodyIsRejected(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodPost, "/api/accounts", "")
	assertStatus(t, rec, http.StatusBadRequest)
	assertErrorCode(t, rec, "INVALID_BODY")
}
