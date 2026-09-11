# token-web · 扫码登录取 token

给青龙脚本供料的小 Web：扫码登录 → 拿到 token → 一键复制 / 导出成 `MT_TOKEN` 环境变量。

```
┌── 浏览器 ──fetch──> server.js ──spawn──> 专家 run.js（登录）──> 美团 Passport
│                        │
│                        └──https POST──> media.meituan.com（验证 token）
└── data/mt_token.txt <───┘
```

## 启动

```bash
node server.js
# 打开 http://127.0.0.1:5178
```

只监听 `127.0.0.1`，本机专用。`PORT=8080 node server.js` 可换端口。
依赖本机已安装「领券下单找我」专家（登录能力由它的 `scripts/run.js` 提供）。

## 页面能做什么

| 功能 | 说明 |
|------|------|
| 扫码登录 | 生成二维码 + 登录链接，自动轮询授权结果，登录成功即刷新 token |
| Token 展示 | 默认脱敏，可切换显示完整值，支持一键复制 |
| 青龙变量 | 直接生成 `export MT_TOKEN=xxx`，一键复制 |
| 导出到文件 | 写入 `data/mt_token.txt`，青龙脚本可直接挂载读取 |
| 验证可用性 | 真实调用一次领券接口，判断 token 是否有效 |
| 退出登录 | 清除本机 Passport 缓存 |

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/token` | 返回完整 token（本服务的核心用途） |
| POST | `/api/run` | 执行白名单命令：`get-token` / `auth-get-code` / `qrcode` / `logout` |
| POST | `/api/task` | 启动长任务（`auth-poll-token`），返回 `taskId` |
| GET | `/api/task/:id` | 轮询任务结果 |
| POST | `/api/verify-token` | 直连领券接口验证 token |
| POST | `/api/export-token` | 把 token 写成 `export MT_TOKEN=...` 文件 |

## 给青龙的三种喂法

1. **环境变量**：复制页面上的 `MT_TOKEN=xxx`，填进青龙面板环境变量
2. **文件挂载**：把 `data/mt_token.txt` 挂到青龙容器，配 `MT_TOKEN_FILE=/path/mt_token.txt`
3. **脚本同级**：把 `mt_token.txt` 放到 `qinglong/` 目录下，脚本会自动读取

## 说明

- token 只在本机流转，服务不对外提供除本机以外的访问入口
- 命令走服务端白名单，参数由服务端拼装，浏览器无法注入任意命令
- 验证 token 会真实调用一次领券接口，若当天未领取会直接把券领到该账号
