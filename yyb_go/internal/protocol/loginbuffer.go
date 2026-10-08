package protocol

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"time"
)

// ErrMissingRefreshToken 表示本地凭据里压根没有 refresh token：这种号不可能再续期。
var ErrMissingRefreshToken = errors.New("missing refresh token")

// AuthRejectedError 表示腾讯侧用业务码（code != 0）明确拒绝了这次凭据操作，
// 而不是超时、DNS、HTTP 5xx、JSON 解析这类过一会儿可能自愈的临时故障。
// 调用方靠它区分「号真的没了」和「这次网络不好」——前者才配把账号判成失效。
type AuthRejectedError struct {
	Step string // "refresh"（换 access token）或 "login_buffer"（取登录态）
	Code int
	Msg  string
}

func (e *AuthRejectedError) Error() string {
	return fmt.Sprintf("%s rejected: code=%d msg=%s", e.Step, e.Code, e.Msg)
}

// HTTPStatusError 表示服务端回了非 2xx。这类错误可能来自腾讯，也可能来自中间的
// 网关 / WAF / CDN，甚至是一次代理故障，不足以断定凭据有问题；而且它的文案里通常
// 带着请求 URL，容易被「token 失效」之类的关键词匹配误伤，所以单独成类型让上层排除。
type HTTPStatusError struct {
	Status int
	Body   string
}

func (e *HTTPStatusError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body)
}

const (
	yybHost         = "https://yybadaccess.3g.qq.com"
	loginBufferURL  = yybHost + "/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth"
	refreshTokenURL = yybHost + "/pc_yyb_auth/pcyyb_refresh_token_auth"
	userInfoURL     = yybHost + "/pc_yyb/pcyyb_get_user_info"
	loginBusinessID = "pc_yyb_auth"
	loginAccessKey  = "wgrdg373hy26ww2"
)

type LoginBufferCredentials struct {
	OpenID       string `json:"openid"`
	AccessToken  string `json:"accesstoken"`
	RefreshToken string `json:"refreshtoken"`
	LoginType    string `json:"logintype"`
	Nickname     string `json:"nickname"`
	ExpiresAt    int64  `json:"expires_at"`
	ExpiresIn    int64  `json:"expires_in"`
}

func CredentialsFromMap(m map[string]any) LoginBufferCredentials {
	return LoginBufferCredentials{
		OpenID:       stringFromMap(m, "openid"),
		AccessToken:  stringFromMap(m, "accesstoken"),
		RefreshToken: stringFromMap(m, "refreshtoken"),
		LoginType:    defaultString(stringFromMap(m, "logintype"), "WX"),
		Nickname:     stringFromMap(m, "nickname"),
		ExpiresAt:    int64FromMap(m, "expires_at"),
		ExpiresIn:    defaultInt64(int64FromMap(m, "expires_in"), 7200),
	}
}

func (c LoginBufferCredentials) ToMap() map[string]any {
	return map[string]any{
		"openid":               c.OpenID,
		"accesstoken":          c.AccessToken,
		"refreshtoken":         c.RefreshToken,
		"logintype":            defaultString(c.LoginType, "WX"),
		"nickname":             c.Nickname,
		"expires_at":           c.ExpiresAt,
		"expires_in":           defaultInt64(c.ExpiresIn, 7200),
		"refresh_refreshed_at": time.Now().Unix(),
	}
}

func (c LoginBufferCredentials) Expired(skew time.Duration) bool {
	return time.Now().Add(skew).Unix() >= c.ExpiresAt
}

type LoginBufferResult struct {
	LoginBuffer string
	Credentials LoginBufferCredentials
	Refreshed   bool
}

type LoginBufferClient struct {
	httpClient *http.Client
	timeout    time.Duration
}

