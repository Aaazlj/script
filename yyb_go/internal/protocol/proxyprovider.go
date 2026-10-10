package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProxyProvider 从提取接口（品赞）拿国内住宅出口，并组装成一条代理链给协议层用。
//
// 为什么必须是链而不是单跳：品赞的代理端口从海外服务器直连是 TCP 超时
// （被网络层屏蔽），但经本机树脂中转可以建立连接——实测
// 「本机 → 树脂 → 品赞出口 → 目标」整条链能拿到目标的真实响应。
//
// 出口按窗口轮换：提取到的 IP 有寿命（接口里的 minute 参数），
// 在寿命耗尽前一直复用它，避免每次请求都重握手（mmtls 会话是按
// 「账号 + 代理」缓存的，频繁换代理会导致反复握手）。
type ProxyProviderConfig struct {
	ExtractURL  string        // 品赞提取接口（含 secret），空表示不启用
	Relay       string        // 跳到品赞所需的跳板，如 http-connect://:token@172.19.0.1:2260
	ProxyScheme string        // 品赞出口协议：http-connect（protocol=1）/ socks5（protocol=2）
	Timeout     time.Duration // 提取请求超时
	RotateAhead time.Duration // 提前多久换出口
	// URLTTL 是从提取 URL 的 minute 参数推出来的寿命，纯文本格式不返回过期时间时用它
	URLTTL time.Duration
	// RetryBackoff 提取失败后的退避时间（默认 60 秒），避免把提取接口打爆
	RetryBackoff time.Duration
	// IdleStopAfter：距最后一次「真的用到出口」超过这么久，就完全停止提取。
	//
	// 提取接口是按次计费的（品赞 10 分钟档 0.02/次），24 小时无条件预热
	// 一天要烧 144 次 ≈ 2.88 元，而脚本一天只用几个时间点 —— 空转的九成以上
	// 都是白花的钱。改成只在活跃期（有请求真的用过出口）才预热。
	IdleStopAfter time.Duration
	// WaitForExit：请求来了但手上没有可用出口时，最多等这么久让后台提取赶上。
	// 首个请求值得等这一下，否则这一次会退回直连（海外 IP），失去走国内出口的意义。
	WaitForExit time.Duration
}

type ProxyProvider struct {
	cfg    ProxyProviderConfig
	client *http.Client

	mu            sync.Mutex
	refreshing    bool
	lastAttemptAt time.Time
	lastDemandAt  time.Time // 最后一次「有请求真的需要出口」，用于判断活跃期
	current       *tcpProxy
	expireAt      time.Time
	lastErr       string
	extracts      int64
	lastAt        time.Time

	stopOnce sync.Once
	stopCh   chan struct{}
}

type extractEntry struct {
	IP       string `json:"ip"`
	Port     string `json:"port"`
	Expired  int64  `json:"expired"` // 毫秒时间戳
	Net      string `json:"net"`
	Account  string `json:"account"`
	Password string `json:"password"`
}

type extractResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		List []extractEntry `json:"list"`
	} `json:"data"`
}

// ProxyChainSeparator 暴露代理链分隔符，便于上层把链打码展示
func ProxyChainSeparator() string { return proxyChainSeparator }

func NewProxyProvider(cfg ProxyProviderConfig) *ProxyProvider {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.RotateAhead <= 0 {
		cfg.RotateAhead = 20 * time.Second
	}
	if cfg.ProxyScheme == "" {
		cfg.ProxyScheme = "http-connect"
	}
	if cfg.URLTTL <= 0 {
		cfg.URLTTL = minuteFromURL(cfg.ExtractURL)
	}
	if cfg.RetryBackoff <= 0 {
		cfg.RetryBackoff = 60 * time.Second
	}
	if cfg.IdleStopAfter <= 0 {
		cfg.IdleStopAfter = 10 * time.Minute
	}
	if cfg.WaitForExit <= 0 {
		cfg.WaitForExit = 3 * time.Second
	}

	transport := &http.Transport{
		// 提取接口本身也常常只能从国内访问（品赞就是），统一走跳板
		Proxy:                 nil,
		TLSHandshakeTimeout:   cfg.Timeout,
		ResponseHeaderTimeout: cfg.Timeout,
	}
	if relay := strings.TrimSpace(cfg.Relay); relay != "" {
		if relayURL, err := url.Parse(firstHopOnly(relay)); err == nil && relayURL.Host != "" {
			// net/http 的 Proxy 只认 http/https/socks5，我们内部用 http-connect 表示
			// 「HTTP CONNECT 隧道」，这里必须换成 http，否则请求直接发不出去。
			if relayURL.Scheme == "http-connect" {
				relayURL.Scheme = "http"
			}
			transport.Proxy = http.ProxyURL(relayURL)
		} else if err != nil {
			log.Printf("[proxy] 跳板地址解析失败，将直连提取接口: %v", err)
		}
	}

	return &ProxyProvider{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.Timeout, Transport: transport},
		stopCh: make(chan struct{}),
	}
}

