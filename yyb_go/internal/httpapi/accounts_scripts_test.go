package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"yyb_go/internal/store"
)

func newScriptsTestApp(t *testing.T) *App {
	t.Helper()
	t.Setenv("GIN_MODE", "test")
	app, err := NewApp(Config{
		ResourceRoot:   t.TempDir(),
		RequestTimeout: time.Second,
		AvatarTimeout:  time.Second,
		SessionTTL:     time.Minute,
		QRSessionTTL:   time.Minute,
	})
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app
}

// envelope 是所有接口统一的 {code,msg,data} 外壳
type envelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

func doJSON(t *testing.T, handler http.Handler, method, path, body string) (int, envelope) {
	t.Helper()
	var reader *bytes.Buffer
	if body == "" {
		reader = bytes.NewBufferString("")
	} else {
		reader = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("%s %s 响应不是 JSON: %v (body=%s)", method, path, err, rec.Body.String())
	}
	return rec.Code, env
}

// listScripts 读 GET /accounts，返回 openid → scripts 的映射
func listScripts(t *testing.T, handler http.Handler) map[string]string {
	t.Helper()
	status, env := doJSON(t, handler, http.MethodGet, "/accounts", "")
	if status != http.StatusOK {
		t.Fatalf("GET /accounts status = %d", status)
	}
	var accounts []store.AccountPublic
	if err := json.Unmarshal(env.Data, &accounts); err != nil {
		t.Fatalf("decode accounts: %v", err)
	}
	out := make(map[string]string, len(accounts))
	for _, a := range accounts {
		value := ""
		if a.Scripts != nil {
			value = *a.Scripts
		}
		out[a.OpenID] = value
	}
	return out
}

func TestAccountsScriptsSetsAndClearsMarkers(t *testing.T) {
	app := newScriptsTestApp(t)
	ctx := context.Background()
	handler := app.Handler()

	nickname := "Aaa"
	for _, openid := range []string{"openid-aaa", "openid-zzz"} {
		if _, err := app.db.UpsertFullAccount(ctx, &store.ExportAccount{
			OpenID:      openid,
			Nickname:    &nickname,
			LoginBuffer: "login-buffer",
		}); err != nil {
			t.Fatalf("seed %s: %v", openid, err)
		}
	}

	// 新账号默认没有标记 —— 空串代表「不限制，所有脚本都跑」
	if got := listScripts(t, handler)["openid-aaa"]; got != "" {
		t.Fatalf("新账号默认标记 = %q, want 空", got)
	}

	// 单个设置：大小写、空格、重复都要被规整掉
	status, env := doJSON(t, handler, http.MethodPost, "/accounts/scripts",
		`{"ref":"openid-aaa","scripts":"MT, sfsy ,mt"}`)
	if status != http.StatusOK || env.Code != 0 {
		t.Fatalf("POST /accounts/scripts status=%d code=%d msg=%s", status, env.Code, env.Msg)
	}
	var single struct {
		Updated  int              `json:"updated"`
		Skipped  []map[string]any `json:"skipped"`
		Accounts []store.AccountPublic
	}
	if err := json.Unmarshal(env.Data, &single); err != nil {
		t.Fatalf("decode scripts response: %v", err)
	}
	if single.Updated != 1 || len(single.Skipped) != 0 {
		t.Fatalf("updated=%d skipped=%#v", single.Updated, single.Skipped)
	}
	if got := listScripts(t, handler)["openid-aaa"]; got != "mt,sfsy" {
		t.Fatalf("标记规整结果 = %q, want %q", got, "mt,sfsy")
	}
	// 另一个账号不受影响
	if got := listScripts(t, handler)["openid-zzz"]; got != "" {
		t.Fatalf("未设置的账号被误改 = %q", got)
	}

	// 批量设置 + 用空串清除
	status, env = doJSON(t, handler, http.MethodPost, "/accounts/scripts",
		`{"items":[{"ref":"openid-aaa","scripts":""},{"ref":"2","scripts":"ppcs"}]}`)
	if status != http.StatusOK || env.Code != 0 {
		t.Fatalf("批量 POST status=%d code=%d msg=%s", status, env.Code, env.Msg)
	}
	scripts := listScripts(t, handler)
	if got := scripts["openid-aaa"]; got != "" {
		t.Fatalf("清除标记失败 = %q, want 空", got)
	}
	// ref 支持按 id 指定（id=2 是第二个插进去的账号）
	if got := scripts["openid-zzz"]; got != "ppcs" {
		t.Fatalf("按 id 设置标记失败 = %q, want ppcs", got)
	}

	// 未知 ref 只跳过自己，不影响同批其它账号
	status, env = doJSON(t, handler, http.MethodPost, "/accounts/scripts",
		`{"items":[{"ref":"不存在","scripts":"mt"},{"ref":"openid-aaa","scripts":"mt"}]}`)
	if status != http.StatusOK || env.Code != 0 {
		t.Fatalf("含未知 ref 的批量请求 status=%d code=%d", status, env.Code)
	}
	var mixed struct {
		Updated int              `json:"updated"`
		Skipped []map[string]any `json:"skipped"`
	}
	if err := json.Unmarshal(env.Data, &mixed); err != nil {
		t.Fatalf("decode mixed response: %v", err)
	}
	if mixed.Updated != 1 || len(mixed.Skipped) != 1 {
		t.Fatalf("updated=%d skipped=%#v", mixed.Updated, mixed.Skipped)
	}
	if got := listScripts(t, handler)["openid-aaa"]; got != "mt" {
		t.Fatalf("同批正常账号没写进去 = %q", got)
	}

	// 参数不合法：既没 ref 也没 items
	status, env = doJSON(t, handler, http.MethodPost, "/accounts/scripts", `{}`)
	if status != http.StatusBadRequest || env.Code != http.StatusBadRequest {
		t.Fatalf("空入参 status=%d code=%d, want 400", status, env.Code)
	}

	// 方法不对
	status, _ = doJSON(t, handler, http.MethodGet, "/accounts/scripts", "")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("GET /accounts/scripts status = %d, want 405", status)
	}
}

