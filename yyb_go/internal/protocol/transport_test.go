package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

const relayToken = "test-token-xyz"

func TestParseProxyChain(t *testing.T) {
	// 单跳 + 认证
	hops, err := parseProxyChain("http-connect://user:p%40ss@1.2.3.4:8080")
	if err != nil {
		t.Fatalf("单跳解析失败: %v", err)
	}
	if len(hops) != 1 || hops[0].Host != "1.2.3.4" || hops[0].Port != "8080" {
		t.Fatalf("单跳解析结果不对: %+v", hops[0])
	}
	if hops[0].User != "user" || hops[0].Pass != "p@ss" {
		t.Fatalf("认证信息解析不对: %q / %q", hops[0].User, hops[0].Pass)
	}
	if strings.Contains(hops[0].Display(), "p@ss") {
		t.Fatalf("Display 不能泄露密码: %s", hops[0].Display())
	}

	// 双跳：先跳板后出口
	hops, err = parseProxyChain("http-connect://:token@172.19.0.1:2260>>http-connect://acct:secret@5.6.7.8:9000")
	if err != nil {
		t.Fatalf("双跳解析失败: %v", err)
	}
	if len(hops) != 2 {
		t.Fatalf("双跳应解析出 2 跳，实际 %d", len(hops))
	}
	if hops[0].Host != "172.19.0.1" || hops[1].Host != "5.6.7.8" {
		t.Fatalf("跳序不对（应先跳板后出口）: %s / %s", hops[0].Host, hops[1].Host)
	}
	if hops[0].User != "" || hops[0].Pass != "token" {
		t.Fatalf("树脂式（用户名空、token 在密码位）解析不对: %q / %q", hops[0].User, hops[0].Pass)
	}

	// 不支持的协议 / 缺端口
	if _, err := parseProxyChain("socks4://1.2.3.4:1"); err == nil {
		t.Fatalf("socks4 应该报错")
	}
	if _, err := parseProxyChain("http-connect://1.2.3.4"); err == nil {
		t.Fatalf("缺端口应该报错")
	}
	// 空串 = 直连
	if hops, err := parseProxyChain("  "); err != nil || hops != nil {
		t.Fatalf("空串应表示直连: %v / %v", hops, err)
	}
}

// fakeProxy 是一个只会做 CONNECT 的假代理，用来验证链路与认证头。
type fakeProxy struct {
	ln net.Listener

	mu    sync.Mutex
	calls []proxyCall
}

type proxyCall struct {
	target string
	auth   string
}

func newFakeProxy(t *testing.T) *fakeProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	fp := &fakeProxy{ln: ln}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go fp.serve(conn)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return fp
}

func (fp *fakeProxy) addr() string { return fp.ln.Addr().String() }

func (fp *fakeProxy) serve(conn net.Conn) {
	br := bufio.NewReader(conn)
	req, err := http.ReadRequest(br)
	if err != nil {
		_ = conn.Close()
		return
	}
	fp.mu.Lock()
	fp.calls = append(fp.calls, proxyCall{target: req.Host, auth: req.Header.Get("Proxy-Authorization")})
	fp.mu.Unlock()

	if req.Method != http.MethodConnect {
		_, _ = conn.Write([]byte("HTTP/1.1 405 Method Not Allowed\r\n\r\n"))
		_ = conn.Close()
		return
	}
	upstream, err := net.DialTimeout("tcp", req.Host, 3*time.Second)
	if err != nil {
		_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		_ = conn.Close()
		return
	}
	_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	go func() {
		_, _ = io.Copy(upstream, br)
		_ = upstream.Close()
	}()
	_, _ = io.Copy(conn, upstream)
	_ = conn.Close()
}

func (fp *fakeProxy) snapshot() []proxyCall {
	fp.mu.Lock()
	defer fp.mu.Unlock()
	out := make([]proxyCall, len(fp.calls))
	copy(out, fp.calls)
	return out
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestDialChainThroughTwoProxies(t *testing.T) {
	// 最终目标：一个只会回一句暗号的假服务器
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("目标监听失败: %v", err)
	}
	t.Cleanup(func() { _ = targetLn.Close() })
	go func() {
		for {
			c, err := targetLn.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("TARGET-OK"))
		}
	}()
	targetHost, targetPortStr, _ := net.SplitHostPort(targetLn.Addr().String())

	relay := newFakeProxy(t)    // 第一跳：树脂（用户名空，token 在密码位）
	final := newFakeProxy(t)    // 第二跳：品赞（账号密码）
	finalHost, finalPort, _ := net.SplitHostPort(final.addr())

	chain := "http-connect://:" + relayToken + "@" + relay.addr() +
		proxyChainSeparator + "http-connect://acct123:secret456@" + final.addr()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialTCP(ctx, targetHost, mustAtoi(targetPortStr), 5*time.Second, chain, false)
	if err != nil {
		t.Fatalf("双跳建连失败: %v", err)
	}
	defer conn.Close()

	buf := make([]byte, len("TARGET-OK"))
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("读目标响应失败: %v", err)
	}
	if string(buf) != "TARGET-OK" {
		t.Fatalf("目标响应不对: %q", string(buf))
	}

	// 第一跳应该被要求连到「第二跳」
	relayCalls := relay.snapshot()
	if len(relayCalls) != 1 {
		t.Fatalf("跳板应收到 1 次 CONNECT，实际 %d", len(relayCalls))
	}
	if relayCalls[0].target != net.JoinHostPort(finalHost, finalPort) {
		t.Fatalf("跳板目标应为第二跳 %s，实际 %s", final.addr(), relayCalls[0].target)
	}
	if relayCalls[0].auth != basic("", relayToken) {
		t.Fatalf("跳板认证头不对: %q", relayCalls[0].auth)
	}

	// 第二跳（品赞）应该被要求连到真正的目标，且带上品赞的账号密码
	finalCalls := final.snapshot()
	if len(finalCalls) != 1 {
		t.Fatalf("出口应收到 1 次 CONNECT，实际 %d", len(finalCalls))
	}
	if finalCalls[0].target != net.JoinHostPort(targetHost, targetPortStr) {
		t.Fatalf("出口目标应为真实目标 %s，实际 %s", targetLn.Addr(), finalCalls[0].target)
	}
	if finalCalls[0].auth != basic("acct123", "secret456") {
		t.Fatalf("出口认证头不对: %q（品赞必须带账号密码）", finalCalls[0].auth)
	}
}

func TestDialTCPFallsBackToDirect(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("DIRECT"))
		}
	}()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())

	// 链指向一个关掉的端口：应该回退直连，而不是整体失败
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	deadAddr := dead.Addr().String()
	_ = dead.Close()

	ctx := context.Background()
	conn, err := dialTCP(ctx, host, mustAtoi(portStr), 2*time.Second,
		"http-connect://"+deadAddr, true)
	if err != nil {
		t.Fatalf("fallbackDirect=true 时应回退直连: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, len("DIRECT"))
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "DIRECT" {
		t.Fatalf("直连回退读取失败: %v / %q", err, string(buf))
	}

	// fallbackDirect=false 时应明确报错（便于区分「代理挂了」和「目标挂了」）
	if _, err := dialTCP(ctx, host, mustAtoi(portStr), 2*time.Second,
		"http-connect://"+deadAddr, false); err == nil {
		t.Fatalf("fallbackDirect=false 时代理不可用应报错")
	}
}
