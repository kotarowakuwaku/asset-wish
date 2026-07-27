// Package infra は外部との接続まわりを持つ。
//
// 秘密情報はここでのみ環境変数から読む（不変条件17）。
// **このリポジトリは public。** 接続文字列やトークンをコードや
// ドキュメントに書かない。1度 push すると数秒で拾われ、履歴から
// 消しても手遅れになる。
package infra

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config はアプリの起動に必要な設定。
type Config struct {
	// Port は待ち受けポート。Cloud Run は PORT を渡してくる。
	Port string
	// DatabaseURL は PostgreSQL の接続文字列。
	DatabaseURL string
	// AuthToken は Bearer 認証で突き合わせる固定トークン。
	AuthToken string
	// AllowedOrigins は CORS で許可するオリジン。ワイルドカードは使わない。
	AllowedOrigins []string
}

const (
	envPort           = "PORT"
	envDatabaseURL    = "DATABASE_URL"
	envAuthToken      = "AUTH_TOKEN"
	envAllowedOrigins = "ALLOWED_ORIGINS"

	defaultPort = "8080"
	// minTokenLength は固定トークンの最低長。単一ユーザー向けとはいえ、
	// 公開エンドポイントに短いトークンを置くと総当たりが現実的になる。
	minTokenLength = 32
)

// LoadConfig は環境変数から設定を読む。
//
// 不足があれば起動させない。起動してから「認証が素通りだった」に
// 気付くより、起動に失敗するほうが安全側に倒れる。
func LoadConfig() (Config, error) {
	cfg := Config{
		Port:           envOr(envPort, defaultPort),
		DatabaseURL:    os.Getenv(envDatabaseURL),
		AuthToken:      os.Getenv(envAuthToken),
		AllowedOrigins: splitAndTrim(os.Getenv(envAllowedOrigins)),
	}

	var problems []string
	if cfg.DatabaseURL == "" {
		problems = append(problems, envDatabaseURL+" が未設定")
	}
	if cfg.AuthToken == "" {
		problems = append(problems, envAuthToken+" が未設定")
	} else if len(cfg.AuthToken) < minTokenLength {
		problems = append(problems, fmt.Sprintf("%s が短すぎる（%d 文字以上が必要）", envAuthToken, minTokenLength))
	}
	if len(cfg.AllowedOrigins) == 0 {
		problems = append(problems, envAllowedOrigins+" が未設定")
	}
	for _, o := range cfg.AllowedOrigins {
		if o == "*" {
			problems = append(problems, envAllowedOrigins+" にワイルドカードは使えない")
		}
	}

	if len(problems) > 0 {
		return Config{}, errors.New("設定が不正: " + strings.Join(problems, " / "))
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func splitAndTrim(s string) []string {
	values := make([]string, 0)
	for _, v := range strings.Split(s, ",") {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}
