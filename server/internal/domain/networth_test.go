package domain_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// テスト用ヘルパー。ドメインの生成経路（コンストラクタ）を通しつつ、
// 検証本体に不要なフィールド（ID/名前/日時など）はコード量を減らす。

func acct(kind domain.AccountKind, balance domain.Money) domain.Account {
	a, _ := domain.NewAccount(uuid.New(), "test", kind, balance, time.Now())
	return a
}

func lend(amount, collected domain.Money) domain.Lending {
	l, _ := domain.NewLending(uuid.New(), "test", "", amount, time.Now())
	l.CollectedAmount = collected
	return l
}

func wish(amount domain.Money, status domain.WishStatus) domain.Wish {
	w, _ := domain.NewWish(uuid.New(), "test", amount, domain.WishCategoryItem, 0, nil)
	w.Status = status
	return w
}

func mb(t *testing.T, y int, m time.Month, income, expense domain.Money) domain.MonthlyBalance {
	t.Helper()
	ym, err := domain.NewYearMonth(y, m)
	if err != nil {
		t.Fatalf("NewYearMonth: %v", err)
	}
	b, err := domain.NewMonthlyBalance(uuid.New(), ym, income, expense)
	if err != nil {
		t.Fatalf("NewMonthlyBalance: %v", err)
	}
	return b
}

func TestCalculateBreakdown(t *testing.T) {
	cash := domain.AccountKindCash
	inv := domain.AccountKindInvestment

	tests := []struct {
		name       string
		accounts   []domain.Account
		lendings   []domain.Lending
		wishes     []domain.Wish
		wantCash   domain.Money
		wantLent   domain.Money
		wantCommit domain.Money
		wantNet    domain.Money
	}{
		{
			name:     "A-1: cash only",
			accounts: []domain.Account{acct(cash, 500_000), acct(cash, 300_000)},
			wantCash: 800_000, wantNet: 800_000,
		},
		{
			name:     "A-2: investment excluded",
			accounts: []domain.Account{acct(cash, 500_000), acct(inv, 400_000)},
			wantCash: 500_000, wantNet: 500_000,
		},
		{
			name:     "A-3: outstanding lending added",
			accounts: []domain.Account{acct(cash, 500_000)},
			lendings: []domain.Lending{lend(12_000, 0)},
			wantCash: 500_000, wantLent: 12_000, wantNet: 512_000,
		},
		{
			name:     "A-4: partially collected lending",
			accounts: []domain.Account{acct(cash, 500_000)},
			lendings: []domain.Lending{lend(12_000, 5_000)},
			wantCash: 500_000, wantLent: 7_000, wantNet: 507_000,
		},
		{
			name:     "A-5: fully collected lending",
			accounts: []domain.Account{acct(cash, 500_000)},
			lendings: []domain.Lending{lend(12_000, 12_000)},
			wantCash: 500_000, wantLent: 0, wantNet: 500_000,
		},
		{
			name:       "A-6: committed wish deducted",
			accounts:   []domain.Account{acct(cash, 500_000)},
			wishes:     []domain.Wish{wish(80_000, domain.WishCommitted)},
			wantCash:   500_000,
			wantCommit: 80_000,
			wantNet:    420_000,
		},
		{
			name:     "A-7: considering wish NOT deducted",
			accounts: []domain.Account{acct(cash, 500_000)},
			wishes:   []domain.Wish{wish(80_000, domain.WishConsidering)},
			wantCash: 500_000, wantNet: 500_000,
		},
		{
			name:     "A-8: done wish NOT deducted",
			accounts: []domain.Account{acct(cash, 500_000)},
			wishes:   []domain.Wish{wish(80_000, domain.WishDone)},
			wantCash: 500_000, wantNet: 500_000,
		},
		{
			name:     "A-9: dropped wish NOT deducted",
			accounts: []domain.Account{acct(cash, 500_000)},
			wishes:   []domain.Wish{wish(80_000, domain.WishDropped)},
			wantCash: 500_000, wantNet: 500_000,
		},
		{
			name: "A-10: all nil",
		},
		{
			name:     "A-11: combined dashboard example",
			accounts: []domain.Account{acct(cash, 910_000), acct(inv, 350_000)},
			lendings: []domain.Lending{lend(12_000, 0)},
			wishes:   []domain.Wish{wish(80_000, domain.WishCommitted)},
			wantCash: 910_000, wantLent: 12_000, wantCommit: 80_000, wantNet: 842_000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := domain.CalculateBreakdown(tt.accounts, tt.lendings, tt.wishes)
			if b.CashTotal != tt.wantCash {
				t.Errorf("CashTotal=%d want %d", b.CashTotal, tt.wantCash)
			}
			if b.OutstandingLendings != tt.wantLent {
				t.Errorf("OutstandingLendings=%d want %d", b.OutstandingLendings, tt.wantLent)
			}
			if b.Commitments != tt.wantCommit {
				t.Errorf("Commitments=%d want %d", b.Commitments, tt.wantCommit)
			}
			if got := b.NetAsset(); got != tt.wantNet {
				t.Errorf("NetAsset()=%d want %d", got, tt.wantNet)
			}
		})
	}
}

