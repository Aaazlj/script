## 扫码登录面板（应用宝 + 美团 → 青龙）

`panel/` 是一个把「应用宝扫码」和「美团扫码」合在一起的网页面板：
普通用户选平台扫码，登录成功后凭据自动写进青龙；管理员在 `/admin` 里配置青龙凭据。

```bash
docker compose up -d --build     # 面板 http://<服务器IP>:5180 ，后台 /admin
```

- 应用宝扫码 → 写入 `yyb_server`
- 美团扫码 → 写入 `MT_TOKEN`（多账号按行追加）
- compose 里 `panel` / `yyb-go` 同时接入青龙已有的 `qinglong_default` 网络，
  **不需要改动青龙自己的 compose**：面板用 `http://qinglong-web-1:5700` 调青龙，
  青龙容器内的脚本用 `http://yyb-go:8000` 调应用宝网关

细节见 [`panel/README.md`](panel/README.md)。

### 挂到自定义域名（scan.leozai.com）

按服务器既有约定走宿主机 nginx（其他子域都是这个套路）：

```
A scan.leozai.com → 47.89.253.12（Cloudflare 代理）
      ↓
宿主机 nginx :443  →  proxy_pass http://127.0.0.1:5180
      ↓
Let's Encrypt 证书（certbot 管理）
```

