package qr

import (
	"net/http/cookiejar"
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
