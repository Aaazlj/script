#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
品赞 HTTP 代理 · 签到 + 余额查询（青龙脚本）

变量名: pzhttp
格式: 账号#密码，多账号用换行隔开
例如:
13800138000#your_password
13800138001#your_password2

可选变量：
  pz_proxy     访问品赞所用的代理。⚠️ 海外服务器直连 service.ipzan.com 会 TLS 超时
               （实测 HTTP 000），必须经国内链路。本机树脂写法：
               http://账号:令牌@172.19.0.1:2260
               未配置时自动回退到 ppcs_proxy / sf_proxy。
  pz_retry     网络类失败的重试次数，默认 3。
  pz_buffer    成功后给下次执行多留的余量秒数，默认 120。cron 只精确到分钟，
               留 2 分钟才不会被服务端判「未满一周」。
  pz_state     状态文件路径，默认 /ql/data/ipzan_state.json。
  pz_ql_url    青龙地址，默认 http://127.0.0.1:5700。
  pz_ql_client_id / pz_ql_client_secret
               青龙应用凭据（要带 crons 权限）。不配会自动从
               /ql/data/db/database.sqlite 的 Apps 表里挑一个带 crons 的应用。
  pz_task      改哪个任务，填任务 id 或任务名；不填则按命令行里的本文件名匹配。

周期说明
  品赞奖励是「精确 7×24 小时」一次：9:00:05 领过，下周必须 9:00:05 之后才能领，
  所以固定 crontab 卡点必然差那几秒。签到成功后脚本直接把青龙任务的下次执行时间
  改成「本次成功 + 7 天 + pz_buffer」，任务到点才跑一次，脚本里不再原地等待。
  「未满一周」时不动状态、把下次推到明天再探一次，直到真正领到为止。
