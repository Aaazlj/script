package httpapi

import (
	"context"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 账号保活：定时给所有存活账号刷一次登录态。
//
// 为什么要有它：微信侧的登录态/access token 有效期很短（两小时），
// 目前只有脚本运行时才会顺手刷新——而「expired」这个状态只会被
// 「刷新成功」或「重新扫码」改变。把刷新做成后台循环，账号就能一直
// 处于「常用」状态，降低被微信侧判定闲置而撤销授权的概率；
// 即便失效也能在当天就发现，而不是等脚本报错。
//
// 参考了 YYB-Go-Enhanced 的 keepalive：间隔可配、跳过 expired、
// 失败退避、并发限流。我们的 refreshLiveness 自带串行化和冷却，
// 所以同一个账号被保活循环和面板/脚本同时刷新也不会出问题。
type keepAliveSnapshot struct {
	Enabled     bool   `json:"enabled"`
	Interval    string `json:"interval"`
	Running     bool   `json:"running"`
	LastStartAt int64  `json:"last_start_at"`
	LastEndAt   int64  `json:"last_end_at"`
	NextRunAt   int64  `json:"next_run_at"`
	// 最近一轮各状态的账号数（alive / expired / unknown / skipped）
	Counts map[string]int `json:"counts"`
	Reason string         `json:"reason"`
}

type keepAliveState struct {
	mu       sync.Mutex
	snapshot keepAliveSnapshot
	stop     chan struct{}
	stopped  bool
}

func (a *App) startKeepAlive() {
	interval := a.cfg.KeepAliveInterval
	if interval <= 0 {
		log.Printf("[keepalive] 未配置保活间隔（YYB_KEEPALIVE_INTERVAL），后台保活关闭")
		return
	}
	a.keepAlive = &keepAliveState{stop: make(chan struct{})}
	a.updateKeepAlive(func(s *keepAliveSnapshot) {
		s.Enabled = true
		s.Interval = interval.String()
	})
	log.Printf("[keepalive] 后台保活已启动：每 %s 刷一轮存活账号", interval)

	go func() {
		// 启动先跑一轮，别让第一轮等满一个间隔
		a.keepAliveOnce("启动")
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-a.keepAlive.stop:
				return
			case <-ticker.C:
				a.keepAliveOnce("定时")
			}
		}
	}()
}

func (a *App) stopKeepAlive() {
	if a.keepAlive == nil {
		return
	}
	a.keepAlive.mu.Lock()
	if !a.keepAlive.stopped {
		close(a.keepAlive.stop)
		a.keepAlive.stopped = true
	}
	a.keepAlive.mu.Unlock()
}

func (a *App) updateKeepAlive(fn func(*keepAliveSnapshot)) {
	if a.keepAlive == nil {
		return
	}
	a.keepAlive.mu.Lock()
	defer a.keepAlive.mu.Unlock()
	fn(&a.keepAlive.snapshot)
}

func (a *App) keepAliveSnapshot() keepAliveSnapshot {
	if a.keepAlive == nil {
		return keepAliveSnapshot{Enabled: false}
	}
	a.keepAlive.mu.Lock()
	defer a.keepAlive.mu.Unlock()
	return a.keepAlive.snapshot
}

// keepAliveOnce 跑一轮保活：跳过 expired 账号（那是「必须重新扫码」的明确结论，
// 不该在这里反复撞），其余账号按存活状态刷新。
func (a *App) keepAliveOnce(reason string) {
	if a.keepAlive == nil {
		return
	}
	started := time.Now()
	a.updateKeepAlive(func(s *keepAliveSnapshot) {
		s.Running = true
		s.Reason = reason
		s.LastStartAt = started.Unix()
		s.NextRunAt = started.Add(a.cfg.KeepAliveInterval).Unix()
	})
	log.Printf("[keepalive] 开始一轮保活（%s）", reason)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	accounts, err := a.db.ListAccounts(ctx)
	if err != nil {
		log.Printf("[keepalive] 读账号失败: %v", err)
		a.updateKeepAlive(func(s *keepAliveSnapshot) { s.Running = false })
		return
	}

	counts := map[string]int{"alive": 0, "expired": 0, "unknown": 0, "skipped": 0}
	for _, acc := range accounts {
		if ctx.Err() != nil {
			break
		}
		// expired = 明确需要重扫的结论，不在这里撞墙
		if currentAccountStatus(acc) == "expired" {
			counts["skipped"]++
			continue
		}
		if acc.Credentials == nil {
			counts["skipped"]++
			continue
		}
		status := a.refreshLiveness(ctx, acc)
		counts[status]++
	}

	finished := time.Now()
	a.updateKeepAlive(func(s *keepAliveSnapshot) {
		s.Running = false
		s.LastEndAt = finished.Unix()
		s.Counts = counts
	})
	log.Printf("[keepalive] 一轮完成（%s）：存活 %d / 失效 %d / 待定 %d / 跳过 %d，耗时 %s",
		reason, counts["alive"], counts["expired"], counts["unknown"], counts["skipped"],
		finished.Sub(started).Truncate(time.Second))
}

// handleKeepAlive GET 状态 / POST 立即跑一轮
func (a *App) handleKeepAlive(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/keepalive" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.keepAliveSnapshot())
	case http.MethodPost:
		if a.keepAlive == nil {
			writeError(w, http.StatusBadRequest, "保活未启用（YYB_KEEPALIVE_INTERVAL 未配置）")
			return
		}
		if a.keepAliveSnapshot().Running {
			writeJSON(w, http.StatusOK, map[string]any{"already": true, "status": a.keepAliveSnapshot()})
			return
		}
		go a.keepAliveOnce("手动")
		writeJSON(w, http.StatusOK, map[string]any{"started": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// keepAliveSummary 给面板/概览用的一行描述
func (a *App) keepAliveSummary() map[string]any {
	snap := a.keepAliveSnapshot()
	out := map[string]any{
		"enabled":  snap.Enabled,
		"running":  snap.Running,
		"interval": snap.Interval,
	}
	if snap.LastStartAt > 0 {
		out["last_start_at"] = snap.LastStartAt
	}
	if snap.NextRunAt > 0 {
		out["next_run_at"] = snap.NextRunAt
	}
	if snap.Counts != nil {
		out["counts"] = snap.Counts
	}
	if strings.TrimSpace(snap.Reason) != "" {
		out["reason"] = snap.Reason
	}
	return out
}
