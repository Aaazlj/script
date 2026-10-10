#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 爷爷不泡茶
"""
爷爷不泡茶 code 版（走 yyb 网关取 code）

功能：
  1. 通过 yyb 网关 /wxapp/getCode 拿微信 code（无需本地 code 服务）
  2. 青梅 mini-app-login 用 code 换 qm-user-token（并缓存，失效自动刷新）
  3. 会员中心接口校验 token
  4. 每日签到 / 连签天数与下一阶段奖励 / 积分与即将过期积分
  5. PushPlus / 企业微信推送

环境变量：
  yyb_server          yyb 网关地址，面板会写进青龙。每行「地址@账号ref」或只写地址
                      （只写地址 = 自动拉取网关里全部账号，再按脚本标记过滤）
  yyb_script_key      本脚本在网关账号上的标记 key，默认 pc
  yyb_default_on      默认 0：**本脚本默认不跑**，只有账号标记里显式含 pc 才跑
  yyb_tag_filter      默认 1；设 0 忽略脚本标记（调试用）
  yyb_auto_refresh    默认 1：账号不是 alive 时自动让网关续期一次
  pc_appid            小程序 appid，默认 wx3423ef0c7b7f19af
  paotea_activity_id  签到活动 ID，默认 983701274523176960（活动按期轮换，过期请抓包更新）
  pc_proxy            业务请求（青梅 webapi.qmai.cn）所用的代理。海外服务器直连会超时，
                      必须走国内出口；未配置时回退 ppcs_proxy / sf_proxy
  pc_login_cache      默认 1：复用本地登录态，失效再取 code
  PLUSPLUS_TOKEN      PushPlus token，可选
  QYWX_TOKEN          企业微信机器人 Webhook key，可选

⚠️ 登录接口为推断（复用青梅 /web/account-center/oauth/mini-app-login），
   未经真机验证，失败请抓包核对。

依赖：pip install requests
"""

import json
import os
import random
import sys
import time
import traceback
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests


APP_NAME = "爷爷不泡茶"
APPID = os.getenv("pc_appid") or os.getenv("PC_APPID") or "wx3423ef0c7b7f19af"

# ---------------- yyb 网关 ----------------
YYB_SERVER = os.getenv("YYB_SERVER") or os.getenv("yyb_server") or ""
YYB_SCRIPT_KEY = (os.getenv("yyb_script_key") or "pc").strip().lower()
YYB_TAG_FILTER = (os.getenv("yyb_tag_filter") or "1") != "0"
YYB_AUTO_REFRESH = (os.getenv("yyb_auto_refresh") or "1") != "0"
YYB_SKIP_EXPIRED = (os.getenv("yyb_skip_expired") or "1") != "0"
# 本脚本默认关：网关账号标记为空时**不跑**（其它脚本是「空=不限制」）。
# 想全量跑可以设 yyb_default_on=1。
YYB_DEFAULT_ON = (os.getenv("yyb_default_on") or "0") == "1"
GATEWAY_TIMEOUT = 60  # getCode 首次会触发登录握手，给宽一点

PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")
QYWX_TOKEN = os.getenv("QYWX_TOKEN", "")

REQUEST_TIMEOUT = 30

# 业务请求（青梅 webapi.qmai.cn）走代理：海外服务器直连实测超时（HTTP 000），
# 经本机树脂出口 200/2s。沿用项目里其它脚本的变量约定（pc_proxy → ppcs_proxy → sf_proxy）。
PROXY_URL = (os.getenv("pc_proxy") or os.getenv("ppcs_proxy") or os.getenv("sf_proxy") or "").strip()
PROXY_DICT = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None
ENABLE_DIRECT_FALLBACK = True

BASE_URL = "https://webapi.qmai.cn"
LOGIN_URL = f"{BASE_URL}/web/account-center/oauth/mini-app-login"
CHECK_LOGIN_URL = f"{BASE_URL}/web/catering2-apiserver/crm/customer-center"
SIGN_STATS_URL = f"{BASE_URL}/web/cmk-center/sign/userSignStatistics"
SIGN_IN_URL = f"{BASE_URL}/web/cmk-center/sign/takePartInSign"
POINTS_INFO_URL = f"{BASE_URL}/web/catering/crm/points-info"