// minuteFromURL 从提取接口的 minute 参数推寿命（纯文本格式不带 expired 字段）
func minuteFromURL(raw string) time.Duration {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(u.Query().Get("minute")))
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Minute
}

// firstHopOnly 取链里的第一跳（跳板本身）——提取接口只需要第一跳就能到。
func firstHopOnly(chain string) string {
	if i := strings.Index(chain, proxyChainSeparator); i >= 0 {
		return strings.TrimSpace(chain[:i])
	}
	return strings.TrimSpace(chain)
}

// Start 起一个后台协程，提前把出口换好，避免请求路径上现等提取。
func (p *ProxyProvider) Start() {
	if p == nil || strings.TrimSpace(p.cfg.ExtractURL) == "" {
		return
	}
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-p.stopCh:
				return
			case <-ticker.C:
				// 只在活跃期预热：闲置时段一次都不提取（按次计费，空转就是烧钱）。
				// 第一笔请求由 Current() 自己按需触发，不必启动就提。
				if p.inActiveWindow() && p.needRefresh() {
					p.refreshAsync("活跃期预热")
				}
			}
		}
	}()
}

func (p *ProxyProvider) Close() {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() { close(p.stopCh) })
}

func (p *ProxyProvider) enabled() bool {
	return p != nil && strings.TrimSpace(p.cfg.ExtractURL) != ""
}

func (p *ProxyProvider) needRefresh() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.needRefreshLocked()
}

func (p *ProxyProvider) needRefreshLocked() bool {
	if p.current == nil {
		return true
	}
	return time.Now().Add(p.cfg.RotateAhead).After(p.expireAt)
}

// Current 返回当前可用的代理链（跳板>>出口）；拿不到就返回空串，调用方会退回直连。
//
// 按需提取（省钱的关键）：只有真的有人要过代理时才会去提取接口。手上还有有效出口
// 就直接复用；没有就触发一次后台提取，并最多等 WaitForExit 让这一次请求也用上
// 国内出口（否则首个请求会退回直连）。闲置时段（IdleStopAfter 内没有任何需求）
// 后台一次都不提取 —— 提取接口按次计费，空转全是白花的钱。
func (p *ProxyProvider) Current() string {
	if !p.enabled() {
		return ""
	}
	p.noteDemand()

	if chain := p.readyChain(); chain != "" {
		// 手上有出口：如果快过期了，顺手让后台去换一个新的（不阻塞这次请求）
		if p.needRefresh() {
			p.refreshAsync("请求触发的换出口")
		}
		return chain
	}

	// 手上没有可用出口：按需提取，并等一小会儿
	p.refreshAsync("按需提取")
	return p.waitForExit()
}

// noteDemand 记下「此刻有请求需要出口」，用于判断是否还在活跃期
func (p *ProxyProvider) noteDemand() {
	p.mu.Lock()
	p.lastDemandAt = time.Now()
	p.mu.Unlock()
}

// readyChain 返回仍然有效的出口链；不触发任何提取
func (p *ProxyProvider) readyChain() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current == nil || !time.Now().Before(p.expireAt) {
		return ""
	}
	return p.chainLocked()
}

// waitForExit 最多等 budget 这么久，看后台提取能不能赶上（避免这次请求退回直连）
func (p *ProxyProvider) waitForExit() string {
	budget := p.cfg.WaitForExit
	if budget <= 0 {
		return ""
	}
	deadline := time.Now().Add(budget)
	for {
		time.Sleep(80 * time.Millisecond)
		if chain := p.readyChain(); chain != "" {
			return chain
		}
		if !time.Now().Before(deadline) {
			return ""
		}
	}
}

