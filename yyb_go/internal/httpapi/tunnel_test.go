package httpapi

import (
	"bufio"
	"io"
	"net"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// CONNECT 隧道：客户端把网关当 HTTP 代理，网关用它自己的代理链去拨号。
// 这样脚本（requests/curl 只能配一层代理）也能用上「树脂>>国内出口」的双跳。
func TestConnectTunnelPipesBytes(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("目标监听失败: %v", err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("TUNNEL-OK"))
		}
	}()

	app, _ := newTestApp(t)
	srv := httptest.NewServer(app.Handler())
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")

	conn, err := net.Dial("tcp", host)
	if err != nil {
		t.Fatalf("连测试服务失败: %v", err)
	}
	defer conn.Close()

	req := "CONNECT " + target.Addr().String() + " HTTP/1.1\r\nHost: " + target.Addr().String() + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("发 CONNECT 失败: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("读响应失败: %v", err)
	}
	if !strings.Contains(line, "200") {
		t.Fatalf("CONNECT 应返回 200，实际: %q", line)
	}
	for { // 吃掉响应头
		l, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("读响应头失败: %v", err)
		}
		if l == "\r\n" || l == "\n" {
			break
		}
	}
	buf := make([]byte, len("TUNNEL-OK"))
	if _, err := io.ReadFull(br, buf); err != nil {
		t.Fatalf("读隧道数据失败: %v", err)
	}
	if string(buf) != "TUNNEL-OK" {
		t.Fatalf("隧道数据不对: %q", string(buf))
	}
}

// 配了 YYB_TUNNEL_TOKEN 就必须带认证，别让网关变成开放代理
func TestConnectTunnelRequiresTokenWhenConfigured(t *testing.T) {
	t.Setenv("YYB_TUNNEL_TOKEN", "sekret")
	app, _ := newTestApp(t)
	srv := httptest.NewServer(app.Handler())
	defer srv.Close()

	u, _ := url.Parse(srv.URL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatalf("连接失败: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("CONNECT www.baidu.com:443 HTTP/1.1\r\nHost: www.baidu.com:443\r\n\r\n"))
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("读响应失败: %v", err)
	}
	if !strings.Contains(line, "407") {
		t.Fatalf("缺认证应返回 407，实际: %q", line)
	}
}