STORE_ID = os.getenv("paotea_store_id") or "216652"
SCENE = "1145"
PAGE_VERSION = "49"
ACTIVITY_ID = os.getenv("paotea_activity_id") or "983701274523176960"

# 登录态缓存放到青龙 data 目录（别写进脚本所在仓库，污染 git）
_QL_DIR = os.getenv("QL_DIR", "")
CACHE_FILE = os.getenv("pc_cache_file") or (
    os.path.join(_QL_DIR, "data", "paotea_login_cache.json") if _QL_DIR
    else os.path.join(os.path.dirname(os.path.abspath(__file__)), "paotea_login_cache.json")
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a1b)XWEB/11097"
)


# ====================== 小工具 ======================

def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


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


def to_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def safe_data(resp: Dict[str, Any]) -> Dict[str, Any]:
    return (resp or {}).get("data") or {}


def is_ok(resp: Any) -> bool:
    """青梅平台信封 {status, code, message, data}，成功 status === true"""
    return isinstance(resp, dict) and resp.get("status") is True


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def log_title(account_count: int) -> None:
    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🍵 爷爷不泡茶 code 版" + " " * 26 + "║")
    print(f"║ 🕒 启动时间: {now_text():<33}║")
    print(f"║ 🔢 账号数量: {account_count:<33}║")
    print("╚" + "═" * 50 + "╝")


def log_account_header(index: int, total: int, label: str) -> None:
    print()
    print("┌" + "─" * 50 + "┐")
    print(f"│ 🧩 账号 {index} / {total}" + " " * (37 - len(str(index)) - len(str(total))) + "│")
    print(f"│ 🌍 来源 {label[:40]:<40}│")
    print("└" + "─" * 50 + "┘")


def direct_session() -> requests.Session:
    """网关/内网请求用：不走代理"""
    session = requests.Session()
    session.trust_env = False
    return session


def biz_request(method: str, url: str, **kwargs) -> requests.Response:
    """青梅业务请求：优先走代理，代理挂了兜底直连（和原脚本一致的策略）"""
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    session = direct_session()
    if PROXY_DICT:
        try:
            return session.request(method, url, proxies=PROXY_DICT, **kwargs)
        except Exception as exc:
            print(f"⚠️ [代理] 业务请求失败: {exc}")
            if not ENABLE_DIRECT_FALLBACK:
                raise
            print("🔁 [兜底] 改用直连重试")
    return session.request(method, url, **kwargs)


# ====================== yyb 网关 ======================

def normalize_server_url(host: str) -> str:
    host = (host or "").strip().rstrip("/")
    if host and not host.startswith(("http://", "https://")):
        host = "http://" + host
    return host


def split_multi(value: str) -> List[str]:
    """和其它 code 版脚本一致：换行 / 逗号 / & 都当作分隔符"""
    text = str(value or "").replace("，", ",").replace("&", ",")
    return [s.strip() for s in text.split("\n") for s in s.split(",") if s.strip()]


def gateway_post(endpoint: str, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = direct_session().post(endpoint + path, json=payload, timeout=GATEWAY_TIMEOUT)
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"网关返回非 JSON（HTTP {response.status_code}）") from exc
    if response.status_code >= 400:
        err = body.get("msg") or body.get("message") or json_preview(body, 200)
        raise RuntimeError(f"网关 HTTP {response.status_code}: {err}")
    return body


def fetch_gateway_accounts(endpoint: str) -> List[Dict[str, Any]]:
    response = direct_session().get(endpoint + "/accounts", timeout=REQUEST_TIMEOUT)
    body = response.json()
    data = body.get("data")
    return data if isinstance(data, list) else []


def refresh_gateway_account(endpoint: str, ref: str) -> str:
    try:
        body = gateway_post(endpoint, "/accounts/refresh", {"ref": ref})
        return str(((body.get("data") or {}).get("status")) or "unknown")
    except Exception as exc:
        print(f"⚠️ [续期] 网关续期失败: {exc}")
        return "unknown"


def account_label(acc: Dict[str, Any]) -> str:
    nick = acc.get("alias") or acc.get("nickname") or ""
    if not nick:
        nick = "openid=" + str(acc.get("openid") or "")[:8]
    return f"#{acc.get('id')} {nick}"