// inActiveWindow 判断当前是否处于活跃期（最近真的用过出口）
func (p *ProxyProvider) inActiveWindow() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lastDemandAt.IsZero() {
		return false
	}
	return time.Since(p.lastDemandAt) < p.cfg.IdleStopAfter
}

// refreshAsync 后台换出口，同一时刻只有一个在跑（single-flight），
// 并且失败后 60 秒内不再重试（避免提取接口被我们自己打爆）。
func (p *ProxyProvider) refreshAsync(reason string) {
	if !p.enabled() {
		return
	}
	p.mu.Lock()
	if p.refreshing {
		p.mu.Unlock()
		return
	}
	if !p.lastAttemptAt.IsZero() && time.Since(p.lastAttemptAt) < p.cfg.RetryBackoff {
		p.mu.Unlock()
		return
	}
	p.refreshing = true
	p.lastAttemptAt = time.Now()
	p.mu.Unlock()

	go func() {
		defer func() {
			p.mu.Lock()
			p.refreshing = false
			p.mu.Unlock()
		}()
		if err := p.Refresh(context.Background()); err != nil {
			log.Printf("[proxy] 换出口失败（%s），暂时直连: %v", reason, err)
		}
	}()
}

func (p *ProxyProvider) chainLocked() string {
	hop := proxyURL(p.cfg.ProxyScheme, p.current.Host, p.current.Port, p.current.User, p.current.Pass)
	if relay := strings.TrimSpace(p.cfg.Relay); relay != "" {
		return relay + proxyChainSeparator + hop
	}
	return hop
}

func proxyURL(scheme, host, port, user, pass string) string {
	u := url.URL{Scheme: scheme, Host: net.JoinHostPort(host, port)}
	if user != "" || pass != "" {
		u.User = url.UserPassword(user, pass)
	}
	return u.String()
}

// Refresh 立即取一个新出口
func (p *ProxyProvider) Refresh(ctx context.Context) error {
	if !p.enabled() {
		return fmt.Errorf("未配置提取接口")
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		entry, err := p.extract(ctx)
		if err == nil {
			expireAt := time.Unix(entry.Expired/1000, 0)
			if entry.Expired <= 0 || expireAt.Before(time.Now().Add(30*time.Second)) {
				// 提取接口没给（或给了个已过期的）寿命：优先用 URL 里的 minute 参数，
				// 再退到 5 分钟保守值
				ttl := p.cfg.URLTTL
				if ttl <= 0 {
					ttl = 5 * time.Minute
				}
				expireAt = time.Now().Add(ttl)
			}
			prev := ""
			if p.current != nil {
				prev = p.current.Addr()
			}
			p.current = &tcpProxy{
				Scheme: p.cfg.ProxyScheme,
				Host:   entry.IP,
				Port:   entry.Port,
				User:   entry.Account,
				Pass:   entry.Password,
			}
			p.expireAt = expireAt
			p.extracts++
			p.lastAt = time.Now()
			p.lastErr = ""
			if prev != p.current.Addr() {
				log.Printf("[proxy] 出口: %s（%s，%s 后过期）", p.current.Display(),
					defaultStr(entry.Net, "未知线路"), time.Until(expireAt).Truncate(time.Second))
			}
			return nil
		}
		lastErr = err
		time.Sleep(800 * time.Millisecond)
	}
	p.lastErr = lastErr.Error()
	log.Printf("[proxy] 提取接口请求失败: %v", lastErr)
	return lastErr
}

func (p *ProxyProvider) extract(ctx context.Context) (*extractEntry, error) {
	reqCtx, cancel := context.WithTimeout(ctx, p.cfg.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, p.cfg.ExtractURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "yyb-go/1.0")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求提取接口失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("读取提取结果失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("提取接口返回 HTTP %d: %s", resp.StatusCode, cropText(string(body), 120))
	}

	return parseExtractBody(body)
}

