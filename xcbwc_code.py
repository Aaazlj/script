#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# name: 小蚕霸王餐
"""
小蚕霸王餐 code 版（青龙脚本）

登录态怎么来（两条路，取到就缓存到本地，失效自动重登）
  1. 走 yyb 网关：给「在面板里勾选了本脚本」的账号取一次小蚕小程序的微信 code，
     再换小蚕的 vayne/teemo/sivir 登录态 —— 不用再手动抓包；
  2. 环境变量 xc_cookie 里手工粘的 vayne#teemo#sivir（一行一个）。

用法（青龙任务命令后面加模式名即可）
  task Aaazlj_script_master/xcbwc_code.py            默认 = run：日常任务
  task Aaazlj_script_master/xcbwc_code.py run        会员签到 + 每日任务 + 抽奖 + 累计奖励
  task Aaazlj_script_master/xcbwc_code.py check      检测登录态是否有效
  task Aaazlj_script_master/xcbwc_code.py rain       抢瓜分封紅雨
  task Aaazlj_script_master/xcbwc_code.py monitor    监控抢单（需配位置与店铺）
  task Aaazlj_script_master/xcbwc_code.py list       查询账号信息（蚕豆/卡券/封紅）
  task Aaazlj_script_master/xcbwc_code.py withdraw   提现（默认微信，可切支付宝）

环境变量
  yyb_server        yyb 网关地址（面板自动写入），用于扫码登录
  xc_tag_key        网关账号上的脚本标记 key，默认 xc
  xc_default_on     默认 0 = **所有账号默认不跑**，必须在面板「应用宝账号」里勾选才跑；
                    设 1 则等同于其它脚本（标记为空就跑）
  xc_cookie         手工登录态（可选）：一行一个 vayne#teemo#sivir
  xc_proxy          业务代理：小蚕接口海外直连不通、且它的 WAF 会拦普通数据中心 IP，
                    实测**必须用「网关隧道」**：xc_proxy=http://yyb-go:8000
                    （网关内部走「树脂 >> 品赞住宅出口」双跳，还能自动轮换出口）
                    未配置时回退 ppcs_proxy / sf_proxy（那条路会被小蚕 WAF 403 拦掉）
  xc_concurrency    并发数，**默认 1 = 严格顺序执行**（一个账号跑完再跑下一个，
                    小蚕对同 IP 并发比较敏感，串行最稳）。想加速可以调大，
                    但输出顺序仍是按账号排的。
  xc_city/xc_lat/xc_lng   抢单定位；不填用账号记录过的位置，再退到深圳
  xc_monitor_stores 监控店铺，如 mt:123456,elm:234567（平台 mt/elm/jd）
  xc_withdraw_channel  withdraw 模式用：wx（默认）/ zfb
  xc_cumulative_steps  累计抽奖奖励领哪几档，默认 1（第 2 档要求抽奖次数更多，
                       实测每天都是「未达到抽奖次数」；想都试就填 1,2）
  xc_yb_lottery        元宝抽奖，**默认 0=关**：该接口只传 activity_id/box_id 会报「服务内部错误」
                       但仍扣 200 元宝（缺 App 端验证 token），摸清参数前别开。
  xc_daily_task_ids    日常福利里自动完成的任务 id，默认 57（抖音电商浏览，500 元宝/天）；
                       下单/邀请/入群/关注/晒图/兑换这类要真实操作的，脚本只报告不做
  QYWX_TOKEN / PLUSPLUS_TOKEN   推送（可选）

执行方式
  - 多账号默认串行（xc_concurrency=1）；调大并发时输出仍按账号顺序整块打印。
  - YYB_SERVER 可写「地址@1,3,5」只跑指定账号；只写地址则自动拉全部账号、按脚本标记过滤。

说明
  - 作者的服务端校验页在海外访问不通：探得到就跟随作者状态，探不到就放行并提示。
  - 需要人工输入的流程（短信/滑块解限）未实现——无人值守跑不了。
"""

import hashlib
import hmac
import json
import os
import random
import re
import socket
import string
import sys
import threading
import time
import uuid
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

import requests

APP_NAME = "小蚕霸王餐"
CHINA_TZ = timezone(timedelta(hours=8))
XC_APPID = os.getenv("xc_appid") or "wx52ae177248081591"   # 小蚕小程序 appid（扫码登录用）
RPC_URL = "https://gw.xiaocantech.com/rpc"

# ---------------- 环境变量 ----------------
YYB_SERVER = os.getenv("YYB_SERVER") or os.getenv("yyb_server") or ""
TAG_KEY = (os.getenv("xc_tag_key") or "xc").strip().lower()
TAG_FILTER = (os.getenv("xc_tag_filter") or "1") != "0"
DEFAULT_ON = (os.getenv("xc_default_on") or "0") == "1"
MANUAL_COOKIES = os.getenv("xc_cookie") or os.getenv("XC_COOKIE") or ""
PROXY_URL = (os.getenv("xc_proxy") or os.getenv("ppcs_proxy") or os.getenv("sf_proxy") or "").strip()
PROXIES = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None
CONCURRENCY = max(1, int(os.getenv("xc_concurrency") or "1"))
# 累计抽奖奖励：只领第 1 档（第 2 档要求更多抽奖次数，实测每天都「未达到抽奖次数」）。
# 想两档都试：xc_cumulative_steps=1,2
CUMULATIVE_STEPS = [x.strip() for x in (os.getenv("xc_cumulative_steps") or "1,2").split(",") if x.strip()]
# 日常福利里「能自动完成」的任务 id（逗号分隔）：57=抖音电商浏览(500元宝/天)
# 其余任务（下单/邀请/入群/关注/晒图/兑换）需要真实操作，脚本只报告不做。
DAILY_TASK_IDS = [x.strip() for x in (os.getenv("xc_daily_task_ids") or "57").split(",") if x.strip()]
# 元宝抽奖：⚠️ 默认关闭。实测 YbLottery 只传 activity_id/box_id 会返回「服务内部错误」，
# 但元宝照扣 200（疑似还需要 App 端的验证 token，抓不到）。在摸清参数前别开：每次失败都白扣 200。
# 想继续试：xc_yb_lottery=1
YB_LOTTERY = (os.getenv("xc_yb_lottery") or "0") != "0"
YB_LOTTERY_TIMES = max(1, int(os.getenv("xc_yb_lottery_times") or "1"))
GATEWAY_TIMEOUT = 60

QYWX_TOKEN = os.getenv("QYWX_TOKEN", "")
PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")

VERSION = "3.12.5.70"
_QL_DIR = os.getenv("QL_DIR", "")
STATE_FILE = os.getenv("xc_state_file") or (
    os.path.join(_QL_DIR, "data", "xcbwc_state.json") if _QL_DIR
    else os.path.join(os.path.dirname(os.path.abspath(__file__)), "xcbwc_state.json")
)

_state_lock = threading.Lock()
_headers_lock = threading.Lock()
_time_offset = None
_offset_expiry = 0


# ====================== 基础小工具 ======================

def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_ntp_time() -> datetime:
    """对齐一下时间（红包雨抢场次对时间敏感）；失败就用本机时间"""
    global _time_offset, _offset_expiry
    now = time.time()
    if _time_offset is None or now > _offset_expiry:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(2)
                s.sendto(b"\x1b" + 47 * b"\0", ("ntp.aliyun.com", 123))
                data, _ = s.recvfrom(1024)
                if data:
                    secs = int.from_bytes(data[40:44], "big") - 2208988800
                    frac = int.from_bytes(data[44:48], "big")
                    _time_offset = (secs + frac / 2 ** 32) - time.time()
                    _offset_expiry = time.time() + 600
        except OSError:
            if _time_offset is None:
                _time_offset = 0
            _offset_expiry = time.time() + 60
    return datetime.fromtimestamp(time.time() + _time_offset)


def china_now() -> datetime:
    return get_ntp_time().astimezone(CHINA_TZ)


def today_str() -> str:
    return str(china_now().date())


def ms_clock() -> str:
    return china_now().strftime("%H:%M:%S.%f")[:-3]


def to_yuan(v) -> float:
    try:
        return (float(v or 0)) / 100.0
    except (TypeError, ValueError):
        return 0.0


def mask(s) -> str:
    s = str(s or "")
    return s if len(s) <= 8 else s[:4] + "..." + s[-4:]


