#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探测：小蚕 task 服务（元宝相关接口）—— 用完即删"""
import json
import sys

sys.path.insert(0, "/ql/data/repo/Aaazlj_script_master")
import xcbwc_code as xc  # noqa: E402


def out(*a):
    print(*a, flush=True)


state = xc.load_state()
accounts = xc.build_accounts(state)
if not accounts:
    sys.exit("没有账号")
acc = accounts[0]
cookie = xc.ensure_cookie(acc, state)
if not cookie:
    sys.exit("登录态不可用")

api = xc.Yuhua(cookie, city_code=str((state["accounts"].get(acc["key"]) or {}).get("city_code") or 440304))
info = api.get_silk()
out(f"账号 {acc['remark']} 登录成功，蚕豆 {xc.to_yuan(info.get('silk', 0))}")
out("完成单数", info.get("completed_number"), "| 注册", info.get("register_time"))


def call(service, method, extra=None):
    body = {"silk_id": int(api.teemo), "app_id": 20}
    body.update(extra or {})
    try:
        r = api.call(service, method, body)
        js = r.json() if r.status_code == 200 else {}
        st = js.get("status") or {}
        return st.get("code"), st.get("msg"), js
    except Exception as exc:
        return "ERR", xc.parse_error(exc), {}


SERVICE, PREFIX = "ActivityTask", "ActivityTaskMobileService."
USER_ID = int(api.vayne)          # 网关登录返回的 user_id
out(f"\n== 探测（service={SERVICE}, user_id={USER_ID}, silk_id={api.teemo}）==")


def raw_call(method, payload):
    """单次请求，不重试，避免探测被卡住"""
    body = {"silk_id": int(api.teemo), "app_id": 20}
    body.update(payload or {})
    try:
        headers = api._headers(SERVICE, f"{PREFIX}{method}")
        r = xc.req("POST", xc.RPC_URL, headers=headers, json=body, max_retries=1)
        return r.json()
    except Exception as exc:
        return {"_error": xc.parse_error(exc)}


js = raw_call("GetDailyTask", {"user_id": USER_ID})
data = js.get("data") or {}
out(f"\n== 日常福利：{data.get('title')} / {data.get('sub_title')} ==")
rows = data.get("list") or []
out(f"共 {len(rows)} 个任务")
out(f"{'id':>4} {'元宝':>6} {'状态':>4} {'上限':>4} {'动作':>4}  标题")
for t in rows:
    out(f"{t.get('id'):>4} {t.get('point'):>6} {str(t.get('completed')):>4} {str(t.get('limit_num')):>4} "
        f"{str(t.get('action_type')):>4}  {t.get('title')}｜{t.get('sub_title')}｜btn={t.get('btn_text')}")
