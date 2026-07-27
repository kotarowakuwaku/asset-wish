package handler_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/handler"
)

const testToken = "0123456789abcdef0123456789abcdef"

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}

func TestAuth(t *testing.T) {
	tests := []struct {
		name       string
		header     string
		wantStatus int
	}{
		{"正しいトークン", "Bearer " + testToken, http.StatusOK},
		{"ヘッダが無い", "", http.StatusUnauthorized},
		{"トークンが違う", "Bearer wrong", http.StatusUnauthorized},
		{"Bearer が無い", testToken, http.StatusUnauthorized},
		{"種別が違う", "Basic " + testToken, http.StatusUnauthorized},
		{"前方一致だけでは通さない", "Bearer " + testToken + "extra", http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := handler.Auth(testToken)(okHandler())

			req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status=%d want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

// TestAuthAllowsPreflight は、CORS の事前検査を認証で弾かないことを
// 確かめる。
//
// ブラウザは OPTIONS に Authorization を付けない。ここで 401 を返すと、
// 本リクエストがそもそも飛ばなくなる。
func TestAuthAllowsPreflight(t *testing.T) {
	h := handler.Auth(testToken)(okHandler())

	req := httptest.NewRequest(http.MethodOptions, "/api/accounts", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code == http.StatusUnauthorized {
		t.Error("事前検査が 401 になっている")
	}
}

func TestCORS(t *testing.T) {
	allowed := []string{"https://asset-wish.example", "http://localhost:5173"}

	tests := []struct {
		name        string
		origin      string
		wantAllowed bool
	}{
		{"許可したオリジン", "https://asset-wish.example", true},
		{"許可した開発用オリジン", "http://localhost:5173", true},
		{"許可していないオリジン", "https://evil.example", false},
		{"Origin が無い", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := handler.CORS(allowed)(okHandler())

			req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			got := rec.Header().Get("Access-Control-Allow-Origin")
			if tt.wantAllowed {
				if got != tt.origin {
					t.Errorf("Allow-Origin=%q want %q", got, tt.origin)
				}
				// オリジンごとに応答が変わることをキャッシュに伝える。
				if rec.Header().Get("Vary") != "Origin" {
					t.Errorf("Vary=%q want Origin", rec.Header().Get("Vary"))
				}
			} else if got != "" {
				t.Errorf("許可していないのにヘッダが付いた: %q", got)
			}
		})
	}
}

// TestCORSNeverUsesWildcard は、ワイルドカードを返さないことを確かめる
// （design.md 4.5）。
func TestCORSNeverUsesWildcard(t *testing.T) {
	h := handler.CORS([]string{"https://asset-wish.example"})(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	req.Header.Set("Origin", "https://asset-wish.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Header().Get("Access-Control-Allow-Origin") == "*" {
		t.Error("ワイルドカードを返している")
	}
}

func TestCORSPreflight(t *testing.T) {
	h := handler.CORS([]string{"https://asset-wish.example"})(okHandler())

	req := httptest.NewRequest(http.MethodOptions, "/api/accounts", nil)
	req.Header.Set("Origin", "https://asset-wish.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status=%d want 204", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("許可メソッドが返っていない")
	}
	if rec.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Error("許可ヘッダが返っていない")
	}
}

// TestChainOrder は、先に渡した middleware が外側になることを確かめる。
func TestChainOrder(t *testing.T) {
	var order []string

	mark := func(name string) handler.Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}

	h := handler.Chain(okHandler(), mark("外"), mark("中"), mark("内"))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	want := []string{"外", "中", "内"}
	for i, w := range want {
		if i >= len(order) || order[i] != w {
			t.Fatalf("order=%v want %v", order, want)
		}
	}
}

// TestCORSOutsideAuth は、実際の並び（CORS が認証の外側）で事前検査が
// 通ることを確かめる。逆順だと、ブラウザからの呼び出しが成立しない。
func TestCORSOutsideAuth(t *testing.T) {
	h := handler.Chain(okHandler(),
		handler.CORS([]string{"https://asset-wish.example"}),
		handler.Auth(testToken),
	)

	req := httptest.NewRequest(http.MethodOptions, "/api/accounts", nil)
	req.Header.Set("Origin", "https://asset-wish.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status=%d want 204", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Error("事前検査に CORS ヘッダが付いていない")
	}
}

func TestParseOrigins(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"", []string{}},
		{"https://a.example", []string{"https://a.example"}},
		{" https://a.example , https://b.example ", []string{"https://a.example", "https://b.example"}},
		{"https://a.example,,", []string{"https://a.example"}},
	}

	for _, tt := range tests {
		got := handler.ParseOrigins(tt.in)
		if len(got) != len(tt.want) {
			t.Errorf("ParseOrigins(%q)=%v want %v", tt.in, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("ParseOrigins(%q)=%v want %v", tt.in, got, tt.want)
				break
			}
		}
	}
}
