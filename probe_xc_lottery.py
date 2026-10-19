#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探测：小蚕元宝抽奖（YbLottery）—— 验完即删"""
import json
import sys

sys.path.insert(0, "/ql/data/repo/Aaazlj_script_master")
import xcbwc_code as xc  # noqa: E402


def out(*a):
    print(*a, flush=True)


state = xc.load_state()
acc = xc.build_accounts(state)[0]
cookie = xc.ensure_cookie(acc, state)
api = xc.Yuhua(cookie)
info = api.get_silk()
out(f"账号 {acc['remark']} | 蚕豆(现金) {xc.to_yuan(info.get('silk', 0))}")

SERVICE, PREFIX = "ActivityTask", "ActivityTaskMobileService."


def call(method, extra=None):
    body = {"silk_id": int(api.teemo), "app_id": 20}
    body.update(extra or {})
    try:
        headers = api._headers(SERVICE, f"{PREFIX}{method}")
        r = xc.req("POST", xc.RPC_URL, headers=headers, json=body, max_retries=1)
        return r.json()
    except Exception as exc:
        return {"_error": xc.parse_error(exc)}


# 1) 余额与抽奖信息
task_js = call("UserTaskV2")
task = task_js.get("data") if "data" in task_js else task_js.get("content")
yb_point = (task or {}).get("yb_point")
out(f"元宝余额: {yb_point}")

lot_js = call("YbLotteryInfo")
lot = lot_js.get("lottery_info") or {}
out("抽奖信息: " + json.dumps(lot, ensure_ascii=False))
cost = lot.get("cost") or 200
aid = lot.get("activity_id")
bid = lot.get("box_id")

if yb_point is None or int(yb_point) < int(cost):
    out(f"元宝不足（{yb_point} < {cost}），不抽")
    sys.exit(0)

# 2) 只抽一次（失败不扣费，成功即完成任务）
out(f"\n== 尝试抽奖一次（activity_id={aid}, box_id={bid}, cost={cost}）==")
js = call("YbLottery", {"activity_id": aid, "box_id": bid})
st = js.get("status") or {}
out(f"  code={st.get('code')} msg={st.get('msg')}")
out("  返回: " + json.dumps(js, ensure_ascii=False)[:700])

# 3) 抽完看任务 46 状态 + 新余额
after = call("UserTaskV2")
t2 = after.get("data") if "data" in after else after.get("content")
out(f"\n抽奖后元宝余额: {(t2 or {}).get('yb_point')}（抽前 {yb_point}）")

daily = call("GetDailyTask", {"user_id": int(api.vayne)})
for t in ((daily.get("data") or {}).get("list") or []):
    if t.get("id") in (46, 1, 57):
        out(f"  任务 id={t['id']} {t['title']} 状态={t['completed']}（1=已完成 2=待做）元宝={t['point']}")