# ====================== 本地状态（替代原插件的 bucket 存储） ======================

# ====================== 多账号执行：并发跑、按账号顺序输出 ======================
# 每个账号的日志先写进本线程缓冲，主线程按 1、2、3… 顺序整块打印，
# 谁先跑完都不影响阅读顺序（直接 as_completed 打印会乱序）。
_log_local = threading.local()
_print_lock = threading.Lock()


def emit(*parts) -> None:
    """所有日志的唯一出口：并发期间写进线程缓冲，由主线程按账号顺序整块输出。

    多行文本会按行拆开（有的接口一次返回好几行，比如「奖励状态: …」，不拆的话
    第二行会跑出账号的缩进/缓冲之外）。
    """
    lines = " ".join(str(p) for p in parts).split("\n")
    buf = getattr(_log_local, "buf", None)
    if buf is None:
        with _print_lock:
            for line in lines:
                sys.stdout.write(line + "\n")
            sys.stdout.flush()
        return
    buf.extend(lines)


def _take_block() -> List[str]:
    buf = getattr(_log_local, "buf", None)
    _log_local.buf = None
    return buf or []


def run_accounts(accounts: List[Dict], worker) -> List[Tuple[bool, str]]:
    """
    并发执行账号，但**按账号顺序**输出。

    worker(index, acc) 返回 (是否成功, 汇总行)；它内部用 emit() 记日志，
    这些日志会被收集成该账号的一块，等轮到它时整块打印。
    """
    total = len(accounts)
    blocks: Dict[int, List[str]] = {}
    outcome: Dict[int, Tuple[bool, str]] = {}
    printed = 0

    def flush_in_order() -> None:
        nonlocal printed
        while printed in blocks:                      # 只按顺序打印；前面没好就等着
            i = printed
            acc = accounts[i]
            name = acc.get("remark") or acc.get("key") or f"#{i + 1}"
            good, line = outcome[i]
            sys.stdout.write("\n" + "─" * 12 + f" 账号 {i + 1}/{total} · {name} " + "─" * 12 + "\n")
            for entry in blocks[i]:
                sys.stdout.write(entry + "\n")
            sys.stdout.write(("✅ " if good else "❌ ") + line + "\n")
            sys.stdout.flush()
            printed += 1

    def run_one(i: int, acc: Dict) -> Tuple[int, bool, str, List[str]]:
        _log_local.buf = []
        try:
            good, line = worker(i, acc)
        except Exception as exc:                       # 单个账号炸了不影响别的
            emit(f"❌ 执行异常：{parse_error(exc)}")
            good, line = False, f"{acc.get('remark') or '?'}：{parse_error(exc)}"
        return i, good, line, _take_block()

    if CONCURRENCY <= 1 or total == 1:
        for i, acc in enumerate(accounts):
            idx, good, line, buf = run_one(i, acc)
            blocks[idx], outcome[idx] = buf, (good, line)
            flush_in_order()
    else:
        with ThreadPoolExecutor(max_workers=min(CONCURRENCY, total)) as pool:
            futures = [pool.submit(run_one, i, acc) for i, acc in enumerate(accounts)]
            for fut in as_completed(futures):
                idx, good, line, buf = fut.result()
                with _print_lock:
                    blocks[idx], outcome[idx] = buf, (good, line)
                    flush_in_order()
    return [outcome[i] for i in range(total)]


def load_state() -> Dict:
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    data.setdefault("accounts", {})
                    return data
    except Exception as exc:
        emit(f"⚠️ [状态] 读取失败: {exc}")
    return {"accounts": {}}