// SetProxyFunc 让续期 / 取登录态的 HTTPS 请求也走代理链。
//
// 这些请求直接打腾讯（yybadaccess.3g.qq.com），海外 IP 高频访问更容易被风控，
// 走国内住宅出口更接近真实用户。传入的函数每次拨号都会被调用，
// 所以出口轮换后自动生效；传 nil 表示保持直连。
func (c *LoginBufferClient) SetProxyFunc(proxy func() string) {
	if c == nil || proxy == nil {
		return
	}
	timeout := c.timeout
	transport := &http.Transport{
		// fallbackDirect=true：代理挂了就直连，别把续期能力整体弄没
		DialContext:           NewProxyDialer(timeout, proxy, true),
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   4,
	}
	c.httpClient = &http.Client{Timeout: timeout, Transport: transport}
}

func NewLoginBufferClient(timeout time.Duration) *LoginBufferClient {
	return &LoginBufferClient{
		httpClient: &http.Client{Timeout: timeout},
		timeout:    timeout,
	}
}

func (c *LoginBufferClient) FetchLoginBuffer(ctx context.Context, creds LoginBufferCredentials) (string, error) {
	body, err := json.Marshal(loginBufferRequest{
		ExtInfo: loginExtInfo{
			ListS: loginListS{
				UnionID:     loginValueString{Value: []string{creds.OpenID}},
				UserID:      loginValueString{Value: []string{creds.OpenID}},
				AccessToken: loginValueString{Value: []string{creds.AccessToken}},
			},
			ListI: loginListI{UserType: loginValueInt{Value: []int{0}}},
		},
	})
	if err != nil {
		return "", err
	}
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	if err = c.requestJSON(ctx, http.MethodPost, loginBufferURL, body, map[string]string{
		"Content-Type":          "application/json",
		"Ual-Access-Businessid": loginBusinessID,
		"Ual-Access-Timestamp":  ts,
		"Ual-Access-Nonce":      nonce,
		"Ual-Access-Signature":  sign(string(body), nonce, ts, loginAccessKey),
		"Cookie":                fmt.Sprintf("openid=%s; accesstoken=%s; refreshtoken=%s", creds.OpenID, creds.AccessToken, creds.RefreshToken),
	}, &data); err != nil {
		return "", err
	}
	if code := intFromAny(data["code"]); code != 0 {
		return "", &AuthRejectedError{Step: "login_buffer", Code: code, Msg: stringFromMap(data, "msg")}
	}
	values := stringSlicePath(data, "ext_info", "list_s", "login_buffer", "value")
	if len(values) == 0 || values[0] == "" {
		return "", fmt.Errorf("login_buffer response is empty")
	}
	return values[0], nil
}

func (c *LoginBufferClient) RefreshCredentials(ctx context.Context, creds LoginBufferCredentials) (LoginBufferCredentials, error) {
	if creds.RefreshToken == "" {
		return LoginBufferCredentials{}, ErrMissingRefreshToken
	}
	body, err := json.Marshal(refreshTokenRequest{UserInfo: refreshTokenUserInfo{
		OpenID:       creds.OpenID,
		RefreshToken: creds.RefreshToken,
		AccessToken:  creds.AccessToken,
		LoginType:    defaultString(creds.LoginType, "WX"),
	}})
	if err != nil {
		return LoginBufferCredentials{}, err
	}
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	if err = c.requestJSON(ctx, http.MethodPost, refreshTokenURL, body, map[string]string{
		"Content-Type":          "application/json",
		"Ual-Access-Businessid": loginBusinessID,
		"Ual-Access-Timestamp":  ts,
		"Ual-Access-Nonce":      nonce,
		"Ual-Access-Signature":  sign(string(body), nonce, ts, loginAccessKey),
	}, &data); err != nil {
		return LoginBufferCredentials{}, err
	}
	if code := intFromAny(data["code"]); code != 0 {
		return LoginBufferCredentials{}, &AuthRejectedError{Step: "refresh", Code: code, Msg: stringFromMap(data, "msg")}
	}
	info, _ := data["user_info"].(map[string]any)
	expiresIn := defaultInt64(int64FromMap(info, "expires_in"), 7200)
	refreshed := creds
	refreshed.AccessToken = stringFromMap(info, "access_token")
	if rt := stringFromMap(info, "refresh_token"); rt != "" {
		refreshed.RefreshToken = rt
	}
	refreshed.ExpiresIn = expiresIn
	refreshed.ExpiresAt = time.Now().Unix() + expiresIn
	if refreshed.AccessToken == "" {
		return LoginBufferCredentials{}, fmt.Errorf("refresh response missing access_token")
	}
	return refreshed, nil
}

