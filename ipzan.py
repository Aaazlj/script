#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
品赞 HTTP 代理 · 签到 + 余额查询（青龙脚本）

变量名: pzhttp
格式: 账号#密码，多账号用换行隔开
例如:
13800138000#your_password
13800138001#your_password2

另外三个可选变量：
  pz_proxy  访问品赞所用的代理。⚠️ 海外服务器直连 service.ipzan.com 会 TLS 超时
            （实测 HTTP 000），必须经国内链路。本机树脂写法：
            http://账号:令牌@172.19.0.1:2260
            未配置时自动回退到 ppcs_proxy / sf_proxy。
  pz_retry  网络类失败的重试次数，默认 3。

说明
  - 品赞登录接口要求一个「混淆过的 account」字段（前端做的简单 Base64 + 随机 hex
    拼装），这里按原实现保留该算法。
  - 品赞这个奖励是「一周一次」（已领取过会返回「请一周后再次领取」），
    所以建议一周跑一次；脚本把「本周已领取」也视为正常，不会误报失败。
    若担心固定星期几差几小时导致漏掉一周，可以改成每周两次或每天跑（脚本很轻）。
"""

import json
import os
import random
import string
import sys

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

LOGIN_URL = "https://service.ipzan.com/users-login"
WALLET_URL = "https://service.ipzan.com/home/userWallet-find"
SIGN_URL = "https://service.ipzan.com/home/userWallet-receive"
SALT = "QWERIPZAN1290QWER"
TIMEOUT = 15

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")

BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://www.ipzan.com",
    "Referer": "https://www.ipzan.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Cookie": "locale=en-us",
}


# ---------------------------------------------------------------- 通知

def notify(title, content):
    """青龙自带 notify.py 时走推送，否则只打日志"""
    for extra in ("/ql/data/scripts", "/ql/scripts"):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    try:
        from notify import send  # type: ignore
        send(title, content)
    except Exception as e:  # 没装/没配渠道都不该影响签到
        print(f"[通知] 未发送（{e}），内容如下：\n{content}")


# ---------------------------------------------------------------- 混淆登录字段

_B64_TABLE = string.ascii_uppercase + string.ascii_lowercase + string.digits + "+/"


def _utf16_to_utf8(s):
    out = []
    for ch in s:
        code = ord(ch)
        if 0 < code <= 127:
            out.append(ch)
        elif 128 <= code <= 2047:
            out.append(chr(192 | (code >> 6) & 31))
            out.append(chr(128 | code & 63))
        elif 2048 <= code <= 65535:
            out.append(chr(224 | (code >> 12) & 15))
            out.append(chr(128 | (code >> 6) & 63))
            out.append(chr(128 | code & 63))
    return "".join(out)


def _b64(s):
    """和前端一致的自定义 Base64（表就是标准表，实现保持原样以免改动行为）"""
    if not s:
        return ""
    data = _utf16_to_utf8(s)
    i, n, out = 0, len(data), []
    while i < n:
        o = ord(data[i])
        i += 1
        out.append(_B64_TABLE[o >> 2])
        if i == n:
            out.append(_B64_TABLE[(o & 3) << 4])
            out.append("==")
            break
        s2 = ord(data[i])
        i += 1
        if i == n:
            out.append(_B64_TABLE[((o & 3) << 4) | ((s2 >> 4) & 15)])
            out.append(_B64_TABLE[(s2 & 15) << 2])
            out.append("=")
            break
        a = ord(data[i])
        i += 1
        out.append(_B64_TABLE[((o & 3) << 4) | ((s2 >> 4) & 15)])
        out.append(_B64_TABLE[((s2 & 15) << 2) | ((a & 192) >> 6)])
        out.append(_B64_TABLE[a & 63])
    return "".join(out)


def obfuscated_account(phone, password):
    """把 手机号+salt+密码 混淆成接口要的 account 字段"""
    encoded = _b64(phone + SALT + password)
    hexs = string.hexdigits.lower()
    filler = "".join(random.choice(hexs) for _ in range(400))

    # 400 位随机 hex 里插入 base64 片段（位置与长度照原实现）
    return (filler[:100] + encoded[:8] + filler[100:200] + encoded[8:20]
            + filler[200:300] + encoded[20:] + filler[300:400])


# ---------------------------------------------------------------- 网络

def env_first(*names, default=""):
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return default


def build_session(proxy):
    """带重试的会话；proxy 为 http://user:pass@host:port 形式"""
    session = requests.Session()
    retry = Retry(
        total=int(env_first("pz_retry", default="3") or 3),
        backoff_factor=1.2,
        status_forcelist=(500, 502, 503, 504),
        allowed_methods=None,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(BASE_HEADERS)
    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})
    return session


def api(session, method, url, token=None, payload=None):
    headers = dict(BASE_HEADERS)
    headers["Authorization"] = f"Bearer {token}" if token else "Bearer null"
    if payload is not None:
        headers["Content-Type"] = "application/json;charset=UTF-8"
        return session.request(method, url, data=json.dumps(payload),
                               headers=headers, timeout=TIMEOUT)
    return session.request(method, url, headers=headers, timeout=TIMEOUT)


def login(session, phone, password):
    resp = api(session, "POST", LOGIN_URL,
               payload={"account": obfuscated_account(phone, password),
                        "source": "ipzan-home-one"})
    data = resp.json()
    if data.get("code") == 0 and data.get("data"):
        return data["data"].get("token"), None
    return None, data.get("message") or f"HTTP {resp.status_code}"