// 导入时带 scripts 要写进去；不带 scripts 要保留库里的原值（不能把标记清掉）
func TestAccountsImportKeepsScriptsWhenAbsent(t *testing.T) {
	app := newScriptsTestApp(t)
	ctx := context.Background()
	handler := app.Handler()

	if _, err := app.db.UpsertFullAccount(ctx, &store.ExportAccount{
		OpenID:      "openid-1",
		LoginBuffer: "login-buffer",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if status, env := doJSON(t, handler, http.MethodPost, "/accounts/scripts",
		`{"ref":"openid-1","scripts":"mt"}`); status != http.StatusOK || env.Code != 0 {
		t.Fatalf("seed scripts status=%d code=%d", status, env.Code)
	}

	// 导入时没带 scripts 字段 → 保留 "mt"
	body := `{"accounts":[{"openid":"openid-1","login_buffer":"login-buffer-2","nickname":"Aaa"}]}`
	if status, env := doJSON(t, handler, http.MethodPost, "/accounts/import", body); status != http.StatusOK || env.Code != 0 {
		t.Fatalf("import status=%d code=%d msg=%s", status, env.Code, env.Msg)
	}
	if got := listScripts(t, handler)["openid-1"]; got != "mt" {
		t.Fatalf("导入覆盖掉了已有标记 = %q, want mt", got)
	}

	// 导入时带了 scripts → 按新值覆盖
	body = `{"accounts":[{"openid":"openid-1","login_buffer":"login-buffer-3","scripts":"sfsy , ppcs"}]}`
	if status, env := doJSON(t, handler, http.MethodPost, "/accounts/import", body); status != http.StatusOK || env.Code != 0 {
		t.Fatalf("import scripts status=%d code=%d msg=%s", status, env.Code, env.Msg)
	}
	if got := listScripts(t, handler)["openid-1"]; got != "sfsy,ppcs" {
		t.Fatalf("导入的标记没写进去 = %q, want sfsy,ppcs", got)
	}
}
