package httpapi

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"yyb_go/internal/protocol"
	"yyb_go/internal/store"
)

var testNow = time.Unix(1_800_000_000, 0)

func TestRefreshFailureStatus(t *testing.T) {
	fresh := protocol.LoginBufferCredentials{ExpiresAt: testNow.Unix() + 3600}
	stale := protocol.LoginBufferCredentials{ExpiresAt: testNow.Unix() - 3600}
	modeA := &protocol.AuthRejectedError{Step: "refresh", Code: -109, Msg: "RC_PARAMS_INVALID"}
	modeB := &protocol.AuthRejectedError{Step: "login_buffer", Code: -101, Msg: "[40188] invalid scope"}

	cases := []struct {
		name    string
		current string
		creds   protocol.LoginBufferCredentials
		err     error
		want    string
	}{
		// --- 确定性失效：腾讯明确拒绝，必须重新扫码 ---
		{"腾讯拒绝刷新(-109) 且凭据未过期", "alive", fresh, modeA, "expired"},
		{"腾讯拒绝取buffer(-101) 且凭据未过期", "alive", fresh, modeB, "expired"},
		{"腾讯拒绝但凭据已过期", "alive", stale, modeA, "expired"},
		{"没有 refresh token", "alive", stale, protocol.ErrMissingRefreshToken, "expired"},
		{"凭据缺 refresh token 但凭据未过期", "alive", fresh, protocol.ErrMissingRefreshToken, "expired"},
		{"被 %w 包过的腾讯拒绝依然认得出", "alive", fresh,
			fmt.Errorf("refresh liveness for 42: %w", modeA), "expired"},

		// --- 文案兜底：万一业务错误被包成普通 error，也不漏判 ---
		{"文案里带 code=-109", "alive", fresh, errors.New("refresh failed: code=-109 msg=RC_PARAMS_INVALID"), "expired"},
		{"文案里带 42007 refresh_token", "alive", fresh, errors.New("refresh failed: code=42007 refresh_token expired"), "expired"},
		{"文案里带 invalid scope", "alive", fresh, errors.New("login_buffer rejected: [40188] invalid scope"), "expired"},
		{"文案要求重新登录", "alive", fresh, errors.New("please relogin to continue"), "expired"},
		{"文案：token 已失效", "alive", fresh, errors.New("登录态失效，请重新登录"), "expired"},

		// --- 不确定：不许误杀好号 ---
		{"网络超时 且凭据未过期 → 状态不动", "alive", fresh,
			errors.New("Post \"https://yybadaccess.3g.qq.com/...\": context deadline exceeded"), "alive"},
		{"代理挂了 且凭据未过期 → 状态不动", "unknown", fresh,
			errors.New("proxyconnect tcp: dial tcp 10.0.0.1:7890: i/o timeout"), "unknown"},
		{"HTTP 502 且凭据未过期 → 状态不动", "alive", fresh,
			errors.New("HTTP 502: <html>bad gateway</html>"), "alive"},
		{"JSON 解析失败 且凭据未过期 → 状态不动", "alive", fresh,
			errors.New("decode JSON: unexpected end of JSON input"), "alive"},
		{"未知业务码 且凭据未过期 → 状态不动", "alive", fresh,
			&protocol.AuthRejectedError{Step: "refresh", Code: -1, Msg: "system busy"}, "alive"},

		// --- 不确定 + 凭据已过期 → unknown，等重试，不冒充失效 ---
		{"网络超时 且凭据已过期 → unknown", "alive", stale,
			errors.New("dial tcp: lookup yybadaccess.3g.qq.com: no such host"), "unknown"},
		{"未知业务码 且凭据已过期 → unknown", "expired", stale,
			&protocol.AuthRejectedError{Step: "refresh", Code: -1, Msg: "system busy"}, "unknown"},
		{"空错误文案 → 不当成失效", "alive", stale, errors.New(""), "unknown"},
		{"expires_at 缺失(=0) 视为已过期", "alive", protocol.LoginBufferCredentials{},
			errors.New("i/o timeout"), "unknown"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := refreshFailureStatus(tc.current, tc.creds, tc.err, testNow)
			if got != tc.want {
				t.Fatalf("refreshFailureStatus() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDefinitiveCredentialFailure(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil 错误不算失效", nil, false},
		{"超时不算失效", errors.New("context deadline exceeded"), false},
		{"未知业务码不算失效", &protocol.AuthRejectedError{Step: "refresh", Code: -1, Msg: "busy"}, false},
		{"-109 算失效", &protocol.AuthRejectedError{Step: "refresh", Code: -109}, true},
		{"-101 算失效", &protocol.AuthRejectedError{Step: "login_buffer", Code: -101}, true},
		{"42007 算失效", &protocol.AuthRejectedError{Step: "refresh", Code: 42007}, true},
		{"缺 refresh token 算失效", protocol.ErrMissingRefreshToken, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := definitiveCredentialFailure(tc.err); got != tc.want {
				t.Fatalf("definitiveCredentialFailure() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCurrentAccountStatusNormalizes(t *testing.T) {
	alive, expired, weird, blank := "alive", "expired", "ALIVE", "   "
	cases := []struct {
		name string
		acc  *store.WechatAccount
		want string
	}{
		{"nil 账号", nil, "unknown"},
		{"NULL 状态", &store.WechatAccount{}, "unknown"},
		{"alive 原样保留", &store.WechatAccount{Status: &alive}, "alive"},
		{"expired 原样保留", &store.WechatAccount{Status: &expired}, "expired"},
		{"未知取值当 unknown", &store.WechatAccount{Status: &weird}, "unknown"},
		{"空白当 unknown", &store.WechatAccount{Status: &blank}, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := currentAccountStatus(tc.acc); got != tc.want {
				t.Fatalf("currentAccountStatus() = %q, want %q", got, tc.want)
			}
		})
	}
}

// 关键回归：一次纯粹的网络抖动绝不能让账号掉出 alive，否则脚本会直接跳过它。
func TestTransientFailureKeepsAliveAccount(t *testing.T) {
	creds := protocol.LoginBufferCredentials{ExpiresAt: testNow.Unix() + 7200}
	transient := []error{
		errors.New("context deadline exceeded"),
		errors.New("dial tcp 203.0.113.7:443: connect: connection refused"),
		errors.New("HTTP 503: service unavailable"),
		errors.New("EOF"),
	}
	for _, err := range transient {
		if got := refreshFailureStatus("alive", creds, err, testNow); got != "alive" {
			t.Fatalf("transient %v → status %q, want alive", err, got)
		}
	}
}
