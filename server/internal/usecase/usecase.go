package usecase

import (
	"time"

	"github.com/google/uuid"
)

// Clock は現在時刻を返す。
//
// time.Now を直に呼ばずに注入するのは、テストで時刻を固定するため。
// 口座の更新日時は「残高がいつ時点のものか」を表す値で、表示にも
// 使われる（domain.Account.IsStale）。実時刻に依存したテストは、
// 境界をまたいだ瞬間に落ちる。
type Clock func() time.Time

// IDGenerator は新しい ID を採番する。テストで固定するために注入する。
type IDGenerator func() uuid.UUID

// SystemClock は本番で使う実時刻。
func SystemClock() time.Time { return time.Now() }

// NewUUID は本番で使う採番。
func NewUUID() uuid.UUID { return uuid.New() }
