package domain

import (
	"strconv"
	"strings"
)

// Money は日本円を円単位で表す。
// 小数は扱わない。int64 の範囲は約 9.2 京円であり、桁あふれは考慮しない。
type Money int64

func (m Money) Add(o Money) Money { return m + o }
func (m Money) Sub(o Money) Money { return m - o }

func (m Money) IsPositive() bool { return m > 0 }
func (m Money) IsNegative() bool { return m < 0 }
func (m Money) IsZero() bool     { return m == 0 }

// String は表示用。"¥1,234,567" の形式。負値は "-¥1,234"。
func (m Money) String() string {
	negative := m < 0
	n := int64(m)
	if negative {
		n = -n
	}
	digits := strconv.FormatInt(n, 10)
	var b strings.Builder
	b.Grow(len(digits) + len(digits)/3 + 2)
	if negative {
		b.WriteByte('-')
	}
	b.WriteRune('¥')
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}
