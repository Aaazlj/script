"""
Author: anonymous
Date: 2026.08.20
Description: 美团小程序领券code本
Cron: 5 9,12,20 * * *
----------------------------------------------------------------------------------------------
美团小程序领券code本

功能：自动执行美团小程序领取优惠券，支持多账号执行。

配置说明：
1. 微信 code 网关（应用宝协议，与朴朴/顺丰脚本统一）：
   yyb_server                                      推荐，应用宝网关地址（支持 @账号ref）
   - 示例：http://yyb-go:8000         不带 @ → 用 mt_openid 里的 ref
           http://yyb-go:8000@1       带 @ → 直接用该 ref（可省掉 mt_openid）
   - 脚本会自动拼接 /wxapp/getCode
   - 请求格式：POST {网关}/wxapp/getCode
   - 请求体：{"app_id": "<小程序appid>", "ref": "账号openid"}
   wx_server_url                                   兼容变量（yyb_server 为空时生效，请求方式相同）

2. 账号变量：
   mt_openid                                       美团专属账号变量（网关 ref）
   - 多账号支持使用 &、英文逗号、中文逗号、空格或换行分隔
   - 示例：openid_a&openid_b 或 openid_a,openid_b
   - 若在 yyb_server 里已经用 @ref 指定了唯一账号，本变量可以留空

3. 代理变量（可选）：
   mt_proxy                                        静态代理，形如 http://user:pass@host:port
                                                   （也可用 script_proxy，与朴朴/顺丰脚本共用一份）
   - 树脂（resin）就是这种写法：http://:管理token@主机:2260（用户名注意留空！）
   mt_proxy_type                                   代理类型，默认 http，可选 socks5 / socks5h
   mt_proxy_validate                               默认 1，启动时先验证代理连通性；
                                                   置 0 可跳过验证（直接用）
   - 只作用于访问美团的请求；网关调用始终直连
   - 美团域名（open.meituan.com / media.meituan.com）走腾讯国际节点，
     海外机器直连可用，一般不需要配代理

4. 青龙任务建议：
   名称：美团小程序领券
   命令：task mt_code.py
   定时：每天运行 1 - 3 次即可，具体时间自行调整
"""

import hashlib
import json
import os
import random
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import re
import requests

# Windows 终端默认 GBK，emoji/特殊字符会抛 UnicodeEncodeError；强制 stdout/stderr 用 UTF-8
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8", "cp65001"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


APP_NAME = "美团优惠券"
APPID = "wxde8ac0a21135c07d"
MT_APP_NAME = "group"


def parse_gateway(raw: str) -> Tuple[str, str]:
    """拆分应用宝网关配置：`http://yyb-go:8000@1` → (地址, ref)。

    与朴朴 / 顺丰脚本保持同一套写法：
    - 带 @：@ 后面的就是账号 ref（这样只配网关也能跑）
    - 不带 @：ref 为空，改用 mt_openid 里的账号
    """
    raw = (raw or "").strip()
    i = raw.rfind("@")
    if i > 0:
        return raw[:i].rstrip("/"), raw[i + 1:].strip()
    return raw.rstrip("/"), ""


YYB_SERVER_RAW = os.getenv("yyb_server", "") or os.getenv("wx_server_url", "")
YYB_BASE, YYB_REF = parse_gateway(YYB_SERVER_RAW)
# 兼容面板里的简写：yyb-go:8000 / yyb-go:8000@1（缺协议头时自动补 http://）
if YYB_BASE and "://" not in YYB_BASE:
    YYB_BASE = "http://" + YYB_BASE

MT_OPENID = os.getenv("mt_openid", "")
MT_OPENIDS = [oid.strip() for oid in re.split(r"[&,，\s\n]", MT_OPENID) if oid.strip()]
if not MT_OPENIDS and YYB_REF:
    # 只配了 yyb_server@ref、没配 mt_openid —— 直接沿用网关里带的 ref
    MT_OPENIDS = [YYB_REF]

# 静态代理（可选）：只作用于访问美团的请求；网关调用始终直连
MT_PROXY = (
    os.getenv("mt_proxy", "")
    or os.getenv("MT_PROXY", "")
    or os.getenv("script_proxy", "")
    or os.getenv("SCRIPT_PROXY", "")
).strip()
PROXY_TYPE = (os.getenv("mt_proxy_type", "") or "http").strip().lower()
PROXY_VALIDATE = (os.getenv("mt_proxy_validate", "") or "1").strip().lower() not in (
    "0", "false", "no", "off",
)

