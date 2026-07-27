package handler

import (
	"net/http"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

func (h *Handler) listAccounts(w http.ResponseWriter, r *http.Request) {
	accounts, err := h.accounts.List(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	now := h.now()
	body := make([]accountResponse, 0, len(accounts))
	for _, a := range accounts {
		body = append(body, newAccountResponse(a, now))
	}
	writeJSON(w, http.StatusOK, body)
}

type createAccountRequest struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Balance int64  `json:"balance"`
}

func (h *Handler) createAccount(w http.ResponseWriter, r *http.Request) {
	var req createAccountRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	// kind の妥当性は domain が判定する（不正なら 422）。
	// ここで弾くと、同じ判断が2箇所に散る。
	a, err := h.accounts.Create(r.Context(), req.Name, domain.AccountKind(req.Kind), domain.Money(req.Balance))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, newAccountResponse(a, h.now()))
}

// updateAccountRequest は部分更新。省略された項目は変更しない。
//
// kind を受け取らない。口座種別が変わると、その口座が実質資産の計算から
// 丸ごと外れる（不変条件1）。decodeJSON が未知のフィールドを拒むので、
// kind を送れば 400 になる。黙って無視するより、送れないと伝えるほうがよい。
type updateAccountRequest struct {
	Name    *string `json:"name"`
	Balance *int64  `json:"balance"`
}

func (h *Handler) updateAccount(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	var req updateAccountRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, err)
		return
	}

	in := usecase.UpdateAccountInput{Name: req.Name}
	if req.Balance != nil {
		balance := domain.Money(*req.Balance)
		in.Balance = &balance
	}

	a, err := h.accounts.Update(r.Context(), id, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, newAccountResponse(a, h.now()))
}

func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}

	// 取引履歴が残っていれば domain.ErrAccountInUse になり 422。
	if err := h.accounts.Delete(r.Context(), id); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