// parseExtractBody 同时支持两种返回格式：
//   - JSON（URL 带 format=json）：{"code":0,"data":{"list":[{"ip","port","expired",...}]}}
//   - 纯文本（默认）：每行「ip:port [账号] [密码]」，取第一行
func parseExtractBody(body []byte) (*extractEntry, error) {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return nil, fmt.Errorf("提取接口返回空内容")
	}

	if strings.HasPrefix(text, "{") {
		var parsed extractResponse
		if err := json.Unmarshal(body, &parsed); err != nil {
			return nil, fmt.Errorf("提取结果不是合法 JSON: %s", cropText(text, 120))
		}
		if parsed.Code != 0 {
			return nil, fmt.Errorf("提取接口报错 code=%d: %s", parsed.Code, defaultStr(parsed.Message, "无 message"))
		}
		if len(parsed.Data.List) == 0 {
			return nil, fmt.Errorf("提取接口没给 IP: %s", cropText(text, 120))
		}
		entry := parsed.Data.List[0]
		if err := validateEntry(&entry); err != nil {
			return nil, err
		}
		return &entry, nil
	}

	// 纯文本：一行一个，取第一行（num>1 时会返回多行）
	line := strings.TrimSpace(strings.Split(text, "\n")[0])
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return nil, fmt.Errorf("提取结果为空: %s", cropText(text, 120))
	}
	if !strings.Contains(fields[0], ":") {
		// 很可能是一句错误提示（如「找不到价格表 请联系客服」）
		return nil, fmt.Errorf("提取接口返回: %s", cropText(text, 120))
	}
	hostPort := strings.SplitN(fields[0], ":", 2)
	entry := extractEntry{IP: strings.TrimSpace(hostPort[0]), Port: strings.TrimSpace(hostPort[1])}
	if len(fields) >= 2 {
		entry.Account = fields[1]
	}
	if len(fields) >= 3 {
		entry.Password = fields[2]
	}
	if err := validateEntry(&entry); err != nil {
		return nil, err
	}
	return &entry, nil
}

func validateEntry(entry *extractEntry) error {
	if entry.IP == "" || entry.Port == "" {
		return fmt.Errorf("提取结果缺少 ip/port")
	}
	if _, err := strconv.Atoi(entry.Port); err != nil {
		return fmt.Errorf("提取结果端口非法: %q", entry.Port)
	}
	return nil
}

// Status 给运维/调试用的状态（不含凭据）
func (p *ProxyProvider) Status() map[string]any {
	if p == nil {
		return map[string]any{"enabled": false}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]any{
		"enabled":  p.enabled(),
		"relay":    p.cfg.Relay != "",
		"extracts": p.extracts,
		"last_err": p.lastErr,
	}
	if p.current != nil {
		out["current"] = p.current.Display()
		out["net"] = p.current.Addr()
		out["expires_in_seconds"] = int(time.Until(p.expireAt).Seconds())
	}
	if !p.lastAt.IsZero() {
		out["last_extract_at"] = p.lastAt.Format(time.RFC3339)
	}
	// 按需模式：让面板能看出「现在是活跃期还是已休眠（闲置不提取）」。
	// 注意这里已经持有 p.mu，不能调 inActiveWindow()（它也会加锁，会自死锁）。
	out["on_demand"] = true
	out["active"] = !p.lastDemandAt.IsZero() && time.Since(p.lastDemandAt) < p.cfg.IdleStopAfter
	if !p.lastDemandAt.IsZero() {
		out["last_demand_at"] = p.lastDemandAt.Unix()
	}
	out["idle_stop_after"] = p.cfg.IdleStopAfter.String()
	return out
}

// Probe 用当前代理链真连一次目标（默认微信 HTTPDNS 短连接 IP），
// 用来验证「跳板 → 品赞 → 目标」这条链此刻是否可用。
func (p *ProxyProvider) Probe(ctx context.Context, host string, port int, timeout time.Duration) (string, error) {
	if !p.enabled() {
		return "", fmt.Errorf("未启用代理")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	chain := p.Current()
	if chain == "" {
		return "", fmt.Errorf("当前没有可用出口（提取失败）")
	}
	conn, err := dialTCP(ctx, host, port, timeout, chain, false)
	if err != nil {
		return chain, err
	}
	_ = conn.Close()
	return chain, nil
}

func cropText(s string, n int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func defaultStr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
