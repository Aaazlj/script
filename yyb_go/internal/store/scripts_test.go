package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// 老库（建表时还没有 scripts 列）打开时要自动补列；补完的账号标记为空 = 不限制
func TestOpenAddsScriptsColumnToExistingDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "yyb.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	ctx := context.Background()
	if _, err = raw.ExecContext(ctx, `
CREATE TABLE wechat_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    openid          TEXT    NOT NULL UNIQUE,
    uin             INTEGER,
    alias           TEXT,
    nickname        TEXT,
    avatar          TEXT,
    user_info       TEXT,
    login_buffer    TEXT    NOT NULL,
    credentials     TEXT,
    status          TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
INSERT INTO wechat_accounts(id, openid, login_buffer, status, sort_order, created_at, updated_at)
VALUES(1, 'openid-1', 'login-buffer', 'alive', 1, 10, 10);
`); err != nil {
		_ = raw.Close()
		t.Fatalf("seed old schema: %v", err)
	}
	if err = raw.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	has, err := sqliteColumnExists(ctx, db.sql, "wechat_accounts", "scripts")
	if err != nil {
		t.Fatalf("check scripts column: %v", err)
	}
	if !has {
		t.Fatalf("Open() 没有给老库补上 scripts 列")
	}

	acc, err := db.GetAccountByOpenID(ctx, "openid-1")
	if err != nil {
		t.Fatalf("GetAccountByOpenID() error = %v", err)
	}
	if acc.Scripts != nil {
		t.Fatalf("老账号的标记 = %q, want 空（不限制）", *acc.Scripts)
	}

	// 写入标记后要能读回来，并且规整过
	if err = db.SetAccountScripts(ctx, acc.ID, " MT, sfsy ,mt"); err != nil {
		t.Fatalf("SetAccountScripts() error = %v", err)
	}
	acc, err = db.GetAccountByOpenID(ctx, "openid-1")
	if err != nil {
		t.Fatalf("reload error = %v", err)
	}
	if acc.Scripts == nil || *acc.Scripts != "mt,sfsy" {
		t.Fatalf("读回的标记 = %v, want mt,sfsy", acc.Scripts)
	}
	if pub := acc.Public(); pub.Scripts == nil || *pub.Scripts != "mt,sfsy" {
		t.Fatalf("Public() 没带上标记: %v", pub.Scripts)
	}
	if exp := acc.Export(); exp.Scripts == nil || *exp.Scripts != "mt,sfsy" {
		t.Fatalf("Export() 没带上标记: %v", exp.Scripts)
	}

	// 空串 = 清除标记
	if err = db.SetAccountScripts(ctx, acc.ID, ""); err != nil {
		t.Fatalf("clear scripts error = %v", err)
	}
	acc, err = db.GetAccountByOpenID(ctx, "openid-1")
	if err != nil {
		t.Fatalf("reload after clear error = %v", err)
	}
	if acc.Scripts == nil || *acc.Scripts != "" {
		t.Fatalf("清除后的标记 = %v, want 空串", acc.Scripts)
	}
}

func TestNormalizeScripts(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"   ", ""},
		{"mt", "mt"},
		{"MT", "mt"},
		{"mt,sfsy", "mt,sfsy"},
		{"mt, sfsy ,mt", "mt,sfsy"},
		{"sfsy;ppcs", "sfsy,ppcs"},
		{"mt\nsfsy\tppcs", "mt,sfsy,ppcs"},
		{"mt，sfsy；ppcs", "mt,sfsy,ppcs"},
		{",mt,", "mt"},
	}
	for _, c := range cases {
		if got := NormalizeScripts(c.in); got != c.want {
			t.Fatalf("NormalizeScripts(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
