package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// proxySettings 是可以在后台面板里热切换的代理开关。
//
// 存到 resource/db 下（该目录是挂载卷），所以容器重建也不会丢；
// 文件不存在时用启动参数 / 环境变量给的默认值。
type proxySettings struct {
	// ScanViaProxy：扫码流程（建会话 / 取二维码 / 轮询 / 换登录态）是否走国内出口
	ScanViaProxy bool `json:"scan_via_proxy"`
	// CodeViaProxy：取 code / 取手机号 / operateWxData / 登录态续期是否走国内出口
	CodeViaProxy bool `json:"code_via_proxy"`
}

const proxySettingsFile = "proxy-settings.json"

func (a *App) proxySettingsPath() string {
	return filepath.Join(a.resources.DB, proxySettingsFile)
}

// defaultProxySettings 用启动参数里的默认值（ProxyScan / 动态出口是否配置）
func (a *App) defaultProxySettings() proxySettings {
	enabled := a.cfg.Proxy != nil && a.cfg.Proxy.Status()["enabled"] == true
	return proxySettings{
		ScanViaProxy: enabled && a.cfg.ProxyScan,
		CodeViaProxy: enabled,
	}
}

// loadProxySettings 启动时读一次；坏文件就当没配过，不要因为一个 json 起不来服务
func (a *App) loadProxySettings() {
	settings := a.defaultProxySettings()
	raw, err := os.ReadFile(a.proxySettingsPath())
	if err == nil {
		var saved proxySettings
		if err := json.Unmarshal(raw, &saved); err != nil {
			log.Printf("[proxy] 代理开关配置损坏，改用默认值: %v", err)
		} else {
			settings = saved
		}
	}
	a.proxyMu.Lock()
	a.proxySet = settings
	a.proxyMu.Unlock()
}

func (a *App) getProxySettings() proxySettings {
	a.proxyMu.Lock()
	defer a.proxyMu.Unlock()
	return a.proxySet
}

// proxySettingsPatch 部分更新：不传的字段保持不变
type proxySettingsPatch struct {
	ScanViaProxy *bool `json:"scan_via_proxy"`
	CodeViaProxy *bool `json:"code_via_proxy"`
}

func (a *App) updateProxySettings(patch proxySettingsPatch) (proxySettings, error) {
	a.proxyMu.Lock()
	current := a.proxySet
	if patch.ScanViaProxy != nil {
		current.ScanViaProxy = *patch.ScanViaProxy
	}
	if patch.CodeViaProxy != nil {
		current.CodeViaProxy = *patch.CodeViaProxy
	}
	a.proxySet = current
	a.proxyMu.Unlock()

	body, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return current, err
	}
	return current, os.WriteFile(a.proxySettingsPath(), body, 0o600)
}

// scanProxyValue 扫码流程要用的代理链；开关关掉或没有可用出口时返回静态代理（通常为空=直连）
func (a *App) scanProxyValue() string {
	if a.cfg.Proxy == nil || !a.getProxySettings().ScanViaProxy {
		return a.cfg.TCPProxy
	}
	if v := a.cfg.Proxy.Current(); v != "" {
		return v
	}
	return a.cfg.TCPProxy
}

// proxySummary 把「开关 + 出口状态 + 是否已配置」拼成一份给面板用的视图
func (a *App) proxySummary() map[string]any {
	settings := a.getProxySettings()
	out := map[string]any{
		"configured":     a.cfg.Proxy != nil && a.cfg.Proxy.Status()["enabled"] == true,
		"scan_via_proxy": settings.ScanViaProxy,
		"code_via_proxy": settings.CodeViaProxy,
	}
	if a.cfg.Proxy != nil {
		for k, v := range a.cfg.Proxy.Status() {
			if k == "enabled" {
				continue
			}
			out[k] = v
		}
	}
	return out
}

// handleProxySettings GET 读 / POST 改（面板上的开关）
func (a *App) handleProxySettings(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/proxy/settings" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.proxySummary())
	case http.MethodPost:
		var patch proxySettingsPatch
		if err := decodeOptionalJSON(r, &patch); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if _, err := a.updateProxySettings(patch); err != nil {
			writeError(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, a.proxySummary())
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleProxyRefresh POST /proxy/refresh —— 强制换一个出口（面板上的「立即换出口」）
func (a *App) handleProxyRefresh(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/proxy/refresh" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if a.cfg.Proxy == nil {
		writeError(w, http.StatusBadRequest, "未配置动态出口")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	if err := a.cfg.Proxy.Refresh(ctx); err != nil {
		writeError(w, http.StatusBadGateway, "换出口失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a.proxySummary())
}