func (c *LoginBufferClient) RefreshLoginBuffer(ctx context.Context, creds LoginBufferCredentials) (LoginBufferResult, error) {
	refreshed, err := c.RefreshCredentials(ctx, creds)
	if err != nil {
		return LoginBufferResult{}, err
	}
	lb, err := c.FetchLoginBuffer(ctx, refreshed)
	if err != nil {
		return LoginBufferResult{}, err
	}
	return LoginBufferResult{LoginBuffer: lb, Credentials: refreshed, Refreshed: true}, nil
}

func (c *LoginBufferClient) FetchUserInfo(ctx context.Context, creds LoginBufferCredentials) (map[string]any, error) {
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	err := c.requestJSON(ctx, http.MethodGet, userInfoURL, nil, map[string]string{
		"Ual-Access-Access-Token": creds.AccessToken,
		"Ual-Access-Login-Type":   "2",
		"Ual-Access-Openid":       creds.OpenID,
		"Ual-Access-Businessid":   "pc_yyb",
		"Ual-Access-Guid":         "web",
		"Ual-Access-Nonce":        nonce,
		"Ual-Access-Requestid":    fmt.Sprintf("%d", rand.Intn(9000)+1000),
		"Ual-Access-Signature":    sign("", nonce, ts, ""),
		"Ual-Access-Timestamp":    ts,
	}, &data)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (c *LoginBufferClient) requestJSON(ctx context.Context, method, url string, body []byte, headers map[string]string, out any) error {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPStatusError{Status: resp.StatusCode, Body: string(data[:min(len(data), 200)])}
	}
	if err = json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode JSON: %w: %s", err, string(data[:min(len(data), 200)]))
	}
	return nil
}

type loginBufferRequest struct {
	ExtInfo loginExtInfo `json:"extInfo"`
}
type loginExtInfo struct {
	ListS loginListS `json:"listS"`
	ListI loginListI `json:"listI"`
}
type loginListS struct {
	UnionID     loginValueString `json:"unionid"`
	UserID      loginValueString `json:"user_id"`
	AccessToken loginValueString `json:"access_token"`
}
type loginListI struct {
	UserType loginValueInt `json:"user_type"`
}
type loginValueString struct {
	Value []string `json:"value"`
}
type loginValueInt struct {
	Value []int `json:"value"`
}
type refreshTokenRequest struct {
	UserInfo refreshTokenUserInfo `json:"userInfo"`
}
type refreshTokenUserInfo struct {
	OpenID       string `json:"openId"`
	RefreshToken string `json:"refreshToken"`
	AccessToken  string `json:"accessToken"`
	LoginType    string `json:"loginType"`
}

func timestampMS() string {
	return fmt.Sprintf("%d", time.Now().UnixMilli())
}

func nonce4() string {
	return fmt.Sprintf("%d", rand.Intn(10000))
}

func sign(body, nonce, ts, key string) string {
	sum := md5.Sum([]byte(body + ts + key + nonce))
	return hex.EncodeToString(sum[:])
}

func stringSlicePath(m map[string]any, path ...string) []string {
	var cur any = m
	for _, p := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = obj[p]
	}
	arr, ok := cur.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func stringFromMap(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func int64FromMap(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

func intFromAny(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	default:
		return 0
	}
}

func defaultString(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func defaultInt64(v, def int64) int64 {
	if v == 0 {
		return def
	}
	return v
}
