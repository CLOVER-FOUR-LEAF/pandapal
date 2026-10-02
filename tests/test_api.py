"""PandaButler 端到端测试：打真实接口、断言响应结构 + 权限隔离。

前置：服务已启动且 .env 配好 LLM Key。
用法：python tests/test_api.py [--base http://localhost:8000]

演示账号（server/auth.py 种子）：小豆/panda123（孩子）、豆豆妈/mama123（家长）、admin/admin123（评委）。
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

RESULTS = []


def record(name: str, ok: bool, note: str = ""):
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def _open(req, timeout):
    """urlopen 包装：HTTPError 也按响应读 body，返回 (status, dict)。"""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}


def get(base: str, path: str, token: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(base + urllib.parse.quote(path, safe="/?=&"))
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return _open(req, 120)


def post_json(base: str, path: str, body: dict, token: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return _open(req, 120)


def post_sse(base: str, path: str, body: dict, token: str | None = None) -> list[dict]:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
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


def login(base: str, username: str, password: str) -> dict:
    st, data = post_json(base, "/api/auth/login", {"username": username, "password": password})
    if st != 200:
        raise RuntimeError(f"登录失败 {st}: {data}")
    return data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    base = ap.parse_args().base.rstrip("/")

    # 1. 健康检查（公开）
    try:
        st, h = get(base, "/api/health")
        record("health", h.get("ok") is True, f"llm_configured={h.get('llm_configured')}")
        if not h.get("llm_configured"):
            print("!! LLM_API_KEY 未配置，后续用例必然失败")
    except Exception as e:
        record("health", False, str(e))
        return _summary()

    # 2. 未认证访问必须 401
    try:
        st, _ = get(base, "/api/memory?name=小豆")
        record("no_token_401", st == 401, f"status={st}")
    except Exception as e:
        record("no_token_401", False, str(e))

    # 3. 登录：孩子 / 家长 / 评委
    try:
        child = login(base, "小豆", "panda123")
        record("login_child", child.get("role") == "child" and bool(child.get("token")),
               f"role={child.get('role')}")
    except Exception as e:
        record("login_child", False, str(e))
        return _summary()
    tk_child = child["token"]

    try:
        st, _ = post_json(base, "/api/auth/login", {"username": "小豆", "password": "wrong"})
        record("login_bad_pw", st == 401, f"status={st}")
    except Exception as e:
        record("login_bad_pw", False, str(e))

    try:
        parent = login(base, "豆豆妈", "mama123")
        admin = login(base, "admin", "admin123")
        record("login_parent_admin",
               parent.get("role") == "parent" and admin.get("role") == "admin",
               f"parent={parent.get('role')} admin={admin.get('role')}")
    except Exception as e:
        record("login_parent_admin", False, str(e))
        return _summary()
    tk_parent, tk_admin = parent["token"], admin["token"]

    # 4. 开场问候（真实 LLM 生成）
    try:
        st, g = get(base, "/api/greeting?name=小豆", tk_child)
        record("greeting", isinstance(g.get("text"), str) and len(g["text"]) > 4, g.get("text", "")[:60])
    except Exception as e:
        record("greeting", False, str(e))

    # 5. 闲聊通道：token 流
    try:
        evs = post_sse(base, "/api/chat", {"name": "小豆", "message": "你好呀，我是小豆"}, tk_child)
        kinds = [e["type"] for e in evs]
        tokens = "".join(e.get("text", "") for e in evs if e["type"] == "token")
        ok = "mode" in kinds and "token" in kinds and "done" in kinds and len(tokens) > 4
        record("chat_stream", ok, f"reply={tokens[:40]}")
    except Exception as e:
        record("chat_stream", False, str(e))

    # 6. 规划链路：plan→node→card
    try:
        evs = post_sse(base, "/api/chat", {"name": "小豆", "message": "西客松比赛我要准备啥？"}, tk_child)
        plan = next((e for e in evs if e["type"] == "plan"), None)
        card = next((e for e in evs if e["type"] == "card"), None)
        nodes_done = [e for e in evs if e["type"] == "node" and e.get("status") == "done"]
        ok = plan and len(plan.get("nodes", [])) >= 2 and card and card["card"].get("sections")
        record("plan_chain", bool(ok),
               f"nodes={len(plan['nodes']) if plan else 0} done={len(nodes_done)} card={'yes' if card else 'no'}")
    except Exception as e:
        record("plan_chain", False, str(e))

    # 7. 记忆本
    try:
        st, m = get(base, "/api/memory?name=小豆", tk_child)
        record("memory", len(m.get("topics", [])) >= 5 and bool(m.get("daily")),
               f"topics={len(m.get('topics', []))}")
    except Exception as e:
        record("memory", False, str(e))

    # 8. 记忆写入沉淀（上轮对话应抽出点什么写进 daily/topics）
    time.sleep(4)  # 等异步沉淀落盘
    try:
        st, m2 = get(base, "/api/memory?name=小豆", tk_child)
        record("memory_written", len(m2.get("daily", [])) >= 3, f"daily={len(m2.get('daily', []))}")
    except Exception as e:
        record("memory_written", False, str(e))

    # 9. 权限隔离：家长不能聊天 / 看日志，孩子不能动收件箱；跨档案访问被拒
    try:
        st1, _ = post_json(base, "/api/chat", {"name": "小豆", "message": "hi"}, tk_parent)
        st2, _ = get(base, "/api/logs", tk_parent)
        st3, _ = get(base, "/api/parent/inbox?name=小豆", tk_child)
        st4, _ = get(base, "/api/memory?name=评测员A", tk_child)
        ok = st1 == 403 and st2 == 403 and st3 == 403 and st4 == 403
        record("isolation_403", ok, f"parent_chat={st1} parent_logs={st2} child_inbox={st3} cross={st4}")
    except Exception as e:
        record("isolation_403", False, str(e))

    # 10. 家长读孩子档案：收件箱可用，图谱强制 parent 过滤（private 节点不可见）
    try:
        st1, inbox = get(base, "/api/parent/inbox?name=小豆", tk_parent)
        st2, gp = get(base, "/api/graph?name=小豆&view=child", tk_parent)  # 客户端要 child 也没用
        leaked = [n for n in gp.get("nodes", []) if n.get("private")]
        st3, gd = get(base, "/api/graph?name=小豆&view=child", tk_admin)  # admin 不受限
        ok = st1 == 200 and st2 == 200 and not leaked and st3 == 200
        record("parent_filter", ok,
               f"inbox={st1} graph={st2} leaked_private={len(leaked)} admin_graph={st3}")
    except Exception as e:
        record("parent_filter", False, str(e))

    # 11. 会话隔离 + 并发不崩（自动注册的新孩子账号 + 小豆同时聊）
    try:
        guest = login(base, "评测员B", "pw123")  # 未知名 → 自动注册 child
        tk_b = guest["token"]
        out: dict[str, list] = {}

        def talk(tk, nm, msg):
            out[nm] = post_sse(base, "/api/chat", {"name": nm, "message": msg}, tk)

        t1 = threading.Thread(target=talk, args=(tk_child, "小豆", "我有点紧张"))
        t2 = threading.Thread(target=talk, args=(tk_b, "评测员B", "你好"))
        t1.start(); t2.start(); t1.join(timeout=120); t2.join(timeout=120)
        ok = all(any(e["type"] == "done" for e in v) for v in out.values())
        record("concurrent", ok, f"sessions={list(out.keys())} guest_new={guest.get('is_new')}")
    except Exception as e:
        record("concurrent", False, str(e))

    return _summary()


def _summary() -> int:
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