func TestCalculateInvestmentTotal(t *testing.T) {
	accounts := []domain.Account{
		acct(domain.AccountKindCash, 500_000),
		acct(domain.AccountKindInvestment, 350_000),
		acct(domain.AccountKindInvestment, 100_000),
	}
	if got := domain.CalculateInvestmentTotal(accounts); got != 450_000 {
		t.Errorf("got %d want 450000", got)
	}
	if got := domain.CalculateInvestmentTotal(nil); got != 0 {
		t.Errorf("nil case: got %d want 0", got)
	}
}

func TestAverageSurplus(t *testing.T) {
	t.Run("B-1: three months averaged", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.May, 300_000, 240_000),  // +60k
			mb(t, 2026, time.June, 300_000, 250_000), // +50k
			mb(t, 2026, time.July, 300_000, 230_000), // +70k
		}
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != 60_000 {
			t.Errorf("got=%d ok=%v want 60000 true", got, ok)
		}
	})

	t.Run("B-2: two months when only two available", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.June, 300_000, 250_000), // +50k
			mb(t, 2026, time.July, 300_000, 230_000), // +70k
		}
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != 60_000 {
			t.Errorf("got=%d ok=%v want 60000 true", got, ok)
		}
	})

	t.Run("B-3: empty slice", func(t *testing.T) {
		if _, ok := domain.AverageSurplus(nil, 3); ok {
			t.Error("ok=true; want false")
		}
	})

	t.Run("B-4: only recent 3 of 4 months", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.April, 300_000, 300_000), // +0 (should be excluded)
			mb(t, 2026, time.May, 300_000, 240_000),   // +60k
			mb(t, 2026, time.June, 300_000, 250_000),  // +50k
			mb(t, 2026, time.July, 300_000, 230_000),  // +70k
		}
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != 60_000 {
			t.Errorf("got=%d ok=%v want 60000 true", got, ok)
		}
	})

	t.Run("B-5: shuffled input, internal sort", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.July, 300_000, 230_000),
			mb(t, 2026, time.May, 300_000, 240_000),
			mb(t, 2026, time.June, 300_000, 250_000),
		}
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != 60_000 {
			t.Errorf("got=%d ok=%v want 60000 true", got, ok)
		}
	})

	t.Run("B-6: single deficit month returns negative", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.July, 200_000, 250_000),
		}
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != -50_000 {
			t.Errorf("got=%d ok=%v want -50000 true", got, ok)
		}
	})

	t.Run("B-7: non-divisible sum truncates toward zero", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.May, 300_000, 239_000),  // +61k
			mb(t, 2026, time.June, 300_000, 250_000), // +50k
			mb(t, 2026, time.July, 300_000, 230_000), // +70k
		}
		// sum = 181000, 181000 / 3 = 60333.33 → 60333
		got, ok := domain.AverageSurplus(bals, 3)
		if !ok || got != 60_333 {
			t.Errorf("got=%d ok=%v want 60333 true", got, ok)
		}
	})

	t.Run("B-8: input slice is not mutated", func(t *testing.T) {
		bals := []domain.MonthlyBalance{
			mb(t, 2026, time.July, 300_000, 230_000),
			mb(t, 2026, time.May, 300_000, 240_000),
			mb(t, 2026, time.June, 300_000, 250_000),
		}
		orig := make([]domain.YearMonth, len(bals))
		for i, b := range bals {
			orig[i] = b.YearMonth
		}
		_, _ = domain.AverageSurplus(bals, 3)
		for i, b := range bals {
			if !b.YearMonth.Equal(orig[i]) {
				t.Errorf("input mutated at [%d]: got %s want %s", i, b.YearMonth, orig[i])
			}
		}
	})
}

func TestMonthsToReach(t *testing.T) {
	tests := []struct {
		name       string
		shortfall  domain.Money
		avgSurplus domain.Money
		wantN      int
		wantOK     bool
	}{
		{"C-1: divides evenly", 600_000, 100_000, 6, true},
		{"C-2: rounds up when non-divisible", 620_000, 100_000, 7, true},
		{"C-3: shortfall=1", 1, 100_000, 1, true},
		{"C-4: exact one month", 100_000, 100_000, 1, true},
		{"C-5: slightly over one month", 100_001, 100_000, 2, true},
		{"C-6: shortfall=0 (achieved)", 0, 100_000, 0, false},
		{"C-7: shortfall<0 (achieved)", -50_000, 100_000, 0, false},
		{"C-8: avgSurplus=0", 600_000, 0, 0, false},
		{"C-9: avgSurplus<0", 600_000, -30_000, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n, ok := domain.MonthsToReach(tt.shortfall, tt.avgSurplus)
			if n != tt.wantN || ok != tt.wantOK {
				t.Errorf("got n=%d ok=%v want n=%d ok=%v", n, ok, tt.wantN, tt.wantOK)
			}
		})
	}
}

func TestCalculateShortfall(t *testing.T) {
	tests := []struct {
		name     string
		amount   domain.Money
		netAsset domain.Money
		want     domain.Money
	}{
		{"D-1: shortfall", 1_200_000, 842_000, 358_000},
		{"D-2: already achievable (negative)", 500_000, 842_000, -342_000},
		{"D-3: exactly matches (zero)", 842_000, 842_000, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := wish(tt.amount, domain.WishConsidering)
			if got := domain.CalculateShortfall(w, tt.netAsset); got != tt.want {
				t.Errorf("got %d want %d", got, tt.want)
			}
		})
	}
}
