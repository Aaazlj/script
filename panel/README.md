# 扫码登录面板

把「应用宝扫码」和「美团扫码」合成一个页面：普通用户选一个平台扫码，登录成功后凭据**自动写进青龙面板**。

- 普通用户入口：`/`
- 管理后台：`/admin`（首次打开引导设置密码）

零第三方依赖，只用 Node 内置模块。

---

## 它做了什么

| 通道 | 扫码方式 | 写入青龙的变量 | 取值来源 |
|------|----------|----------------|----------|
| 应用宝 | 微信扫码 yyb_go 网关的二维码 | `yyb_server` | 后台配置的「写入青龙的地址」，默认 `http://yyb-go:8000` |
| 美团 | 美团 App 扫官方专家包生成的二维码 | `MT_TOKEN` | 扫码拿到的 token，多账号**按行追加**，已存在则跳过 |

> 应用宝这条链路不重写 yyb_go 的 mmtls 协议，而是由面板服务端代理它已有的 `/qr` 接口，
> 扫到账号后仍存在 yyb_go 自己的库里，面板只负责把网关地址告诉青龙。

---

## 快速开始（Docker Compose）

在仓库根目录：

```bash
docker compose up -d --build
```

然后打开 `http://<服务器IP>:5180/admin`，第一次会让你设置管理员密码，进去后填：

1. **青龙面板**：地址 + Client ID + Client Secret
   （青龙后台 → 系统设置 → 应用设置 → 新建应用）
   容器里默认地址已填好 `http://qinglong-web-1:5700`，点「测试连接」应能读到面板版本。
2. **应用宝网关**：默认 `http://yyb-go:8000`（compose 内网服务名），点「测试连通」。
3. **美团**：run.js 路径默认 `/opt/meituan-expert/scripts/run.js`，点「环境自检」。

配置项保存在 `data/panel/config.json`（0600），密码用 scrypt 加盐哈希。

### 网络是怎么打通的

`docker-compose.yml` 里 `panel` 与 `yyb-go` 同时加入两个网络：

- `script_panel`：面板 ←→ 网关的内部通信
- `qinglong_default`（外部网络，青龙 compose 建的）：**与已有青龙容器打通**

于是：

- 面板容器里可以用 `http://qinglong-web-1:5700` 调青龙 OpenAPI
- 青龙容器里的脚本可以用 `http://yyb-go:8000` 调应用宝网关

`docker-compose.yml` 里 `qinglong: external: true, name: qinglong_default` 就是这一层桥接，
不需要改动青龙自己的 compose 文件。

---

## 本地不用 Docker 直接跑

```bash
node server.js                 # 默认 0.0.0.0:5180
node server.js --port 5181     # 换端口
```

依赖外部服务：`yyb_go`（应用宝）与官方专家包 `run.js`（美团）。
缺哪个，对应的那个通道会在页面上给出明确提示，另一个通道不受影响。

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `5180` | 监听端口 |
| `PANEL_DATA_DIR` | `./data` | 配置与运行数据目录 |
| `PANEL_QINGLONG_HOST` | 空 | 后台「青龙地址」的初始默认值 |
| `PANEL_YYB_BASE_URL` | `http://127.0.0.1:8000` | 面板调网关的地址 |
| `PANEL_YYB_PUBLIC_BASE_URL` | 空 | 写进青龙的 `yyb_server` 值 |
| `MT_RUN_JS` | 空 | 美团专家包 `scripts/run.js` 的绝对路径 |
| `MT_AI_SCENE` | 空 | 美团接口 `aiScene` |

> 这些变量只在**首次生成 `config.json` 时**作为默认值，之后一律以后台里保存的配置为准。

---

## 接口一览

公开：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 是否已初始化、青龙是否已配置 |
| `POST` | `/api/yyb/qr` | 新建应用宝二维码会话 |
| `GET` | `/api/yyb/poll?sid=` | 轮询扫码状态 |
| `POST` | `/api/yyb/confirm` | 确认授权 → 写入 `yyb_server` |
| `POST` | `/api/meituan/start` | 取二维码 / 复用已有 token |
| `GET` | `/api/meituan/status?sid=` | 轮询登录结果 → 写入 `MT_TOKEN` |

后台（需登录）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/health` | 是否需要初始化、是否已登录 |
| `POST` | `/api/admin/setup` | 首次设置密码 |
| `POST` | `/api/admin/login` / `logout` | 登录 / 退出 |
| `POST` | `/api/admin/password` | 改密码 |
| `GET`/`PUT` | `/api/admin/config` | 读写配置（Secret 只回传「是否已设置」） |
| `POST` | `/api/admin/test/qinglong` / `test/yyb` / `test/meituan` | 连接测试 |

---

## 青龙 OpenAPI 的对接细节

按青龙 `back/api/*.ts` 的实际实现对接，踩过的点：

- 取 token：`GET /api/auth/token?client_id=&client_secret=`（老版本在 `/api/system/token`，代码会自动回退）
- 后续请求头：`Authorization: Bearer <token>`
- `POST /api/envs` 的 body 是**裸数组** `[{name,value,remarks}]`，不是 `{envs:[...]}`
- `PUT /api/envs` 的 body 是对象，标识字段是 **`id`**（数字），不是 `_id`
- 变量名有格式校验 `^[a-zA-Z_][0-9a-zA-Z_]*$`

---

## 安全说明

- 管理员密码 scrypt 加盐哈希，会话是 HMAC 签名的过期时间戳，放 HttpOnly Cookie
- 登录失败按 IP 限速（10 分钟 8 次）
- `Client Secret` 与扫到的 token **永不回传前端**，只回传脱敏值
- 面板会绑定 `0.0.0.0:5180`，公网暴露时请自行加安全组/反代鉴权
