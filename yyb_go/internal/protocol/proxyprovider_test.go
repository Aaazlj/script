package protocol

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 按需提取：只有请求真的需要出口时才去提取，且同一个窗口内只提一次。
func TestProviderExtractsOnDemandOnly(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		_, _ = w.Write([]byte("1.2.3.4:8080 testacct testpass"))
	}))
	defer srv.Close()

	p := NewProxyProvider(ProxyProviderConfig{
		ExtractURL:    srv.URL,
		ProxyScheme:   "http-connect",
		Timeout:       2 * time.Second,
		IdleStopAfter: 300 * time.Millisecond,
		WaitForExit:   2 * time.Second,
	})

	// 一开始没有入口，也没请求过 → 不在活跃期，后台不会提取
	if got := atomic.LoadInt64(&hits); got != 0 {
		t.Fatalf("没有任何请求时不应提取，实际 %d 次", got)
	}
	if p.inActiveWindow() {
		t.Fatalf("没有请求过不应处于活跃期")
	}
	if chain := p.readyChain(); chain != "" {
		t.Fatalf("还没有出口时 readyChain 应为空，实际 %q", chain)
	}

	// 第一个请求：按需提取，并等它赶上（这次就走国内出口）
	chain := p.Current()
	if chain == "" {
		t.Fatalf("首个请求应该触发提取并拿到出口")
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Fatalf("首个请求应提取 1 次，实际 %d 次", got)
	}
	if !p.inActiveWindow() {
		t.Fatalf("刚用过出口应处于活跃期")
	}

	// 同一窗口内的后续请求：复用出口，不再提取
	for i := 0; i < 3; i++ {
		if c := p.Current(); c != chain {
			t.Fatalf("同一窗口内应复用同一个出口，实际 %q vs %q", c, chain)
		}
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Fatalf("同一窗口内不应重复提取，实际 %d 次", got)
	}

	// 闲置超过 IdleStopAfter → 退出活跃期（后台从此不再提取）
	time.Sleep(400 * time.Millisecond)
	if p.inActiveWindow() {
		t.Fatalf("闲置超过窗口后不应还在活跃期")
	}

	// 面板状态里要能看出是按需模式
	st := p.Status()
	if st["on_demand"] != true || st["active"] != false {
		t.Fatalf("状态字段不对: %+v", st)
	}
	_ = context.Background()
}