PROXY_RETRY_TIMES = 3
PROXY_VALIDATE_URL = "https://www.baidu.com"
ENABLE_DIRECT_FALLBACK = True
REQUEST_TIMEOUT = 30

if not YYB_BASE:
    print("❌ [配置] 缺少必填环境变量 yyb_server（应用宝网关地址，兼容旧变量 wx_server_url）")
    sys.exit(1)

if not MT_OPENIDS:
    print(
        "❌ [配置] 缺少账号：请配置 mt_openid（应用宝网关 ref），"
        "或在 yyb_server 里用 @ref 指定；多账号用 & 、逗号或换行分隔"
    )
    sys.exit(1)

OPEN_BASE_URL = "https://open.meituan.com"
WECHAT_LOGIN_URL = f"{OPEN_BASE_URL}/user/v1/weapplogin"

# 美团优惠券（纯 H5，media.meituan.com 域名）
MEDIA_BASE_URL = "https://media.meituan.com"
LIST_PATH = "/fulishemini/couponActivity/listActivityCoupon"
GRANT_PATH = "/fulishemini/couponActivity/grantActivityCoupon"
WEB_QUERY = "yodaReady=wx&csecappid=wx0b42a347aafbe0d0&csecplatform=3&csecversionname=1.47.0&csecversion=1.3.0"

UTC8 = timezone(timedelta(hours=8))

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364"
)


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def mask(value: Any) -> str:
    value = str(value or "")
    if len(value) <= 12:
        return value
    return f"{value[:6]}...{value[-6:]}"


def json_preview(data: Any, limit: int = 800) -> str:
    try:
        return json.dumps(data, ensure_ascii=False)[:limit]
    except Exception:
        return str(data)[:limit]


def safe_data(resp: Dict[str, Any]) -> Dict[str, Any]:
    return resp.get("data") or {}


def _disp_w(s: str) -> int:
    """返回字符串在终端的显示宽度。

    emoji 算 2 列，中文/全角算 2 列，ASCII 算 1 列。
    变体选择符 (VS16/ZWJ) 算 0 列（不占显示宽度）。
    """
    import unicodedata
    w = 0
    for ch in s:
        cp = ord(ch)
        # 变体选择符、零宽连接符不占显示宽度
        if cp in (0xFE0F, 0x200D, 0xFE0E):
            continue
        if unicodedata.east_asian_width(ch) in ("F", "W"):
            w += 2
        elif cp >= 0x1F000:  # emoji 等
            w += 2
        else:
            w += 1
    return w


def _pad_r(s: str, width: int) -> str:
    """左对齐补空格到指定显示宽度。"""
    return s + " " * max(0, width - _disp_w(s))


def log_title() -> None:
    print()
    print("╔" + "═" * 50 + "╗")
    print("║" + _pad_r("🚀 美团优惠券动态 code 版", 50) + "║")
    print("║" + _pad_r(f"🕒 启动时间: {now_text()}", 50) + "║")
    print("║" + _pad_r(f"🔢 账号数量: {len(MT_OPENIDS)}", 50) + "║")
    print("╚" + "═" * 50 + "╝")


def _mask(s: str, head: int = 4, tail: int = 4) -> str:
    """脱敏：保留头部 head 字符 + 尾部 tail 字符，中间用 * 替代。"""
    if not s or len(s) <= head + tail:
        return s or ""
    return s[:head] + "*" * (len(s) - head - tail) + s[-tail:]


def log_account_header(index: int, total: int, server: str) -> None:
    print()
    print("┌" + "─" * 50 + "┐")
    print("│" + _pad_r(f"🧩 账号 {index} / {total}", 50) + "│")
    print("│" + _pad_r(f"🌍 网关 {_mask(YYB_BASE)}", 50) + "│")
    print("│" + _pad_r(f"🧾 身份 {_mask(server)}", 50) + "│")
    print("└" + "─" * 50 + "┘")


