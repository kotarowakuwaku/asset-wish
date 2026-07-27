package handler

import (
	"net/http"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func (h *Handler) listLendings(w http.ResponseWriter, r *http.Request) {
	// ?outstanding=true で未回収のみ。それ以外の値は全件として扱う。
	outstandingOnly := r.URL.Query().Get("outstanding") == "true"

	lendings, err := h.lendings.List(r.Context(), outstandingOnly)
	if err != nil {
		writeError(w, r, err)
		return
	}

	body := make([]lendingResponse, 0, len(lendings))
	for _, l := range lendings {
		body = append(body, newLendingResponse(l))
	}
	writeJSON(w, http.StatusOK, body)
}

type createLendingRequest struct {
	Counterparty string `json:"counterparty"`
	Description  string `json:"description"`
	Amount       int64  `json:"amount"`
	OccurredOn   string `json:"occurredOn"`
	AccountID    string `json:"accountId"`
}

func (h *Handler) createLending(w http.ResponseWriter, r *http.Request) {
	var req createLendingRequest
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

	l, err := h.lendings.Create(
		r.Context(), req.Counterparty, req.Description,
		domain.Money(req.Amount), occurredOn, accountID,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, newLendingResponse(l))
}

type collectLendingRequest struct {
	Amount     int64  `json:"amount"`
	OccurredOn string `json:"occurredOn"`
	AccountID  string `json:"accountId"`
}

// collectLending は回収を記録する。
// 未回収残高を超える額は 422（COLLECT_EXCEEDS_OUTSTANDING）になる。
func (h *Handler) collectLending(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	var req collectLendingRequest
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

	l, err := h.lendings.Collect(r.Context(), id, domain.Money(req.Amount), occurredOn, accountID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newLendingResponse(l))
}

func (h *Handler) deleteLending(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := h.lendings.Delete(r.Context(), id); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
