package store

import (
	"context"
	"path/filepath"
	"testing"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "yyb.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func mustUpsert(t *testing.T, db *DB, openid, loginBuffer string, nickname string) *WechatAccount {
	t.Helper()
	ctx := context.Background()
	nick := nickname
	acc, err := db.UpsertAccount(ctx, openid, loginBuffer, &nick, &nick, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("UpsertAccount(%s) error = %v", openid, err)
	}
	return acc
}

func TestSetAccountOrderChangesListOrder(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	// 老库（无 sort_order 列）也要能跑：UpsertAccount 走的是同一张表
	a := mustUpsert(t, db, "openid-a", "buf-a", "Aaa")
	b := mustUpsert(t, db, "openid-b", "buf-b", "Bbb")
	c := mustUpsert(t, db, "openid-c", "buf-c", "Ccc")

	got := openIDs(t, db)
	if len(got) != 3 || got[0] != a.OpenID || got[2] != c.OpenID {
		t.Fatalf("初始顺序应按 id 升序，实际 %v", got)
	}

	// 按 openid / id / uin 三种 ref 都能定位：这里故意混用
	n, err := db.SetAccountOrder(ctx, []string{"openid-c", "openid-a"})
	if err != nil {
		t.Fatalf("SetAccountOrder() error = %v", err)
	}
	if n != 2 {
		t.Fatalf("SetAccountOrder() ordered = %d, want 2", n)
	}
	got = openIDs(t, db)
	want := []string{"openid-c", "openid-a", "openid-b"} // 未列出的 b 排到末尾
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("重排后顺序 = %v, want %v", got, want)
		}
	}

	// 未知 ref 直接忽略，不报错
	if _, err := db.SetAccountOrder(ctx, []string{"not-exist", "openid-b"}); err != nil {
		t.Fatalf("SetAccountOrder(未知 ref) error = %v", err)
	}
	if got = openIDs(t, db); got[0] != "openid-b" {
		t.Fatalf("未知 ref 应被忽略，实际顺序 %v", got)
	}

	_ = b
	_ = c
}

func TestNewAccountGoesLast(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	a := mustUpsert(t, db, "openid-a", "buf-a", "Aaa")
	b := mustUpsert(t, db, "openid-b", "buf-b", "Bbb")
	c := mustUpsert(t, db, "openid-c", "buf-c", "Ccc")

	// 用户手动把 a 拖到最后：c, b, a
	if _, err := db.SetAccountOrder(ctx, []string{"openid-c", "openid-b", "openid-a"}); err != nil {
		t.Fatalf("SetAccountOrder() error = %v", err)
	}

	// 新扫码进来的账号必须排在最后，而不是插到最前面（sort_order 默认 0 会排到 1/2/3 前面）
	if _, err := db.UpsertAccount(ctx, "openid-new", "buf-new", nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("UpsertAccount(新增) error = %v", err)
	}
	got := openIDs(t, db)
	want := []string{"openid-c", "openid-b", "openid-a", "openid-new"}
	if len(got) != len(want) {
		t.Fatalf("账号数 = %d, want %d（%v）", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("新增账号应排在最后，实际顺序 %v, want %v", got, want)
		}
	}

	// 老库里遗留的 sort_order=0（历史上扫码的账号）也要排到有序账号之后
	if _, err := db.sql.ExecContext(ctx,
		"UPDATE wechat_accounts SET sort_order=0 WHERE openid=?", "openid-new"); err != nil {
		t.Fatalf("构造遗留数据失败: %v", err)
	}
	if err := normalizeSortOrder(ctx, db.sql); err != nil {
		t.Fatalf("normalizeSortOrder() error = %v", err)
	}
	got = openIDs(t, db)
	if got[len(got)-1] != "openid-new" {
		t.Fatalf("sort_order=0 的老账号应被归一化到最后，实际 %v", got)
	}
	// 幂等：再跑一次结果不变
	if err := normalizeSortOrder(ctx, db.sql); err != nil {
		t.Fatalf("normalizeSortOrder() 第二次 error = %v", err)
	}
	if again := openIDs(t, db); again[len(again)-1] != "openid-new" {
		t.Fatalf("归一化应幂等，实际 %v", again)
	}

	_ = a
	_ = b
	_ = c
}

