package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	newdnsHost      = "aedns.weixin.qq.com"
	newdnsBackupIP  = "180.153.202.85"
	newdnsPath      = "/cgi-bin/default/getdns"
	longlinkDomain  = "longcloud.weixin.com"
	shortlinkDomain = "shortcloud.weixin.com"
	protoMMTLS      = "mmtlsovertcp"
	defaultUA       = "MicroMessenger Client"
)

type Target struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

type dnsDomain struct {
	IPs       []string
	Protocols map[string][]int
	Timeout   int
}

type dnsCacheEntry struct {
	ExpiresAt time.Time
	Parsed    map[string]dnsDomain
}

var dnsCache = struct {
	sync.Mutex
	entries map[string]dnsCacheEntry
}{entries: map[string]dnsCacheEntry{}}

func buildDNSQuery(clientVersion int, deviceType string, uin int) string {
	v := url.Values{}
	v.Set("clientversion", strconv.Itoa(clientVersion))
	v.Set("devicetype", deviceType)
	v.Set("uin", strconv.Itoa(uin))
	v.Set("format", "json")
	return v.Encode()
}

func requestNewDNS(ctx context.Context, connectTo string, timeout time.Duration) (int, map[string]any, string, error) {
	host := connectTo
	if host == "" {
		host = newdnsHost
	}
	conn, err := dialDirect(ctx, host, 80, timeout)
	if err != nil {
		return 0, nil, "", err
	}
	defer conn.Close()
	if timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(timeout))
	}
	path := newdnsPath + "?" + buildDNSQuery(0, "Windows", 0)
	req := fmt.Sprintf("GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: %s\r\nAccept: */*\r\nConnection: close\r\n\r\n", path, newdnsHost, defaultUA)
	if _, err = conn.Write([]byte(req)); err != nil {
		return 0, nil, "", err
	}
	raw, err := io.ReadAll(conn)
	if err != nil {
		return 0, nil, "", err
	}
	head, body := splitHTTP(raw)
	status := 0
	if lines := strings.Split(head, "\n"); len(lines) > 0 {
		parts := strings.Fields(lines[0])
		if len(parts) >= 2 {
			status, _ = strconv.Atoi(parts[1])
		}
	}
	text := string(body)
	var obj map[string]any
	_ = json.Unmarshal(body, &obj)
	return status, obj, text, nil
}

func getDNSParsed(ctx context.Context, timeout, cacheTTL time.Duration, force bool) (map[string]dnsDomain, error) {
	key := "0|Windows"
	now := time.Now()
	if !force && cacheTTL > 0 {
		dnsCache.Lock()
		if ent, ok := dnsCache.entries[key]; ok && ent.ExpiresAt.After(now) {
			dnsCache.Unlock()
			return ent.Parsed, nil
		}
		dnsCache.Unlock()
	}
	var last error
	for _, connectTo := range []string{"", newdnsBackupIP} {
		status, obj, text, err := requestNewDNS(ctx, connectTo, timeout)
		if err != nil {
			last = err
			continue
		}
		if status != 200 || obj == nil {
			last = fmt.Errorf("newdns HTTP %d body=%q", status, text[:min(len(text), 120)])
			continue
		}
		parsed, err := parseDomainList(obj)
		if err != nil {
			last = err
			continue
		}
		if cacheTTL > 0 {
			dnsCache.Lock()
			dnsCache.entries[key] = dnsCacheEntry{ExpiresAt: now.Add(cacheTTL), Parsed: parsed}
			dnsCache.Unlock()
		}
		return parsed, nil
	}
	if last == nil {
		last = fmt.Errorf("newdns request failed")
	}
	return nil, last
}

func parseDomainList(obj map[string]any) (map[string]dnsDomain, error) {
	dnsObj, ok := obj["dns"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("dns missing in response")
	}
	if rc, ok := dnsObj["retcode"].(float64); ok && int(rc) != 0 {
		return nil, fmt.Errorf("newdns retcode=%d", int(rc))
	}
	list, ok := dnsObj["domainlist"].([]any)
	if !ok {
		return nil, fmt.Errorf("domainlist missing in response")
	}
	out := map[string]dnsDomain{}
	for _, item := range list {
		d, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := d["name"].(string)
		if name == "" {
			continue
		}
		dom := dnsDomain{Protocols: map[string][]int{}}
		if t, ok := d["timeout"].(float64); ok {
			dom.Timeout = int(t)
		}
		if ips, ok := d["iplist"].([]any); ok {
			for _, it := range ips {
				if m, ok := it.(map[string]any); ok {
					if ip, ok := m["ip"].(string); ok && net.ParseIP(ip) != nil {
						dom.IPs = append(dom.IPs, ip)
					}
				}
			}
		}
		if plist, ok := d["protocollist"].([]any); ok {
			for _, it := range plist {
				p, ok := it.(map[string]any)
				if !ok {
					continue
				}
				pname, _ := p["name"].(string)
				if pname == "" {
					continue
				}
				if ports, ok := p["portlist"].([]any); ok {
					for _, pv := range ports {
						if f, ok := pv.(float64); ok {
							dom.Protocols[pname] = append(dom.Protocols[pname], int(f))
						}
					}
				}
			}
		}
		out[name] = dom
	}
	return out, nil
}

