package usecase_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// 値はすべて架空のもの（不変条件17）。

// fixedNow は時刻を固定する。実時刻に依存したテストは、日付が
// 変わった瞬間に理由もなく落ちる。
var fixedNow = time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)

type harness struct {
	data      *fakeData
	accounts  *usecase.AccountUsecase
	lendings  *usecase.LendingUsecase
	wishes    *usecase.WishUsecase
	balances  *usecase.MonthlyBalanceUsecase
	dashboard *usecase.DashboardUsecase
	ctx       context.Context
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	data := newFakeData()
	tx := &fakeTx{data: data}
	accounts := &fakeAccounts{data: data}
	lendings := &fakeLendings{data: data}
	wishes := &fakeWishes{data: data}
	balances := &fakeBalances{data: data}
	transactions := &fakeTransactions{data: data}

	now := func() time.Time { return fixedNow }
	newID := func() uuid.UUID { return uuid.New() }

	return &harness{
		data:      data,
		accounts:  usecase.NewAccountUsecase(accounts, now, newID),
		lendings:  usecase.NewLendingUsecase(tx, lendings, accounts, transactions, now, newID),
		wishes:    usecase.NewWishUsecase(tx, wishes, accounts, transactions, now, newID),
		balances:  usecase.NewMonthlyBalanceUsecase(balances, newID),
		dashboard: usecase.NewDashboardUsecase(accounts, lendings, wishes, balances),
		ctx:       context.Background(),
	}
}

// seedAccount は口座を直接置く。usecase を経由しないのは、
// テストの前提づくりで検証対象の手順を巻き込まないため。
func (h *harness) seedAccount(t *testing.T, name string, kind domain.AccountKind, balance domain.Money) domain.Account {
	t.Helper()

	a, err := domain.NewAccount(uuid.New(), name, kind, balance, fixedNow)
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	h.data.accounts[a.ID] = a
	return a
}

func (h *harness) seedLending(t *testing.T, counterparty string, amount, collected domain.Money) domain.Lending {
	t.Helper()

	l, err := domain.NewLending(uuid.New(), counterparty, "立替", amount, date(2026, time.June, 10))
	if err != nil {
		t.Fatalf("NewLending: %v", err)
	}
	if collected > 0 {
		if err := l.Collect(collected); err != nil {
			t.Fatalf("Collect: %v", err)
		}
	}
	h.data.lendings[l.ID] = l
	return l
}

func (h *harness) seedWish(t *testing.T, title string, amount domain.Money, status domain.WishStatus) domain.Wish {
	t.Helper()

	w, err := domain.NewWish(uuid.New(), title, amount, domain.WishCategoryItem, 1, nil)
	if err != nil {
		t.Fatalf("NewWish: %v", err)
	}
	w.Status = status
	h.data.wishes[w.ID] = w
	return w
}

func (h *harness) seedBalance(t *testing.T, year int, month time.Month, income, expense domain.Money) {
	t.Helper()

	ym, err := domain.NewYearMonth(year, month)
	if err != nil {
		t.Fatalf("NewYearMonth: %v", err)
	}
	m, err := domain.NewMonthlyBalance(uuid.New(), ym, income, expense)
	if err != nil {
		t.Fatalf("NewMonthlyBalance: %v", err)
	}
	h.data.balances[ym.String()] = m
}

// netAsset はいまの実質資産を domain の関数で算出する。
// テスト側で式を書き写すと、実装と同じ間違いをしても気付けない。
func (h *harness) netAsset(t *testing.T) domain.Money {
	t.Helper()

	accounts, err := (&fakeAccounts{data: h.data}).List(h.ctx)
	if err != nil {
		t.Fatalf("List(accounts): %v", err)
	}
	lendings, err := (&fakeLendings{data: h.data}).List(h.ctx, true)
	if err != nil {
		t.Fatalf("List(lendings): %v", err)
	}
	wishes, err := (&fakeWishes{data: h.data}).List(h.ctx, nil)
	if err != nil {
		t.Fatalf("List(wishes): %v", err)
	}
	return domain.CalculateBreakdown(accounts, lendings, wishes).NetAsset()
}

func (h *harness) account(t *testing.T, id uuid.UUID) domain.Account {
	t.Helper()

	a, ok := h.data.accounts[id]
	if !ok {
		t.Fatalf("口座が見つからない: %s", id)
	}
	return a
}

func (h *harness) lending(t *testing.T, id uuid.UUID) domain.Lending {
	t.Helper()

	l, ok := h.data.lendings[id]
	if !ok {
		t.Fatalf("立替が見つからない: %s", id)
	}
	return l
}

func (h *harness) wish(t *testing.T, id uuid.UUID) domain.Wish {
	t.Helper()

	w, ok := h.data.wishes[id]
	if !ok {
		t.Fatalf("ウィッシュが見つからない: %s", id)
	}
	return w
}

func date(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
