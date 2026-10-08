package qr

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"yyb_go/internal/protocol"
)

const (
	oauthURL = "https://open.weixin.qq.com/connect/qrconnect" +
		"?appid=wxd44977328b36e647" +
		"&redirect_uri=https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth?login_type=WX" +
		"&response_type=code&scope=snsapi_login,snsapi_runtime_pcsdk" +
		"&state=web&fast_login=1&self_redirect=true"
	callbackURL  = "https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth"
	qrBase       = "https://open.weixin.qq.com/connect/qrcode/"
	longPollBase = "https://long.open.weixin.qq.com/connect/l/qrconnect"
)

var (
	uuidRE = regexp.MustCompile(`/connect/qrcode/([^"'>\s]+)`)
	errRE  = regexp.MustCompile(`wx_errcode\s*=\s*(\d+)`)
	codeRE = regexp.MustCompile(`wx_code\s*=\s*'([^']*)'`)
)

type Session struct {
	ID            string
	WXUUID        string
	QRCodeURL     string
	CreatedAt     time.Time
	HTTPClient    *http.Client
	Jar           http.CookieJar
	AuthorizeCode string
	Credentials   *protocol.LoginBufferCredentials
	LoginBuffer   string
	Status        string
	Error         string
	mu            sync.Mutex
}

func (s *Session) Age() time.Duration { return time.Since(s.CreatedAt) }

type ImageResult struct {
	Session    *Session
	ImageBytes []byte
}

type PollResult struct {
	Status  string `json:"status"`
	ErrCode *int   `json:"errcode,omitempty"`
	Code    string `json:"-"`
	Message string `json:"-"`
}

type Client struct {
	timeout      time.Duration
	loginBuffers *protocol.LoginBufferClient

	// proxy 返回当前代理链（空串=直连）。扫码整条链路（建会话 / 取二维码 /
	// 轮询 / 换登录态）都用它，让「扫码」这件事也发生在国内出口上。
	proxy func() string
}

func NewClient(timeout time.Duration) *Client {
	return &Client{
		timeout:      timeout,
		loginBuffers: protocol.NewLoginBufferClient(timeout),
	}
}

func (c *Client) LoginBuffers() *protocol.LoginBufferClient { return c.loginBuffers }

// SetProxyFunc 让扫码流程也走代理链。传 nil 表示直连（默认）。
func (c *Client) SetProxyFunc(proxy func() string) { c.proxy = proxy }

// SetTimeout 调整扫码各步的超时。
// 走代理链时要放宽：双跳（跳板 + 住宅出口）建立连接本身就要几秒，
// 用直连时代的 8 秒会大面积 context deadline exceeded。
func (c *Client) SetTimeout(timeout time.Duration) {
	if timeout > 0 {
		c.timeout = timeout
	}
}

// Timeout 供调用方参考当前值
func (c *Client) Timeout() time.Duration { return c.timeout }

// newHTTPClient 建一个（按需走代理的）HTTP 客户端。
// fallbackDirect=true：代理抖了就直接连，别把扫码功能整体弄挂。
func (c *Client) newHTTPClient(jar http.CookieJar) *http.Client {
	hc := &http.Client{Timeout: c.timeout, Jar: jar}
	if c.proxy == nil {
		return hc
	}
	hc.Transport = &fallbackTransport{
		primary: &http.Transport{
			DialContext:           protocol.NewProxyDialer(c.timeout, c.proxy, true),
			TLSHandshakeTimeout:   c.timeout,
			ResponseHeaderTimeout: c.timeout,
			MaxIdleConns:          8,
			MaxIdleConnsPerHost:   4,
		},
		// 国内住宅出口对 open.weixin.qq.com 这种交互式请求并不稳定
		// （实测 10~21 秒、约 1/3 失败），所以失败立刻用直连再走一次：
		// 代理能用就走代理，用不了也不会让扫码卡住。
		secondary: http.DefaultTransport,
	}
	return hc
}