配置模板与签证书步骤（含两个必踩的坑：ACME 校验目录被 `location /` 吞掉、
必须先灰云签证书再切橙云）见 [`panel/README.md`](panel/README.md#部署到自定义域名宿主机-nginx推荐)。

> 面板端口只绑 `127.0.0.1:5180`，nginx 是唯一入口；`docker compose up -d` 不会再暴露公网。
> 备用方案（Cloudflare Tunnel）已在 compose 里放到 `profiles: ["tunnel"]` 下，
> 需要时 `docker compose --profile tunnel up -d` 才会启用。

### 部署到 /root/script（阿里云）

```bash
# 1) 拉代码
git clone https://github.com/Aaazlj/script.git /root/script && cd /root/script

# 2) 放美团专家包（美团扫码通道需要，缺失时只有应用宝可用）
mkdir -p meituan-expert && tar xzf meituan-expert.tgz -C meituan-expert --strip-components=1

# 3) 起服务
mkdir -p data/panel data/yyb/db data/yyb/avatars data/meituan-auth
docker compose up -d --build
```

首次打开 `http://<IP>:5180/admin` 会引导设置管理员密码，然后填青龙的
host / Client ID / Client Secret 即可。

## 拉库命令

```bash
ql repo https://github.com/Aaazlj/script.git "" "token-web|node_modules|yyb_go" "" "master" "js|py"
```

参数顺序：`ql repo <仓库地址> <白名单> <黑名单> <依赖文件> <分支> <文件后缀>`

| 参数 | 本次取值 | 作用 |
|------|----------|------|
| 白名单 | 空（不限制） | 需要拉取的路径包含的关键字 |
| 黑名单 | `token-web\|node_modules` | **忽略目录**，防止 `token-web/server.js`、`public/app.js` 被当成青龙脚本误识别 |
| 依赖文件 | 空 | 不受黑名单影响、强制拷贝的文件 |
| 分支 | `master` | 指定分支 |
| 文件后缀 | `js\|py` | 只扫这两类脚本，`.md/.html/.css` 一律不入库 |

> `token-web/` 只是本地取 token 的 Web 服务，**不是青龙脚本**，必须屏蔽，
> 否则它的 `server.js` / `public/app.js` 会被拉进定时任务列表报错。

更严格的写法（只放行真正的脚本，新增脚本时需同步更新白名单）：

```bash
ql repo https://github.com/Aaazlj/script.git "meituan_coupon|ppcs|sfsy" "token-web|node_modules" "" "master" "js|py"
```

## 青龙自动添加任务 · 名称与定时约定

青龙 `shell/update.sh` 的 `add_cron()` 按下面顺序取**任务名**：

1. `grep "new Env"` → 取 `(` 与 `)` 之间被**单/双引号包裹的字面量**
2. 取不到 → `grep "name:"` 取冒号后内容
3. 还取不到 → 用文件名

所以脚本里必须写成字面量：

```js
new Env('朴朴超市')     // ✅ 任务名 = 朴朴超市
new Env(SCRIPT_NAME)    // ❌ 任务名会变成 "SCRIPT_NAME"
```

定时同理，只认小写 `cron:`（`grep "cron:"` 大小写敏感）：

```
cron: 9 8 * * *         // ✅
Cron: 9 8 * * *         // ❌ 匹配不到，会退化成随机定时
cron 9 8 * * *          // ❌ 同上
```

> 已存在的定时任务不会因为改脚本而自动改名，需在面板手动改，或删掉后重新拉库。

## 朴朴签到 · YYB-Go-Enhanced 网关

`ppcs_code.js` 不填 ck，登录 code 由本地网关 `yyb_go` 提供：

```bash
cd yyb_go && go run ./cmd/yyb-go -host 0.0.0.0 -port 8000
# 打开 http://<ip>:8000 扫码添加账号
```

青龙环境变量 `yyb_server` 三种写法（多条用 `&`、逗号或换行分隔）：

```bash
http://127.0.0.1:8000@1      # 指定账号，@ 后为 账号ID / UIN / OpenID
http://127.0.0.1:8000        # 不带 @，自动拉取网关 /accounts 全部账号
http://127.0.0.1:8000@*      # 同上
```

地址可省略协议头（如 `yyb-go:8000@1`），缺协议时自动补 `http://`。

## 脚本列表

| 脚本 | 说明 | 环境变量 |
|------|------|----------|
| `meituan_coupon.js` | 美团优惠券自动领取（`cron: 0 10 * * *`） | `MT_TOKEN`、`MT_TOKEN_FILE`、`MT_AI_SCENE`、`MT_PUSH_URL`、`MT_MAX_COUPONS`、`MT_CACHE_FILE` |
| `ppcs.js` | 朴朴超市 | — |
| `ppcs_code.js` | 朴朴超市签到（YYB-Go-Enhanced 网关取 code 版，`cron: 20 8,12,20 * * *`） | `yyb_server`、`wx_server_url`+`ppcs_openid`、`ppcs_appid`、`ppcs_lng`/`ppcs_lat` |
| `sfsy.py` | 顺丰速运 | — |

`meituan_coupon.js` 环境变量明细：

| 变量 | 必填 | 说明 |
|------|------|------|
| `MT_TOKEN` | 是 | 美团登录 Token，**多账号用换行分隔**（单行时兼容旧的 `#` 分隔；换行分隔时 token 内的 `#` 不会被截断） |
| `MT_TOKEN_FILE` | 否 | Token 文件路径，默认依次尝试 `mt_token.txt` / `data/mt_token.txt` / `token-web/data/mt_token.txt`；文件里的 `#` 注释行会被忽略 |
| `MT_AI_SCENE` | 否 | 接口 `aiScene` 渠道标识，默认空 |
| `MT_PUSH_URL` | 否 | 自定义推送地址（POST `{title, content}`），**http / https 均可** |
| `MT_MAX_COUPONS` | 否 | 通知最多展示几张券，默认 8 |
| `MT_CACHE_FILE` | 否 | 当日券缓存路径，默认 `data/mt_coupons_cache.json` |

> 每天限领一次。当天首次真正领到券时脚本会把明细写进缓存，之后再跑（含定时任务）直接命中缓存回放，**不再重复请求领券接口**，跨天自动失效。

## 美团领券 · 获取 Token

仓库内 `token-web/` 是一个本地扫码登录服务，专门给青龙脚本供 token：

```bash
cd token-web
node server.js
# 打开 http://127.0.0.1:5178 → 扫码 → 复制 MT_TOKEN=xxx 填进青龙环境变量
```

> `token-web` 的登录能力依赖官方专家包 **meituan-living-assistant**（「领券下单找我」）的 `scripts/run.js`。
> 脚本会按当前用户主目录自动探测它的位置；探测不到时用环境变量指定，例如：
>
> ```bash
> MT_RUN_JS=/Users/you/.workbuddy/plugins/marketplaces/experts/plugins/meituan-living-assistant/scripts/run.js node server.js
> ```