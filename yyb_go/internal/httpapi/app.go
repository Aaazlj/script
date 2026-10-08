package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	httpSwagger "github.com/swaggo/http-swagger/v2"

	"yyb_go/internal/protocol"
	"yyb_go/internal/qr"
	"yyb_go/internal/store"
)

type Config struct {
	ResourceRoot string
	DBFilename   string
	TCPProxy     string
	// Proxy 为空表示不使用动态出口（品赞链路），只用上面的静态 TCPProxy
	Proxy *protocol.ProxyProvider
	// ProxyScan 控制扫码流程（建会话/取二维码/轮询/换登录态）是否也走动态出口
	ProxyScan      bool
	SessionTTL     time.Duration
	RequestTimeout time.Duration
	AvatarTimeout  time.Duration
	ScanTimeout    time.Duration
	QRSessionTTL   time.Duration
}

type App struct {
	cfg       Config
	resources resources
	db        *store.DB
	pool      *protocol.Pool
	qr        *qr.Client

	mu         sync.Mutex
	qrSessions map[string]*qr.Session

	// 登录态刷新的串行化与冷却（见 refreshLiveness）
	refreshMu     sync.Mutex
	refreshLocks  map[int64]*sync.Mutex
	refreshRecent map[int64]refreshMemo

	// 面板可热切换的代理开关（见 proxycontrol.go）
	proxyMu  sync.Mutex
	proxySet proxySettings
}

var swaggerDocsHandler = httpSwagger.Handler(
	httpSwagger.URL("/openapi.json"),
	httpSwagger.DocExpansion("list"),
	httpSwagger.DeepLinking(true),
	httpSwagger.DefaultModelsExpandDepth(httpSwagger.ShowModel),
)

func NewApp(cfg Config) (*App, error) {
	if cfg.ResourceRoot == "" {
		cfg.ResourceRoot = filepath.Join(".", "resource")
	}
	if cfg.DBFilename == "" {
		cfg.DBFilename = DefaultDBFilename
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = 8 * time.Second
	}
	if cfg.AvatarTimeout == 0 {
		cfg.AvatarTimeout = 10 * time.Second
	}
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 30 * time.Minute
	}
	if cfg.QRSessionTTL == 0 {
		cfg.QRSessionTTL = 5 * time.Minute
	}
	res, err := ensureResources(cfg.ResourceRoot)
	if err != nil {
		return nil, err
	}
	dbPath, err := prepareDBPath(res.DB, cfg.DBFilename)
	if err != nil {
		return nil, err
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return nil, err
	}
	poolCfg := protocol.DefaultConfig()
	poolCfg.SessionTTL = cfg.SessionTTL
	poolCfg.ShortlinkTimeout = cfg.RequestTimeout
	poolCfg.TCPProxy = cfg.TCPProxy
	pool := protocol.NewPool(poolCfg, db)

	app := &App{
		cfg:        cfg,
		resources:  res,
		db:         db,
		pool:       pool,
		qr:         qr.NewClient(cfg.RequestTimeout),
		qrSessions: map[string]*qr.Session{},
	}

	// 动态出口（品赞链路）：配置了就让「取 code / 扫码 / 续期」都能走国内出口，
	// 具体走不走由面板里的开关决定（见 proxycontrol.go）。没配置时一切照旧。
	// 开关配置任何时候都要读：即使这次没配动态出口，面板上也要显示上次保存的状态
	app.loadProxySettings()

	if cfg.Proxy != nil && cfg.Proxy.Status()["enabled"] == true {
		// 两个 proxy func 都在调用时才读开关，所以面板一改就立即生效、无需重启
		app.qr.LoginBuffers().SetProxyFunc(app.tcpProxyValue)
		app.qr.SetProxyFunc(app.scanProxyValue)
		// 走代理链时单步耗时会到数秒；另外扫码轮询本身就是长轮询
		// （最长 35 秒才回），客户端超时不能比它短，否则每轮都超时。
		if scanTimeout := 35 * time.Second; app.qr.Timeout() < scanTimeout {
			app.qr.SetTimeout(scanTimeout)
		}
		cfg.Proxy.Start()
		settings := app.getProxySettings()
		log.Printf("[proxy] 动态出口已启用：跳板=%v 扫码走代理=%v 取code走代理=%v",
			cfg.Proxy.Status()["relay"], settings.ScanViaProxy, settings.CodeViaProxy)
	}
	return app, nil
}

func (a *App) Close() error {
	if a.cfg.Proxy != nil {
		a.cfg.Proxy.Close()
	}
	if a.db != nil {
		return a.db.Close()
	}
	return nil
}

