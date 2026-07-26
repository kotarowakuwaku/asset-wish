package domain

import "github.com/google/uuid"

type MonthlyBalance struct {
	ID        uuid.UUID
	YearMonth YearMonth
	Income    Money
	Expense   Money
}

// NewMonthlyBalance は月次収支を生成する。
// ym がゼロ値なら ErrInvalidYearMonth、income または expense が負なら ErrNegativeAmount。
func NewMonthlyBalance(id uuid.UUID, ym YearMonth, income, expense Money) (MonthlyBalance, error) {
	if ym.IsZero() {
		return MonthlyBalance{}, ErrInvalidYearMonth
	}
	if income.IsNegative() {
		return MonthlyBalance{}, ErrNegativeAmount
	}
	if expense.IsNegative() {
		return MonthlyBalance{}, ErrNegativeAmount
	}
	return MonthlyBalance{
		ID:        id,
		YearMonth: ym,
		Income:    income,
		Expense:   expense,
	}, nil
}

// Surplus は月間余剰を返す。負値なら赤字。
func (m MonthlyBalance) Surplus() Money {
	return m.Income.Sub(m.Expense)
}

func (m MonthlyBalance) IsSurplus() bool { return m.Surplus().IsPositive() }
func (m MonthlyBalance) IsDeficit() bool { return m.Surplus().IsNegative() }
