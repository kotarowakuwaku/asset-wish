package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// errorBody は design.md 4.4 のエラー形式。
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// badRequestError は形式の誤りを表す。400 に対応する。
//
// 業務ルール違反（422）と区別するために型を分ける。「送られた形が
// おかしい」のか「形は正しいが受け付けられない」のかは、クライアント
// 側の直し方が変わる。
type badRequestError struct {
	code    string
	message string
}

func (e *badRequestError) Error() string { return e.message }

func newBadRequest(code, message string) error {
	return &badRequestError{code: code, message: message}
}

// writeJSON は本文つきの成功応答を返す。
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if body == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// ヘッダは送信済みなので、ここでステータスは変えられない。
		slog.Error("レスポンスの書き込みに失敗", "error", err)
	}
}

// writeError はエラーをステータスコードに対応づけて返す（design.md 4.4）。
//
//	形式の誤り        400
//	認証失敗          401（middleware が直接返す）
//	対象が無い        404
//	業務ルール違反    422
//	それ以外          500
//
// 業務ルール違反を 400 に混ぜない。形式は正しいが受け付けられない、
// という区別をクライアントに伝えるため。
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var (
		domainErr *domain.DomainError
		badReq    *badRequestError
	)

	switch {
	case errors.As(err, &badReq):
		writeJSON(w, http.StatusBadRequest, errorBody{errorDetail{badReq.code, badReq.message}})

	case errors.Is(err, usecase.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{errorDetail{"NOT_FOUND", "対象が見つかりません"}})

	case errors.As(err, &domainErr):
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{errorDetail{domainErr.Code, domainErr.Message}})

	default:
		// 内部の事情はクライアントに出さない。原因はログに残す。
		slog.Error("リクエストの処理に失敗",
			"error", err, "method", r.Method, "path", r.URL.Path)
		writeJSON(w, http.StatusInternalServerError,
			errorBody{errorDetail{"INTERNAL_ERROR", "サーバー内部でエラーが発生しました"}})
	}
}

// maxBodyBytes は受け付ける本文の上限。
// 単一ユーザーの家計データに 1MB を超える本文は無い。
const maxBodyBytes = 1 << 20

// decodeJSON は本文を読み取る。
//
// 未知のフィールドを拒否する。PATCH で status を送るような、
// 「受け付けたつもりが黙って無視されていた」を防ぐため
// （detailed-design 6.4）。
func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return newBadRequest("INVALID_BODY", "リクエスト本文が空です")
		}
		return newBadRequest("INVALID_BODY", "リクエスト本文を解釈できません: "+err.Error())
	}
	return nil
}

// pathUUID は経路変数から UUID を取り出す。
func pathUUID(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil, newBadRequest("INVALID_ID", "ID の形式が不正です")
	}
	return id, nil
}