def direct_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def mask_proxy(raw: str) -> str:
    """代理脱敏：把 user:pass 里的密码打成 ***。"""
    if "://" not in raw:
        return _mask(raw, 4, 4)
    scheme, rest = raw.split("://", 1)
    if "@" not in rest:
        return raw
    cred, host = rest.rsplit("@", 1)
    if ":" in cred:
        user = cred.split(":", 1)[0]
        cred = f"{user}:***"
    else:
        cred = "***"
    return f"{scheme}://{cred}@{host}"


def build_static_proxies(raw: str | None = None) -> Dict[str, str] | None:
    """把 mt_proxy / script_proxy 解析成 requests 用的 proxies 字典。

    值可以自带协议头（http:// / socks5:// ），也可以只写 host:port，
    缺协议时按 mt_proxy_type 补（默认 http）。
    """
    raw = (raw if raw is not None else MT_PROXY).strip()
    if not raw:
        return None

    if "://" in raw:
        url = raw
    else:
        scheme = "http"
        if PROXY_TYPE.startswith("socks5h"):
            scheme = "socks5h"
        elif PROXY_TYPE.startswith("socks"):
            scheme = "socks5"
        url = f"{scheme}://{raw}"

    if url.lower().startswith("socks"):
        try:
            import socks  # noqa: F401  PySocks：requests 走 socks 代理的必需依赖
        except Exception:
            print("⚠️ [代理] 配了 socks 代理但缺少 PySocks，退回直连（pip install requests[socks]）")
            return None

    return {"http": url, "https": url}


def validate_proxies(proxies: Dict[str, str] | None) -> bool:
    if not proxies:
        return False
    try:
        response = requests.get(PROXY_VALIDATE_URL, proxies=proxies, timeout=10)
        if response.status_code == 200:
            return True
        print(f"⚠️ [代理] 验证返回 {response.status_code}")
    except Exception as exc:
        print(f"⚠️ [代理] 验证失败: {exc}")
    return False


def get_valid_proxy(account_name: str = "") -> Tuple[Dict[str, str] | None, str]:
    """返回 (proxies, 展示用 IP/标识)。静态代理验证不过就退回直连。"""
    proxies = build_static_proxies()
    if not proxies:
        print("🔌 [代理] 未配置 mt_proxy / script_proxy，使用直连")
        return None, ""

    proxy_url = proxies["https"]
    print(f"🌐 [代理] 使用静态代理 {mask_proxy(proxy_url)}")

    if not PROXY_VALIDATE:
        print("⏭️ [代理] 已跳过连通性验证（mt_proxy_validate=0）")
        return proxies, mask_proxy(proxy_url)

    for index in range(1, PROXY_RETRY_TIMES + 1):
        if validate_proxies(proxies):
            print("✅ [代理] 验证通过")
            return proxies, mask_proxy(proxy_url)
        if index < PROXY_RETRY_TIMES:
            sleep(2)

    print("⚠️ [代理] 验证未通过，退回直连")
    return None, ""


def request_with_proxy(
    method: str,
    url: str,
    *,
    proxies: Dict[str, str] | None = None,
    server: str = "",
    **kwargs,
) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)

    if proxies:
        try:
            return requests.request(method, url, proxies=proxies, **kwargs)
        except Exception as exc:
            print(f"⚠️ [代理] {server} 代理请求失败: {exc}")
            if not ENABLE_DIRECT_FALLBACK:
                raise
            print("🔁 [兜底] 切换直连重试")

    session = direct_session()
    return session.request(method, url, **kwargs)


def refresh_gateway_account(ref: str) -> None:
    """网关里账号登录态失效（HTTP 409）时，让网关重新续期一次再试。"""
    try:
        response = direct_session().post(
            f"{YYB_BASE}/accounts/refresh",
            json={"ref": ref},
            headers={"Content-Type": "application/json"},
            timeout=120,
        )
        print(f"♻️ [授权] 已请求网关续期 {_mask(ref)}（HTTP {response.status_code}）")
    except Exception as exc:
        print(f"⚠️ [授权] 请求网关续期失败: {exc}")


