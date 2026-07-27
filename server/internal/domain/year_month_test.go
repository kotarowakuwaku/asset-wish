package domain_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func TestYearMonth_NewYearMonth(t *testing.T) {
	tests := []struct {
		name  string
		year  int
		month time.Month
		want  string
		err   error
	}{
		{"G-1: valid 2026-07", 2026, time.July, "2026-07", nil},
		{"G-2: month 13", 2026, time.Month(13), "", domain.ErrInvalidYearMonth},
		{"G-3: month 0", 2026, time.Month(0), "", domain.ErrInvalidYearMonth},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ym, err := domain.NewYearMonth(tt.year, tt.month)
			if !errors.Is(err, tt.err) {
				t.Fatalf("err=%v want %v", err, tt.err)
			}
			if tt.err == nil {
				if got := ym.String(); got != tt.want {
					t.Errorf("String()=%q want %q", got, tt.want)
				}
			}
		})
	}
}

func TestYearMonth_ParseYearMonth(t *testing.T) {
	tests := []struct {
		name string
		in   string
		err  error
	}{
		{"G-4: 2026-07 ok", "2026-07", nil},
		{"G-5: 2026-7 (month must be 2 digits)", "2026-7", domain.ErrInvalidYearMonth},
		{"G-6: 2026/07 (separator differs)", "2026/07", domain.ErrInvalidYearMonth},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ym, err := domain.ParseYearMonth(tt.in)
			if !errors.Is(err, tt.err) {
				t.Fatalf("err=%v want %v", err, tt.err)
			}
			if tt.err == nil && ym.String() != tt.in {
				t.Errorf("round-trip mismatch: got %q want %q", ym.String(), tt.in)
			}
		})
	}
}

func TestYearMonth_AddMonths(t *testing.T) {
	t.Run("G-7: 2026-12 + 1 = 2027-01 (year rollover forward)", func(t *testing.T) {
		src, _ := domain.NewYearMonth(2026, time.December)
		want, _ := domain.NewYearMonth(2027, time.January)
		if got := src.AddMonths(1); !got.Equal(want) {
			t.Errorf("got %s want %s", got, want)
		}
	})
	t.Run("G-8: 2026-01 - 1 = 2025-12 (year rollover backward)", func(t *testing.T) {
		src, _ := domain.NewYearMonth(2026, time.January)
		want, _ := domain.NewYearMonth(2025, time.December)
		if got := src.AddMonths(-1); !got.Equal(want) {
			t.Errorf("got %s want %s", got, want)
		}
	})
}

func TestYearMonth_FirstDay(t *testing.T) {
	ym, _ := domain.NewYearMonth(2026, time.July)
	got := ym.FirstDay()
	want := time.Date(2026, time.July, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("G-9: got %v want %v", got, want)
	}
	if loc := got.Location(); loc != time.UTC {
		t.Errorf("G-9: Location=%v want UTC", loc)
	}
}

func TestYearMonth_IsZero(t *testing.T) {
	var ym domain.YearMonth
	if !ym.IsZero() {
		t.Errorf("G-10: zero value should be IsZero")
	}
	nonZero, _ := domain.NewYearMonth(2026, time.July)
	if nonZero.IsZero() {
		t.Errorf("G-10: constructed value should not be IsZero")
	}
}

func TestYearMonth_Compare(t *testing.T) {
	a, _ := domain.NewYearMonth(2026, time.July)
	b, _ := domain.NewYearMonth(2026, time.August)
	if got := a.Compare(b); got >= 0 {
		t.Errorf("G-11: Compare(2026-07, 2026-08)=%d want negative", got)
	}
	if got := b.Compare(a); got <= 0 {
		t.Errorf("Compare(2026-08, 2026-07)=%d want positive", got)
	}
	if got := a.Compare(a); got != 0 {
		t.Errorf("Compare(a, a)=%d want 0", got)
	}
	// 異なる年での比較
	c, _ := domain.NewYearMonth(2025, time.December)
	if got := c.Compare(a); got >= 0 {
		t.Errorf("Compare(2025-12, 2026-07)=%d want negative", got)
	}
}
