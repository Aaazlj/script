#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探测：小蚕抽奖进度与累计奖励接口（验完即删）"""
import json
import sys

sys.path.insert(0, "/ql/data/repo/Aaazlj_script_master")
import xcbwc_code as xc  # noqa: E402


def out(*a):
    print(*a, flush=True)


state = xc.load_state()
acc = xc.build_accounts(state)[0]
api = xc.Yuhua(xc.ensure_cookie(acc, state))
info = api.get_silk()
out(f"账号 {acc['remark']} | 蚕豆 {xc.to_yuan(info.get('silk', 0))}")

LOT = ("SilkwormLottery", "SilkwormLotteryMobile.")


def call(method, payload, service=None, prefix=None):
    body = {"silk_id": int(api.teemo), "app_id": 20}
    body.update(payload or {})
    svc = service or LOT[0]
    pre = prefix or LOT[1]
    try:
        r = xc.req("POST", xc.RPC_URL, headers=api._headers(svc, f"{pre}{method}"), json=body, max_retries=1)
        return r.status_code, r.text[:400]
    except Exception as exc:
        return "ERR", xc.parse_error(exc)


out("\n== 1) LotteryInfo / GetLotteryProgress ==")
for m in ("LotteryInfo", "GetLotteryProgress"):
    code, body = call(m, {})
    out(f"--- {m} → {code}")
    out("    " + body.replace("\n", " ")[:380])

out("\n== 2) ReceiveExtraLottery 各种参数（step=1） ==")
for payload in ({"step": 1}, {"step_id": 1}, {"id": 1}, {"step": 1, "type": 1}):
    code, body = call("ReceiveExtraLottery", payload)
    out(f"  {payload} → {code} | {body.replace(chr(10), ' ')[:200]}")

out("\n== 3) 日常福利里签到/抽奖任务的状态 ==")
js = api.call("ActivityTask", "ActivityTaskMobileService.GetDailyTask",
              {"silk_id": int(api.teemo), "user_id": int(api.vayne), "app_id": 20}).json()
for t in ((js.get("data") or {}).get("list") or []):
    if t.get("id") in (1, 46, 57):
        out(f"  id={t['id']:>3} {t['title']} 状态={t['completed']} 元宝={t['point']}")