// fallbackTransport 先走 primary（代理），失败且请求可重放时改走 secondary（直连）。
//
// 扫码是交互式流程，用户就看着二维码出不出来；住宅出口抖动时宁可退回直连，
// 也不要让面板扫码变慢或报错。
type fallbackTransport struct {
	primary   http.RoundTripper
	secondary http.RoundTripper
}

func (t *fallbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.primary.RoundTrip(req)
	if err == nil {
		return resp, nil
	}
	// 请求体不可重放时不重试（扫码流程都是 GET，正常不会走到这）
	if req.Body != nil && req.GetBody == nil {
		return nil, err
	}
	log.Printf("[qr] 代理出口失败（%v），本次改用直连重试", err)
	retry := req.Clone(req.Context())
	if req.GetBody != nil {
		body, bodyErr := req.GetBody()
		if bodyErr != nil {
			return nil, err
		}
		retry.Body = body
	}
	return t.secondary.RoundTrip(retry)
}

func (c *Client) GetQRCodeImage(ctx context.Context) (ImageResult, error) {
	sess, err := c.CreateSession(ctx)
	if err != nil {
		return ImageResult{}, err
	}
	data, err := c.FetchQRCodeImage(ctx, sess)
	if err != nil {
		return ImageResult{}, err
	}
	return ImageResult{Session: sess, ImageBytes: data}, nil
}