func (a *App) Handler() http.Handler {
	if os.Getenv(gin.EnvGinMode) == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.Any("/", gin.WrapF(a.handleIndex))
	router.Any("/scan", gin.WrapF(a.handleScan))
	router.Any("/docs", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/docs/index.html")
	})
	router.Any("/docs/*path", gin.WrapF(a.handleDocs))
	router.Any("/openapi.json", gin.WrapF(a.handleOpenAPI))
	router.Any("/health", func(c *gin.Context) {
		writeJSON(c.Writer, http.StatusOK, gin.H{"ok": true})
	})
	router.StaticFS("/static", http.Dir(a.resources.Static))
	router.Any("/qr", gin.WrapF(a.handleQRRoot))
	router.Any("/qr/*path", gin.WrapF(a.handleQR))
	router.Any("/proxy/status", gin.WrapF(a.handleProxyStatus))
	router.Any("/proxy/settings", gin.WrapF(a.handleProxySettings))
	router.Any("/proxy/refresh", gin.WrapF(a.handleProxyRefresh))
	router.Any("/proxy/probe", gin.WrapF(a.handleProxyProbe))
	router.Any("/accounts", gin.WrapF(a.handleAccountsRoot))
	router.Any("/accounts/export", gin.WrapF(a.handleAccountsExport))
	router.Any("/accounts/import", gin.WrapF(a.handleAccountsImport))
	router.Any("/accounts/order", gin.WrapF(a.handleAccountsOrder))
	router.Any("/accounts/scripts", gin.WrapF(a.handleAccountsScripts))
	router.Any("/accounts/avatar", gin.WrapF(a.handleAccountAvatar))
	router.Any("/accounts/refresh", gin.WrapF(a.handleAccountRefresh))
	router.Any("/accounts/resync", gin.WrapF(a.handleAccountResync))
	router.Any("/wxapp/getCode", gin.WrapF(a.handleGetCode))
	router.Any("/wxapp/getPhoneNumber", gin.WrapF(a.handleGetPhoneNumber))
	router.Any("/wxapp/operateWxData", gin.WrapF(a.handleOperateWXData))
	router.NoRoute(func(c *gin.Context) {
		writeError(c.Writer, http.StatusNotFound, "not found")
	})

	return router
}

func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	serveFileOrText(w, r, filepath.Join(a.resources.Templates, "index.html"), fallbackIndexHTML)
}

func (a *App) handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	serveFileOrText(w, r, filepath.Join(a.resources.Templates, "scan.html"), fallbackScanHTML)
}

func (a *App) handleDocs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.URL.Path == "/docs/" {
		http.Redirect(w, r, "/docs/index.html", http.StatusMovedPermanently)
		return
	}
	swaggerDocsHandler.ServeHTTP(w, r)
}

func (a *App) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeRawJSON(w, http.StatusOK, openAPISpec)
}

func (a *App) handleQRRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/qr" {
		writeError(w, http.StatusNotFound, "qr session not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	a.pruneQR()
	// 预算是给代理链留余量的：走国内住宅出口时单步可能十几秒
	// （面板侧的超时是 60 秒，这里别比它先放弃）
	budget := a.cfg.RequestTimeout + 35*time.Second
	if a.cfg.ProxyScan {
		budget = a.cfg.RequestTimeout + 50*time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()
	img, err := a.qr.GetQRCodeImage(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	a.mu.Lock()
	a.qrSessions[img.Session.ID] = img.Session
	keep := make(map[string]bool, len(a.qrSessions))
	for sid := range a.qrSessions {
		keep[sid] = true
	}
	a.mu.Unlock()
	path := a.resources.qrPath(img.Session.ID)
	_ = os.WriteFile(path, img.ImageBytes, 0o644)
	a.cleanupQR(keep)
	out := map[string]any{
		"session_id": img.Session.ID,
		"status":     img.Session.Status,
		"image_url":  "/qr/" + img.Session.ID + "/image",
	}
	if r.URL.Query().Get("as_base64") == "true" {
		out["image_base64"] = qr.DataURIJPEG(img.ImageBytes)
	} else {
		out["image_base64"] = nil
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleQR(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/qr/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "qr session not found")
		return
	}
	sessionID, action := parts[0], parts[1]
	switch action {
	case "image":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		path := a.resources.qrPath(sessionID)
		if _, err := os.Stat(path); err != nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, path)
	case "poll":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		sess := a.getQRSession(sessionID)
		if sess == nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		result, err := a.qr.PollQRCode(r.Context(), sess)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if terminalQR(result.Status) {
			a.dropQRSession(sessionID)
		}
		writeJSON(w, http.StatusOK, result)
	case "confirm":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		sess := a.getQRSession(sessionID)
		if sess == nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		result, err := a.qr.GetLoginBuffer(r.Context(), sess)
		if err != nil {
			writeError(w, http.StatusConflict, "buffer not ready: "+err.Error())
			return
		}
		var userInfo map[string]any
		if ui, err := a.qr.LoginBuffers().FetchUserInfo(r.Context(), result.Credentials); err == nil {
			userInfo = ui
		}
		acc, err := a.storeFromScan(r.Context(), result.LoginBuffer, result.Credentials, userInfo)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		a.dropQRSession(sessionID)
		writeJSON(w, http.StatusOK, acc.Public())
	default:
		writeError(w, http.StatusNotFound, "qr session not found")
	}
}

// GET /proxy/status —— 看当前国内出口是什么、还有多久过期、上次报错
func (a *App) handleProxyStatus(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/proxy/status" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if a.cfg.Proxy == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "hint": "未配置动态出口，当前走直连或静态代理"})
		return
	}
	writeJSON(w, http.StatusOK, a.proxySummary())
}

