package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// tcpProxy 是一跳代理。支持（可选）用户名密码，用于品赞这类需要认证的代理。
type tcpProxy struct {
	Scheme string
	Host   string
	Port   string
	User   string
	Pass   string
}

func (p *tcpProxy) Addr() string {
	if p == nil {
		return ""
	}
	return net.JoinHostPort(p.Host, p.Port)
}

func (p *tcpProxy) hasAuth() bool {
	return p != nil && (p.User != "" || p.Pass != "")
}

// Display 给日志用的脱敏描述（绝不打印密码）
func (p *tcpProxy) Display() string {
	if p == nil {
		return "direct"
	}
	if p.hasAuth() {
		return fmt.Sprintf("%s://%s:***@%s", p.Scheme, p.User, p.Addr())
	}
	return fmt.Sprintf("%s://%s", p.Scheme, p.Addr())
}

// proxyChainSeparator 分隔多跳代理，按「先连的在前」排列：
//
//	http-connect://token@relay:2260>>http-connect://user:pass@1.2.3.4:8080
//
// 意思是：直连 relay，再让 relay 把流量穿透到 1.2.3.4:8080，
// 最后用 1.2.3.4:8080 去连目标。单跳时就是原来的行为。
const proxyChainSeparator = ">>"

func parseTCPProxy(value string) (*tcpProxy, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	u, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "socks5" && u.Scheme != "http-connect" {
		return nil, fmt.Errorf("tcp_proxy must use socks5:// or http-connect://")
	}
	if u.Hostname() == "" || u.Port() == "" {
		return nil, fmt.Errorf("tcp_proxy must include host and port")
	}
	hop := &tcpProxy{Scheme: u.Scheme, Host: u.Hostname(), Port: u.Port()}
	if u.User != nil {
		hop.User = u.User.Username()
		hop.Pass, _ = u.User.Password()
	}
	return hop, nil
}

// parseProxyChain 解析可能带多跳的代理串；空串表示直连。
func parseProxyChain(value string) ([]*tcpProxy, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parts := strings.Split(value, proxyChainSeparator)
	hops := make([]*tcpProxy, 0, len(parts))
	for _, part := range parts {
		hop, err := parseTCPProxy(part)
		if err != nil {
			return nil, err
		}
		if hop == nil {
			return nil, fmt.Errorf("tcp_proxy 链里有空的一跳: %q", value)
		}
		hops = append(hops, hop)
	}
	return hops, nil
}

func dialTCP(ctx context.Context, host string, port int, timeout time.Duration, proxyValue string, fallbackDirect bool) (net.Conn, error) {
	hops, err := parseProxyChain(proxyValue)
	if err != nil {
		return nil, err
	}
	if len(hops) == 0 {
		return dialDirect(ctx, host, port, timeout)
	}
	conn, err := dialChain(ctx, hops, host, port, timeout)
	if err == nil {
		return conn, nil
	}
	if !fallbackDirect {
		return nil, err
	}
	return dialDirect(ctx, host, port, timeout)
}

func dialDirect(ctx context.Context, host string, port int, timeout time.Duration) (net.Conn, error) {
	var d net.Dialer
	if timeout > 0 {
		d.Timeout = timeout
	}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}

// dialChain 按跳顺序建立隧道：先直连第一跳，再逐跳 CONNECT 穿透，
// 最后一跳负责连目标。
func dialChain(ctx context.Context, hops []*tcpProxy, targetHost string, targetPort int, timeout time.Duration) (net.Conn, error) {
	first := hops[0]
	conn, err := dialDirect(ctx, first.Host, mustAtoi(first.Port), timeout)
	if err != nil {
		return nil, fmt.Errorf("连接代理 %s 失败: %w", first.Display(), err)
	}
	if timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(timeout))
		defer conn.SetDeadline(time.Time{})
	}

	// 用第 i-1 跳把第 i 跳「打开」（第二跳开始都是套在隧道里谈的）
	// 注意：出错时 proxyConnect 会返回 nil，必须用原 conn 去 Close，
	// 否则就是空指针解引用（会让 HTTP handler 直接 panic）。
	for i := 1; i < len(hops); i++ {
		next, err := proxyConnect(conn, hops[i-1], hops[i].Host, mustAtoi(hops[i].Port))
		if err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("穿透到第 %d 跳 %s 失败: %w", i+1, hops[i].Display(), err)
		}
		conn = next
	}

	last := hops[len(hops)-1]
	next, err := proxyConnect(conn, last, targetHost, targetPort)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("经代理 %s 连接 %s:%d 失败: %w", last.Display(), targetHost, targetPort, err)
	}
	return next, nil
}

