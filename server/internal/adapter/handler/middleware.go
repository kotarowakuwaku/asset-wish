package handler

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Middleware は http.Handler を包む。
type Middleware func(http.Handler) http.Handler

// Chain は middleware を順に適用する。先に渡したものが外側になる。
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}

// Auth は固定トークンによる認証（design.md 4.5）。
//
// 単一ユーザーのため、ユーザー管理・パスワード・セッションは持たない。
// 環境変数のトークンと突き合わせるだけ。
//
// 比較に crypto/subtle を使うのは、文字列比較の実行時間からトークンを
// 推測されるのを避けるため。単一ユーザーの個人アプリで現実的な脅威では
// ないが、正しい比較を書くコストがほぼゼロなので、そちらに寄せる。
func Auth(token string) Middleware {
	expected := []byte("Bearer " + token)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// CORS の事前検査には Authorization が付かない。
			// ここで弾くとブラウザからの本リクエストが飛ばなくなる。
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			got := []byte(r.Header.Get("Authorization"))
			if subtle.ConstantTimeCompare(got, expected) != 1 {
				writeJSON(w, http.StatusUnauthorized,
					errorBody{errorDetail{"UNAUTHORIZED", "認証が必要です"}})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CORS は許可したオリジンからの呼び出しを通す（design.md 4.5）。
//
// front は別オリジンから API を呼ぶ。**ワイルドカードは使わない。**
// 許可するオリジンは環境変数で受け取る。
func CORS(allowedOrigins []string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && slices.Contains(allowedOrigins, origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				// オリジンごとに応答が変わることをキャッシュに伝える。
				w.Header().Add("Vary", "Origin")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequestLog はアクセスログを残す。
//
// 本文は記録しない。金額や相手の名前が流れるため（不変条件17）。
func RequestLog() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r)

			slog.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"duration", time.Since(started).String(),
			)
		})
	}
}

// statusRecorder は書き込まれたステータスコードを覚える。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// ParseOrigins はカンマ区切りのオリジン一覧を解釈する。
// 空要素と前後の空白は落とす。
func ParseOrigins(s string) []string {
	origins := make([]string, 0)
	for _, o := range strings.Split(s, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	return origins
}