def save_state(state: Dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        emit(f"❌ [状态] 保存失败: {exc}")


def acc_of(state: Dict, key: str) -> Dict:
    return state.setdefault("accounts", {}).setdefault(key, {})


def today_set(acc: Dict, field: str) -> set:
    data = acc.get(field) or {}
    if data.get("date") != today_str():
        return set()
    return set(map(str, data.get("ids", [])))


def today_add(acc: Dict, field: str, value: str) -> None:
    data = acc.get(field) or {}
    ids = set(map(str, data.get("ids", []))) if data.get("date") == today_str() else set()
    ids.add(str(value))
    acc[field] = {"date": today_str(), "ids": list(ids)}


# ====================== 代理与请求 ======================

_proxy_lock = threading.Lock()
_used_proxies: set = set()


def req(method: str, url: str, max_retries: int = 6, **kwargs) -> requests.Response:
    """带代理与重试的请求。小蚕接口海外直连不通，没代理会直接失败。"""
    kwargs.setdefault("timeout", 12)
    last_error = None
    for attempt in range(max_retries):
        try:
            with requests.Session() as session:
                session.trust_env = False
                resp = session.request(method, url, proxies=PROXIES, **kwargs)
            if resp.status_code == 401:
                raise RuntimeError("CK失效")
            if resp.status_code == 403:
                last_error = RuntimeError("IP已被风控")
                time.sleep(0.2 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp
        except RuntimeError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt < max_retries - 1:
                time.sleep(0.2 * (attempt + 1))
    raise last_error if last_error else RuntimeError("请求失败")


def parse_error(err) -> str:
    text = str(err)
    for key in ("CK失效", "IP已被风控", "网络异常"):
        if key in text:
            return key
    if "timeout" in text.lower() or "超时" in text:
        return "网络超时"
    if "connection" in text.lower() or "连接" in text:
        return "连接失败"
    return f"请求异常: {text[:120]}"


# ====================== 设备与签名（协议部分照搬原实现） ======================

_dev_cache: Dict[str, Dict] = {}


def device_data(key) -> Dict:
    k = str(key) if key and str(key) != "0" else "global"
    with _headers_lock:
        if k in _dev_cache:
            return _dev_cache[k]
    brands = ["realme", "Xiaomi", "vivo", "OPPO", "HUAWEI", "HONOR", "Samsung"]
    b = random.choice(brands)
    if b == "realme":
        m = f"RMX{random.randint(3700, 3999)}"
    elif b == "Xiaomi":
        m = f"{random.choice(['24', '25', '26'])}{random.randint(0, 1)}{random.randint(1, 9)}{random.randint(10, 19)}C"
    elif b == "vivo":
        m = f"V{random.randint(2300, 2500)}A"
    elif b == "OPPO":
        m = f"P{random.choice(['G', 'H', 'J', 'K'])}{random.choice(['D', 'M', 'T'])}{random.randint(110, 130)}"
    elif b == "HUAWEI":
        m = f"{random.choice(['ALN', 'HBP', 'BRA'])}-{random.choice(['AL', 'AN'])}{random.randint(0, 9)}0"
    elif b == "HONOR":
        m = f"{random.choice(['PGT', 'BVL', 'MAA'])}-AN{random.randint(0, 2)}0"
    else:
        m = f"SM-S9{random.randint(1, 3)}{random.randint(1, 8)}0"
    v = str(random.randint(13, 15))
    bld = f"{random.choice(['S', 'T', 'U', 'V'])}P1A.{random.randint(230101, 251231)}.0{random.randint(10, 99)}"
    cv = f"{random.randint(135, 145)}.0.{random.randint(5000, 7500)}.{random.randint(50, 200)}"
    wx_ver = f"8.0.{random.randint(60, 66)}"
    ua = (f"Mozilla/5.0 (Linux; Android {v}; {m} Build/{bld}; wv) AppleWebKit/537.36 "
          f"(KHTML, like Gecko) Version/4.0 Chrome/{cv} Mobile Safari/537.36 "
          f"XWEB/{random.randint(6000, 9999)} MMWEBSDK/2025{random.randint(1, 12):02d}02 "
          f"MMWEBID/{random.randint(1000, 9999)} MicroMessenger/{wx_ver}.2600"
          f"(0x2800{random.randint(30, 35)}{random.randint(10, 99)}) WeChat/arm64 Weixin "
          f"NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android")
    info = {"ua": ua, "model": f"{m} {b}", "dm": b}
    with _headers_lock:
        _dev_cache[k] = info
    return info


def xc_headers(servername: str, methodname: str, teemo="0", vayne="0", sivir="",
               extra: Optional[Dict] = None, device_key=None, city_code="440304") -> Dict:
    ru = uuid.uuid4().hex
    teemo_str = str(teemo)
    suffix_len = max(0, 16 - 4 - len(teemo_str))
    x_nami = f"{ru[:4]}{teemo_str}{ru[4:4 + suffix_len]}"
    x_garen = str(int(time.time() * 1000))
    sig = hashlib.md5((hashlib.md5(f"{servername}.{methodname}".lower().encode()).hexdigest()
                       + x_garen + x_nami).encode()).hexdigest()
    dev = device_data(device_key or teemo)
    headers = {
        "Host": "gw.xiaocantech.com", "Connection": "keep-alive",
        "servername": servername, "methodname": methodname,
        "version": VERSION, "X-Version": VERSION,
        "X-Nami": x_nami, "X-Garen": x_garen, "X-Ashe": sig, "x-Annie": "XC",
        "X-Platform": "mini", "x-Teemo": teemo_str, "x-Vayne": vayne, "x-Sivir": sivir,
        "X-Model": dev["model"],
        "x-City": (extra or {}).get("x-City", city_code),
        "env": "", "appid": (extra or {}).get("appidNum", "20"),
        "content-type": "application/json", "charset": "utf-8",
        "Referer": f"https://servicewechat.com/{XC_APPID}/666/page-frame.html",
        "User-Agent": dev["ua"],
        "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if vayne != "0":
        headers["userid"] = vayne
    if extra:
        headers.update(extra)
    return headers


def anonymous_query(lat, lng, city_code, offset=0, number=20, device_key=None):
    """匿名查附近店铺活动（不需要登录态，只要坐标）"""
    # 注意：extra 是第 6 个位置参数，这里必须用关键字传，别把 dict 塞到 vayne 位上
    headers = xc_headers("SilkwormRec", "RecService.GetStorePromotionList", "0",
                         vayne="0", extra={"x-Vayne": "0", "x-City": str(city_code)},
                         device_key=device_key)
    payload = {"latitude": lat, "longitude": lng, "promotion_sort": 1, "store_type": 0,
               "offset": offset, "number": number, "silk_id": 0, "promotion_filter": 0,
               "promotion_category": 0, "city_code": int(city_code), "store_category": 0,
               "store_platform": 0, "app_id": 20}
    try:
        js = req("POST", RPC_URL, headers=headers, json=payload).json()
        if js.get("status", {}).get("code") == 0:
            return True, js.get("promotion_list", [])
        return False, js.get("status", {}).get("msg", "未知API错误")
    except Exception as exc:
        return False, parse_error(exc)


# ====================== 业务客户端（照原实现移植） ======================

class BaseApiClient:
    def __init__(self, cookie_str: str, city_code: str = "440304"):
        parts = str(cookie_str or "").split("#")
        if len(parts) < 3:
            raise ValueError("登录态不合法（应为 vayne#teemo#sivir）")
        self.vayne, self.teemo, self.sivir = parts[0], parts[1], parts[2]
        self.city_code = str(city_code)
        self.dev = device_data(self.teemo)
        self.lat = None
        self.lng = None

    def _headers(self, servername, methodname, extra=None):
        return xc_headers(servername, methodname, self.teemo, self.vayne, self.sivir,
                          extra, self.teemo, self.city_code)

    def call(self, servername: str, methodname: str, payload: Dict,
             extra_headers: Optional[Dict] = None) -> requests.Response:
        headers = self._headers(servername, methodname, extra_headers)
        last = None
        for i in range(6):
            try:
                r = req("POST", RPC_URL, headers=headers, json=payload)
                if r.status_code == 403:
                    last = RuntimeError("IP已被风控")
                    time.sleep(0.1 * (i + 1))
                    continue
                return r
            except RuntimeError:
                raise
            except Exception as exc:
                last = exc
                time.sleep(0.1 * (i + 1))
        raise last if last else RuntimeError("请求失败")


class Yuhua(BaseApiClient):
    """小蚕主要业务接口"""

    def get_silk(self, force: bool = False) -> Dict:
        payload = {"silk_id": int(self.teemo), "if_need_subscribe": True, "inviter_silk_id": 0,
                   "up": {"rcp": 1, "rc": 0, "dm": self.dev["dm"], "re_ch": ""}, "app_id": 20}
        js = self.call("Silkworm", "SilkwormService.GetClientUserInfo", payload).json()
        if js.get("status", {}).get("code") == 0 and "user_info" in js:
            return js["user_info"]
        raise RuntimeError(f"CK失效，服务器响应：{js.get('status', {}).get('msg', '未知')}")

    def sign_in(self) -> str:
        time.sleep(random.uniform(1.0, 3.0))
        try:
            resp = self.call("ActivityTask", "ActivityTaskMobileService.SignIn",
                             {"silk_id": int(self.teemo), "app_id": 20}).json()
            code = resp.get("status", {}).get("code")
            if code == 0:
                return f"会员签到: 获得{resp.get('point', 0)}"
            if code == 200001:
                return "会员签到: 触发风控"
            msg = str(resp.get("status", {}).get("msg") or "")
            if "重复" in msg or "限一次" in msg:
                return "会员签到: 今天已签"
            return f"会员签到: {msg}"
        except Exception as exc:
            return f"会员签到: {parse_error(exc)}"

    def task(self, t) -> str:
        time.sleep(random.uniform(3.0, 5.0))
        try:
            resp = self.call("SilkwormLottery", "SilkwormLotteryMobile.AddLotteryTimes",
                             {"silk_id": int(self.teemo), "type": t, "app_id": 20}).json()
            if resp["status"]["code"] == 0:
                return f"任务[{t}]完成, 抽奖次数+1"
            return f"任务[{t}]失败, {resp['status']['msg']}"
        except Exception as exc:
            return f"任务[{t}]异常: {parse_error(exc)}"

    def lottery(self) -> str:
        time.sleep(random.uniform(3.0, 6.0))
        try:
            rr = self.call("SilkwormLottery", "SilkwormLotteryMobile.Lottery",
                           {"silk_id": int(self.teemo), "prize_type": 1, "app_id": 20}).json()
            if rr["status"]["code"] == 0:
                return f"抽奖成功, 获得[{rr['prize']['name']}]"
            return f"抽奖状态: {rr['status']['msg']}"
        except Exception as exc:
            return f"抽奖异常: {parse_error(exc)}"

    def lottery_progress(self) -> Dict:
        """抽奖进度：{first_step_count, second_step_count, lottery_count, has_got_*_step_prize}"""
        js = self.call("SilkwormLottery", "SilkwormLotteryMobile.GetLotteryProgress",
                       {"silk_id": int(self.teemo), "app_id": 20}).json()
        return js.get("lottery_progress") or {}

    def receive_cumulative_reward(self) -> str:
        """
        累计抽奖奖励：按进度决定要不要领（第 1 档需 3 次抽奖、第 2 档需 9 次）。
        之前不看门槛硬领，第 2 档永远「未达到」；而且连发请求容易被限流打 500，
        这里只对可能领到的档位发请求，500 当作抖动重试两次。
        """
        try:
            progress = self.lottery_progress()
        except Exception as exc:
            return f"奖励状态: 查进度失败（{parse_error(exc)}）"
        total = int(progress.get("lottery_count") or 0)
        steps = ((1, int(progress.get("first_step_count") or 3), bool(progress.get("has_got_first_step_prize"))),
                 (2, int(progress.get("second_step_count") or 9), bool(progress.get("has_got_second_step_prize"))))
        logs = []
        for stp, need, got in steps:
            if str(stp) not in CUMULATIVE_STEPS:
                continue
            if got:
                logs.append(f"奖励状态: 奖励[{stp}]已领过")
                continue
            if total < need:
                logs.append(f"奖励状态: 奖励[{stp}]还差 {need - total} 次抽奖（需 {need} 次，今天 {total} 次）")
                continue
            for attempt in range(3):
                try:
                    resp = self.call("SilkwormLottery", "SilkwormLotteryMobile.ReceiveExtraLottery",
                                     {"silk_id": int(self.teemo), "step": stp, "app_id": 20}).json()
                    code = resp.get("status", {}).get("code")
                    if code == 0:
                        prize = (resp.get("prize") or {}).get("name") or "未知"
                        logs.append(f"奖励状态: ✅ 领取奖励[{stp}]成功, 获得[{prize}]")
                        break
                    msg = str(resp.get("status", {}).get("msg") or "")
                    if "已领" in msg or "不在领取范围" in msg:
                        logs.append(f"奖励状态: 奖励[{stp}]已领过")
                    else:
                        logs.append(f"奖励状态: 奖励[{stp}]失败: {msg}")
                    break
                except Exception as exc:
                    # 小蚕在连发请求后会返回 500，等一下再试（不要当成"领不到"）
                    if attempt < 2 and "500" in str(exc):
                        time.sleep(3)
                        continue
                    logs.append(f"奖励状态: 奖励[{stp}]接口异常（{parse_error(exc)}）")
                    break
        return "\n".join(logs)

    # ---------- 日常福利任务（任务中心 → 元宝） ----------
    TASK_SERVICE = "ActivityTask"
    TASK_PREFIX = "ActivityTaskMobileService."

    def ad_task(self, task_type: int, bus_type: int) -> str:
        """看广告类任务：sign = HMAC-SHA256(silk_id&timestamp&nonce&bus_type)"""
        time.sleep(random.uniform(3.0, 5.0))
        timestamp = int(time.time())
        nonce = "".join(random.choice(string.digits) for _ in range(6))
        sign_text = (f"silk_id={int(self.teemo)}&timestamp={timestamp}"
                     f"&nonce={nonce}&bus_type={int(bus_type)}")
        signature = hmac.new(b"lcjkbqadfrzsewxy", sign_text.encode(), hashlib.sha256).digest()
        payload = {"silk_id": int(self.teemo), "timestamp": timestamp, "nonce": nonce,
                   "bus_type": int(bus_type), "sign": b64encode(signature).decode(),
                   "task_type": task_type, "app_id": 20}
        try:
            resp = self.call("SilkwormLottery", "SilkwormLotteryMobile.OnAdViewed", payload).json()
            if resp["status"]["code"] == 0:
                return f"任务[{task_type}]完成, 抽奖次数+1"
            return f"任务[{task_type}]失败, {resp['status']['msg']}"
        except Exception as exc:
            return f"任务[{task_type}]异常: {parse_error(exc)}"

    def run_all(self) -> List[str]:
        logs = [self.sign_in()]                 # 会员签到（= 日常福利「每日签到」，只做这一次）
        for t in (2, 8, 9, 10, 11):             # 1 是签到，已由 sign_in 完成
            logs.append(self.task(t))
        logs.append(self.ad_task(6, 2))
        logs.append(self.ad_task(7, 4))
        for _ in range(20):                     # 有多少次抽多少次，风控/没次数就停
            ret = self.lottery()
            logs.append(ret)
            if "抽奖成功" not in ret:
                break
            time.sleep(random.uniform(2.0, 4.0))
        logs.append(self.receive_cumulative_reward())
        logs.append(self.daily_task_step())
        logs.append(self.yb_lottery_step())
        return [x for x in logs if x]            # 关掉的步骤返回空串，别留空行

    def daily_tasks(self) -> Dict:
        """拉日常福利任务列表（需要 user_id，不是 silk_id）"""
        payload = {"silk_id": int(self.teemo), "user_id": int(self.vayne), "app_id": 20}
        js = self.call(self.TASK_SERVICE, f"{self.TASK_PREFIX}GetDailyTask", payload).json()
        if js.get("status", {}).get("code") != 0:
            raise RuntimeError(js.get("status", {}).get("msg") or "拉日常任务失败")
        return js.get("data") or {}

    def complete_task(self, task_id) -> Tuple[int, str]:
        payload = {"silk_id": int(self.teemo), "task_id": int(task_id), "app_id": 20}
        try:
            js = self.call(self.TASK_SERVICE, f"{self.TASK_PREFIX}CompleteTask", payload).json()
            st = js.get("status") or {}
            return int(st.get("code") or 0), str(st.get("msg") or "")
        except Exception as exc:
            return -1, parse_error(exc)

    def yb_lottery_info(self, retries: int = 3) -> Dict:
        """抽奖活动信息（该接口有节流，返回空就等几秒再试）"""
        for _ in range(retries):
            js = self.call(self.TASK_SERVICE, f"{self.TASK_PREFIX}YbLotteryInfo",
                           {"silk_id": int(self.teemo), "app_id": 20}).json()
            info = js.get("lottery_info") or {}
            if info.get("activity_id"):
                return info
            time.sleep(5)
        return {}

    def yb_point(self) -> int:
        js = self.call(self.TASK_SERVICE, f"{self.TASK_PREFIX}UserTaskV2",
                       {"silk_id": int(self.teemo), "app_id": 20}).json()
        data = js.get("data") or js.get("content") or {}
        return int(data.get("yb_point") or 0)

    def yb_lottery_step(self) -> str:
        """
        元宝抽奖：花 cost 抽一次，「参与元宝抽奖」任务返 200 → 净零，奖品是白赚的。
        防亏：余额不够不抽；请求超时**不重试**（重试要再扣一次）。
        """
        if not YB_LOTTERY:
            return ""            # 关闭时不出日志
        info = self.yb_lottery_info()
        if not info:
            return "元宝抽奖: 拿不到活动信息（接口节流），跳过"
        cost = int(info.get("cost") or 200)
        balance = self.yb_point()
        if balance < cost:
            return f"元宝抽奖: 元宝不足（{balance} < {cost}/次），跳过"
        logs = []
        for i in range(YB_LOTTERY_TIMES):
            try:
                js = self.call(self.TASK_SERVICE, f"{self.TASK_PREFIX}YbLottery",
                               {"silk_id": int(self.teemo), "activity_id": info["activity_id"],
                                "box_id": info.get("box_id"), "app_id": 20}).json()
            except Exception as exc:
                logs.append(f"元宝抽奖: 请求超时（{parse_error(exc)}），结果未知，不重试（以余额为准）")
                break
            st = js.get("status") or {}
            if st.get("code") != 0:
                # 实测 20004「服务内部错误」并不会扣元宝，别吓唬人
                logs.append(f"元宝抽奖: 失败（{st.get('msg') or '无返回'}），未扣费")
                break
            prize = ""
            for key in ("prize", "prize_info", "items"):
                v = js.get(key)
                if isinstance(v, dict):
                    prize = str(v.get("name") or v.get("prize_name") or "")
                elif isinstance(v, list) and v and isinstance(v[0], dict):
                    prize = str(v[0].get("name") or v[0].get("prize_name") or "")
                if prize:
                    break
            logs.append(f"元宝抽奖: 抽到[{prize or '未知奖品'}]（花 {cost}）")
            # 抽完把「参与元宝抽奖」任务领掉，把 200 拿回来
            code, msg = self.complete_task(46)
            if code == 0:
                logs.append("元宝抽奖: ✅ 已领回任务奖励 200")
            elif "重复" in msg:
                logs.append("元宝抽奖: 任务奖励已领过")
            else:
                logs.append(f"元宝抽奖: 任务奖励未领到（{msg}）")
        return "\n".join(logs)

    def daily_task_step(self) -> str:
        """
        日常福利：自动完成能自动做的任务（默认只有「抖音电商浏览」），
        其余（下单/邀请/入群/关注/晒图/兑换）需要真实操作，只报告不尝试。
        """
        try:
            data = self.daily_tasks()
        except Exception as exc:
            return f"日常福利: 拉取失败 {parse_error(exc)}"
        tasks = data.get("list") or []
        auto = {}
        for t in tasks:
            done = t.get("completed") == 1            # 1=今天已完成，2=待做
            line = f"{t.get('title')}({t.get('point')})"
            if done:
                if str(t.get("id")) == "1":      # 每日签到 = 会员签到，避免重复一行
                    continue
                auto.setdefault("done", []).append(line)
            elif str(t.get("id")) in DAILY_TASK_IDS:
                auto.setdefault("todo", []).append(t)
            # 其余需要真实操作的任务（下单/邀请/入群/关注/晒图/兑换）不再逐条打印
        logs = []
        for t in auto.get("todo", []):
            code, msg = self.complete_task(t["id"])
            if code == 0:
                logs.append(f"日常福利: ✅ {t['title']} +{t['point']} 元宝")
            elif "重复" in msg:
                logs.append(f"日常福利: {t['title']} 已完成")
            else:
                logs.append(f"日常福利: {t['title']} 未完成（{msg}）")
        if auto.get("done"):
            logs.append("日常福利: 已完成 " + "、".join(auto["done"][:6]))
        return "\n".join(logs) if logs else "日常福利: 没有可做任务"

    def get_all_cards(self) -> str:
        time.sleep(random.uniform(1.0, 1.5))
        offset, total = 0, {}
        while True:
            try:
                r = self.call("SilkwormCard", "SilkwormCardService.GetUserCardList",
                              {"silk_id": int(self.teemo), "status": 0, "offset": offset,
                               "number": 10, "app_id": 20}).json()
                if r["status"]["code"] != 0:
                    return f"失败, {r['status']['msg']}"
                lst = r.get("list", [])
                if not lst:
                    break
                for item in lst:
                    name = item["card"]["name"]
                    total[name] = total.get(name, 0) + 1
                if len(lst) < 10:
                    break
                offset += 10
                time.sleep(random.uniform(1.0, 1.5))
            except Exception as exc:
                return f"异常, {parse_error(exc)}"
        return ", ".join(f"{k}x{v}" for k, v in total.items()) if total else "暂无"

    def get_all_redpacks(self) -> str:
        time.sleep(random.uniform(1.0, 1.5))
        page, results = 1, []
        while True:
            try:
                resp = self.call("RedPackService", "RedPackService.GetAppRedPackList",
                                 {"silk_id": int(self.teemo), "page": page, "page_size": 10, "app_id": 20})
                if not resp or resp.status_code != 200:
                    return "无"
                js = resp.json()
                if js["status"]["code"] != 0:
                    return "暂无"
                items = js.get("unused_items", [])
                if not items:
                    break
                for item in items:
                    if item.get("user_red_pack_status", 0) == 1:
                        results.append(f"{item.get('name', '未知封紅')}{to_yuan(item.get('value_num', 0)):.2f}")
                if len(items) < 10:
                    break
                page += 1
                time.sleep(random.uniform(1.0, 1.5))
            except Exception:
                return "暂无"
        return ", ".join(results) or "暂无"

    # ---------- 提现 ----------
    def withdraw(self, channel: int) -> Tuple[bool, str]:
        user = self.get_silk()
        money = to_yuan(user.get("silk", 0))
        if money < 1:
            return False, f"蚕豆不足（当前 {money:.2f} 元）"
        try:
            js = self.call("Silkworm", "SilkwormService.ClientWithdraw",
                           {"silk_id": int(self.teemo), "silk": int(money * 100),
                            "channel": channel, "app_id": 20}).json()
            if js["status"]["code"] == 0:
                return True, f"发起提现 {money:.2f} 元，请及时查验"
            return False, str(js["status"].get("msg"))
        except Exception as exc:
            return False, parse_error(exc)

    # ---------- 封紅雨 ----------
    def fetch_rain_events(self, city_code) -> Optional[List]:
        payload = {"silk_id": int(self.teemo), "city_code": int(city_code),
                   "date": today_str(), "app_id": 20}
        try:
            js = self.call("SilkwormLottery", "SilkwormLotteryMobile.GetRedPackRainEventsByDate",
                           payload, {"x-City": str(city_code)}).json()
            return js.get("events") if js.get("status", {}).get("code") == 0 else None
        except Exception:
            return None

    def join_rain(self, event_id, city_code) -> Tuple[bool, str, Optional[int]]:
        payload = {"silk_id": int(self.teemo), "city_code": int(city_code),
                   "event_id": event_id, "app_id": 20}
        try:
            js = self.call("SilkwormLottery", "SilkwormLotteryMobile.JoinRedPackRainEvent",
                           payload, {"x-City": str(city_code)}).json()
            code = js["status"]["code"]
            if code == 0:
                if js.get("success", False):
                    return True, "报名成功", None
                return False, js.get("failed_reason", "报名失败"), None
            if code == 200001:
                return False, js["status"].get("msg", "风控验证"), js.get("verify_method", 0)
            return False, js["status"].get("msg", "未知错误"), None
        except Exception as exc:
            return False, parse_error(exc), None

    def grab_rain(self, event_id, city_code) -> Tuple[bool, str]:
        payload = {"silk_id": int(self.teemo), "event_id": event_id, "click_num": 18, "app_id": 20}
        try:
            resp = self.call("SilkwormLottery", "SilkwormLotteryMobile.RedPackRainGrabNum",
                             payload, {"x-City": str(city_code)}).json()
            if resp["status"]["code"] != 0:
                return False, resp["status"].get("msg", "抽奖失败未知原因")
            items = resp.get("items", [])
            if not items:
                return False, "无封紅信息"
            it = items[0]
            return True, f"抽奖成功, 获得[{it.get('name', '未知封紅')}{to_yuan(it.get('prize_value', 0)):.2f}]"
        except Exception as exc:
            return False, f"异常:{parse_error(exc)}"


class XcClient(BaseApiClient):
    """抢单相关"""

    def get_promotion_order_list(self, offset=0, number=20, order_status=0):
        time.sleep(random.uniform(1.0, 2.0))
        try:
            js = self.call("Silkworm", "SilkwormService.GetPromotionOrderList",
                           {"silk_id": int(self.teemo), "order_status": order_status,
                            "offset": offset, "number": number, "app_id": 20}).json()
            if js.get("status", {}).get("code") != 0:
                return False, js.get("status", {}).get("msg", "未知错误"), []
            return True, "ok", js.get("order_list", [])
        except Exception as exc:
            return False, parse_error(exc), []

    def grab_promotion(self, pid, pf, city_code, lat, lng) -> Tuple[bool, str]:
        time.sleep(random.uniform(0.1, 0.3))
        if not lat or not lng:
            return False, "坐标无效"
        payload = {"silk_id": int(self.teemo), "promotion_id": pid, "store_platform": pf,
                   "if_advance_order": False, "if_pre_order": False,
                   "latitude": float(lat), "longitude": float(lng),
                   "city_code": int(city_code), "app_id": 20}
        try:
            js = self.call("Silkworm", "SilkwormService.GrabPromotionQuota", payload,
                           {"x-City": str(city_code)}).json()
            if js["status"]["code"] == 0:
                return True, "抢单成功"
            return False, js["status"].get("msg", "未知错误")
        except Exception as exc:
            return False, parse_error(exc)

    def cancel_order(self, promotion_order_id) -> Tuple[bool, str]:
        time.sleep(random.uniform(1.0, 2.0))
        try:
            js = self.call("Silkworm", "SilkwormService.CancelPromotionQuota",
                           {"silk_id": int(self.teemo),
                            "promotion_order_id": promotion_order_id, "app_id": 20}).json()
            if js.get("status", {}).get("code", -1) == 0:
                return True, "订单取消成功"
            return False, js.get("status", {}).get("msg", "取消失败")
        except Exception as exc:
            return False, parse_error(exc)


# ====================== 抢单相关的计算 ======================

def platform_of(promo) -> int:
    if promo.get("tp_promotion", {}).get("tp_status", 0) == 1:
        return 3
    if promo.get("meituan_status", 0) == 1:
        return 1
    if promo.get("eleme_status", 0) == 1 or promo.get("meituan_status", 0) == 0:
        return 2
    return 0


PLATFORM_NAME = {1: "美团", 2: "淘宝闪购", 3: "京东"}


def promo_data(p):
    pf = platform_of(p)
    if pf == 1:
        return pf, p.get("meituan_left_number", 0), p.get("meituan_order_money", 0), p.get("meituan_user_rebate", 0)
    if pf == 2:
        return pf, p.get("eleme_left_number", 0), p.get("eleme_order_money", 0), p.get("eleme_user_rebate", 0)
    tp = p.get("tp_promotion", {})
    return pf, tp.get("tp_left_number", 0), tp.get("tp_order_money", 0), tp.get("tp_user_rebate", 0)


def format_promotions(promotions, reduce_left=False) -> str:
    if not promotions:
        return "未发现任何活动"
    grouped = {}
    for item in promotions:
        pf, left, money, rebate = promo_data(item)
        sid = item["store"]["store_id"]
        key = (sid, pf)
        if key not in grouped:
            grouped[key] = {"store_id": sid, "store_name": item["store"].get("name", ""),
                            "platform": PLATFORM_NAME.get(pf, "未知"),
                            "distance": item.get("distance", 0), "promotions": []}
        grouped[key]["promotions"].append((item, left, money, rebate))
    lines = []
    for (_, _pf), info in grouped.items():
        lines += [f"店铺标识:  {info['store_id']}", f"店铺名称:  {info['store_name']}",
                  f"店铺平台:  {info['platform']}",
                  f"店铺距离:  {round(info['distance'] / 1000, 1)}km"]
        for pm, left, money, rebate in info["promotions"]:
            cond = "无需评价" if pm.get("rebate_condition", 0) == 99 else (
                "用餐反馈" if pm.get("rebate_condition", 0) == 2 else "")
            if reduce_left and left > 0:
                left -= 1
            money_str = (f"满{money // 100}返{rebate // 100}" if money > 0
                         else f"每单返{rebate // 100}")
            lines += [f"活动标识:  {pm.get('promotion_id', '未知')}",
                      f"抢单时间:  {pm['start_time_hour']:02d}:{pm['start_time_minute']:02d}"
                      f"-{pm['end_time_hour']:02d}:{pm['end_time_minute']:02d}",
                      f"返现要求:  {money_str} {cond}".strip(),
                      f"剩余名额:  {left}"]
        lines.append("")
    return "\n".join(lines).strip()


def best_promotion(promotions):
    """挑「净返利最高、其次无需评价、再其次返得多」的那个"""
    now_val = china_now().hour * 60 + china_now().minute
    candidates = []
    for p in promotions:
        pf, left, money, rebate = promo_data(p)
        start = p["start_time_hour"] * 60 + p["start_time_minute"]
        end = p["end_time_hour"] * 60 + p["end_time_minute"]
        if left <= 0 or not (start <= now_val <= end):
            continue
        candidates.append({"promo": p, "left": left,
                           "cond": 1 if p.get("rebate_condition", 0) == 99 else 0,
                           "rebate": rebate, "money": money, "net": rebate - money})
    if not candidates:
        return None
    candidates.sort(key=lambda x: (-x["net"], -x["cond"], -x["rebate"], x["money"], -x["left"]))
    return candidates[0]["promo"]


# ====================== 登录：yyb 取 code → 小蚕换登录态 ======================

def gateway_post(path: str, payload: Dict) -> Dict:
    endpoint = YYB_SERVER.strip().split("@")[0].strip().rstrip("/")
    if not endpoint.startswith(("http://", "https://")):
        endpoint = "http://" + endpoint
    with requests.Session() as session:
        session.trust_env = False
        resp = session.post(endpoint + path, json=payload, timeout=GATEWAY_TIMEOUT)
    body = resp.json()
    if resp.status_code >= 400:
        raise RuntimeError(body.get("msg") or body.get("message") or f"HTTP {resp.status_code}")
    return body


def get_code_via_gateway(ref: str) -> Optional[str]:
    emit(f"🔐 [登录] 经网关取小蚕 code（ref={ref}，appid={XC_APPID}）")
    try:
        body = gateway_post("/wxapp/getCode", {"ref": ref, "app_id": XC_APPID})
        data = body.get("data") or {}
        result = data.get("result") if isinstance(data.get("result"), dict) else {}
        code = result.get("code") or data.get("code")
        if code:
            emit("✅ [登录] code 拿到")
            return str(code)
        emit(f"❌ [登录] 网关没返回 code: {json.dumps(body, ensure_ascii=False)[:200]}")
    except Exception as exc:
        emit(f"❌ [登录] 取 code 异常: {exc}")
    return None


def app_login(wx_code: str, device_key=None) -> Tuple[Optional[str], Optional[str]]:
    """
    code → user_id + access_token。

    方法名以反编译的小程序为准：api/core 里 server="mp" 映射到 WechatOpenapi +
    前缀 WechatOpenapiService.，登录方法叫 **MiniLogin**（不是 AppLogin——
    那个是别的端在用的，小蚕这边会直接 403/WAF 拦）。
    """
    headers = xc_headers("WechatOpenapi", "WechatOpenapiService.MiniLogin", "0",
                         extra={"appid": "20", "appidNum": "20"}, device_key=device_key)
    headers["X-App-Sr"] = "20"
    headers["X-Session-Id"] = ""
    last = ""
    for _ in range(3):
        try:
            r = req("POST", RPC_URL, headers=headers, json={"code": wx_code, "app_id": 20})
            js = r.json()
            if js.get("status", {}).get("code") == 0:
                ui = js.get("user_info") or {}
                token = ui.get("token") or {}
                access = token.get("access_token") or ui.get("access_token") or js.get("access_token")
                user_id = ui.get("user_id") or js.get("user_id")
                if user_id and access:
                    return str(user_id), str(access)
                # 结构变了也别静默失败：把字段名打出来
                last = f"响应里没有 user_id/access_token，字段={list(ui.keys())} 顶层={list(js.keys())}"
                emit(f"⚠️ [登录] {last}")
                return None, None
            last = str(js.get("status", {}).get("msg") or js)[:200]
        except Exception as exc:
            last = parse_error(exc)
        time.sleep(0.8)
    emit(f"❌ [登录] MiniLogin 失败: {last}")
    return None, None


def user_info_by_scan(vayne: str, sivir: str, device_key=None) -> Tuple[Optional[str], Optional[str]]:
    """user_id + token → silk_id + 昵称"""
    headers = xc_headers("Silkworm", "SilkwormService.GetClientUserInfo",
                         extra={"userid": vayne, "x-Vayne": vayne, "appidNum": "16", "x-Sivir": sivir},
                         device_key=device_key)
    payload = {"user_id": int(vayne), "inviter_silk_id": 0,
               "up": {"rcp": 1, "rc": 0}, "app_id": 16}
    try:
        js = req("POST", RPC_URL, headers=headers, json=payload, timeout=12).json()
        if js.get("status", {}).get("code") == 0:
            ui = js["user_info"]
            return str(ui["silk_id"]), ui.get("nickname", "")
    except Exception:
        pass
    return None, None


def login_by_yyb(ref: str, device_key=None) -> Optional[Tuple[str, str]]:
    """返回 (cookie, 昵称)"""
    code = get_code_via_gateway(ref)
    if not code:
        return None
    vayne, sivir = app_login(code, device_key)
    if not vayne:
        emit("❌ [登录] AppLogin 失败（code 可能已过期/被用过）")
        return None
    teemo, nickname = user_info_by_scan(vayne, sivir, device_key)
    if not teemo:
        emit("❌ [登录] 取 silk_id 失败")
        return None
    emit(f"✅ [登录] 成功：{nickname or vayne}（silk_id={mask(teemo)}）")
    return f"{vayne}#{teemo}#{sivir}", nickname or str(vayne)


# ====================== 账号装配 ======================

def tag_allows(acc: Dict) -> bool:
    if not TAG_FILTER:
        return True
    tags = [t.strip().lower() for t in str(acc.get("scripts") or "").replace("，", ",").split(",") if t.strip()]
    if not tags:
        return DEFAULT_ON          # 本脚本默认关：标记为空 = 不跑
    return TAG_KEY in tags


def gateway_accounts() -> List[Dict]:
    endpoint = YYB_SERVER.strip().split("@")[0].strip().rstrip("/")
    if not endpoint:
        return []
    if not endpoint.startswith(("http://", "https://")):
        endpoint = "http://" + endpoint
    try:
        with requests.Session() as session:
            session.trust_env = False
            body = session.get(endpoint + "/accounts", timeout=20).json()
        data = body.get("data")
        return data if isinstance(data, list) else []
    except Exception as exc:
        emit(f"⚠️ [网关] 拉取账号失败: {exc}")
        return []


def build_accounts(state: Dict) -> List[Dict]:
    """
    账号来源：① xc_cookie 手工填的；② yyb 网关里「勾选了本脚本」的账号（自动扫码登录）
    登录态缓存在状态文件里，失效会自动重新登一次。
    """
    accounts: List[Dict] = []
    seen_keys = set()

    # ① 手工 cookie
    for line in str(MANUAL_COOKIES).replace("\r", "").split("\n"):
        cookie = line.strip()
        if not cookie or cookie.count("#") < 2:
            continue
        key = "manual:" + cookie.split("#")[1]
        seen_keys.add(key)
        accounts.append({"key": key, "cookie": cookie, "remark": "手工登录态"})

    # ② yyb 网关 + 账号标记（默认关）
    server_line = YYB_SERVER.strip()
    # 地址@1,3,5 → 只跑这几个 ref；地址（不带 @）→ 拉全部账号再按脚本标记过滤
    explicit_refs = set()
    if "@" in server_line:
        explicit_refs = {x.strip() for x in server_line.split("@", 1)[1].replace("，", ",").split(",") if x.strip()}
    if server_line:
        for acc in gateway_accounts():
            ref = str(acc.get("id"))
            if explicit_refs and ref not in explicit_refs:
                continue
            if not explicit_refs and not tag_allows(acc):
                emit(f"⏭️ [网关] 跳过 #{ref} {acc.get('nickname') or ''}："
                      f"脚本标记 [{str(acc.get('scripts') or '').strip() or '空'}] 未勾选本脚本 [{TAG_KEY}]")
                continue
            stored = state["accounts"].get(f"yyb:{ref}") or {}
            remark = acc.get("nickname") or acc.get("alias") or f"#{ref}"
            accounts.append({
                "key": f"yyb:{ref}", "ref": ref, "remark": remark,
                "cookie": stored.get("cookie"), "city_code": stored.get("city_code"),
                "lat": stored.get("lat"), "lng": stored.get("lng"),
            })
            seen_keys.add(f"yyb:{ref}")

    # 补上状态文件里留着、但这次没列出来的账号（手工删了 cookie 之后还能靠缓存跑）
    return accounts


def ensure_cookie(acc: Dict, state: Dict) -> Optional[str]:
    """拿到可用登录态：缓存优先 → yyb 登录 → 失败返回 None"""
    key = acc["key"]
    stored = state["accounts"].get(key) or {}
    cookie = acc.get("cookie") or stored.get("cookie")

    if cookie:
        # 校验一下缓存是否还有效（顺带把 silk 信息带回来）
        try:
            info = Yuhua(cookie, city_code=str(stored.get("city_code") or 440304)).get_silk()
            acc["info"] = info
            return cookie
        except Exception as exc:
            emit(f"⚠️ [{acc['remark']}] 缓存登录态失效（{parse_error(exc)}），尝试重新登录")

    ref = acc.get("ref")
    if not ref:
        emit(f"❌ [{acc['remark']}] 没有可用的登录态，也没有 yyb 账号可重新登录")
        return None

    result = login_by_yyb(ref, device_key=key)
    if not result:
        return None
    cookie, nickname = result
    with _state_lock:
        entry = acc_of(state, key)
        entry["cookie"] = cookie
        entry.setdefault("remark", nickname)
        entry["updated_at"] = now_text()
        save_state(state)
    acc["cookie"] = cookie
    acc["remark"] = nickname or acc["remark"]
    return cookie


# ====================== 各模式 ======================

def load_accounts_or_exit(state: Dict) -> List[Dict]:
    accounts = build_accounts(state)
    if not accounts:
        emit("❌ 没有需要执行的账号：")
        emit("   · 本脚本默认关，请在面板「应用宝账号」页把「小蚕霸王餐」勾上（或用 xc_cookie 填登录态）")
        emit("   · 只想临时跑可以先设 xc_default_on=1")
        return []
    return accounts


def mode_run(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        cookie = ensure_cookie(acc, state)
        if not cookie:
            return False, f"{acc['remark']}：登录态不可用"
        entry = state["accounts"].get(acc["key"]) or {}
        api = Yuhua(cookie, city_code=str(entry.get("city_code") or 440304))
        api.get_silk()
        logs = api.run_all()
        for line in logs:                       # 可能含多行结果，逐行加缩进
            for sub in str(line).split("\n"):
                emit("   " + sub)
        done = [l for l in logs if any(k in l for k in ("完成", "成功", "限一次", "已经领取"))]
        return (len(done) >= 3), f"{acc['remark']}：{len(done)} 项完成"

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


def mode_check(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        key = acc["key"]
        cookie = (state["accounts"].get(key) or {}).get("cookie") or acc.get("cookie")
        if not cookie:
            return False, f"{acc['remark']}：无登录态"
        try:
            info = Yuhua(cookie).get_silk()
        except Exception as exc:
            reason = parse_error(exc)
            emit("   " + reason)
            if reason == "CK失效":
                with _state_lock:
                    acc_of(state, key).pop("cookie", None)
                    save_state(state)
            return False, f"{acc['remark']}：{reason}"
        silk = to_yuan(info.get("silk", 0))
        emit(f"   蚕豆 {silk:.2f}")
        return True, f"{acc['remark']}：正常，蚕豆 {silk:.2f}"

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


def _rain_event(state: Dict) -> Optional[Dict]:
    """当前/下一场封紅雨（缓存当天场次）"""
    cached = state.get("hb_event") or {}
    if cached.get("date") != today_str():
        events = None
        for acc in state["accounts"].values():
            if acc.get("cookie"):
                try:
                    events = Yuhua(acc["cookie"]).fetch_rain_events(acc.get("city_code") or 440304)
                except Exception:
                    events = None
                if events:
                    break
        if not events:
            return None
        cached = {"date": today_str(), "events": events}
        state["hb_event"] = cached
        save_state(state)
    now_ts = china_now().timestamp()
    events = cached.get("events") or []
    ongoing = next((e for e in events if e.get("time", 0) <= now_ts <= e.get("end_time", 0)), None)
    future = [e for e in events if e.get("time", 0) > now_ts]
    return ongoing or (min(future, key=lambda x: x.get("time")) if future else None)


def mode_rain(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    event = _rain_event(state)
    if not event:
        return 0, len(accounts), ["❌ 没取到封紅雨场次（登录态可能都失效了）"]
    start_ts = event.get("time", 0)
    now_ts = china_now().timestamp()
    if abs(start_ts - now_ts) > 600:
        when = datetime.fromtimestamp(start_ts, CHINA_TZ).strftime("%H:%M:%S")
        return 0, len(accounts), [f"⏭️ 不在场次前后 10 分钟内，跳过（本场开抢时间 {when}）"]
    emit(f"🎯 本场开抢时间 {datetime.fromtimestamp(start_ts, CHINA_TZ):%H:%M:%S}，"
         f"账号同时报名、准点瓜分")

    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        cookie = ensure_cookie(acc, state)
        if not cookie:
            return False, f"{acc['remark']}：无登录态"
        city = (state["accounts"].get(acc["key"]) or {}).get("city_code") or 440304
        api = Yuhua(cookie, city_code=str(city))
        api.get_silk()
        wait = start_ts - 0.9 - china_now().timestamp()
        if wait > 0:
            time.sleep(wait)
        joined, msg, verify = api.join_rain(event.get("event_id"), city)
        if not joined:
            hint = "（需风控验证，青龙里做不了，去小程序手动瓜分一场即可解除）" if verify else ""
            return False, f"{acc['remark']}：报名失败 {msg}{hint}"
        wait = start_ts + 0.1 - china_now().timestamp()
        if wait > 0:
            time.sleep(wait)
        time.sleep(random.uniform(0.01, 0.05))
        good, msg2 = api.grab_rain(event.get("event_id"), city)
        return good, f"{acc['remark']}：{msg2}"

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


def monitor_stores_from_env() -> Dict[int, List[str]]:
    raw = os.getenv("xc_monitor_stores") or ""
    result: Dict[int, List[str]] = {1: [], 2: [], 3: []}
    name_map = {"mt": 1, "meituan": 1, "美团": 1, "elm": 2, "ele": 2, "eleme": 2, "淘宝闪购": 2,
                "jd": 3, "京东": 3}
    for item in re.split(r"[,\n，;；]+", raw):
        item = item.strip()
        if not item:
            continue
        if ":" in item:
            pf_raw, sid = item.split(":", 1)
            pf = name_map.get(pf_raw.strip().lower())
            if pf and sid.strip().isdigit():
                result[pf].append(sid.strip())
    return result


def mode_monitor(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    """监控抢单：按位置拉附近活动 → 命中店铺清单就抢（需要 xc_monitor_stores + 定位）"""
    stores = monitor_stores_from_env()
    if not any(stores.values()):
        return 0, 0, ["⏭️ 未配置 xc_monitor_stores（如 mt:123456,elm:234567），监控抢单跳过"]
    wanted = sum(len(ids) for ids in stores.values())
    emit(f"🎯 监控 {wanted} 个店铺（" +
         "、".join(f"{PLATFORM_NAME[pf]}{len(ids)}个" for pf, ids in stores.items() if ids) + "）")

    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        entry = state["accounts"].get(acc["key"]) or {}
        cookie = entry.get("cookie") or acc.get("cookie")
        if not cookie:
            return False, f"{acc['remark']}：无登录态"
        lat = float(os.getenv("xc_lat") or entry.get("lat") or 22.5455)
        lng = float(os.getenv("xc_lng") or entry.get("lng") or 114.0545)
        city = int(os.getenv("xc_city") or entry.get("city_code") or 440304)
        api = XcClient(cookie, city_code=str(city))
        api.get_silk()

        promos, offset = [], 0
        while True:
            good, batch = anonymous_query(lat, lng, city, offset, 20, device_key=acc["key"])
            if not good or not batch:
                break
            promos.extend(batch)
            if len(batch) < 20:
                break
            offset += 20
            time.sleep(random.uniform(0.5, 1.0))
        emit(f"   附近活动 {len(promos)} 条（{lat},{lng} 城市 {city}）")
        if not promos:
            return False, f"{acc['remark']}：附近没有活动"

        hit, missed = [], []
        for pf, ids in stores.items():
            for sid in ids:
                if sid in today_set(entry, "grabbed"):
                    missed.append(f"{sid}(今日已抢)")
                    continue
                candidates = [x for x in promos
                              if str(x["store"]["store_id"]) == sid and platform_of(x) == pf]
                if not candidates:
                    missed.append(f"{sid}(不在附近)")
                    continue
                best = best_promotion(candidates)
                if not best:
                    missed.append(f"{sid}(无可用活动)")
                    continue
                good, msg = api.grab_promotion(best["promotion_id"], pf, city, lat, lng)
                if good:
                    hit.append(best["store"]["name"])
                    with _state_lock:
                        today_add(entry, "grabbed", sid)
                        save_state(state)
                else:
                    missed.append(f"{best['store']['name']}({msg})")
                    if "超过店铺限制" in msg:
                        with _state_lock:
                            today_add(entry, "overlimit", sid)
                            save_state(state)
        if missed:
            emit("   未抢到：" + "、".join(missed[:6]))
        if not hit:
            return False, f"{acc['remark']}：0 个店铺抢到"
        return True, f"{acc['remark']}：抢到 {len(hit)} 个（" + "、".join(hit) + "）"

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


def mode_list(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        cookie = ensure_cookie(acc, state)
        if not cookie:
            return False, f"{acc['remark']}：无登录态"
        api = Yuhua(cookie)
        info = api.get_silk(force=True)
        register_ts = info.get("register_time", 0)
        join_days = ((china_now().replace(tzinfo=None) - datetime.fromtimestamp(register_ts)).days
                     if register_ts else 0)
        cards = api.get_all_cards()
        emit(f"   累计已返 {to_yuan(info.get('withdraw_total', 0)):.2f} 元 / "
             f"加入 {join_days} 天 / 完成 {info.get('completed_number', 0)} 单")
        emit(f"   蚕豆 {to_yuan(info.get('silk', 0)):.2f} / 卡券 {cards}")
        return True, (f"{acc['remark']}：蚕豆 {to_yuan(info.get('silk', 0)):.2f}"
                      f"（累计已返 {to_yuan(info.get('withdraw_total', 0)):.2f} 元）")

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


def mode_withdraw(state: Dict, accounts: List[Dict]) -> Tuple[int, int, List[str]]:
    channel = 1 if (os.getenv("xc_withdraw_channel") or "wx").lower() in ("zfb", "2", "支付宝") else 0
    emit(f"💸 提现渠道：{'支付宝' if channel == 1 else '微信'}")

    def work(i: int, acc: Dict) -> Tuple[bool, str]:
        cookie = ensure_cookie(acc, state)
        if not cookie:
            return False, f"{acc['remark']}：无登录态"
        good, msg = Yuhua(cookie).withdraw(channel)
        return good, f"{acc['remark']}：{msg}"

    results = run_accounts(accounts, work)
    ok = sum(1 for good, _ in results if good)
    return ok, len(results) - ok, [("✅ " if g else "❌ ") + line for g, line in results]


# ====================== 作者服务端校验（海外访问不通 → 探测不通就放行） ======================

def author_service_ok() -> bool:
    if (os.getenv("xc_skip_author_check") or "0") == "1":
        return True
    try:
        with requests.Session() as session:
            session.trust_env = False
            # 301 → /shouquan/ 由 requests 自动跟随；编码必须显式按 UTF-8 读，
            # 否则服务端没声明 charset 时会按 ISO-8859-1 解成乱码，中文匹配必然失败
            resp = session.get("https://yuhualhh.250666.xyz/shouquan",
                               headers={"User-Agent": "Mozilla/5.0"},
                               proxies=PROXIES, timeout=(5, 10), allow_redirects=True)
            resp.encoding = "utf-8"
        text = resp.text or ""
        if "服务正常中" in text:
            emit("ℹ️ [作者服务] 状态正常")
            return True
        # 能打开页面但没有「服务正常中」→ 作者那边主动停了
        if resp.status_code == 200:
            emit("❌ [作者服务] 页面提示服务异常，按作者状态停止运行")
            return False
    except Exception as exc:
        emit(f"ℹ️ [作者服务] 校验页访问不了（{str(exc)[:60]}），海外环境下按放行处理")
        return True
    return True


# ====================== 推送 ======================

def notify(title: str, content: str) -> None:
    if QYWX_TOKEN:
        try:
            key = QYWX_TOKEN.split("key=")[-1].strip()
            text = f"{title}\n{content}"
            if len(text.encode("utf-8")) > 2000:
                text = text.encode("utf-8")[:2000].decode("utf-8", "ignore")
            payload = json.dumps({"msgtype": "text", "text": {"content": text}}).encode()
            r = requests.post("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + key,
                              data=payload, headers={"Content-Type": "application/json"}, timeout=10)
            emit(f"[企业微信] 推送 {r.json().get('errcode')}")
        except Exception as exc:
            emit(f"[企业微信] 推送异常: {exc}")
    if PLUSPLUS_TOKEN:
        try:
            requests.post("https://www.pushplus.plus/send",
                          json={"token": PLUSPLUS_TOKEN, "title": title, "content": content,
                                "template": "txt"}, timeout=10)
            emit("[PushPlus] 推送成功")
        except Exception as exc:
            emit(f"[PushPlus] 推送异常: {exc}")
    for extra in ("/ql/data/scripts", "/ql/scripts"):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    try:
        from notify import send  # type: ignore
        send(title, content)
    except Exception:
        pass


MODES = {
    "run": ("日常任务", mode_run),
    "check": ("检测登录态", mode_check),
    "rain": ("瓜分封紅雨", mode_rain),
    "monitor": ("监控抢单", mode_monitor),
    "list": ("查询账号", mode_list),
    "withdraw": ("提现", mode_withdraw),
}


def main() -> int:
    mode = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("xc_mode") or "run").strip().lower()
    if mode not in MODES:
        emit(f"❌ 未知模式 '{mode}'，可用：{', '.join(MODES)}")
        return 1
    mode_name, handler = MODES[mode]

    emit("=" * 52)
    emit(f"🐛 {APP_NAME} · {mode_name}")
    emit(f"🕒 {now_text()}")
    if PROXIES:
        emit(f"🔌 代理 {PROXY_URL.split('@')[-1]}")
    else:
        emit("⚠️ 未配置 xc_proxy/ppcs_proxy/sf_proxy：小蚕接口海外直连不通，很可能整轮失败")
    emit("=" * 52)

    if not author_service_ok():
        notify(f"🐛 {APP_NAME} 已停止", "作者服务端提示服务异常，本轮未执行")
        return 1

    state = load_state()
    accounts = load_accounts_or_exit(state)
    if not accounts:
        return 1

    emit(f"📱 本次处理 {len(accounts)} 个账号")
    try:
        ok, fail, details = handler(state, accounts)
    finally:
        with _state_lock:
            save_state(state)

    emit("\n" + "-" * 52)
    for line in details:
        emit(line)
    emit("-" * 52)
    emit(f"🏁 {mode_name}：成功 {ok} / 失败 {fail}")

    notified = "\n".join(details[:20])
    notify(f"🐛 {APP_NAME} {mode_name}（{ok}成功/{fail}失败）", notified or "无详情")
    return 0 if (ok or fail == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