"""

import json
import os
import random
import sqlite3
import string
import sys
import time

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


def env_int(name, default):
    try:
        return int(env_first(name, default=str(default)) or default)
    except ValueError:
        return default


def build_session(proxy):
    """带重试的会话；proxy 为 http://user:pass@host:port 形式"""
    session = requests.Session()
    retry = Retry(
        total=env_int("pz_retry", 3),
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


# ---------------------------------------------------------------- 签到周期

WEEK_SECONDS = 7 * 24 * 3600


def fmt_duration(seconds):
    seconds = int(max(0, seconds))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if days:
        return f"{days}天{hours}小时{minutes}分"
    if hours:
        return f"{hours}小时{minutes}分"
    if minutes:
        return f"{minutes}分{seconds}秒"
    return f"{seconds}秒"


def state_file():
    explicit = env_first("pz_state")
    if explicit:
        return explicit
    # 青龙的 /ql/data 会跟着备份走，且不会被订阅更新覆盖
    if os.path.isdir("/ql/data"):
        return os.path.join("/ql/data", "ipzan_state.json")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ipzan_state.json")


def load_state():
    try:
        with open(state_file(), "r", encoding="utf-8") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        print(f"⚠️ 状态文件读取失败（{exc}），按首次签到处理")
        return {}


def save_state(state):
    path = state_file()
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            json.dump(state, fp, ensure_ascii=False, indent=2)
        os.replace(tmp, path)  # 原子替换，避免写一半被打断留下坏文件
    except OSError as exc:
        print(f"⚠️ 状态文件写入失败（{exc}），下次会重新试一次")


def next_allowed(state, phone):
    item = state.get(phone)
    if not isinstance(item, dict):
        return 0.0
    try:
        return float(item.get("next_at") or 0)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- 青龙调度

QL_DB = "/ql/data/db/database.sqlite"


def read_ql_app():
    """青龙应用凭据：直接从面板库里找一个带 crons 权限的，免去手配"""
    if not os.path.exists(QL_DB):
        return None, None
    try:
        conn = sqlite3.connect(f"file:{QL_DB}?mode=ro", uri=True, timeout=5)
        try:
            rows = conn.execute("SELECT client_id, client_secret, scopes FROM Apps").fetchall()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        print(f"⚠️ 读青龙数据库失败：{exc}")
        return None, None
    for client_id, client_secret, scopes in rows:
        if "crons" in (scopes or "") or '"*"' in (scopes or ""):
            return client_id, client_secret
    return None, None


def ql_request(method, path, base, token=None, **kwargs):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    session = requests.Session()
    session.trust_env = False  # 容器里若配了 HTTP_PROXY，127.0.0.1 不能被代理走
    try:
        resp = session.request(method, f"{base}{path}", headers=headers, timeout=10, **kwargs)
    finally:
        session.close()
    try:
        return resp.json()
    except ValueError:
        raise RuntimeError(f"{path} 返回非 JSON（HTTP {resp.status_code}）")


def ql_token(base):
    client_id = env_first("pz_ql_client_id")
    client_secret = env_first("pz_ql_client_secret")
    if not (client_id and client_secret):
        client_id, client_secret = read_ql_app()
    if not (client_id and client_secret):
        return None, "没找到带 crons 权限的青龙应用（可在面板「应用」里建，或配 pz_ql_client_id/secret）"
    # 注意是 GET，POST 会 404
    data = ql_request("GET", "/open/auth/token", base,
                      params={"client_id": client_id, "client_secret": client_secret})
    if data.get("code") != 200:
        return None, data.get("message") or "换 token 失败"
    return (data.get("data") or {}).get("token"), None


def ql_find_tasks(base, token, script):
    data = ql_request("GET", "/open/crons", base, token=token, params={"searchValue": script})
    payload = data.get("data") or {}
    items = payload.get("data") if isinstance(payload, dict) else payload
    return [x for x in (items or []) if script in (x.get("command") or "")]


def reschedule(next_ts):
    """把青龙任务的下次执行时间改到 next_ts 所在的那一分钟（每周同一条）"""
    base = env_first("pz_ql_url", default="http://127.0.0.1:5700").rstrip("/")
    script = os.path.basename(os.path.abspath(__file__))

    token, err = ql_token(base)
    if not token:
        print(f"⚠️ 跳过改定时：{err}")
        return

    try:
        tasks = ql_find_tasks(base, token, script)
        wanted = env_first("pz_task")
        if wanted:
            hit = [t for t in tasks if str(t.get("id")) == wanted or t.get("name") == wanted]
            tasks = hit or tasks
        if not tasks:
            print(f"⚠️ 青龙里没找到跑 {script} 的任务，跳过改定时")
            return

        tm = time.localtime(next_ts)
        schedule = f"{tm.tm_min} {tm.tm_hour} * * {int(time.strftime('%w', tm))}"
        when = time.strftime("%m-%d %H:%M", tm)
        for task in tasks:
            if task.get("schedule") == schedule:
                print(f"🗓 任务「{task.get('name')}」定时已是 {schedule}（{when}），不用改")
                continue
            data = ql_request("PUT", "/open/crons", base, token=token,
                              json={"id": task["id"], "name": task["name"],
                                    "command": task["command"], "schedule": schedule})
            if data.get("code") == 200:
                print(f"🗓 任务「{task.get('name')}」下次执行已改到 {when}（cron {schedule}）")
            else:
                print(f"⚠️ 改定时失败：{data.get('message') or data}")
    except Exception as exc:  # 改定时失败不该让签到结果变成失败
        print(f"⚠️ 改定时异常：{exc}")


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


def handle_account(idx, total, phone, password, proxy, state):
    masked = phone[:3] + "****" + phone[-4:] if len(phone) >= 7 else phone
    print(f"\n———— 账号 {idx}/{total}：{masked} ————")

    buffer_seconds = env_int("pz_buffer", 120)
    now = time.time()
    next_at = next_allowed(state, phone)
    if next_at > now:
        # 没满 7 天时服务端只会回「请一周后再次领取」，这次请求可以直接省掉
        print(f"⏳ 还没满一周：{time.strftime('%m-%d %H:%M', time.localtime(next_at))} 之后可领"
              f"（还剩 {fmt_duration(next_at - now)}），本次跳过")
        return "early", f"{masked}：未到时间（{time.strftime('%m-%d %H:%M', time.localtime(next_at))} 后可领）"

    session = build_session(proxy)

    token, err = login(session, phone, password)
    if not token:
        print(f"❌ 登录失败：{err}")
        return "fail", f"{masked} 登录失败：{err}"

    before, _ = wallet(session, token)
    if before:
        print(f"💰 签到前余额：{before.get('balance', 0)}（奖励 {before.get('bonus_amount', 0)}"
              f" / 真实 {before.get('real_amount', 0)}）")
        if before.get("levelReward"):
            print("🏆 有可领取的等级奖励（去官网领一下）")

    ok, message, already = sign_in(session, token)
    if ok:
        print(f"✅ 签到成功：{message}")
        # cron 只到分钟，时间戳取整到分钟，任务到点触发时才不会因为差几十秒被跳过
        next_at = (int(time.time()) + WEEK_SECONDS + buffer_seconds) // 60 * 60
        state[phone] = {"last_success": int(time.time()), "next_at": next_at}
        save_state(state)
        status = "success"
    elif already:
        # 状态没记录（比如在官网手动领过）或估算偏了。按明天再探一次，
        # 宁可多跑几天也不能漏掉这一轮
        entry = dict(state.get(phone) or {})
        entry["next_at"] = (int(time.time()) + 86400) // 60 * 60
        state[phone] = entry
        save_state(state)
        print(f"ℹ️ 服务端说还没满一周（{message}），明天再探一次")
        status = "already"
    else:
        print(f"⚠️ 签到失败：{message}")
        status = "fail"

    after, _ = wallet(session, token)
    gain = ""
    if before and after:
        try:
            delta = float(after.get("balance", 0)) - float(before.get("balance", 0))
            gain = f"，本次 +{delta:g}" if delta else "，余额无变化"
            print(f"💰 签到后余额：{after.get('balance', 0)}{gain}")
        except (TypeError, ValueError):
            pass

    label = {"success": "签到成功", "already": "未满一周", "fail": "签到失败"}[status]
    summary = f"{masked}：{label}"
    if status == "fail" and message:
        summary += f"（{message}）"
    if after:
        summary += f"，余额 {after.get('balance', 0)}"
    return status, summary


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

    state = load_state()
    print(f"📱 共 {len(accounts)} 个账号，开始签到…")
    lines, counts = [], {"success": 0, "already": 0, "early": 0, "fail": 0}
    for idx, (phone, password) in enumerate(accounts, 1):
        try:
            if password is None:
                print(f"⚠️ 账号 {idx} 格式错误（应为 手机号#密码），已跳过")
                lines.append(f"账号 {idx}：格式错误")
                counts["fail"] += 1
                continue
            status, line = handle_account(idx, len(accounts), phone, password, proxy, state)
            lines.append(line)
            counts[status] += 1
        except requests.RequestException as e:
            print(f"❌ 账号 {idx} 网络异常：{e}")
            lines.append(f"账号 {idx}：网络异常（{e}）")
            counts["fail"] += 1
        except Exception as e:  # 单个账号出问题不影响其它账号
            print(f"❌ 账号 {idx} 异常：{e}")
            lines.append(f"账号 {idx}：异常 {e}")
            counts["fail"] += 1

    total = len(accounts)
    body = "\n".join(lines)
    print(f"\n🎉 完成：成功 {counts['success']}／未到时间 {counts['early']}／"
          f"未满一周 {counts['already']}／失败 {counts['fail']}（共 {total}）\n{body}")

    # 把最早可领的时间写回青龙任务，下次到点才跑，脚本里不必干等
    pending = [next_allowed(state, phone) for phone, password in accounts
               if password and next_allowed(state, phone) > time.time()]
    if pending:
        reschedule(min(pending))
    else:
        print("⚠️ 算不出下次可领时间，青龙定时保持不变")

    # 没到时间的那些日子只留日志，避免每天推一次没意义的消息
    if counts["success"] or counts["fail"]:
        if counts["fail"]:
            title = f"品赞签到 {counts['success']}/{total}"
        else:
            title = f"品赞签到 成功 {counts['success']}/{total}"
        notify(title, body)
    else:
        print("（本次都没到可领时间，不推送通知）")

    # 全部都没成功才以非 0 退出（青龙会标红提醒）
    return 0 if (counts["success"] or counts["already"] or counts["early"]) else 1


if __name__ == "__main__":
    sys.exit(main())