// POST /proxy/probe[?host=&port=] —— 用当前出口真连一次目标，验证「跳板→品赞→目标」是否通
func (a *App) handleProxyProbe(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/proxy/probe" {
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
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	port := 80
	if v := strings.TrimSpace(r.URL.Query().Get("port")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}
	if host == "" {
		host = defaultProbeHost
		port = defaultProbePort
	}
	started := time.Now()
	chain, err := a.cfg.Proxy.Probe(r.Context(), host, port, a.cfg.RequestTimeout+7*time.Second)
	out := map[string]any{
		"target":     fmt.Sprintf("%s:%d", host, port),
		"chain":      maskChain(chain),
		"elapsed_ms": time.Since(started).Milliseconds(),
	}
	if err != nil {
		out["ok"] = false
		out["error"] = err.Error()
		writeJSON(w, http.StatusBadGateway, out)
		return
	}
	out["ok"] = true
	writeJSON(w, http.StatusOK, out)
}

const (
	// 默认拿微信 HTTPDNS 的长连接节点来试：实测国内住宅出口到它的连通性
	// 明显好于短连接备用 IP（120.241.131.173 经常连不上，会让「测试链路」误报不通）
	defaultProbeHost = "180.153.202.85"
	defaultProbePort = 80
)

// maskChain 只保留出口的 host:port，抹掉用户名密码
func maskChain(chain string) string {
	if chain == "" {
		return ""
	}
	parts := strings.Split(chain, protocol.ProxyChainSeparator())
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if u, err := url.Parse(part); err == nil && u.Host != "" {
			out = append(out, u.Scheme+"://"+u.Host)
			continue
		}
		out = append(out, "?")
	}
	return strings.Join(out, protocol.ProxyChainSeparator())
}

