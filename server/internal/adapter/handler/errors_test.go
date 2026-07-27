package handler_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// エラーのステータスコードへの対応づけ（design.md 4.4）。
//
//	形式の誤り        400
//	対象が無い        404
//	業務ルール違反    422
//	それ以外          500
//
// **400 と 422 の区別が要点。** 形式は正しいが受け付けられない、という
// 状態をクライアントに伝えるため。前者はリクエストの組み立てを直す話、
// 後者は値や状態を見直す話で、対処がまるで違う。
func TestErrorMapping(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "対象が無い",
			err:        usecase.ErrNotFound,
			wantStatus: http.StatusNotFound,
			wantCode:   "NOT_FOUND",
		},
		{
			name:       "不正な状態遷移",
			err:        domain.ErrInvalidTransition,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "INVALID_TRANSITION",
		},
		{
			name:       "過回収",
			err:        domain.ErrCollectExceedsOutstanding,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "COLLECT_EXCEEDS_OUTSTANDING",
		},
		{
			name:       "口座種別が不正",
			err:        domain.ErrInvalidAccountKind,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "INVALID_ACCOUNT_KIND",
		},
		{
			name:       "履歴の残る口座の削除",
			err:        domain.ErrAccountInUse,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "ACCOUNT_IN_USE",
		},
		{
			name:       "想定外のエラー",
			err:        errors.New("DB が落ちている"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, s := newServer(t)
			s.wishes.commitFn = func(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
				return domain.Wish{}, tt.err
			}

			rec := do(t, h, http.MethodPost, "/api/wishes/"+uuid.New().String()+"/commit", "")
			assertStatus(t, rec, tt.wantStatus)
			assertErrorCode(t, rec, tt.wantCode)
		})
	}
}

// TestInternalErrorHidesDetail は、内部の事情をクライアントに出さない
// ことを確かめる。接続文字列やテーブル名が漏れる経路になるため。
func TestInternalErrorHidesDetail(t *testing.T) {
	h, s := newServer(t)
	s.wishes.commitFn = func(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
		return domain.Wish{}, errors.New("dial tcp 10.0.0.1:5432: connection refused")
	}

	rec := do(t, h, http.MethodPost, "/api/wishes/"+uuid.New().String()+"/commit", "")
	assertStatus(t, rec, http.StatusInternalServerError)

	if body := rec.Body.String(); strings.Contains(body, "5432") || strings.Contains(body, "connection refused") {
		t.Errorf("内部の詳細が漏れている: %s", body)
	}
}

// TestWrappedErrorsAreMapped は、包まれたエラーでも対応づけが効くことを
// 確かめる。repository は fmt.Errorf で文脈を足して返す。
func TestWrappedErrorsAreMapped(t *testing.T) {
	h, s := newServer(t)
	s.wishes.commitFn = func(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
		return domain.Wish{}, fmt.Errorf("ウィッシュの取得に失敗: %w", usecase.ErrNotFound)
	}

	rec := do(t, h, http.MethodPost, "/api/wishes/"+uuid.New().String()+"/commit", "")
	assertStatus(t, rec, http.StatusNotFound)
}

// TestContentTypeIsJSON はレスポンスの Content-Type を確かめる。
func TestContentTypeIsJSON(t *testing.T) {
	h, _ := newServer(t)

	rec := do(t, h, http.MethodGet, "/api/accounts", "")
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type=%q", got)
	}
}
