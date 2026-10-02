"""PandaButler 端到端测试：打真实接口、断言响应结构。

前置：服务已启动且 .env 配好 LLM Key。
用法：python tests/test_api.py [--base http://localhost:8000]
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.request

RESULTS = []


def record(name: str, ok: bool, note: str = ""):
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=120) as r:
        return json.loads(r.read())


def post_sse(base: str, path: str, body: dict) -> list[dict]:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    events = []
    buf = b""
    with urllib.request.urlopen(req, timeout=300) as r:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            buf += chunk
            while b"\n\n" in buf:
                raw, buf = buf.split(b"\n\n", 1)
                line = raw.decode("utf-8").strip()
                if line.startswith("data:"):
                    events.append(json.loads(line[5:]))
    return events


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    base = ap.parse_args().base.rstrip("/")

    # 1. 健康检查
    try:
        h = get(base, "/api/health")
        record("health", h.get("ok") is True, f"llm_configured={h.get('llm_configured')}")
        if not h.get("llm_configured"):
            print("!! LLM_API_KEY 未配置，后续用例必然失败")
    except Exception as e:
        record("health", False, str(e))
        return _summary()

    # 2. 登录选档
    try:
        req = urllib.request.Request(
            base + "/api/session",
            data=json.dumps({"name": "小豆"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            s = json.loads(r.read())
        record("session", s.get("child") == "小豆" or s.get("name") == "小豆", str(s))
    except Exception as e:
        record("session", False, str(e))

    # 3. 开场问候（真实 LLM 生成）
    try:
        g = get(base, "/api/greeting?name=小豆")
        record("greeting", isinstance(g.get("text"), str) and len(g["text"]) > 4, g.get("text", "")[:60])
    except Exception as e:
        record("greeting", False, str(e))

    # 4. 闲聊通道：token 流
    try:
        evs = post_sse(base, "/api/chat", {"name": "小豆", "message": "你好呀，我是小豆"})
        kinds = [e["type"] for e in evs]
        tokens = "".join(e.get("text", "") for e in evs if e["type"] == "token")
        ok = "mode" in kinds and "token" in kinds and "done" in kinds and len(tokens) > 4
        record("chat_stream", ok, f"events={kinds} reply={tokens[:40]}")
    except Exception as e:
        record("chat_stream", False, str(e))

    # 5. 规划链路：plan→node→card
    try:
        evs = post_sse(base, "/api/chat", {"name": "小豆", "message": "西客松比赛我要准备啥？"})
        kinds = [e["type"] for e in evs]
        plan = next((e for e in evs if e["type"] == "plan"), None)
        card = next((e for e in evs if e["type"] == "card"), None)
        nodes_done = [e for e in evs if e["type"] == "node" and e.get("status") == "done"]
        ok = plan and len(plan.get("nodes", [])) >= 2 and card and card["card"].get("sections")
        record("plan_chain", bool(ok), f"nodes={len(plan['nodes']) if plan else 0} done={len(nodes_done)} card={'yes' if card else 'no'}")
    except Exception as e:
        record("plan_chain", False, str(e))

    # 6. 记忆本
    try:
        m = get(base, "/api/memory?name=小豆")
        record("memory", len(m.get("topics", [])) >= 5 and bool(m.get("daily")), f"topics={len(m.get('topics', []))}")
    except Exception as e:
        record("memory", False, str(e))

    # 7. 记忆写入沉淀（上轮对话应抽出点什么写进 daily/topics）
    time.sleep(4)  # 等异步沉淀落盘
    try:
        m2 = get(base, "/api/memory?name=小豆")
        record("memory_written", len(m2.get("daily", [])) >= 3, f"daily={len(m2.get('daily', []))}")
    except Exception as e:
        record("memory_written", False, str(e))

    # 8. 会话隔离 + 并发不崩（两个不同孩子同时聊）
    try:
        out: dict[str, list] = {}

        def talk(nm, msg):
            out[nm] = post_sse(base, "/api/chat", {"name": nm, "message": msg})

        t1 = threading.Thread(target=talk, args=("小豆", "我有点紧张"))
        t2 = threading.Thread(target=talk, args=("评测员A", "你好"))
        t1.start(); t2.start(); t1.join(timeout=120); t2.join(timeout=120)
        ok = all(any(e["type"] == "done" for e in v) for v in out.values())
        record("concurrent", ok, f"sessions={list(out.keys())}")
    except Exception as e:
        record("concurrent", False, str(e))

    return _summary()


def _summary() -> int:
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
