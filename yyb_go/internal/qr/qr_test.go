package qr

import (
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewHTTPClientProxyWiring(t *testing.T) {
	c := NewClient(5 * time.Second)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}

	// 没设代理：保持默认（直连），不要无谓地装 Transport
	if hc := c.newHTTPClient(jar); hc.Transport != nil {
		t.Fatalf("未设置代理时不应装自定义 Transport")
	}

	// 设了代理函数：装上代理 Transport（链为空串时它自己会回退直连）
	c.SetProxyFunc(func() string { return "" })
	if hc := c.newHTTPClient(jar); hc.Transport == nil {
		t.Fatalf("设置代理后应装代理 Transport")
	}
}

func TestMaskProxyChainHidesCredentials(t *testing.T) {
	chain := "http-connect://:resintoken@172.19.0.1:2260" +
		"http-connect://acct:secret@1.2.3.4:8080"
	// 故意用错分隔符，确认不会把整串原样打出来
	got := maskProxyChain(chain)
	if strings.Contains(got, "resintoken") || strings.Contains(got, "secret") {
		t.Fatalf("打码后仍泄露凭据: %s", got)
	}

	good := "http-connect://:resintoken@172.19.0.1:2260>>http-connect://acct:secret@1.2.3.4:8080"
	got = maskProxyChain(good)
	if strings.Contains(got, "resintoken") || strings.Contains(got, "secret") {
		t.Fatalf("打码后仍泄露凭据: %s", got)
	}
	if !strings.Contains(got, "172.19.0.1:2260") || !strings.Contains(got, "1.2.3.4:8080") {
		t.Fatalf("打码后应保留各跳 host:port，实际: %s", got)
	}

	if maskProxyChain("") != "direct" {
		t.Fatalf("空链应显示 direct")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFallbackTransportFallsBackToDirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("DIRECT-OK"))
	}))
	defer srv.Close()

	// 代理这一跳直接失败 → 应改用直连（secondary）
	rt := &fallbackTransport{
		primary:   roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("代理不可用") }),
		secondary: http.DefaultTransport,
	}
	resp, err := (&http.Client{Transport: rt}).Get(srv.URL)
	if err != nil {
		t.Fatalf("应回退直连成功，实际报错: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "DIRECT-OK" {
		t.Fatalf("回退直连的内容不对: %q", string(body))
	}

	// 代理可用时不应走直连（用 502 状态而不是错误来区分）
	primaryUsed := false
	rt2 := &fallbackTransport{
		primary: roundTripFunc(func(*http.Request) (*http.Response, error) {
			primaryUsed = true
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("VIA-PROXY"))}, nil
		}),
		secondary: roundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Fatalf("代理成功时不应走直连")
			return nil, nil
		}),
	}
	resp2, err := (&http.Client{Transport: rt2}).Get(srv.URL)
	if err != nil {
		t.Fatalf("走代理成功时不该报错: %v", err)
	}
	defer resp2.Body.Close()
	b2, _ := io.ReadAll(resp2.Body)
	if !primaryUsed || string(b2) != "VIA-PROXY" {
		t.Fatalf("应优先使用代理，实际 primaryUsed=%v body=%q", primaryUsed, string(b2))
	}
}