def get_code(ref: str, server: str = "") -> str | None:
    url = f"{YYB_BASE}/wxapp/getCode"
    payload = {"app_id": APPID, "ref": ref}
    for attempt in range(1, 4):
        try:
            response = direct_session().post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=40,
            )

            # 登录态过期：让网关续期后重试
            if response.status_code == 409:
                print("⚠️ [授权] 网关返回 409（账号登录态失效），尝试续期后重试")
                refresh_gateway_account(ref)
                if attempt < 3:
                    sleep(3)
                continue

            try:
                data = response.json()
            except Exception:
                print(
                    f"⚠️ [授权] 第 {attempt} 次响应非 JSON"
                    f"（HTTP {response.status_code}）: {response.text[:200]}"
                )
                data = {}

            # 网关返回结构:
            # {"code":0,"msg":"success","data":{"openid":...,"result":{"code":"<微信code>","errMsg":"login:ok"}}}
            if data.get("code") != 0:
                print(f"⚠️ [授权] 第 {attempt} 次网关错误: {json_preview(data)}")
            else:
                inner = data.get("data") or {}
                code = (inner.get("result") or {}).get("code") or inner.get("code")
                if not code or code == "null":
                    print(f"⚠️ [授权] 第 {attempt} 次未返回 code: {json_preview(data)}")
                else:
                    print(f"🔑 [授权] code 获取成功: {mask(code)}")
                    return str(code)
        except Exception as exc:
            print(f"⚠️ [授权] 第 {attempt} 次获取异常: {exc}")

        if attempt < 3:
            sleep(2)

    print("❌ [授权] code 获取失败，已重试 3 次")
    return None


def common_headers(token: str | None = None) -> Dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "xweb_xhr": "1",
        "Referer": f"https://servicewechat.com/{APPID}/270/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if token:
        headers["token"] = token
    return headers


