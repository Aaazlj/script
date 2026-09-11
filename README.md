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
| `meituan_coupon.js` | 美团优惠券自动领取（`cron: 0 10 * * *`） | `MT_TOKEN`、`MT_TOKEN_FILE`、`MT_PUSH_URL`、`MT_MAX_COUPONS` |
| `ppcs.js` | 朴朴超市 | — |
| `ppcs_code.js` | 朴朴超市签到（YYB-Go-Enhanced 网关取 code 版，`cron: 20 8,12,20 * * *`） | `yyb_server`、`wx_server_url`+`ppcs_openid`、`ppcs_appid`、`ppcs_lng`/`ppcs_lat` |
| `sfsy.py` | 顺丰速运 | — |

## 美团领券 · 获取 Token

仓库内 `token-web/` 是一个本地扫码登录服务，专门给青龙脚本供 token：

```bash
cd token-web
node server.js
# 打开 http://127.0.0.1:5178 → 扫码 → 复制 MT_TOKEN=xxx 填进青龙环境变量
```