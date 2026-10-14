"""把每条流量落成 JSONL，并在 stdout 打一行摘要。

字段尽量保留可分析内容：完整 URL、请求体（含签名参数）、响应体片段。
REA 侧仍用 mitmdump 原生的 .mitm flow 文件作为权威证据。
"""

import json
import time

from mitmproxy import http

LOG = "/tmp/ios/flows.jsonl"
REQ_BODY_MAX = 4000
RES_BODY_MAX = 6000


def _now() -> str:
    return time.strftime("%H:%M:%S")


def _append(rec: dict) -> None:
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


class Recorder:
    def response(self, flow: http.HTTPFlow) -> None:
        req, res = flow.request, flow.response
        if res is None:
            return

        try:
            raw = res.get_content() or b""
        except Exception:
            raw = b""

        rec = {
            "t": _now(),
            "method": req.method,
            "host": req.host,
            "path": req.path,
            "url": req.pretty_url,
            "status": res.status_code,
            "ctype": res.headers.get("content-type", ""),
            "req_ct": req.headers.get("content-type", ""),
            "req_body": (req.get_text(strict=False) or "")[:REQ_BODY_MAX],
            "res_body": raw[:RES_BODY_MAX].decode("utf-8", "replace"),
            "res_len": len(raw),
        }
        _append(rec)
        print(
            f"[{rec['t']}] {rec['method']:4s} {rec['status']} {req.host}{req.path[:130]}",
            flush=True,
        )

    def error(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        host = req.host if req else "?"
        path = req.path if req else "?"
        _append({"t": _now(), "error": str(flow.error), "host": host, "path": path})
        print(f"[ERR] {host}{path[:100]} -> {flow.error}", flush=True)


addons = [Recorder()]