def extract_token(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None

    candidates = [
        data.get("token"),
        data.get("wm_logintoken"),
        data.get("accessToken"),
        data.get("access_token"),
        data.get("jwt"),
    ]

    inner = data.get("data")
    if isinstance(inner, dict):
        candidates.extend([
            inner.get("token"),
            inner.get("wm_logintoken"),
            inner.get("accessToken"),
            inner.get("access_token"),
            inner.get("jwt"),
        ])

        user = inner.get("user")
        if isinstance(user, dict):
            candidates.extend([
                user.get("token"),
                user.get("wm_logintoken"),
                user.get("accessToken"),
                user.get("access_token"),
                user.get("jwt"),
            ])

    for item in candidates:
        if item and item != "null":
            return str(item)

    return None


def _query_nickname(
    token: str,
    user_id: Any,
    open_id: str,
    open_id_cipher: str,
    proxies: Dict[str, str] | None = None,
) -> str:
    """查询用户信息"""
    try:
        resp = request_with_proxy(
            "GET",
            "https://open.meituan.com/user/v1/info",
            proxies=proxies,
            headers={
                "Content-Type": "application/json",
                "token": token,
                "openId": open_id,
                "openIdCipher": open_id_cipher,
                "csecuserid": str(user_id),
                "csecuuid": "1457266102798364772",
                "User-Agent": USER_AGENT,
                "Referer": f"https://servicewechat.com/{APPID}/270/page-frame.html",
            },
            params={
                "token": token,
                "fields": "id,nickname",
                "sdkType": "wxmp",
                "appName": MT_APP_NAME,
                "yodaReady": "wx",
                "csecappid": APPID,
                "csecplatform": "3",
                "csecversionname": "1.47.0",
                "csecversion": "1.3.0",
            },
        )
        if isinstance(resp, requests.Response):
            resp = resp.json()
        user = (resp.get("user") or {}) if isinstance(resp, dict) else {}
        return user.get("nickname") or "未知"
    except Exception:
        return "未知"


def query_coupons(
    token: str,
    user_id: Any,
    open_id: str,
    open_id_cipher: str,
    granted_coupons: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """查询账户本次领取的优惠券/奖励列表"""
    found_any = False

    # --- 0. grantActivityCoupon 响应中本次领取的券明细（福利社红包墙体系） ---
    if granted_coupons:
        found_any = True
        print(f"🎟️ [美团优惠券] 本次领取的优惠券 ({len(granted_coupons)} 张):")
        for c in granted_coupons:
            name = c.get("couponName") or "-"
            val = c.get("couponValue") or 0
            limit = c.get("priceLimit") or 0
            status = c.get("status")
            line = f"  - {name} | 面额 {val/100:.2f}元 | 满 {limit/100:.2f}元可用"
            if status not in (0, None):
                line += f" | status={status}"
            print(line)

    if not found_any:
        print("🎟️ [美团优惠券] 本次没有可以领取的优惠券")


def login_by_code(
    server: str,
    code: str,
    proxies: Dict[str, str] | None,
) -> Tuple[str | None, Dict[str, Any] | None]:
    try:
        response = request_with_proxy(
            "POST",
            WECHAT_LOGIN_URL,
            headers={**common_headers(), "Content-Type": "application/x-www-form-urlencoded"},
            data={"code": code, "appName": MT_APP_NAME},
            proxies=proxies,
            server=server,
        )

        try:
            data = response.json()
        except Exception:
            data = {"raw": response.text[:800]}

        token = extract_token(data)
        if token:
            print(f"✅ [登录] token 获取成功: {mask(token)}")
            return token, data

        print(f"❌ [登录] 未识别 token 字段: {json_preview(data)}")
        return None, data
    except Exception as exc:
        print(f"❌ [登录] 请求异常: {exc}")
        return None, None


def wall_headers(
    *,
    token: str,
    open_id: str,
    open_id_cipher: str,
    user_id: int,
) -> Dict[str, str]:
    headers = {
        "geographyInfo": "%7B%7D",
        "openIdCipher": open_id_cipher,
        "xweb_xhr": "1",
        "csecuuid": "1457266102798364772",
        "swimlane": "",
        "x-env": "online",
        "csecuserid": str(user_id),
        "openId": open_id,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "token": token,
        "Accept": "*/*",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": f"https://servicewechat.com/{APPID}/270/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    return headers


def wall_post(
    server: str,
    path: str,
    proxies: Dict[str, str] | None,
    *,
    token: str,
    open_id: str,
    open_id_cipher: str,
    user_id: int,
    raw_body: str,
) -> Dict[str, Any]:
    url = f"{MEDIA_BASE_URL}{path}?{WEB_QUERY}"
    headers = wall_headers(
        token=token,
        open_id=open_id,
        open_id_cipher=open_id_cipher,
        user_id=user_id,
    )
    response = request_with_proxy(
        "POST",
        url,
        headers=headers,
        data=raw_body.encode("utf-8"),
        proxies=proxies,
        server=server,
    )
    try:
        return response.json()
    except Exception:
        return {
            "code": -1,
            "message": f"JSON解析失败: {response.text[:300]}",
        }


def run_account(index: int, total: int, server: str) -> Dict[str, Any]:
    result = {
        "server": server,
        "success": False,
        "proxyStatus": "未使用代理",
        "proxyIp": "-",
        "token": "-",
        "couponMsg": "-",
        "error": "",
    }

    log_account_header(index, total, server)

    proxies, proxy_label = get_valid_proxy(server)
    result["proxyStatus"] = "使用静态代理" if proxies else "使用直连"
    result["proxyIp"] = proxy_label or "-"

    delay = random.randint(2, 6)
    print(f"⏳ [延迟] 启动延迟 {delay}s")
    sleep(delay)

    code = get_code(server)
    if not code:
        result["error"] = "获取 code 失败"
        return result

    token, raw_login = login_by_code(server, code, proxies)
    if not token:
        result["error"] = f"登录失败: {json_preview(raw_login)}"
        return result

    result["token"] = mask(token)

    login_data: Dict[str, Any] = {}
    open_id = None
    open_id_cipher = None
    if isinstance(raw_login, dict):
        login_data = raw_login.get("data") or {}
        open_id = raw_login.get("openId") or login_data.get("openId") or login_data.get("open_id")
        open_id_cipher = raw_login.get("openIdCipher") or login_data.get("openIdCipher")

    if not open_id or not open_id_cipher:
        result["error"] = "登录响应未返回 openId/openIdCipher"
        print(f"❌ [登录] {result['error']}")
        return result

    user_id = login_data.get("userId") or login_data.get("userid")
    nickname = _query_nickname(token, user_id, open_id, open_id_cipher, proxies)
    print(f"👤 [用户] userId={user_id} 昵称={nickname}")

    # ── 1. 拉取优惠券配置 ──
    list_body = json.dumps(
        {
            "wm_did": "",
            "wm_mac": "",
            "waimai_sign": "/",
            "wm_ctype": "fulishe_wxapp",
            "wm_dtype": "microsoft",
            "wm_dversion": "4.1.12.55",
            "wm_dplatform": "windows",
            "wm_uuid": "1457266102798364772",
            "wm_visitid": "90357da0-9471-4a38-af91-bb7338fb81b7",
            "wm_appversion": "1.47.0",
            "wm_logintoken": token,
            "req_time": int(time.time() * 1000),
            "userid": user_id,
            "user_id": user_id,
            "lch": 1260,
            "wm_uuid_source": "server",
            "hostAppVersion": "",
            "open_id": open_id,
            "unionid": "oNQu9t2M2aGnZbGGda83ER7Oxweo",
            "fp_platform": 13,
            "appId": APPID,
            "cPosition": 1005,
            "pBizLine": 9000,
            "pSubCode": 30300,
            "finger_applets": "",
            "expoId": open_id_cipher,
            "requestType": 0,
            "requestSource": 1,
            "couponActivityScene": 1,
            "osType": "Windows",
            "distributorChannel": 0,
            "wm_latitude": 23083309,
            "wm_longitude": 113317200,
            "wm_actual_latitude": 23083309,
            "wm_actual_longitude": 113317200,
            "actual_city_id_level2": "440100",
            "actual_city_id_level3": "440105",
            "city_id_level2": "440100",
            "city_id_level3": "440105",
        },
        separators=(",", ":"),
    )

    list_resp = wall_post(
        server,
        LIST_PATH,
        proxies,
        token=token,
        open_id=open_id,
        open_id_cipher=open_id_cipher,
        user_id=user_id,
        raw_body=list_body,
    )

    # 接口返回 code=200 表示成功（HTTP 风格），code=0 也兼容
    _code = list_resp.get("code")
    if _code not in (0, 200, "0", "200"):
        result["error"] = (
            f"美团优惠券配置获取失败 code={_code} "
            f"{list_resp.get('message') or list_resp.get('msg') or json_preview(list_resp, 300)}"
        )
        print(f"❌ [美团优惠券] {result['error']}")
        return result

    list_data = list_resp.get("data") or {}
    config = list_data.get("config") or {}
    activity_code = config.get("activityCode") or list_data.get("activityCode")
    activity_name = config.get("activityName") or list_data.get("activityName") or "美团优惠券活动配置"
    session_id = list_data.get("sessionId") or "1a01aa999d0-8f3b-8811-6d"
    # recallToken 由 list 响应下发，grant 必须使用此值（服务端校验，不可自编）
    recall_token = list_data.get("recallToken") or ""

    # 从 preGrantList 聚合 (planCode -> rightCodes[])，构造 grant 用 tabs
    # 只发 preGrantList 里的组（有具体 rightCode = 可领的券），不发空 rightCodes 的组
    plan_map: Dict[str, List[str]] = {}
    for pg in (list_data.get("preGrantList") or []):
        if not isinstance(pg, dict):
            continue
        pd = pg.get("data") or {}
        plan = pd.get("planCode")
        right = pd.get("rightCode")
        if not plan or not right:
            continue
        plan_map.setdefault(plan, [])
        if right not in plan_map[plan]:
            plan_map[plan].append(right)
    tabs = [{"planCode": plan, "rightCodes": rights} for plan, rights in plan_map.items()]

    # 兜底：若 preGrantList 为空，退而从 tabList 取 planCode（rightCodes 留空）
    if not tabs:
        for t in (config.get("tabList") or []):
            if isinstance(t, dict) and t.get("planCode"):
                tabs.append({"planCode": t["planCode"], "rightCodes": t.get("rightCodes") or []})

    print(f"🎟️ [美团优惠券] 本次查询共有 {len(tabs)} 组券包可以领取")

    if not tabs:
        result["couponMsg"] = "美团优惠券暂无可以领取的券包"
        result["success"] = True
        return result

    # ── 2. 一键领取全部优惠券 ──
    grant_body = json.dumps(
        {
            "wm_did": "",
            "wm_mac": "",
            "waimai_sign": "/",
            "wm_ctype": "fulishe_wxapp",
            "wm_dtype": "microsoft",
            "wm_dversion": "4.1.12.55",
            "wm_dplatform": "windows",
            "wm_uuid": "1457266102798364772",
            "wm_visitid": "90357da0-9471-4a38-af91-bb7338fb81b7",
            "wm_appversion": "1.47.0",
            "wm_logintoken": token,
            "req_time": int(time.time() * 1000),
            "userid": user_id,
            "user_id": user_id,
            "lch": 1260,
            "wm_uuid_source": "server",
            "hostAppVersion": "",
            "open_id": open_id,
            "unionid": "oNQu9t2M2aGnZbGGda83ER7Oxweo",
            "activityName": activity_name,
            "activityCode": activity_code,
            "sessionId": session_id,
            "unpl": "v1_4AHi-LokTshbKe0CTLVFiRfpi2gcMVypu2V3bcBL-lxh8gsU0RWoDhMxZHRdAilG",
            "tabs": tabs,
            "finger_applets": "",
            "fp_platform": 13,
            "appId": APPID,
            "expoId": open_id_cipher,
            "cPosition": 1005,
            "pBizLine": 9000,
            "pSubCode": 30301,
            "recallToken": recall_token,
            "preGrantSource": 2,
            "activityScene": 1,
            "osType": "Windows",
            "pageId": "c_waimai_7hs96y41",
            "moduleId": "b_waimai_gci8oda9_mc",
            "distributorChannel": 0,
            "wm_latitude": 23083309,
            "wm_longitude": 113317200,
            "wm_actual_latitude": 23083309,
            "wm_actual_longitude": 113317200,
            "actual_city_id_level2": "440100",
            "actual_city_id_level3": "440105",
            "city_id_level2": "440100",
            "city_id_level3": "440105",
        },
        separators=(",", ":"),
    )

    grant_resp = wall_post(
        server,
        GRANT_PATH,
        proxies,
        token=token,
        open_id=open_id,
        open_id_cipher=open_id_cipher,
        user_id=user_id,
        raw_body=grant_body,
    )

    _gcode = grant_resp.get("code")
    if _gcode in (0, 200, "0", "200"):
        gdata = grant_resp.get("data") or {}
        result["couponMsg"] = f"美团优惠券领取成功（{activity_name}）"
        print(f"🎟️ [美团优惠券] 领取成功")

        # 打印领取到的具体券明细
        total_value = gdata.get("totalCouponValue")
        if total_value is not None:
            print(f"🎟️ [美团优惠券] 总面额: {total_value/100:.2f} 元")
        granted_coupons = []
        for tab in (gdata.get("tabs") or []):
            for c in (tab.get("couponList") or []):
                granted_coupons.append(c)
        if granted_coupons:
            result["couponMsg"] = (
                f"美团优惠券领取成功，共 {len(granted_coupons)} 张券（{activity_name}）"
            )
        result["success"] = True
    else:
        result["couponMsg"] = "美团优惠券领取失败"
        result["error"] = (
            f"领取失败 code={grant_resp.get('code')} "
            f"{grant_resp.get('message') or grant_resp.get('msg') or json_preview(grant_resp, 300)}"
        )
        print(f"❌ [美团优惠券] {result['error']}")
        granted_coupons = []

    # ── 3. 查询当前账户优惠券 ──
    query_coupons(token, user_id, open_id, open_id_cipher, granted_coupons)

    return result


def main() -> None:
    log_title()

    results: List[Dict[str, Any]] = []

    servers = MT_OPENIDS
    for index, server in enumerate(servers, 1):
        try:
            result = run_account(index, len(servers), server)
            results.append(result)
        except Exception as exc:
            print(f"❌ [主程序] {server} 执行异常: {exc}")
            results.append({
                "server": server,
                "success": False,
                "proxyStatus": "-",
                "proxyIp": "-",
                "token": "-",
                "couponMsg": "-",
                "error": traceback.format_exc().strip(),
            })

        if index < len(servers):
            print("")
            print("⏳ [间隔] 等待 2s 后处理下一个账号")
            sleep(2)

    success_count = sum(1 for item in results if item["success"])
    fail_count = len(results) - success_count

    print()
    print("╔" + "═" * 50 + "╗")
    print("║" + _pad_r("🏁 美团优惠券任务执行完成", 50) + "║")
    print("║" + _pad_r(f"✅ 成功: {success_count}", 50) + "║")
    print("║" + _pad_r(f"❌ 失败: {fail_count}", 50) + "║")
    print("║" + _pad_r(f"🕒 结束时间: {now_text()}", 50) + "║")
    print("╚" + "═" * 50 + "╝")


if __name__ == "__main__":
    main()