def tag_allows(acc: Dict[str, Any]) -> bool:
    """
    网关账号标记（scripts，逗号分隔）是否允许跑本脚本。

    与其它脚本不同，本脚本**默认关**：
      · 标记为空            → 只有 yyb_default_on=1 才跑（默认不跑）
      · 标记里有 pc         → 跑
      · 标记里没有 pc       → 跳过
    """
    if not YYB_TAG_FILTER:
        return True
    tags = [t.strip().lower() for t in str(acc.get("scripts") or "").replace("，", ",").split(",") if t.strip()]
    if not tags:
        return YYB_DEFAULT_ON
    return YYB_SCRIPT_KEY in tags


def parse_yyb_accounts() -> List[Dict[str, Any]]:
    """把 yyb_server 解析成 [{endpoint, ref, label}]；ref 为 * 表示自动发现"""
    entries: List[Dict[str, Any]] = []
    for item in split_multi(YYB_SERVER):
        at = item.rfind("@")
        host, ref = (item, "*") if at == -1 else (item[:at].strip(), item[at + 1:].strip())
        if not host:
            print(f"⚠️ yyb_server 格式错误（网关地址为空）: {item}")
            continue
        entries.append({"endpoint": normalize_server_url(host), "ref": ref or "*"})

    resolved: List[Dict[str, Any]] = []
    for entry in entries:
        endpoint, ref = entry["endpoint"], entry["ref"]
        if ref != "*":
            # 显式写了 @ref：你写谁就跑谁，不做标记过滤
            resolved.append({"endpoint": endpoint, "ref": ref, "label": f"指定账号 ref={ref}"})
            continue
        try:
            accounts = fetch_gateway_accounts(endpoint)
        except Exception as exc:
            print(f"❌ [网关] 拉取账号失败 {endpoint}: {exc}")
            continue
        if not accounts:
            print(f"⚠️ [网关] 没有账号: {endpoint}")
            continue
        alive = [a for a in accounts if str(a.get("status")) == "alive"]
        skipped = 0
        for acc in accounts:
            if not tag_allows(acc):
                skipped += 1
                print(f"⏭️ [网关] 跳过 {account_label(acc)}：脚本标记 [{str(acc.get('scripts') or '').strip() or '空'}]"
                      f" 未启用本脚本 [{YYB_SCRIPT_KEY}]")
                continue
            ref_id = str(acc.get("id"))
            status = str(acc.get("status") or "unknown")
            if status != "alive" and YYB_AUTO_REFRESH:
                status = refresh_gateway_account(endpoint, ref_id)
                print(f"♻️ [网关] {account_label(acc)} 续期结果: {status}")
            if status != "alive" and YYB_SKIP_EXPIRED:
                print(f"⚠️ [网关] 跳过非存活账号 {account_label(acc)}（status={status}）")
                continue
            resolved.append({"endpoint": endpoint, "ref": ref_id, "label": account_label(acc)})
        if skipped:
            print(f"ℹ️ [网关] 共 {len(alive)} 个存活账号，按标记跳过 {skipped} 个"
                  f"（本脚本默认关，想跑请在面板「应用宝账号」页把它勾上）")
    return resolved


def get_code(endpoint: str, ref: str) -> Optional[str]:
    """通过 yyb 网关取 wx.login code；信封 {code:0,data:{result:{code}}}"""
    print(f"🔐 [授权] 经网关取 code（ref={ref}）")
    try:
        body = gateway_post(endpoint, "/wxapp/getCode", {"ref": ref, "app_id": APPID})
        data = body.get("data") or {}
        result = data.get("result") if isinstance(data.get("result"), dict) else {}
        code = result.get("code") or data.get("code")
        if not code:
            print(f"❌ [授权] 网关没返回 code: {json_preview(body, 300)}")
            return None
        print(f"✅ [授权] code 获取成功（{mask(code)}）")
        return str(code)
    except Exception as exc:
        print(f"❌ [授权] 取 code 异常: {exc}")
        return None


# ====================== 青梅业务接口 ======================

def common_headers(token: Optional[str] = None) -> Dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "store-id": STORE_ID,
        "qm-from": "wechat",
        "scene": SCENE,
        "Referer": f"https://servicewechat.com/{APPID}/{PAGE_VERSION}/page-frame.html",
    }
    if token:
        headers["qm-user-token"] = token
    return headers


