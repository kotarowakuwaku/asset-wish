package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

func (h *Handler) listWishes(w http.ResponseWriter, r *http.Request) {
	var status *domain.WishStatus
	if raw := r.URL.Query().Get("status"); raw != "" {
		s := domain.WishStatus(raw)
		if !s.Valid() {
			// 絞り込みの指定ミスは形式の誤り。存在しない状態で
			// 空配列を返すと、絞り込めているように見えてしまう。
			writeError(w, r, newBadRequest("INVALID_WISH_STATUS", "status の指定が不正です"))
			return
		}
		status = &s
	}

	wishes, err := h.wishes.List(r.Context(), status)
	if err != nil {
		writeError(w, r, err)
		return
	}

	body := make([]wishResponse, 0, len(wishes))
	for _, wish := range wishes {
		body = append(body, newWishResponse(wish))
	}
	writeJSON(w, http.StatusOK, body)
}

type createWishRequest struct {
	Title    string  `json:"title"`
	Amount   int64   `json:"amount"`
	Category string  `json:"category"`
	Priority *int    `json:"priority"`
	Deadline *string `json:"deadline"`
}

func (h *Handler) createWish(w http.ResponseWriter, r *http.Request) {
	var req createWishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	deadline, err := parseDatePtr(req.Deadline)
	if err != nil {
		writeError(w, r, err)
		return
	}

	priority := 0
	if req.Priority != nil {
		priority = *req.Priority
	}

	// status は受け取らない。新規は必ず検討中から始まる（不変条件3）。
	wish, err := h.wishes.Create(
		r.Context(), req.Title, domain.Money(req.Amount),
		domain.WishCategory(req.Category), priority, deadline,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, newWishResponse(wish))
}

// updateWishRequest は部分更新。省略された項目は変更しない。
//
// status を持たない。状態遷移は /commit /pay /drop の専用経路に限る
// （不変条件6）。decodeJSON が未知のフィールドを拒むので、status を
// 送れば 400 になる（detailed-design 6.4）。
//
// Deadline を json.RawMessage で受けるのは、3つの状態を区別するため。
//
//	キー自体が無い  → 変更しない（nil）
//	null            → 期限を外す
//	"2026-12-31"    → その日に設定する
//
// *string では前2つが区別できず、「期限を外したい」が「変更しない」に
// なってしまう。
type updateWishRequest struct {
	Title    *string         `json:"title"`
	Amount   *int64          `json:"amount"`
	Category *string         `json:"category"`
	Priority *int            `json:"priority"`
	Deadline json.RawMessage `json:"deadline"`
}

func (h *Handler) updateWish(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	var req updateWishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	in := usecase.UpdateWishInput{Title: req.Title, Priority: req.Priority}
	if req.Amount != nil {
		amount := domain.Money(*req.Amount)
		in.Amount = &amount
	}
	if req.Category != nil {
		category := domain.WishCategory(*req.Category)
		in.Category = &category
	}
	if len(req.Deadline) > 0 {
		if bytes.Equal(bytes.TrimSpace(req.Deadline), []byte("null")) {
			in.ClearDeadline = true
		} else {
			var s string
			if err := json.Unmarshal(req.Deadline, &s); err != nil {
				writeError(w, r, newBadRequest("INVALID_DATE", "deadline は文字列または null で指定してください"))
				return
			}
			deadline, err := parseDate(s)
			if err != nil {
				writeError(w, r, err)
				return
			}
			in.Deadline = &deadline
		}
	}

	wish, err := h.wishes.UpdateContent(r.Context(), id, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newWishResponse(wish))
}

// commitWish は 検討中 → 確定。確定した時点で実質資産から控除される。
func (h *Handler) commitWish(w http.ResponseWriter, r *http.Request) {
	h.transitWish(w, r, func(id uuid.UUID) (domain.Wish, error) {
		return h.wishes.Commit(r.Context(), id)
	})
}

// dropWish は 見送り へ。
func (h *Handler) dropWish(w http.ResponseWriter, r *http.Request) {
	h.transitWish(w, r, func(id uuid.UUID) (domain.Wish, error) {
		return h.wishes.Drop(r.Context(), id)
	})
}

type payWishRequest struct {
	AccountID  string `json:"accountId"`
	OccurredOn string `json:"occurredOn"`
}

// payWish は 確定 → 完了。口座残高が減り、取引履歴が残る。
// 支払いの前後で実質資産は変わらない。
func (h *Handler) payWish(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	var req payWishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	occurredOn, err := parseDate(req.OccurredOn)
	if err != nil {
		writeError(w, r, err)
		return
	}
	accountID, err := parseUUID(req.AccountID, "accountId")
	if err != nil {
		writeError(w, r, err)
		return
	}

	wish, err := h.wishes.Pay(r.Context(), id, accountID, occurredOn)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newWishResponse(wish))
}

// transitWish は遷移系の共通処理。不正な遷移は 422（INVALID_TRANSITION）。
func (h *Handler) transitWish(
	w http.ResponseWriter,
	r *http.Request,
	transit func(uuid.UUID) (domain.Wish, error),
) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	wish, err := transit(id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newWishResponse(wish))
}

func (h *Handler) deleteWish(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := h.wishes.Delete(r.Context(), id); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseDatePtr(s *string) (*time.Time, error) {
	if s == nil {
		return nil, nil
	}
	t, err := parseDate(*s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
