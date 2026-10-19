#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时：只查元宝余额（用完即删）"""
import sys
sys.path.insert(0, "/ql/data/repo/Aaazlj_script_master")
import xcbwc_code as xc  # noqa: E402

state = xc.load_state()
acc = xc.build_accounts(state)[0]
api = xc.Yuhua(xc.ensure_cookie(acc, state))
print(f"账号 {acc['remark']}")
print("蚕豆(现金):", xc.to_yuan(api.get_silk().get("silk", 0)))
js = api.call("ActivityTask", "ActivityTaskMobileService.UserTaskV2",
              {"silk_id": int(api.teemo), "app_id": 20}).json()
d = js.get("data") or {}
print("元宝余额:", d.get("yb_point"), "| 已兑换:", d.get("exchanged_yb_point"))
