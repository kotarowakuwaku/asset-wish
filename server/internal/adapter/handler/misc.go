package handler

import (
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func (h *Handler) getDashboard(w http.ResponseWriter, r *http.Request) {
	d, err := h.dashboard.Get(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newDashboardResponse(d))
}

func (h *Handler) listMonthlyBalances(w http.ResponseWriter, r *http.Request) {
	balances, err := h.balances.List(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	body := make([]monthlyBalanceResponse, 0, len(balances))
	for _, m := range balances {
		body = append(body, newMonthlyBalanceResponse(m))
	}
	writeJSON(w, http.StatusOK, body)
}

type upsertMonthlyBalanceRequest struct {
	Income  int64 `json:"income"`
	Expense int64 `json:"expense"`
}

// upsertMonthlyBalance は月次収支を登録・更新する（冪等）。
//
// 経路の {yearMonth} は "2026-07" 形式。形式の誤り（桁数・区切り）は 400、
// 範囲外（13月など）は 422 に分ける（detailed-design 6.5）。前者は
// クライアントの組み立てミス、後者は値の誤り。
func (h *Handler) upsertMonthlyBalance(w http.ResponseWriter, r *http.Request) {
	raw := r.PathValue("yearMonth")
	if !isYearMonthShape(raw) {
		writeError(w, r, newBadRequest("INVALID_YEAR_MONTH", "年月は YYYY-MM 形式で指定してください"))
		return
	}

	ym, err := domain.ParseYearMonth(raw)
	if err != nil {
		// 形は合っているが値が範囲外。domain のエラーなので 422 になる。
		writeError(w, r, err)
		return
	}

	var req upsertMonthlyBalanceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	m, err := h.balances.Upsert(r.Context(), ym, domain.Money(req.Income), domain.Money(req.Expense))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newMonthlyBalanceResponse(m))
}

// isYearMonthShape は "YYYY-MM" の形をしているかだけを見る。
// 値が妥当かどうかは domain.ParseYearMonth が判定する。
func isYearMonthShape(s string) bool {
	if len(s) != 7 || s[4] != '-' {
		return false
	}
	for i, c := range s {
		if i == 4 {
			continue
		}
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (h *Handler) listTransactions(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			writeError(w, r, newBadRequest("INVALID_LIMIT", "limit は 0 以上の整数で指定してください"))
			return
		}
		limit = parsed
	}

	transactions, err := h.transactions.List(r.Context(), limit)
	if err != nil {
		writeError(w, r, err)
		return
	}

	body := make([]transactionResponse, 0, len(transactions))
	for _, t := range transactions {
		body = append(body, newTransactionResponse(t))
	}
	writeJSON(w, http.StatusOK, body)
}

// parseUUID は本文中の ID を解釈する。形式の誤りは 400。
func parseUUID(s, field string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, newBadRequest("INVALID_ID", field+" の形式が不正です")
	}
	return id, nil
}