func serversFor(parsed map[string]dnsDomain, domain, proto string) []Target {
	info, ok := parsed[domain]
	if !ok {
		return nil
	}
	ports := info.Protocols[proto]
	var out []Target
	for _, ip := range info.IPs {
		for _, p := range ports {
			out = append(out, Target{IP: ip, Port: p})
		}
	}
	return out
}

func getLonglinkTargets(ctx context.Context, timeout, cacheTTL time.Duration) ([]Target, error) {
	parsed, err := getDNSParsed(ctx, timeout, cacheTTL, false)
	if err != nil {
		// 微信 HTTPDNS 入口（aedns.weixin.qq.com）只在大陆可达，
		// 海外机器会超时。此时退回系统 DNS 解析长连接域名。
		if fallback := systemDNSLonglinkTargets(ctx); len(fallback) > 0 {
			return fallback, nil
		}
		return nil, err
	}
	targets := serversFor(parsed, longlinkDomain, protoMMTLS)
	if len(targets) == 0 {
		if fallback := systemDNSLonglinkTargets(ctx); len(fallback) > 0 {
			return fallback, nil
		}
	}
	return targets, nil
}

// systemDNSLonglinkTargets 是 HTTPDNS 不可达时的兜底：
// 用系统 DNS 解析 longlinkDomain，按常见 mmtls 端口展开候选。
//
// 只取前两个 IP（系统 DNS 已按地理位置给出就近节点），并且每个 IP 都展开
// 8080/80/443 三个端口——因为 orderLonglinkTargets 是"按端口优先"排序后截断的，
// 若给出太多 IP，后面的端口会被截掉，反而试不到。
//
// 注意：容器里的 DNS 常常只返回 AAAA（IPv6），而容器多半没有 IPv6 出网，
// 所以**显式只查 IPv4**；查不到再退回普通 LookupHost 并过滤掉 IPv6。
func systemDNSLonglinkTargets(ctx context.Context) []Target {
	// 关键：不能直接用上游 ctx —— 走到这里时前面的 HTTPDNS 两次 dial
	// 已经耗掉十几秒，上游 deadline 往往已经到期，查询会立刻被取消。
	// 用 WithoutCancel 脱离上游取消，再套一个自己的超时。
	base := context.WithoutCancel(ctx)
	lookupCtx, cancel := context.WithTimeout(base, 5*time.Second)
	defer cancel()

	var ips []string
	if addrs, err := net.DefaultResolver.LookupNetIP(lookupCtx, "ip4", longlinkDomain); err == nil {
		for _, a := range addrs {
			if a.Is4() {
				ips = append(ips, a.String())
			}
		}
	} else {
		log.Printf("[newdns] system dns ip4 lookup failed: %v", err)
	}
	if len(ips) == 0 {
		if addrs, err := net.DefaultResolver.LookupHost(lookupCtx, longlinkDomain); err == nil {
			for _, ip := range addrs {
				if p := net.ParseIP(ip); p != nil && p.To4() != nil {
					ips = append(ips, ip)
				}
			}
		} else {
			log.Printf("[newdns] system dns lookup failed: %v", err)
		}
	}
	if len(ips) == 0 {
		log.Printf("[newdns] no IPv4 for %s, fallback unavailable", longlinkDomain)
		return nil
	}

	const maxIPs = 2
	var out []Target
	for _, ip := range ips {
		if len(out) >= maxIPs*3 {
			break
		}
		for _, port := range []int{8080, 80, 443} {
			out = append(out, Target{IP: ip, Port: port})
		}
	}
	log.Printf("[newdns] HTTPDNS unavailable, using system dns targets: %v", out)
	return out
}

func getShortlinkTargets(ctx context.Context, timeout, cacheTTL time.Duration) []Target {
	parsed, err := getDNSParsed(ctx, timeout, cacheTTL, false)
	if err != nil {
		return []Target{{IP: "120.241.131.173", Port: 80}}
	}
	targets := serversFor(parsed, shortlinkDomain, "http")
	seen := map[string]bool{}
	var out []Target
	for _, t := range targets {
		if t.Port == 80 && !seen[t.IP] {
			seen[t.IP] = true
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []Target{{IP: "120.241.131.173", Port: 80}}
	}
	return out
}

func orderLonglinkTargets(targets []Target, max int) []Target {
	pref := []int{8080, 80, 443, 5000}
	seen := map[string]bool{}
	var out []Target
	for _, p := range pref {
		for _, t := range targets {
			if t.Port == p && !seen[t.IP] {
				seen[t.IP] = true
				out = append(out, t)
			}
		}
	}
	if len(out) == 0 {
		out = append(out, targets...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return out
}

func splitHTTP(raw []byte) (string, []byte) {
	idx := strings.Index(string(raw), "\r\n\r\n")
	if idx < 0 {
		return "", raw
	}
	return string(raw[:idx]), raw[idx+4:]
}
