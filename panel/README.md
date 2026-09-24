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
美团的登录态落在 `data/meituan-auth/`，容器重建也不用重新扫码。

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

## 部署到自定义域名（宿主机 nginx，推荐）

服务器上已经跑着 nginx（80/443），其他子域都是「A 记录 → 服务器 IP（Cloudflare 代理）→ nginx 反代本机端口」。
照这个约定接最省事，也不用额外维护 cloudflared。

1. 面板端口只绑回环（compose 里已是 `127.0.0.1:5180:5180`），nginx 成为唯一入口。
2. 建站点 `/etc/nginx/sites-available/scan.leozai.com`：

   ```nginx
   server {
       server_name scan.leozai.com;

       # Let's Encrypt HTTP-01 校验走本地目录，不转发给面板
       location ^~ /.well-known/acme-challenge/ {
           root /var/www/letsencrypt;
           default_type "text/plain";
           try_files $uri =404;
       }

       # 扫码轮询与 run.js 调用都比较慢，超时给足避免 504
       proxy_read_timeout 180s;
       proxy_send_timeout 180s;
       client_max_body_size 8m;

       location / {
           proxy_pass http://127.0.0.1:5180;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }

       listen 443 ssl;
       listen [::]:443 ssl;
       ssl_certificate     /etc/letsencrypt/live/scan.leozai.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/scan.leozai.com/privkey.pem;
       include /etc/letsencrypt/options-ssl-nginx.conf;
       ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
   }

   server {
       server_name scan.leozai.com;

       # 续期走 webroot，80 上保留校验目录
       location ^~ /.well-known/acme-challenge/ {
           root /var/www/letsencrypt;
           default_type "text/plain";
           try_files $uri =404;
       }

       location / { return 301 https://$host$request_uri; }

       listen 80;
       listen [::]:80;
   }
   ```

3. `ln -s` 到 `sites-enabled/`，`nginx -t` 通过后 `systemctl reload nginx`。
4. 先建 **DNS-only（灰云）** 的 A 记录，再签证书，最后改回代理（橙云）：

   ```bash
   mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
   certbot certonly --webroot -w /var/www/letsencrypt -d scan.leozai.com \
     --non-interactive --agree-tos
   certbot renew --cert-name scan.leozai.com --dry-run   # 续期演练
   ```

   > ⚠️ 两个坑：
   > 1. 站点里有 `location / { proxy_pass ... }` 时，**必须显式加 `^~ /.well-known/acme-challenge/`**，
   >    否则校验请求会被转发给面板、返回 404，签发失败。
   > 2. 直接开着 Cloudflare 代理（橙云）签 HTTP-01 容易失败，**先切灰云签完再切回橙云**。

验证（注意服务器本机可能缓存旧 DNS 解析，要强制指到 Cloudflare 边缘）：

```bash
CF_IP=$(dig +short scan.leozai.com @1.1.1.1 | head -1)
curl -sI --resolve scan.leozai.com:443:$CF_IP https://scan.leozai.com/api/health | grep -i 'cf-ray\|^server'
# 期望看到 cf-ray: ... / server: cloudflare
```

## 备选：用 Cloudflare Tunnel 暴露（不开任何入站端口）

服务器不需要开放任何入站端口（5180 可以只在安全组里放行给内网或干脆关掉），
Cloudflare 会自动签发证书并把 `https://<域名>` 反代到面板。

1. 建隧道并配置 ingress（把公网域名指到 compose 里的面板服务）：

   ```
   PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
   {
     "config": {
       "ingress": [
         { "hostname": "scan.leozai.com", "service": "http://scan-panel:5180" },
         { "service": "http_status:404" }
       ]
     }
   }
   ```

   `service` 用 compose 网络里的容器名/服务名，因为 cloudflared 也跑在 `script_panel` 网络里。

2. 在 `leozai.com` 区域建一条 DNS：

   | 类型 | 名称 | 内容 | 代理状态 |
   |------|------|------|----------|
   | CNAME | `scan` | `<tunnel_id>.cfargotunnel.com` | 已代理（橙色云） |

   > 这条记录**必须存在**，否则 Cloudflare 不会把请求交给隧道。
   > 若用 API：`POST /zones/{zone_id}/dns_records`，需要 token 具备 `Zone → DNS → Edit`。

3. 把连接器 token 写进服务器上的 `.env`，然后启动：

   ```bash
   echo "CF_TUNNEL_TOKEN=<token>" > /root/script/.env && chmod 600 /root/script/.env
   docker compose up -d
   ```

   token 通过环境变量 `TUNNEL_TOKEN` 注入，不会出现在容器的命令行里（`ps` 看不到）。

4. 验证隧道已连上：

   ```
   GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections
   ```

   有 `conns` 且 `is_pending_reconnect: false` 即为健康。

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