func proxyConnect(conn net.Conn, via *tcpProxy, host string, port int) (net.Conn, error) {
	if via != nil && via.Scheme == "socks5" {
		return conn, socks5Connect(conn, host, port, via)
	}
	return httpConnect(conn, host, port, via)
}

func socks5Connect(conn net.Conn, targetHost string, targetPort int, via *tcpProxy) error {
	if via.hasAuth() {
		if _, err := conn.Write([]byte{0x05, 0x02, 0x00, 0x02}); err != nil {
			return err
		}
	} else if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return err
	}
	if buf[0] != 0x05 {
		return fmt.Errorf("SOCKS5 negotiation failed: %x", buf)
	}
	switch buf[1] {
	case 0x00:
		// 无需认证
	case 0x02:
		if !via.hasAuth() {
			return fmt.Errorf("SOCKS5 代理要求用户名密码，但未配置")
		}
		if err := socks5Auth(conn, via.User, via.Pass); err != nil {
			return err
		}
	default:
		return fmt.Errorf("SOCKS5 不支持的认证方式: %d", buf[1])
	}

	hostBytes := []byte(targetHost)
	if len(hostBytes) > 255 {
		return fmt.Errorf("SOCKS5 target host too long")
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(hostBytes))}
	req = append(req, hostBytes...)
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], uint16(targetPort))
	req = append(req, p[:]...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[0] != 5 || head[1] != 0 {
		return fmt.Errorf("SOCKS5 connect failed: %x", head)
	}
	switch head[3] {
	case 1:
		_, err := io.CopyN(io.Discard, conn, 6)
		return err
	case 3:
		ln := make([]byte, 1)
		if _, err := io.ReadFull(conn, ln); err != nil {
			return err
		}
		_, err := io.CopyN(io.Discard, conn, int64(ln[0])+2)
		return err
	case 4:
		_, err := io.CopyN(io.Discard, conn, 18)
		return err
	default:
		return fmt.Errorf("SOCKS5 unsupported bind address type: %d", head[3])
	}
}

func socks5Auth(conn net.Conn, user, pass string) error {
	if len(user) > 255 || len(pass) > 255 {
		return fmt.Errorf("SOCKS5 用户名或密码过长")
	}
	req := []byte{0x01, byte(len(user))}
	req = append(req, user...)
	req = append(req, byte(len(pass)))
	req = append(req, pass...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return err
	}
	if resp[1] != 0x00 {
		return fmt.Errorf("SOCKS5 认证被拒绝: %x", resp)
	}
	return nil
}

// bufferedConn 把「读 CONNECT 响应时多读进来的字节」还给上层。
//
// 这是个容易踩的坑：响应和随后的隧道数据可能落在同一个 TCP 段里，
// 用 bufio.Reader 读响应会把隧道数据一起读进缓冲区，如果直接扔掉，
// 双跳时代理链会因为丢掉「下一跳的 200 响应」而永久卡住。
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func httpConnect(conn net.Conn, targetHost string, targetPort int, via *tcpProxy) (net.Conn, error) {
	target := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	var b strings.Builder
	b.WriteString("CONNECT " + target + " HTTP/1.1\r\n")
	b.WriteString("Host: " + target + "\r\n")
	if via.hasAuth() {
		token := base64.StdEncoding.EncodeToString([]byte(via.User + ":" + via.Pass))
		b.WriteString("Proxy-Authorization: Basic " + token + "\r\n")
	}
	b.WriteString("Connection: close\r\n\r\n")
	if _, err := conn.Write([]byte(b.String())); err != nil {
		return nil, err
	}
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	parts := strings.Fields(line)
	if len(parts) < 2 || !strings.HasPrefix(parts[1], "2") {
		return nil, fmt.Errorf("HTTP CONNECT failed: %s", strings.TrimSpace(line))
	}
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if l == "\r\n" || l == "\n" {
			break
		}
	}
	return &bufferedConn{Conn: conn, r: br}, nil
}

func mustAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