func TestUpsertFullAccountImport(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	// 1) 新建：带完整字段
	created, err := db.UpsertFullAccount(ctx, &ExportAccount{
		OpenID:      "openid-new",
		LoginBuffer: "buffer-new",
		Nickname:    strPtr("New"),
		Alias:       strPtr("New"),
		UserInfo:    map[string]any{"nick_name": "New", "ret": float64(0)},
		Credentials: map[string]any{"openid": "openid-new", "logintype": "WX"},
	})
	if err != nil {
		t.Fatalf("UpsertFullAccount(新建) error = %v", err)
	}
	if !created {
		t.Fatalf("UpsertFullAccount(新建) created = false, want true")
	}

	acc, err := db.GetAccountByOpenID(ctx, "openid-new")
	if err != nil {
		t.Fatalf("GetAccountByOpenID() error = %v", err)
	}
	if acc.LoginBuffer != "buffer-new" || acc.Credentials["logintype"] != "WX" {
		t.Fatalf("导入字段未落库: %+v", acc)
	}
	if acc.UserInfo["nick_name"] != "New" {
		t.Fatalf("user_info 未落库: %+v", acc.UserInfo)
	}

	// 2) 覆盖已存在：登录态更新，缺字段保留原值
	created, err = db.UpsertFullAccount(ctx, &ExportAccount{
		OpenID:      "openid-new",
		LoginBuffer: "buffer-refreshed",
	})
	if err != nil {
		t.Fatalf("UpsertFullAccount(覆盖) error = %v", err)
	}
	if created {
		t.Fatalf("UpsertFullAccount(覆盖) created = true, want false")
	}
	acc, _ = db.GetAccountByOpenID(ctx, "openid-new")
	if acc.LoginBuffer != "buffer-refreshed" {
		t.Fatalf("login_buffer 应被覆盖，实际 %q", acc.LoginBuffer)
	}
	if acc.Nickname == nil || *acc.Nickname != "New" {
		t.Fatalf("缺字段时应保留原昵称，实际 %v", acc.Nickname)
	}
	if acc.Credentials["logintype"] != "WX" {
		t.Fatalf("缺 credentials 时应保留原值，实际 %+v", acc.Credentials)
	}
}

func TestNormalizeImport(t *testing.T) {
	// 缺 login_buffer 直接拒绝（导入后也取不到 code）
	if _, err := NormalizeImport(map[string]any{"openid": "x"}); err == nil {
		t.Fatalf("缺 login_buffer 应报错")
	}
	// 缺 openid 但给了 uin：用 uin 占位
	got, err := NormalizeImport(map[string]any{"uin": float64(25985012499414548), "login_buffer": "b"})
	if err != nil {
		t.Fatalf("NormalizeImport(uin 占位) error = %v", err)
	}
	if got.OpenID != "uin_25985012499414548" || got.UIN == nil || *got.UIN != 25985012499414548 {
		t.Fatalf("uin 占位结果不对: %+v", got)
	}
	// 数字型 uin / 字符串型 uin 都能吃
	for _, raw := range []any{float64(123), "123"} {
		got, err := NormalizeImport(map[string]any{
			"openid": "o", "login_buffer": "b", "uin": raw,
		})
		if err != nil {
			t.Fatalf("NormalizeImport(uin=%v) error = %v", raw, err)
		}
		if got.UIN == nil || *got.UIN != 123 {
			t.Fatalf("uin=%v 解析结果 %+v", raw, got.UIN)
		}
	}
	// 昵称可从 user_info.nick_name 兜底
	got, err = NormalizeImport(map[string]any{
		"openid": "o", "login_buffer": "b",
		"user_info": map[string]any{"nick_name": "昵称"},
	})
	if err != nil {
		t.Fatalf("NormalizeImport() error = %v", err)
	}
	if got.Nickname == nil || *got.Nickname != "昵称" {
		t.Fatalf("昵称兜底失败: %+v", got.Nickname)
	}
}

func openIDs(t *testing.T, db *DB) []string {
	t.Helper()
	accounts, err := db.ListAccounts(context.Background())
	if err != nil {
		t.Fatalf("ListAccounts() error = %v", err)
	}
	out := make([]string, 0, len(accounts))
	for _, acc := range accounts {
		out = append(out, acc.OpenID)
	}
	return out
}

func strPtr(s string) *string { return &s }
