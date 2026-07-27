package repository_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/dbtest"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// repository 層のテストは実物の PostgreSQL に対して行う。
//
// この層の仕事は sqlc 生成型とドメイン型の詰め替えなので、fake で
// 代替すると検証したいものが消える。NULL の往復、DATE と YearMonth の
// 変換、トランザクションの巻き戻りは、実物でしか確かめられない。
//
// domain の計算ロジックはここでは扱わない。DB 不要で回る
// internal/domain のテストが担当する（不変条件8）。
//
// 値はすべて架空のもの（不変条件17）。

func newStore(t *testing.T) (*repository.Store, *sql.DB, context.Context) {
	t.Helper()

	conn := dbtest.Setup(t)
	return repository.NewStore(conn), conn, context.Background()
}

func date(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func newAccount(t *testing.T, name string, kind domain.AccountKind, balance domain.Money) domain.Account {
	t.Helper()

	a, err := domain.NewAccount(uuid.New(), name, kind, balance, date(2026, time.July, 1))
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	return a
}

func newLending(t *testing.T, counterparty string, amount domain.Money) domain.Lending {
	t.Helper()

	l, err := domain.NewLending(uuid.New(), counterparty, "立替", amount, date(2026, time.June, 10))
	if err != nil {
		t.Fatalf("NewLending: %v", err)
	}
	return l
}

func newWish(t *testing.T, title string, amount domain.Money, deadline *time.Time) domain.Wish {
	t.Helper()

	w, err := domain.NewWish(uuid.New(), title, amount, domain.WishCategoryItem, 1, deadline)
	if err != nil {
		t.Fatalf("NewWish: %v", err)
	}
	return w
}

func newMonthlyBalance(t *testing.T, year int, month time.Month, income, expense domain.Money) domain.MonthlyBalance {
	t.Helper()

	ym, err := domain.NewYearMonth(year, month)
	if err != nil {
		t.Fatalf("NewYearMonth: %v", err)
	}
	m, err := domain.NewMonthlyBalance(uuid.New(), ym, income, expense)
	if err != nil {
		t.Fatalf("NewMonthlyBalance: %v", err)
	}
	return m
}
