package domain

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	yearMonthMinYear = 1900
	yearMonthMaxYear = 9999
)

// YearMonth は年月を表す。日・時刻・タイムゾーンを持たない。
// ゼロ値は不正な値であり、必ずコンストラクタを経由して生成する。
type YearMonth struct {
	year  int
	month time.Month
}

// NewYearMonth は年月を生成する。
// year が 1900〜9999 の範囲外、または month が 1〜12 の範囲外なら
// ErrInvalidYearMonth を返す。
func NewYearMonth(year int, month time.Month) (YearMonth, error) {
	if year < yearMonthMinYear || year > yearMonthMaxYear {
		return YearMonth{}, ErrInvalidYearMonth
	}
	if month < time.January || month > time.December {
		return YearMonth{}, ErrInvalidYearMonth
	}
	return YearMonth{year: year, month: month}, nil
}

// ParseYearMonth は "2026-07" 形式の文字列を解釈する。
// 月は2桁固定。形式が異なる場合は ErrInvalidYearMonth を返す。
func ParseYearMonth(s string) (YearMonth, error) {
	if len(s) != 7 || s[4] != '-' {
		return YearMonth{}, ErrInvalidYearMonth
	}
	yStr, mStr := s[:4], s[5:]
	if !allDigits(yStr) || !allDigits(mStr) {
		return YearMonth{}, ErrInvalidYearMonth
	}
	y, _ := strconv.Atoi(yStr)
	m, _ := strconv.Atoi(mStr)
	return NewYearMonth(y, time.Month(m))
}

func allDigits(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return r < '0' || r > '9' }) == -1
}

// FromTime は time.Time の年月部分を取り出す。
// 与えられた時刻のロケーションをそのまま用いる。DB からの復元に使う。
func FromTime(t time.Time) YearMonth {
	return YearMonth{year: t.Year(), month: t.Month()}
}

func (ym YearMonth) Year() int         { return ym.year }
func (ym YearMonth) Month() time.Month { return ym.month }

// String は "2026-07" 形式を返す。月は必ず2桁。
func (ym YearMonth) String() string {
	return fmt.Sprintf("%04d-%02d", ym.year, int(ym.month))
}

// FirstDay はその月の1日を UTC の 00:00:00 で返す。DB の DATE 列との変換に使う。
func (ym YearMonth) FirstDay() time.Time {
	return time.Date(ym.year, ym.month, 1, 0, 0, 0, 0, time.UTC)
}

// AddMonths は n ヶ月後を返す。n は負でもよい。time.Date が月を正規化するため
// 12月+1 = 翌年1月、1月-1 = 前年12月のように繰り上がり・繰り下がりが自然に扱える。
func (ym YearMonth) AddMonths(n int) YearMonth {
	t := time.Date(ym.year, ym.month+time.Month(n), 1, 0, 0, 0, 0, time.UTC)
	return YearMonth{year: t.Year(), month: t.Month()}
}

func (ym YearMonth) Before(o YearMonth) bool { return ym.Compare(o) < 0 }
func (ym YearMonth) After(o YearMonth) bool  { return ym.Compare(o) > 0 }
func (ym YearMonth) Equal(o YearMonth) bool  { return ym.Compare(o) == 0 }

// Compare は ym < o なら負、等しければ 0、ym > o なら正を返す。
// slices.SortFunc に渡す用途。
func (ym YearMonth) Compare(o YearMonth) int {
	if ym.year != o.year {
		if ym.year < o.year {
			return -1
		}
		return 1
	}
	if ym.month < o.month {
		return -1
	}
	if ym.month > o.month {
		return 1
	}
	return 0
}

// IsZero はゼロ値（未初期化）かどうかを返す。
func (ym YearMonth) IsZero() bool { return ym.year == 0 }