def wallet(session, token):
    data = api(session, "GET", WALLET_URL, token=token).json()
    if data.get("code") != 0:
        return None, data.get("message") or "查询余额失败"
    return data.get("data") or {}, None


def sign_in(session, token):
    """
    签到。原脚本用 GET，这里先按 GET 试；若服务端抱怨方法/参数，
    再按 POST 重试（不同时期接口行为变过，这样两种都能覆盖）。
    """
    resp = api(session, "GET", SIGN_URL, token=token)
    try:
        data = resp.json()
    except ValueError:
        return False, f"签到返回非 JSON（HTTP {resp.status_code}）", False

    if data.get("code") == 0:
        return True, data.get("message") or "签到成功", False

    message = str(data.get("message") or "")
    if resp.status_code in (404, 405) or any(k in message for k in ("方法", "请求方式", "method")):
        resp = api(session, "POST", SIGN_URL, token=token, payload={})
        try:
            data = resp.json()
        except ValueError:
            return False, f"签到(POST)返回非 JSON（HTTP {resp.status_code}）", False
        if data.get("code") == 0:
            return True, data.get("message") or "签到成功", False
        message = str(data.get("message") or "")

    already = any(k in message for k in ("已领取", "领取过", "已领", "一周后", "已签", "重复", "already"))
    return False, message or f"HTTP {resp.status_code}", already


# ---------------------------------------------------------------- 主流程

def parse_accounts(raw):
    parts = []
    for chunk in raw.replace("，", ",").replace(",", "&").replace("\r", "").split("\n"):
        parts.extend(chunk.split("&"))
    accounts = []
    for item in parts:
        item = item.strip()
        if not item:
            continue
        if "#" not in item:
            accounts.append((item, None))
            continue
        # 密码里可能含 #，只按第一个 # 切
        phone, password = item.split("#", 1)
        accounts.append((phone.strip(), password.strip()))
    return accounts


def handle_account(idx, total, phone, password, proxy):
    masked = phone[:3] + "****" + phone[-4:] if len(phone) >= 7 else phone
    print(f"\n———— 账号 {idx}/{total}：{masked} ————")
    session = build_session(proxy)

    token, err = login(session, phone, password)
    if not token:
        print(f"❌ 登录失败：{err}")
        return False, f"{masked} 登录失败：{err}"

    before, _ = wallet(session, token)
    if before:
        print(f"💰 签到前余额：{before.get('balance', 0)}（奖励 {before.get('bonus_amount', 0)}"
              f" / 真实 {before.get('real_amount', 0)}）")
        if before.get("levelReward"):
            print("🏆 有可领取的等级奖励（去官网领一下）")

    ok, message, already = sign_in(session, token)
    if ok:
        print(f"✅ 签到成功：{message}")
    elif already:
        print(f"ℹ️ 本周已领取过（品赞奖励一周一次，无需重复）：{message}")
    else:
        print(f"⚠️ 签到失败：{message}")

    after, _ = wallet(session, token)
    gain = ""
    if before and after:
        try:
            delta = float(after.get("balance", 0)) - float(before.get("balance", 0))
            gain = f"，本次 +{delta:g}" if delta else "，余额无变化"
            print(f"💰 签到后余额：{after.get('balance', 0)}{gain}")
        except (TypeError, ValueError):
            pass

    summary = f"{masked}：{'签到成功' if ok else ('本周已领取' if already else '签到失败')}"
    if after:
        summary += f"，余额 {after.get('balance', 0)}"
    return ok or already, summary


def main():
    raw = env_first("pzhttp")
    if not raw:
        print("❌ 未配置 pzhttp（格式：手机号#密码，多账号换行分隔）")
        return 1

    accounts = parse_accounts(raw)
    if not accounts:
        print("❌ pzhttp 里没有解析出账号")
        return 1

    proxy = env_first("pz_proxy", "ppcs_proxy", "sf_proxy")
    if not proxy:
        print("⚠️ 未配置 pz_proxy：海外服务器直连品赞大概率超时，建议配置国内出口")
    else:
        print(f"🔌 使用代理：{proxy.split('@')[-1] if '@' in proxy else proxy}")

    print(f"📱 共 {len(accounts)} 个账号，开始签到…")
    lines, ok_count = [], 0
    for idx, (phone, password) in enumerate(accounts, 1):
        try:
            if password is None:
                print(f"⚠️ 账号 {idx} 格式错误（应为 手机号#密码），已跳过")
                lines.append(f"账号 {idx}：格式错误")
                continue
            ok, line = handle_account(idx, len(accounts), phone, password, proxy)
            lines.append(line)
            if ok:
                ok_count += 1
        except requests.RequestException as e:
            print(f"❌ 账号 {idx} 网络异常：{e}")
            lines.append(f"账号 {idx}：网络异常")
        except Exception as e:  # 单个账号出问题不影响其它账号
            print(f"❌ 账号 {idx} 异常：{e}")
            lines.append(f"账号 {idx}：异常 {e}")

    title = f"品赞签到 {'完成' if ok_count == len(accounts) else f'{ok_count}/{len(accounts)}'}"
    body = "\n".join(lines)
    print(f"\n🎉 完成：{ok_count}/{len(accounts)} 个账号\n{body}")
    notify(title, body)

    # 全部失败才以非 0 退出（青龙会标红提醒）
    return 0 if ok_count else 1


if __name__ == "__main__":
    sys.exit(main())
