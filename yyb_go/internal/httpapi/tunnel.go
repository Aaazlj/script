package httpapi

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"yyb_go/internal/protocol"
)

// HTTP CONNECT 隧道：把网关当代理用，链路是「本机 → 树脂跳板 → 品赞国内出口 → 目标」。
//
// 为什么需要它：品赞的代理端口从海外直连不通，只能经树脂中转（双跳）；而 Python 的
// requests、curl 这些客户端只能配一层代理，做不了双跳。所以把隧道能力放在网关里，
// 脚本直接 `xc_proxy=http://yyb-go:8000` 就能用上国内出口 —— 出口轮换也由网关统一管。
//
// 安全：默认只信任能访问到网关的客户端（容器内网）；设置 YYB_TUNNEL_TOKEN 后
// 必须带 Proxy-Authorization 才能用，避免网关被外部当成开放代理。

func (a *App) tunnelToken() string {
	return strings.TrimSpace(os.Getenv("YYB_TUNNEL_TOKEN"))
}

func (a *App) tunnelAllowed(r *http.Request) bool {
	token := a.tunnelToken()
	if token == "" {
		return true
	}
	raw := strings.TrimSpace(r.Header.Get("Proxy-Authorization"))
	if raw == "" {
		return false
	}
	parts := strings.SplitN(raw, " ", 2)
	if len(parts) != 2 {
		return false
	}
	value := strings.TrimSpace(parts[1])
	if strings.EqualFold(parts[0], "Bearer") {
		return value == token
	}
	// Basic：用户名随便，密码/令牌位放 token
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		seg := string(decoded)
		if i := strings.IndexByte(seg, ':'); i >= 0 {
			return seg[i+1:] == token
		}
		return seg == token
	}
	return false
}

// handleConnect 处理 CONNECT 请求：经代理链拨号，然后把两个方向直接对接
func (a *App) handleConnect(w http.ResponseWriter, r *http.Request) {
	target := r.Host
	if target == "" {
		target = r.URL.Host
	}
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		http.Error(w, "CONNECT target must be host:port", http.StatusBadRequest)
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		http.Error(w, "CONNECT target port invalid", http.StatusBadRequest)
		return
	}
	if !a.tunnelAllowed(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="yyb"`)
		http.Error(w, "proxy auth required", http.StatusProxyAuthRequired)
		return
	}

	conn, err := a.dialThroughChain(r.Context(), host, port)
	if err != nil {
		http.Error(w, "tunnel dial failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = conn.Close()
		http.Error(w, "hijack not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		_ = conn.Close()
		return
	}

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		_ = clientConn.Close()
		_ = conn.Close()
		return
	}
	log.Printf("[tunnel] CONNECT %s", target)

	go func() {
		_, _ = io.Copy(conn, clientConn)
		_ = conn.Close()
	}()
	_, _ = io.Copy(clientConn, conn)
	_ = clientConn.Close()
}

// dialThroughChain 用当前代理链拨号（拿不到出口时按 fallbackDirect 直连）
func (a *App) dialThroughChain(ctx context.Context, host string, port int) (net.Conn, error) {
	timeout := 20 * time.Second
	dial := protocol.NewProxyDialer(timeout, a.tcpProxyValue, true)
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return dial(dialCtx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}
