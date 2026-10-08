package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"yyb_go/internal/httpapi"
	"yyb_go/internal/protocol"
)

func envDurationOr(key string, fallback time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

func envBoolOr(key string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "":
		return fallback
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func main() {
	host := flag.String("host", "127.0.0.1", "listen host")
	port := flag.Int("port", 8000, "listen port")
	resourceRoot := flag.String("resource-root", filepath.Join(".", "resource"), "runtime resource directory")
	dbFilename := flag.String("db", httpapi.DefaultDBFilename, "SQLite database filename under resource/db")
	tcpProxy := flag.String("tcp-proxy", "", "optional TCP proxy: socks5://host:port or http-connect://host:port")
	ipzanExtract := flag.String("ipzan-extract", os.Getenv("YYB_IPZAN_EXTRACT_URL"),
		"提取接口（品赞）地址，含 secret；配置后取 code / 续期都会走国内住宅出口")
	ipzanRelay := flag.String("ipzan-relay", os.Getenv("YYB_IPZAN_RELAY"),
		"到达提取接口与品赞出口所需的跳板，如 http-connect://:token@172.19.0.1:2260（用品赞必须配）")
	ipzanScheme := flag.String("ipzan-proxy-scheme", envOr("YYB_IPZAN_PROXY_SCHEME", "http-connect"),
		"品赞出口协议：http-connect（protocol=1）或 socks5（protocol=2）")
	ipzanScan := flag.Bool("ipzan-scan", envBoolOr("YYB_IPZAN_SCAN", true),
		"扫码流程（建会话/取二维码/轮询/换登录态）是否也走动态出口，默认是")
	keepAlive := flag.Duration("keepalive-interval", envDurationOr("YYB_KEEPALIVE_INTERVAL", 6*time.Hour),
		"后台保活间隔（<=0 关闭）：定时刷新所有存活账号的登录态")
	flag.Parse()

	var proxyProvider *protocol.ProxyProvider
	if strings.TrimSpace(*ipzanExtract) != "" {
		proxyProvider = protocol.NewProxyProvider(protocol.ProxyProviderConfig{
			ExtractURL:  strings.TrimSpace(*ipzanExtract),
			Relay:       strings.TrimSpace(*ipzanRelay),
			ProxyScheme: strings.TrimSpace(*ipzanScheme),
			Timeout:     15 * time.Second,
		})
		log.Printf("已启用动态出口（品赞链路）: 跳板=%v", *ipzanRelay != "")
	}

	cfg := httpapi.Config{
		ResourceRoot:      *resourceRoot,
		DBFilename:        *dbFilename,
		TCPProxy:          *tcpProxy,
		Proxy:             proxyProvider,
		ProxyScan:         *ipzanScan,
		KeepAliveInterval: *keepAlive,
		SessionTTL:        30 * time.Minute,
		RequestTimeout:    8 * time.Second,
		AvatarTimeout:     10 * time.Second,
		ScanTimeout:       180 * time.Second,
		QRSessionTTL:      5 * time.Minute,
	}

	app, err := httpapi.NewApp(cfg)
	if err != nil {
		log.Fatalf("init app: %v", err)
	}
	defer app.Close()

	addr := fmt.Sprintf("%s:%d", *host, *port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("YYB Go service listening on http://%s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