func (c *Client) CreateSession(ctx context.Context) (*Session, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	hc := c.newHTTPClient(jar)
	if c.proxy != nil {
		log.Printf("[qr] 建扫码会话走代理: %s", maskProxyChain(c.proxy()))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, oauthURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	m := uuidRE.FindStringSubmatch(string(body))
	if len(m) < 2 {
		return nil, fmt.Errorf("failed to parse WeChat QR uuid")
	}
	id, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	wxuuid := m[1]
	return &Session{
		ID:         id,
		WXUUID:     wxuuid,
		QRCodeURL:  qrBase + wxuuid,
		CreatedAt:  time.Now(),
		HTTPClient: hc,
		Jar:        jar,
		Status:     "pending",
	}, nil
}

func (c *Client) FetchQRCodeImage(ctx context.Context, sess *Session) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sess.QRCodeURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := sess.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("QR image HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (c *Client) PollQRCode(ctx context.Context, sess *Session) (PollResult, error) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.LoginBuffer != "" {
		return PollResult{Status: "confirmed"}, nil
	}
	if sess.AuthorizeCode != "" {
		code := 405
		return PollResult{Status: "authorized", ErrCode: &code, Code: sess.AuthorizeCode}, nil
	}
	u := longPollBase + "?" + url.Values{
		"uuid": {sess.WXUUID},
		"_":    {strconv.FormatInt(time.Now().UnixMilli(), 10)},
	}.Encode()
	reqCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return PollResult{}, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := sess.HTTPClient.Do(req)
	if err != nil {
		return PollResult{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	text := string(body)
	errcode, code := parsePoll(text)
	switch {
	case errcode != nil && *errcode == 408:
		sess.Status = "pending"
		return PollResult{Status: "pending", ErrCode: errcode, Code: code}, nil
	case errcode != nil && *errcode == 404:
		sess.Status = "scanned"
		return PollResult{Status: "scanned", ErrCode: errcode, Code: code}, nil
	case errcode != nil && *errcode == 403:
		sess.Status = "cancelled"
		return PollResult{Status: "cancelled", ErrCode: errcode, Code: code}, nil
	case errcode != nil && *errcode == 402:
		sess.Status = "expired"
		return PollResult{Status: "expired", ErrCode: errcode, Code: code}, nil
	case errcode != nil && *errcode == 405 && code != "":
		sess.AuthorizeCode = code
		sess.Status = "authorized"
		return PollResult{Status: "authorized", ErrCode: errcode, Code: code}, nil
	default:
		sess.Status = "unknown"
		if len(text) > 200 {
			text = text[:200]
		}
		sess.Error = text
		return PollResult{Status: "unknown", ErrCode: errcode, Code: code, Message: text}, nil
	}
}

func (c *Client) GetLoginBuffer(ctx context.Context, sess *Session) (protocol.LoginBufferResult, error) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.LoginBuffer != "" && sess.Credentials != nil {
		return protocol.LoginBufferResult{LoginBuffer: sess.LoginBuffer, Credentials: *sess.Credentials}, nil
	}
	if sess.AuthorizeCode == "" {
		return protocol.LoginBufferResult{}, fmt.Errorf("QR session is not authorized yet")
	}
	cb := callbackURL + "?" + url.Values{
		"login_type": {"WX"},
		"code":       {sess.AuthorizeCode},
		"state":      {"web"},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cb, nil)
	if err != nil {
		return protocol.LoginBufferResult{}, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := sess.HTTPClient.Do(req)
	if err != nil {
		return protocol.LoginBufferResult{}, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	creds, err := credentialsFromJar(sess.Jar, cb)
	if err != nil {
		return protocol.LoginBufferResult{}, err
	}
	lb, err := c.loginBuffers.FetchLoginBuffer(ctx, creds)
	if err != nil {
		return protocol.LoginBufferResult{}, err
	}
	sess.Credentials = &creds
	sess.LoginBuffer = lb
	sess.Status = "confirmed"
	return protocol.LoginBufferResult{LoginBuffer: lb, Credentials: creds}, nil
}

func (c *Client) RefreshLoginBuffer(ctx context.Context, creds protocol.LoginBufferCredentials) (protocol.LoginBufferResult, error) {
	return c.loginBuffers.RefreshLoginBuffer(ctx, creds)
}

func DataURIJPEG(data []byte) string {
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
}

func parsePoll(text string) (*int, string) {
	var out *int
	if m := errRE.FindStringSubmatch(text); len(m) == 2 {
		n, _ := strconv.Atoi(m[1])
		out = &n
	}
	code := ""
	if m := codeRE.FindStringSubmatch(text); len(m) == 2 {
		code = m[1]
	}
	return out, code
}

func credentialsFromJar(jar http.CookieJar, rawURL string) (protocol.LoginBufferCredentials, error) {
	u, _ := url.Parse(rawURL)
	var cookies []*http.Cookie
	if u != nil {
		cookies = append(cookies, jar.Cookies(u)...)
	}
	hostURL, _ := url.Parse("https://yybadaccess.3g.qq.com/")
	cookies = append(cookies, jar.Cookies(hostURL)...)
	values := map[string]string{}
	for _, ck := range cookies {
		values[ck.Name] = ck.Value
	}
	openid := values["openid"]
	accessToken := values["accesstoken"]
	if openid == "" || accessToken == "" {
		return protocol.LoginBufferCredentials{}, fmt.Errorf("OAuth callback did not set required cookies")
	}
	expiresIn := int64(7200)
	if values["expires_in"] != "" {
		if n, err := strconv.ParseInt(values["expires_in"], 10, 64); err == nil && n > 0 {
			expiresIn = n
		}
	}
	return protocol.LoginBufferCredentials{
		OpenID:       openid,
		AccessToken:  accessToken,
		RefreshToken: values["refreshtoken"],
		LoginType:    defaultString(values["logintype"], "WX"),
		Nickname:     values["nickname"],
		ExpiresAt:    time.Now().Unix() + expiresIn,
		ExpiresIn:    expiresIn,
	}, nil
}

func defaultString(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// maskProxyChain 只保留各跳的 host:port，去掉用户名密码
func maskProxyChain(chain string) string {
	if chain == "" {
		return "direct"
	}
	parts := strings.Split(chain, protocol.ProxyChainSeparator())
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if u, err := url.Parse(part); err == nil && u.Host != "" {
			out = append(out, u.Host)
			continue
		}
		out = append(out, "?")
	}
	return strings.Join(out, protocol.ProxyChainSeparator())
}
