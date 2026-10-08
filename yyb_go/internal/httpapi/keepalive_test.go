package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestKeepAliveStatusEndpoint(t *testing.T) {
	app, _ := newTestApp(t)
	handler := app.Handler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/keepalive", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /keepalive = %d", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	data, _ := out["data"].(map[string]any)
	if data["enabled"] != false {
		t.Fatalf("未配置间隔时保活应为关闭，实际 %v", data["enabled"])
	}

	// 未启用时 POST 应报 400
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, httptest.NewRequest(http.MethodPost, "/keepalive", nil))
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("未启用时 POST /keepalive = %d，应为 400", rec2.Code)
	}
}

func TestKeepAliveDisabledWithoutInterval(t *testing.T) {
	app, _ := newTestApp(t)
	// 测试 App 没配 KeepAliveInterval → 不应启动
	if snap := app.keepAliveSnapshot(); snap.Enabled {
		t.Fatalf("未配置间隔时不应启用保活: %+v", snap)
	}

	// 配置了就应该启动
	app2, _ := newTestAppWithKeepAlive(t)
	snap := app2.keepAliveSnapshot()
	if !snap.Enabled || snap.Interval == "" {
		t.Fatalf("配置了间隔应启用保活: %+v", snap)
	}
}

func newTestAppWithKeepAlive(t *testing.T) (*App, string) {
	t.Helper()
	t.Setenv("GIN_MODE", "test")
	dir := t.TempDir()
	app, err := NewApp(Config{
		ResourceRoot:      dir,
		RequestTimeout:    time.Second,
		AvatarTimeout:     time.Second,
		SessionTTL:        time.Minute,
		QRSessionTTL:      time.Minute,
		KeepAliveInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app, dir
}
