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


out("\n== 1) 找 task 服务的命名 ==")
prefix, service = None, "SilkwormTask"
for p in ("SilkwormTaskMobile", "TaskService", "SilkwormTaskService", "SilkwormTask"):
    code, msg, js = call("SilkwormTask", f"{p}.GetDailyTask")
    out(f"   SilkwormTask/{p} → code={code} msg={str(msg)[:70]}")
    if code == 0:
        prefix = p
        out("   ↳ 命中：" + json.dumps(js, ensure_ascii=False)[:600])
        break
if not prefix:
    for svc in ("SilkwormTaskCenter", "SilkwormTaskServer"):
        code, msg, js = call(svc, "TaskService.GetDailyTask")
        out(f"   {svc}/TaskService → code={code} msg={str(msg)[:70]}")
        if code == 0:
            prefix, service = "TaskService", svc
            out("   ↳ 命中：" + json.dumps(js, ensure_ascii=False)[:600])
            break
if not prefix:
    sys.exit("没找到 task 服务命名")

out(f"\n== 2) 元宝相关接口（service={service}, prefix={prefix}）==")
for m in ("WaitClaimedPoints", "GetUnReceivedPointRecords", "YbLotteryInfo", "CollectPoints",
          "GetPointTaskAwardProgress", "UserTaskV2"):
    code, msg, js = call(service, f"{prefix}.{m}")
    body = js.get("content") if "content" in js else js.get("data")
    out(f"\n--- {m} → code={code} msg={str(msg)[:70]}")
    out("    " + (json.dumps(body, ensure_ascii=False)[:700] if body is not None else "(无 content)"))
