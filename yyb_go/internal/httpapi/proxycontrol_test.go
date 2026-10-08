package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestApp(t *testing.T) (*App, string) {
	t.Helper()
	t.Setenv("GIN_MODE", "test")
	dir := t.TempDir()
	app, err := NewApp(Config{
		ResourceRoot:   dir,
		RequestTimeout: time.Second,
		AvatarTimeout:  time.Second,
		SessionTTL:     time.Minute,
		QRSessionTTL:   time.Minute,
	})
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app, dir
}

// 面板上的开关：能改、能读、能落盘，且重启后仍然生效
func TestProxySettingsToggleAndPersist(t *testing.T) {
	app, _ := newTestApp(t)
	handler := app.Handler()

	// 初始：没配动态出口时两个开关都是 false
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/proxy/settings", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /proxy/settings = %d", get.Code)
	}
	var summary map[string]any
	if err := json.Unmarshal(get.Body.Bytes(), &summary); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	data, _ := summary["data"].(map[string]any)
	if data["configured"] != false {
		t.Fatalf("未配置动态出口时 configured 应为 false，实际 %v", data["configured"])
	}

	// 改开关
	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/proxy/settings",
		strings.NewReader(`{"scan_via_proxy":true,"code_via_proxy":true}`)))
	if post.Code != http.StatusOK {
		t.Fatalf("POST /proxy/settings = %d body=%s", post.Code, post.Body.String())
	}
	settings := app.getProxySettings()
	if !settings.ScanViaProxy || !settings.CodeViaProxy {
		t.Fatalf("开关没生效: %+v", settings)
	}

	// 部分更新：只关扫码，code 保持不变
	post2 := httptest.NewRecorder()
	handler.ServeHTTP(post2, httptest.NewRequest(http.MethodPost, "/proxy/settings",
		strings.NewReader(`{"scan_via_proxy":false}`)))
	if post2.Code != http.StatusOK {
		t.Fatalf("POST(部分更新) = %d", post2.Code)
	}
	settings = app.getProxySettings()
	if settings.ScanViaProxy || !settings.CodeViaProxy {
		t.Fatalf("部分更新结果不对: %+v", settings)
	}

	// 落盘 + 重建 App 后仍生效（容器重启不丢配置）
	app2, _ := newTestAppInDir(t, app.cfg.ResourceRoot)
	if got := app2.getProxySettings(); got.ScanViaProxy || !got.CodeViaProxy {
		t.Fatalf("重启后没读到已保存的开关: %+v", got)
	}
}

func newTestAppInDir(t *testing.T, dir string) (*App, string) {
	t.Helper()
	t.Setenv("GIN_MODE", "test")
	app, err := NewApp(Config{
		ResourceRoot:   dir,
		RequestTimeout: time.Second,
		AvatarTimeout:  time.Second,
		SessionTTL:     time.Minute,
		QRSessionTTL:   time.Minute,
	})
	if err != nil {
		t.Fatalf("NewApp(复用目录) error = %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app, dir
}