func (a *App) handleAccountsRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		accounts, err := a.db.ListAccounts(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out := make([]store.AccountPublic, 0, len(accounts))
		for _, acc := range accounts {
			out = append(out, acc.Public())
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodDelete:
		acc, ok := a.resolveAccountFromQuery(w, r)
		if !ok {
			return
		}
		if err := a.db.DeleteAccount(r.Context(), acc.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": acc.ID, "openid": acc.OpenID})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

/* ---------------- 导出 / 导入 / 排序 ---------------- */

// writeAccountList 把当前账号列表（公共视图）写给调用方，导入/排序后方便一次刷新
func (a *App) writeAccountList(ctx context.Context, extra map[string]any) map[string]any {
	accounts, err := a.db.ListAccounts(ctx)
	if err != nil {
		return extra
	}
	out := make([]store.AccountPublic, 0, len(accounts))
	for _, acc := range accounts {
		out = append(out, acc.Public())
	}
	extra["accounts"] = out
	return extra
}

// GET /accounts/export[?ref=] —— 导出账号（含 login_buffer / credentials / user_info），
// 返回纯数组，字段与其它工具（taobao-tool 等）的 yyb 账号文件一致，便于互导。
func (a *App) handleAccountsExport(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/export" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))
	out := make([]store.ExportAccount, 0, len(accounts))
	for _, acc := range accounts {
		if !acc.MatchesRef(ref) {
			continue
		}
		out = append(out, acc.Export())
	}
	if ref != "" && len(out) == 0 {
		writeError(w, http.StatusNotFound, "未找到账号: "+ref)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /accounts/import —— 导入账号。接受纯数组、{"accounts":[...]} 或单个对象；
// 按 openid upsert（已存在则更新登录态，缺字段保留原值）。
func (a *App) handleAccountsImport(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/import" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "读取请求体失败: "+err.Error())
		return
	}
	items, err := decodeAccountPayload(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(items) == 0 {
		writeError(w, http.StatusBadRequest, "没有可导入的账号")
		return
	}

	created, updated := 0, 0
	skipped := make([]map[string]any, 0)
	for _, item := range items {
		acc, err := store.NormalizeImport(item)
		if err != nil {
			skipped = append(skipped, map[string]any{
				"openid": strings.TrimSpace(coerceStringAny(item["openid"])),
				"reason": err.Error(),
			})
			continue
		}
		isNew, err := a.db.UpsertFullAccount(r.Context(), acc)
		if err != nil {
			skipped = append(skipped, map[string]any{"openid": acc.OpenID, "reason": err.Error()})
			continue
		}
		if isNew {
			created++
		} else {
			updated++
		}
	}

	out := a.writeAccountList(r.Context(), map[string]any{
		"created": created,
		"updated": updated,
		"skipped": skipped,
	})
	writeJSON(w, http.StatusOK, out)
}

// POST /accounts/order —— 按 {"refs":[...]}（或 {"order":[...]}）的顺序重排账号，
// 脚本按 /accounts 返回顺序逐个取 code，所以顺序在这里定。
func (a *App) handleAccountsOrder(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/order" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		Refs  []string `json:"refs"`
		Order []string `json:"order"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	refs := body.Refs
	if len(refs) == 0 {
		refs = body.Order
	}
	if len(refs) == 0 {
		writeError(w, http.StatusBadRequest, "缺少 refs")
		return
	}
	// 全是空字符串也当没传
	nonEmpty := 0
	for _, r := range refs {
		if strings.TrimSpace(r) != "" {
			nonEmpty++
		}
	}
	if nonEmpty == 0 {
		writeError(w, http.StatusBadRequest, "refs 不能全为空")
		return
	}
	ordered, err := a.db.SetAccountOrder(r.Context(), refs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ordered == 0 {
		writeError(w, http.StatusBadRequest, "refs 里没有匹配到任何账号（支持 ID / UIN / openid）")
		return
	}
	out := a.writeAccountList(r.Context(), map[string]any{"ordered": ordered})
	writeJSON(w, http.StatusOK, out)
}

// accountScriptsIn 是 POST /accounts/scripts 的入参，支持两种写法：
//
//	单个： {"ref":"1","scripts":"mt,sfsy"}
//	批量： {"items":[{"ref":"1","scripts":"mt"},{"ref":"2","scripts":""}]}
//
// scripts 传空串表示清除标记 —— 该账号恢复成「所有脚本都跑它」；
// 字段缺省（null）表示不动这一项。
type accountScriptsIn struct {
	Ref     string               `json:"ref"`
	Scripts *string              `json:"scripts"`
	Items   []accountScriptsItem `json:"items"`
}

type accountScriptsItem struct {
	Ref     string  `json:"ref"`
	Scripts *string `json:"scripts"`
}

// POST /accounts/scripts —— 设置账号的「跑哪些脚本」标记。
//
// 标记是逗号分隔的脚本 key（如 mt,sfsy,ppcs），落在账号表上，
// 由各个脚本自己拉 /accounts 时按 key 过滤：标记为空 = 不限制。
func (a *App) handleAccountsScripts(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/scripts" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body accountScriptsIn
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	items := body.Items
	if len(items) == 0 && strings.TrimSpace(body.Ref) != "" {
		items = []accountScriptsItem{{Ref: body.Ref, Scripts: body.Scripts}}
	}
	if len(items) == 0 {
		writeError(w, http.StatusBadRequest, "缺少 ref 或 items")
		return
	}

	updated := 0
	skipped := make([]map[string]any, 0)
	for _, item := range items {
		ref := strings.TrimSpace(item.Ref)
		if ref == "" {
			skipped = append(skipped, map[string]any{"ref": item.Ref, "reason": "ref 为空"})
			continue
		}
		acc, err := a.db.ResolveAccount(r.Context(), ref)
		if err != nil {
			reason := err.Error()
			if errors.Is(err, sql.ErrNoRows) {
				reason = "未找到账号: " + ref
			}
			skipped = append(skipped, map[string]any{"ref": ref, "reason": reason})
			continue
		}
		value := ""
		if item.Scripts != nil {
			value = *item.Scripts
		}
		if err := a.db.SetAccountScripts(r.Context(), acc.ID, value); err != nil {
			skipped = append(skipped, map[string]any{"ref": ref, "reason": err.Error()})
			continue
		}
		updated++
	}

	out := a.writeAccountList(r.Context(), map[string]any{"updated": updated, "skipped": skipped})
	writeJSON(w, http.StatusOK, out)
}

// decodeAccountPayload 兼容三种入参：数组、{"accounts":[...]}、单个账号对象
func decodeAccountPayload(raw []byte) ([]map[string]any, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, errors.New("请求体为空")
	}
	switch trimmed[0] {
	case '[':
		var list []map[string]any
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, errors.New("账号列表不是合法 JSON 数组: " + err.Error())
		}
		return list, nil
	case '{':
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			return nil, errors.New("请求体不是合法 JSON: " + err.Error())
		}
		for _, key := range []string{"accounts", "data", "list", "items"} {
			if arr, ok := obj[key].([]any); ok {
				out := make([]map[string]any, 0, len(arr))
				for _, v := range arr {
					if m, ok := v.(map[string]any); ok {
						out = append(out, m)
					}
				}
				return out, nil
			}
		}
		return []map[string]any{obj}, nil
	default:
		return nil, errors.New("请求体应为 JSON 数组或对象")
	}
}

func coerceStringAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func (a *App) handleAccountAvatar(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/avatar" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	acc, ok := a.resolveAccountFromQuery(w, r)
	if !ok {
		return
	}
	a.serveAvatar(w, r, acc)
}

func (a *App) handleAccountRefresh(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/refresh" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body accountRefIn
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		a.refreshAll(w, r)
		return
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	status := a.refreshLiveness(r.Context(), acc)
	writeJSON(w, http.StatusOK, refreshOut(acc, status))
}

func (a *App) handleAccountResync(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/resync" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body accountRefIn
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		a.resyncAll(w, r)
		return
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	updated, err := a.resyncProfile(r.Context(), acc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated.Public())
}

func (a *App) handleGetCode(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/getCode") {
		return
	}
	a.callWXApp(w, r, false, a.invokeGetCode)
}

func (a *App) handleGetPhoneNumber(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/getPhoneNumber") {
		return
	}
	a.callWXApp(w, r, false, a.invokeGetPhoneNumber)
}

func (a *App) handleOperateWXData(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/operateWxData") {
		return
	}
	a.callWXApp(w, r, true, a.invokeOperateWXData)
}

func acceptWXAppRoute(w http.ResponseWriter, r *http.Request, path string) bool {
	if r.URL.Path != path {
		writeError(w, http.StatusNotFound, "not found")
		return false
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return false
	}
	return true
}

type accountRefIn struct {
	Ref string `json:"ref"`
}

type wxappRequest struct {
	Ref     string         `json:"ref"`
	AppID   string         `json:"app_id"`
	Payload map[string]any `json:"payload"`
}

type wxappCall func(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any) (map[string]any, error)

func (a *App) callWXApp(w http.ResponseWriter, r *http.Request, requirePayload bool, call wxappCall) {
	var body wxappRequest
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		writeError(w, http.StatusBadRequest, "ref is required")
		return
	}
	if body.AppID == "" {
		writeError(w, http.StatusBadRequest, "app_id is required")
		return
	}
	if requirePayload && body.Payload == nil {
		writeError(w, http.StatusBadRequest, "payload is required")
		return
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	result, err := a.invokeWXApp(r.Context(), acc, body.AppID, body.Payload, call)
	if err != nil {
		var unusable accountUnusableError
		switch {
		case errors.As(err, &unusable) && unusable.status == "expired":
			writeError(w, http.StatusConflict, "account login_buffer expired (refresh rejected); re-scan required")
		case errors.As(err, &unusable):
			// 状态是 unknown：续期这次没成功，但也说不准号就一定没了，别催人重扫。
			writeError(w, http.StatusBadGateway,
				"account is temporarily unusable (status="+unusable.status+"); retry later")
		default:
			writeError(w, http.StatusBadGateway, "call failed: "+err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"openid": acc.OpenID, "result": result})
}

func decodeOptionalJSON(r *http.Request, dst any) error {
	err := json.NewDecoder(r.Body).Decode(dst)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (a *App) resolveAccountFromQuery(w http.ResponseWriter, r *http.Request) (*store.WechatAccount, bool) {
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))
	if ref == "" {
		writeError(w, http.StatusBadRequest, "ref query param is required")
		return nil, false
	}
	return a.resolveAccountRef(w, r, ref)
}

func (a *App) resolveAccountRef(w http.ResponseWriter, r *http.Request, ref string) (*store.WechatAccount, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		writeError(w, http.StatusBadRequest, "ref is required")
		return nil, false
	}
	acc, err := a.db.ResolveAccount(r.Context(), ref)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "account not found: "+ref)
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return nil, false
	}
	return acc, true
}

func (a *App) refreshAll(w http.ResponseWriter, r *http.Request) {
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]map[string]any, 0, len(accounts))
	for _, acc := range accounts {
		out = append(out, refreshOut(acc, a.refreshLiveness(r.Context(), acc)))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) resyncAll(w http.ResponseWriter, r *http.Request) {
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]store.AccountPublic, 0, len(accounts))
	for _, acc := range accounts {
		updated, err := a.resyncProfile(r.Context(), acc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out = append(out, updated.Public())
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) serveAvatar(w http.ResponseWriter, r *http.Request, acc *store.WechatAccount) {
	if acc.Avatar != nil && *acc.Avatar != "" {
		if _, err := os.Stat(*acc.Avatar); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			http.ServeFile(w, r, *acc.Avatar)
			return
		}
		if strings.HasPrefix(*acc.Avatar, "http://") || strings.HasPrefix(*acc.Avatar, "https://") {
			http.Redirect(w, r, *acc.Avatar, http.StatusFound)
			return
		}
	}
	writeError(w, http.StatusNotFound, "no avatar")
}

func (a *App) storeFromScan(ctx context.Context, loginBuffer string, creds protocol.LoginBufferCredentials, userInfo map[string]any) (*store.WechatAccount, error) {
	openid := creds.OpenID
	nick := pickNickname(userInfo, creds.Nickname)
	avatar := a.resolveAvatar(ctx, openid, userInfo)
	status := "alive"
	return a.db.UpsertAccount(ctx, openid, loginBuffer, stringPtrMaybe(nick), stringPtrMaybe(nick), stringPtrMaybe(avatar), userInfo, creds.ToMap(), &status)
}

// refreshLiveness 复查账号还能不能续期，并按「确定性 / 不确定」三分法落库状态：
//
//   - 凭据本身就是死的（没有 refresh token，或腾讯明确拒绝）→ expired，只能重新扫码；
//   - 这次请求失败（超时 / 代理挂了 / DNS 抖动 / HTTP 5xx）而 access token 还没到期
//     → 保持原状态不动，别把好号误判成失效；
//   - 不确定且 access token 已过期 → unknown，等下次重试，不冒充「已失效」；
//   - 原本已经是 expired 的不会被降级成 unknown：expired 是明确结论，只靠
//     刷新成功或重新扫码离开，不靠一次失败的请求。
//
// 旧实现是「只要 RefreshLoginBuffer 返回 error 就 expired」，一次网络抖动就能把
// 好号打成失效（脚本随即跳过它），代价是必须人工重新扫码——这里修的就是这条。
// refreshCooldown：同一账号在这么短的时间内只真刷一次。
//
// 微信侧的 refresh token 每次使用都会轮换，两次并发刷新必然有一条拿着已作废的
// 旧 token 被拒（-109 RC_PARAMS_INVALID），账号就"莫名其妙"失效了。面板连点、
// 多个青龙脚本同时跑、或脚本与面板同时刷新，都会踩到。这里做两件事：
//  1. 同一账号的刷新串行执行；
//  2. 冷却期内直接复用上一次结果（拿锁前后各查一次，避免惊群）。
const refreshCooldown = 90 * time.Second

type refreshMemo struct {
	at     time.Time
	status string
}

func (a *App) refreshLiveness(ctx context.Context, acc *store.WechatAccount) string {
	if status, ok := a.recentRefreshStatus(acc.ID); ok {
		return status
	}

	lock := a.accountRefreshLock(acc.ID)
	lock.Lock()
	defer lock.Unlock()

	// 等锁期间可能已经有别的请求刷完了
	if status, ok := a.recentRefreshStatus(acc.ID); ok {
		return status
	}

	status := a.doRefreshLiveness(ctx, acc)
	a.rememberRefresh(acc.ID, status)
	return status
}

func (a *App) recentRefreshStatus(id int64) (string, bool) {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	memo, ok := a.refreshRecent[id]
	if !ok || time.Since(memo.at) >= refreshCooldown {
		return "", false
	}
	return memo.status, true
}

func (a *App) rememberRefresh(id int64, status string) {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	if a.refreshRecent == nil {
		a.refreshRecent = map[int64]refreshMemo{}
	}
	a.refreshRecent[id] = refreshMemo{at: time.Now(), status: status}
}

func (a *App) accountRefreshLock(id int64) *sync.Mutex {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	if a.refreshLocks == nil {
		a.refreshLocks = map[int64]*sync.Mutex{}
	}
	if a.refreshLocks[id] == nil {
		a.refreshLocks[id] = &sync.Mutex{}
	}
	return a.refreshLocks[id]
}

func (a *App) doRefreshLiveness(ctx context.Context, acc *store.WechatAccount) string {
	if acc.Credentials == nil {
		// 从没扫过码、或导入时没带凭据：没有任何可续期的材料。
		_ = a.db.SetAccountStatus(ctx, acc.ID, "unknown")
		return "unknown"
	}
	creds := protocol.CredentialsFromMap(acc.Credentials)
	result, err := a.qr.RefreshLoginBuffer(ctx, creds)
	if err != nil {
		status := refreshFailureStatus(currentAccountStatus(acc), creds, err, time.Now())
		// 失败原因必须落日志：面板上只看到 expired，不知道到底是凭据真废了
		// 还是网络/网关抖动，排查时全靠这一行。
		log.Printf("[refresh] 账号 #%d %s → %s（%s）：%v",
			acc.ID, accountLabel(acc), status, credsExpiryHint(creds), err)
		_ = a.db.SetAccountStatus(ctx, acc.ID, status)
		return status
	}
	_ = a.db.SetAccountCredential(ctx, acc.ID, result.LoginBuffer, result.Credentials.ToMap())
	_ = a.db.SetAccountStatus(ctx, acc.ID, "alive")
	if avatar := a.resolveAvatar(ctx, acc.OpenID, acc.UserInfo); avatar != "" {
		_ = a.db.SetAccountProfile(ctx, acc.ID, acc.Nickname, &avatar, acc.UserInfo)
	}
	return "alive"
}

// accountLabel 给日志一个能认出人的短标识
func accountLabel(acc *store.WechatAccount) string {
	if acc == nil {
		return "?"
	}
	if acc.Nickname != nil && strings.TrimSpace(*acc.Nickname) != "" {
		return *acc.Nickname
	}
	openid := acc.OpenID
	if len(openid) > 10 {
		openid = openid[:10] + "…"
	}
	return openid
}

// credsExpiryHint 说明 access token 是否还有效，便于区分「号废了」和「这次请求失败」
func credsExpiryHint(creds protocol.LoginBufferCredentials) string {
	if creds.ExpiresAt <= 0 {
		return "无过期时间"
	}
	left := time.Until(time.Unix(creds.ExpiresAt, 0))
	if left > 0 {
		return fmt.Sprintf("access token 还剩 %s", left.Truncate(time.Minute))
	}
	return fmt.Sprintf("access token 已过期 %s", (-left).Truncate(time.Minute))
}

// refreshFailureStatus 把一次续期失败翻译成账号状态。current 是失败前的状态。
func refreshFailureStatus(current string, creds protocol.LoginBufferCredentials, err error, now time.Time) string {
	if definitiveCredentialFailure(err) {
		return "expired"
	}
	if creds.ExpiresAt > now.Unix() {
		// access token 还没到期，说明这次失败跟号本身无关，别动状态。
		return current
	}
	if current == "expired" {
		// 已经是「必须重新扫码」的明确结论了。一次说不清的失败不该把它降级成
		// unknown——那只会让面板变得不可操作（人不知道该不该去重扫）。
		// expired 只能靠「刷新成功」或「重新扫码」离开，不是靠一次请求失败。
		return "expired"
	}
	return "unknown"
}

// definitiveCredentialFailure 判断错误是否属于「凭据 / 授权本身已作废」，即腾讯明确拒绝。
// 只有这类错误才配把账号打成 expired——因为 expired 对使用者意味着「必须重新扫码」。
func definitiveCredentialFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, protocol.ErrMissingRefreshToken) {
		return true
	}
	var rejected *protocol.AuthRejectedError
	if errors.As(err, &rejected) {
		if _, ok := definitiveAuthRejections[rejected.Code]; ok {
			return true
		}
		return definitiveRejectionMessage(rejected.Error())
	}
	var httpErr *protocol.HTTPStatusError
	if errors.As(err, &httpErr) {
		// 请求压根没走到业务逻辑（可能是中间网关/WAF/CDN 的问题），不拿它判凭据死活。
		return false
	}
	// 其余都是传输层错误（超时 / DNS / 代理 / JSON 解析）。留一道文案兜底：
	// 万一有哪条路径把业务错误包成了普通 error，也不至于漏判。
	return definitiveRejectionMessage(err.Error())
}

// definitiveAuthRejections 是腾讯 pc_yyb 侧「凭据 / 授权已作废」的业务码，命中即必须重新扫码。
// 未列出的业务码一律按「服务端这次不认，但原因不明」处理——宁可保守，也不误杀好号。
var definitiveAuthRejections = map[int]string{
	-109:  "RC_PARAMS_INVALID：refresh token 已作废（刷新第一步就被拒，实测签名）",
	-101:  "[40188] invalid scope：token 还在，但授权 scope 失效（取 login_buffer 被拒，实测签名）",
	42007: "refresh_token 相关拒绝",
}

// definitiveRejectionMessage 是业务码之外的文案兜底：错误串里同时出现
// 「无效 / 过期 / 失效」类词和「token / 登录 / 授权」类词，或直接要求重新登录时判为确定性失效。
func definitiveRejectionMessage(raw string) bool {
	message := strings.ToLower(strings.TrimSpace(raw))
	if message == "" {
		return false
	}
	for code := range definitiveAuthRejections {
		if strings.Contains(message, fmt.Sprintf("code=%d", code)) {
			return true
		}
	}
	if strings.Contains(message, "42007") && strings.Contains(message, "refresh_token") {
		return true
	}
	if strings.Contains(message, "40188") && strings.Contains(message, "invalid scope") {
		return true
	}
	invalid := strings.Contains(message, "invalid") || strings.Contains(message, "expired") ||
		strings.Contains(message, "expire") || strings.Contains(message, "无效") ||
		strings.Contains(message, "过期") || strings.Contains(message, "失效")
	token := strings.Contains(message, "token") || strings.Contains(message, "登录") ||
		strings.Contains(message, "凭证") || strings.Contains(message, "授权")
	relogin := strings.Contains(message, "relogin") || strings.Contains(message, "re-login") ||
		strings.Contains(message, "重新登录") || strings.Contains(message, "重新授权")
	return relogin || (invalid && token)
}

// currentAccountStatus 规整账号当前状态：库里可能存 NULL 或历史遗留值，
// 一律当作 unknown，避免把空字符串当成状态写回去。
func currentAccountStatus(acc *store.WechatAccount) string {
	if acc == nil || acc.Status == nil {
		return "unknown"
	}
	switch s := strings.TrimSpace(*acc.Status); s {
	case "alive", "expired", "unknown":
		return s
	default:
		return "unknown"
	}
}

func (a *App) resyncProfile(ctx context.Context, acc *store.WechatAccount) (*store.WechatAccount, error) {
	nick := pickNickname(acc.UserInfo, deref(acc.Nickname))
	avatar := a.resolveAvatar(ctx, acc.OpenID, acc.UserInfo)
	if avatar == "" {
		avatar = deref(acc.Avatar)
	}
	if err := a.db.SetAccountProfile(ctx, acc.ID, stringPtrMaybe(nick), stringPtrMaybe(avatar), acc.UserInfo); err != nil {
		return nil, err
	}
	return a.db.GetAccount(ctx, acc.ID)
}

// accountUnusableError 表示账号当前取不到登录态，无法代它调微信接口。
// 特意带上 status：expired 是「必须重新扫码」，unknown 只是「这次说不准，待会儿再试」，
// 两者对调用方的意义完全不同，不能都报成「请重新扫码」。
type accountUnusableError struct {
	openid string
	status string
}

func (e accountUnusableError) Error() string {
	return "account not usable: " + e.openid + " (status=" + e.status + ")"
}

// tcpProxyValue 返回本次请求要用的代理链：优先用动态出口（品赞国内 IP），
// 拿不到时退回静态代理，再没有就直连（dialTCP 自己会按 fallbackDirect 兜底）。
func (a *App) tcpProxyValue() string {
	if a.cfg.Proxy == nil || !a.getProxySettings().CodeViaProxy {
		return a.cfg.TCPProxy
	}
	if v := a.cfg.Proxy.Current(); v != "" {
		return v
	}
	return a.cfg.TCPProxy
}

func (a *App) invokeWXApp(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any, call wxappCall) (map[string]any, error) {
	proxy := a.tcpProxyValue()
	if _, err := a.db.GetSession(ctx, acc.ID, proxy); err == nil {
		result, err := call(ctx, acc, appID, payload)
		if err == nil {
			return result, nil
		}
		_ = a.db.InvalidateSession(ctx, acc.ID, proxy)
	}
	status := a.refreshLiveness(ctx, acc)
	if status != "alive" {
		return nil, accountUnusableError{openid: acc.OpenID, status: status}
	}
	fresh, err := a.db.GetAccount(ctx, acc.ID)
	if err == nil && fresh != nil {
		acc = fresh
	}
	return call(ctx, acc, appID, payload)
}

func (a *App) invokeGetCode(ctx context.Context, acc *store.WechatAccount, appID string, _ map[string]any) (map[string]any, error) {
	return a.pool.GetCode(ctx, acc.LoginBuffer, appID, acc.ID, a.tcpProxyValue())
}

func (a *App) invokeGetPhoneNumber(ctx context.Context, acc *store.WechatAccount, appID string, _ map[string]any) (map[string]any, error) {
	return a.pool.GetPhoneNumber(ctx, acc.LoginBuffer, appID, acc.ID, a.tcpProxyValue())
}

func (a *App) invokeOperateWXData(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any) (map[string]any, error) {
	return a.pool.OperateWXData(ctx, acc.LoginBuffer, appID, payload, acc.ID, a.tcpProxyValue())
}

func refreshOut(acc *store.WechatAccount, status string) map[string]any {
	return map[string]any{"id": acc.ID, "openid": acc.OpenID, "uin": acc.UIN, "nickname": acc.Nickname, "status": status}
}

func pickNickname(userInfo map[string]any, fallback string) string {
	if s := stringFromAny(userInfo["nick_name"]); s != "" {
		return s
	}
	return fallback
}

func pickAvatarURL(userInfo map[string]any) string {
	for _, k := range []string{"head_img_url", "head_url", "headimgurl", "avatar"} {
		if s := stringFromAny(userInfo[k]); s != "" {
			return s
		}
	}
	return ""
}

func (a *App) resolveAvatar(ctx context.Context, openid string, userInfo map[string]any) string {
	u := pickAvatarURL(userInfo)
	if u == "" {
		return ""
	}
	dest := a.resources.avatarPath(openid)
	if downloadAvatar(ctx, u, dest, a.cfg.AvatarTimeout) {
		return dest
	}
	return u
}

func downloadAvatar(ctx context.Context, url, dest string, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode != 200 || !looksLikeImage(data) {
		return false
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	return os.WriteFile(dest, data, 0o644) == nil
}

func looksLikeImage(data []byte) bool {
	if len(data) < 64 {
		return false
	}
	magics := [][]byte{{0xff, 0xd8, 0xff}, {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, []byte("GIF87a"), []byte("GIF89a")}
	for _, m := range magics {
		if strings.HasPrefix(string(data), string(m)) {
			return true
		}
	}
	return false
}

func (a *App) getQRSession(id string) *qr.Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.qrSessions[id]
}

func (a *App) dropQRSession(id string) {
	a.mu.Lock()
	delete(a.qrSessions, id)
	a.mu.Unlock()
	_ = os.Remove(a.resources.qrPath(id))
}

func (a *App) pruneQR() {
	a.mu.Lock()
	var drop []string
	for sid, sess := range a.qrSessions {
		if sess.Age() > a.cfg.QRSessionTTL {
			drop = append(drop, sid)
		}
	}
	for _, sid := range drop {
		delete(a.qrSessions, sid)
	}
	a.mu.Unlock()
	for _, sid := range drop {
		_ = os.Remove(a.resources.qrPath(sid))
	}
}

func (a *App) cleanupQR(keep map[string]bool) {
	files, _ := filepath.Glob(filepath.Join(a.resources.QR, "*.jpg"))
	for _, f := range files {
		sid := strings.TrimSuffix(filepath.Base(f), ".jpg")
		if !keep[sid] {
			_ = os.Remove(f)
		}
	}
}

func terminalQR(status string) bool {
	return status == "expired" || status == "cancelled" || status == "unknown"
}

type apiEnvelope struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data any    `json:"data"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	writeRawJSON(w, status, apiEnvelope{
		Code: 0,
		Msg:  "success",
		Data: v,
	})
}

func writeRawJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeRawJSON(w, status, apiEnvelope{
		Code: status,
		Msg:  detail,
		Data: nil,
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func serveFileOrText(w http.ResponseWriter, r *http.Request, path, fallback string) {
	if _, err := os.Stat(path); err == nil {
		http.ServeFile(w, r, path)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(fallback))
}

func stringFromAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func stringPtrMaybe(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func safeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sortedKeys[M ~map[string]V, V any](m M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
