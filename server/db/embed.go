// Package migrations は db/migrations/*.sql を実行ファイルに埋め込む。
//
// goose を CLI としてだけ使うなら埋め込みは要らないが、テストから
// goose.Up を呼ぶには FS が要る。段階3の repository テストは
// 「まっさらな DB にスキーマを流してから検証する」形になるため、
// そこで同じ FS を使い回す。
//
// ディレクトリ名は db、パッケージ名は migrations で揃っていない。
// 生成コード側の internal/db がパッケージ名 db を先に取っており、
// 両方を import する箇所で別名が必要になるのを避けるため。
package migrations

import "embed"

// FS は db/migrations 以下の SQL を保持する。
// goose に渡すときのディレクトリ名は "migrations"。
//
//go:embed migrations/*.sql
var FS embed.FS
