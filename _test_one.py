#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时：只跑 1 个账号验证（用完即删）"""
import os
import sys

os.environ["YYB_SERVER"] = "http://yyb-go:8000@1"      # 只跑 ref=1
sys.path.insert(0, "/ql/data/repo/Aaazlj_script_master")
import xcbwc_code  # noqa: E402

sys.exit(xcbwc_code.main())