def extract_token(data: Any) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    candidates = [data.get("token"), data.get("accessToken"), data.get("access_token"), data.get("jwt")]
    inner = data.get("data")
    if isinstance(inner, dict):
        candidates.extend([inner.get("token"), inner.get("accessToken"), inner.get("access_token"), inner.get("jwt")])
        user = inner.get("user")
        if isinstance(user, dict):
            candidates.extend([user.get("token"), user.get("accessToken"), user.get("access_token"), user.get("jwt")])
    for item in candidates:
        if item and item != "null":
            return str(item)
    return None


def login_by_code(code: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    try:
        print("🔐 [登录] code 换 token（青梅 mini-app-login）")
        response = biz_request(
            "POST", LOGIN_URL, headers=common_headers(),
            json={"code": code, "eVersion": "1.0", "appid": APPID},
        )
        try:
            data = response.json()
        except Exception:
            data = {"raw": response.text[:800]}
        token = extract_token(data)
        if token:
            print(f"✅ [登录] token 获取成功: {mask(token)}")
            return token, data
        print(f"❌ [登录] 未识别到 token: {json_preview(data, 400)}")
        return None, data
    except Exception as exc:
        print(f"❌ [登录] 请求异常: {exc}")
        return None, None


def api_get(url: str, token: str) -> Dict[str, Any]:
    try:
        response = biz_request("GET", url, headers=common_headers(token))
        return response.json()
    except Exception:
        return {"code": -1, "msg": "请求或解析失败"}


def api_post(url: str, token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        response = biz_request("POST", url, headers=common_headers(token), json=payload)
        return response.json()
    except Exception:
        return {"code": -1, "msg": "请求或解析失败"}


# ====================== 登录态缓存 ======================

def load_cache() -> Dict[str, Any]:
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as exc:
        print(f"⚠️ [缓存] 读取失败: {exc}")
    return {}


def save_cache(cache: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        print("✅ [缓存] 登录态已保存")
    except Exception as exc:
        print(f"❌ [缓存] 保存失败: {exc}")


def get_cached_token(key: str) -> Optional[str]:
    if (os.getenv("pc_login_cache") or "1") == "0":
        return None
    data = load_cache().get(key) or {}
    token, expire = data.get("token"), data.get("expireTime")
    if token and expire:
        try:
            if time.time() * 1000 < datetime.fromisoformat(expire).timestamp() * 1000 - 3600 * 1000:
                print(f"✅ [缓存] 复用登录态（{key}）")
                return token
        except Exception as exc:
            print(f"⚠️ [缓存] 过期时间解析异常: {exc}")
    return None


def set_cached_token(key: str, token: str, expire_time: str) -> None:
    cache = load_cache()
    cache[key] = {"token": token, "expireTime": expire_time, "updateTime": datetime.now().isoformat()}
    save_cache(cache)


def login_with_cache(key: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    cached = get_cached_token(key)
    if cached:
        check = api_get(f"{CHECK_LOGIN_URL}?appid={APPID}", cached)
        if is_ok(check):
            print("✅ [缓存] 登录态仍然有效")
            return cached, None
        print("⚠️ [缓存] 已失效，重新取 code 登录")

    # 重新登录需要网关参数（key 是「网关地址#ref」）
    if "#" not in key:
        return None, None
    endpoint, ref = key.split("#", 1)
    code = get_code(endpoint, ref)
    if not code:
        return None, None

    token, raw = login_by_code(code)
    if not token:
        return None, raw

    expire_time = None
    if isinstance(raw, dict):
        inner = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        expire_time = inner.get("expireTime") or inner.get("expire_time")
        expires_in = inner.get("expiresIn")
        if not expire_time and isinstance(expires_in, (int, float)) and expires_in > 0:
            expire_time = datetime.fromtimestamp(time.time() + expires_in).isoformat()
    if not expire_time:
        expire_time = datetime.fromtimestamp(time.time() + 24 * 3600).isoformat()
    elif not isinstance(expire_time, str):
        expire_time = datetime.fromtimestamp(expire_time / 1000).isoformat()
    set_cached_token(key, token, expire_time)
    return token, raw


# ====================== 茶店业务 ======================

def query_sign_days(token: str) -> str:
    resp = api_post(SIGN_STATS_URL, token, {"activityId": ACTIVITY_ID, "appid": APPID})
    if not is_ok(resp):
        msg = str(resp.get("message") or json_preview(resp, 200))
        print(f"⚠️ [连续签到] 查询失败: {msg}")
        activity_stale_hint(msg)
        return "-"
    data = safe_data(resp)
    days = to_float(data.get("signDays"))
    print(f"📅 [连续签到] 已连续签到 {int(days)} 天")
    for reward in (data.get("rewardList") or []):
        if not isinstance(reward, dict):
            continue
        need = to_float(reward.get("signNum"))
        if need > days:
            left = int(need - days)
            inner = reward.get("rewardList") if isinstance(reward.get("rewardList"), list) else []
            name = str(inner[0].get("rewardName") or "-") if inner and isinstance(inner[0], dict) else "-"
            print(f"🎁 [连续签到] 下一阶段奖励[{name}]还需 {left} 天")
            return f"已连续 {int(days)} 天，下一阶段[{name}]还需 {left} 天"
    print("🎉 [连续签到] 已达成全部阶段")
    return f"已连续 {int(days)} 天，已达成全部阶段"


def query_points(token: str) -> str:
    resp = api_post(POINTS_INFO_URL, token, {"appid": APPID})
    if not is_ok(resp):
        print(f"⚠️ [积分] 查询失败: {resp.get('message') or json_preview(resp, 200)}")
        return "-"
    data = safe_data(resp)
    total = data.get("totalPoints")
    total_text = str(total) if total is not None else "-"
    soon = to_float(data.get("soonExpiredPoints"))
    expired_time = data.get("expiredTime") or ""
    print(f"💰 [积分] 当前积分: {total_text}")
    if soon > 0:
        print(f"⏳ [积分] {int(soon)} 积分将于 {expired_time} 失效")
        return f"{total_text}（{int(soon)} 将于 {expired_time} 失效）"
    print("💰 [积分] 暂无过期积分")
    return total_text


ACTIVITY_STALE_HINTS = ("活动不在进行中", "活动id为空", "活动不存在", "已结束", "未开始")


def activity_stale_hint(message: str) -> None:
    """活动 ID 是按期轮换的，过期后接口会明确拒绝——给一句能直接照做的提示"""
    if any(k in str(message or "") for k in ACTIVITY_STALE_HINTS):
        print("💡 [活动] 签到活动 ID 已过期/未开始。请在茶店小程序里抓包拿新的 activityId，"
              "更新青龙变量 paotea_activity_id（当前默认值已失效）")


def do_sign(token: str) -> Tuple[str, bool]:
    stats = api_post(SIGN_STATS_URL, token, {"activityId": ACTIVITY_ID, "appid": APPID})
    if is_ok(stats) and safe_data(stats).get("signStatus") == 1:
        print("✅ [签到] 今天已经签到过了")
        return "今日已签到", True
    if not is_ok(stats):
        msg = str(stats.get("message") or json_preview(stats, 200))
        print(f"⚠️ [签到] 查询签到状态失败: {msg}")
        activity_stale_hint(msg)

    sleep(random.uniform(3, 5))
    sign_resp = api_post(SIGN_IN_URL, token, {
        "activityId": ACTIVITY_ID,
        "storeId": int(STORE_ID),
        "timestamp": int(time.time() * 1000),
        "appid": APPID,
    })
    if is_ok(sign_resp):
        print("✅ [签到] 签到成功")
        return "签到成功", True
    msg = str(sign_resp.get("message") or sign_resp.get("msg") or json_preview(sign_resp, 200))
    print(f"❌ [签到] 签到失败: {msg}")
    activity_stale_hint(msg)
    return f"签到失败: {msg}", False


def run_one(index: int, total: int, entry: Dict[str, Any]) -> Dict[str, Any]:
    label = entry["label"]
    result = {"label": label, "success": False, "token": "-", "sign": "-", "days": "-", "points": "-", "error": ""}
    log_account_header(index, total, label)

    key = f"{entry['endpoint']}#{entry['ref']}"
    time.sleep(random.randint(2, 6))

    token, raw = login_with_cache(key)
    if not token:
        result["error"] = f"登录失败: {json_preview(raw, 300)}"
        return result
    result["token"] = mask(token)

    try:
        sign_msg, ok = do_sign(token)
        result["sign"] = sign_msg
        sleep(random.uniform(1, 1.5))
        result["days"] = query_sign_days(token)
        result["points"] = query_points(token)
        result["success"] = ok
        return result
    except Exception:
        result["error"] = traceback.format_exc().strip()
        print(f"❌ [账号] 执行失败: {result['error']}")
        return result


# ====================== 推送 ======================

def send_qywx(title: str, content: str) -> bool:
    if not QYWX_TOKEN:
        return False
    key = QYWX_TOKEN.split("key=")[-1].strip()
    try:
        text = f"{title}\n{content}"
        if len(text.encode("utf-8")) > 2000:
            text = text.encode("utf-8")[:2000].decode("utf-8", "ignore")
        payload = json.dumps({"msgtype": "text", "text": {"content": text}}).encode("utf-8")
        req = urllib.request.Request(
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + key,
            data=payload, headers={"Content-Type": "application/json"},
        )
        res = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
        ok = res.get("errcode") == 0
        print(f"[企业微信] 推送{'成功 ✓' if ok else '失败 ✗'} errcode={res.get('errcode')} {res.get('errmsg', '')}")
        return ok
    except Exception as exc:
        print(f"[企业微信] 推送异常: {exc}")
        return False


def notify(title: str, content: str) -> None:
    send_qywx(title, content)
    if not PLUSPLUS_TOKEN:
        print("⚠️ [PushPlus] 未配置 PLUSPLUS_TOKEN，跳过")
        return
    try:
        requests.post(
            "https://www.pushplus.plus/send",
            json={"token": PLUSPLUS_TOKEN, "title": title, "content": content, "template": "txt"},
            timeout=10,
        )
        print("✅ [PushPlus] 推送成功")
    except Exception as exc:
        print(f"❌ [PushPlus] 推送失败: {exc}")


def build_notify(results: List[Dict[str, Any]]) -> str:
    ok = sum(1 for r in results if r["success"])
    content = (f"🍵 {APP_NAME}任务结果\n\n🏁 {ok} 成功 / {len(results) - ok} 失败\n"
               f"🕒 {now_text()}\n" + "━" * 20 + "\n")
    for i, res in enumerate(results, 1):
        content += (f"\n🧩 {i}. {res['label']}\n📝 签到：{res['sign']}\n📅 连签：{res['days']}\n"
                    f"💰 积分：{res['points']}\n{'✅ 成功' if res['success'] else '❌ 失败'}\n")
        if not res["success"] and res["error"]:
            content += f"❌ 原因：{res['error'][:300]}\n"
        content += "━" * 20 + "\n"
    return content


def main() -> int:
    if not YYB_SERVER.strip():
        print("❌ 未配置 yyb_server：请确认青龙里已写入网关地址（面板 → 应用宝网关/青龙变量）")
        return 1

    if PROXY_URL:
        print(f"🔌 [代理] 业务请求走 {PROXY_URL.split('@')[-1]}")
    else:
        print("⚠️ [代理] 未配置 pc_proxy/ppcs_proxy/sf_proxy：海外服务器直连青梅接口大概率超时")

    entries = parse_yyb_accounts()
    log_title(len(entries))
    if not entries:
        print("❌ 没有需要执行的账号：本脚本默认关，请在面板「应用宝账号」页把「爷爷不泡茶」勾上；"
              "或用 YYB_SERVER=地址@账号ID 指定账号")
        return 1

    results = []
    for index, entry in enumerate(entries, 1):
        try:
            results.append(run_one(index, len(entries), entry))
        except Exception as exc:
            print(f"❌ [主程序] {entry.get('label')} 异常: {exc}")
            results.append({"label": entry.get("label", "?"), "success": False, "token": "-",
                            "sign": "-", "days": "-", "points": "-", "error": traceback.format_exc().strip()})
        if index < len(entries):
            sleep(2)

    ok = sum(1 for r in results if r["success"])
    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🏁 爷爷不泡茶任务执行完成" + " " * 22 + "║")
    print(f"║ ✅ 成功: {ok:<41}║")
    print(f"║ ❌ 失败: {len(results) - ok:<41}║")
    print(f"║ 🕒 结束时间: {now_text():<32}║")
    print("╚" + "═" * 50 + "╝")

    notify(f"🍵 {APP_NAME}任务完成", build_notify(results))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
