package infra_test

import (
	"strings"
	"testing"

	"github.com/kotarowakuwaku/asset-wish/server/internal/infra"
)

// 値はすべて架空のもの（不変条件17）。
const (
	validToken = "0123456789abcdef0123456789abcdef"
	validDSN   = "postgres://user:pass@localhost:5432/db?sslmode=disable"
)

// setEnv は環境変数を差し替える。t.Setenv は後始末まで面倒を見る。
func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()

	for _, key := range []string{"PORT", "DATABASE_URL", "AUTH_TOKEN", "ALLOWED_ORIGINS"} {
		t.Setenv(key, kv[key])
	}
}

func TestLoadConfig(t *testing.T) {
	setEnv(t, map[string]string{
		"DATABASE_URL":    validDSN,
		"AUTH_TOKEN":      validToken,
		"ALLOWED_ORIGINS": " https://asset-wish.example , http://localhost:5173 ",
	})

	cfg, err := infra.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	// PORT が無ければ 8080。Cloud Run は PORT を渡してくる。
	if cfg.Port != "8080" {
		t.Errorf("Port=%q want 8080", cfg.Port)
	}
	if cfg.DatabaseURL != validDSN {
		t.Errorf("DatabaseURL=%q", cfg.DatabaseURL)
	}
	if len(cfg.AllowedOrigins) != 2 {
		t.Fatalf("AllowedOrigins=%v want 2件", cfg.AllowedOrigins)
	}
	if cfg.AllowedOrigins[0] != "https://asset-wish.example" {
		t.Errorf("空白が落ちていない: %q", cfg.AllowedOrigins[0])
	}
}

func TestLoadConfigUsesPort(t *testing.T) {
	setEnv(t, map[string]string{
		"PORT":            "3000",
		"DATABASE_URL":    validDSN,
		"AUTH_TOKEN":      validToken,
		"ALLOWED_ORIGINS": "https://asset-wish.example",
	})

	cfg, err := infra.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Port != "3000" {
		t.Errorf("Port=%q want 3000", cfg.Port)
	}
}

// TestLoadConfigRejects は、不足や危険な設定で起動させないことを確かめる。
//
// 起動してから「認証が素通りだった」と気付くより、起動に失敗するほうが
// 安全側に倒れる。とくにこのリポジトリは public で、サービスは
// 未認証呼び出しを許可した状態で公開される（design.md 4.5）。
func TestLoadConfigRejects(t *testing.T) {
	tests := []struct {
		name     string
		env      map[string]string
		wantHint string
	}{
		{
			name: "DATABASE_URL が無い",
			env: map[string]string{
				"AUTH_TOKEN": validToken, "ALLOWED_ORIGINS": "https://a.example",
			},
			wantHint: "DATABASE_URL",
		},
		{
			name: "AUTH_TOKEN が無い",
			env: map[string]string{
				"DATABASE_URL": validDSN, "ALLOWED_ORIGINS": "https://a.example",
			},
			wantHint: "AUTH_TOKEN",
		},
		{
			name: "AUTH_TOKEN が短い",
			env: map[string]string{
				"DATABASE_URL": validDSN, "AUTH_TOKEN": "short",
				"ALLOWED_ORIGINS": "https://a.example",
			},
			wantHint: "AUTH_TOKEN",
		},
		{
			name: "ALLOWED_ORIGINS が無い",
			env: map[string]string{
				"DATABASE_URL": validDSN, "AUTH_TOKEN": validToken,
			},
			wantHint: "ALLOWED_ORIGINS",
		},
		{
			name: "ワイルドカードは許さない",
			env: map[string]string{
				"DATABASE_URL": validDSN, "AUTH_TOKEN": validToken,
				"ALLOWED_ORIGINS": "*",
			},
			wantHint: "ワイルドカード",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setEnv(t, tt.env)

			_, err := infra.LoadConfig()
			if err == nil {
				t.Fatal("起動を止めるはず")
			}
			if !strings.Contains(err.Error(), tt.wantHint) {
				t.Errorf("何が足りないか分かるメッセージであること: %v", err)
			}
		})
	}
}
