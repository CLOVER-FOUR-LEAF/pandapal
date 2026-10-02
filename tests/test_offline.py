"""离线自检（契约 §7）：monkeypatch server.llm，不联网跑通核心链路。

用法：.venv/bin/python tests/test_offline.py
覆盖：登录 → briefing → plan 全链路 SSE 事件顺序（§5：mode→recall?→affair→plan→
      node*→action*→card→done→memory）→ 记忆/事务落盘 → 悄悄话 private 隔离 →
      graph 视角白名单 → 非法 stage 400。
测试档案固定用 data/child_test_离线（契约 §0 允许的 child_test_*），结束自动清理。
"""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from server import config, llm  # noqa: E402
from server.main import app  # noqa: E402

NAME = "test_离线"
CHILD_DIR = config.DATA_DIR / f"child_{NAME}"
PROFILES = config.DATA_DIR / "profiles.json"

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


# ------------------------------------------------------------------ LLM 假身

def _last_user(messages: list[dict]) -> str:
    return str(messages[-1].get("content", "")) if messages else ""


async def fake_complete(messages, *, max_tokens=1200, temperature=0.7, caller="unknown"):
    return {"greeting": "早！昨晚睡得怎么样？", "briefing": "我盯着几件事，最要紧的是比赛。"}.get(
        caller, f"{caller} 的离线回复")


async def fake_stream(messages, *, max_tokens=1200, temperature=0.7, caller="unknown"):
    for tok in ("我在听，", "慢慢说。"):
        yield tok


async def fake_complete_json(messages, *, max_tokens=1200, caller="unknown"):
    content = _last_user(messages)
    if caller == "router":
        if "比赛" in content:
            return {"intent": "new_affair", "mood": "happy", "affair_id": None, "reason": "离线"}
        return {"intent": "chat", "mood": "normal", "affair_id": None, "reason": "离线"}
    if caller == "planner":
        return {"title": "离线筹备计划", "nodes": [
            {"id": "n1", "title": "想想第一步", "tool": "llm",
             "args": {"task": "列出第一步"}, "depends_on": []},
            {"id": "n2", "title": "汇总方案", "tool": "llm",
             "args": {"task": "汇总"}, "depends_on": ["n1"]},
        ]}
    if caller == "synth":
        return {"title": "参赛方案", "emoji": "🏆", "closing": "加油！", "sections": [
            {"heading": "提醒事项", "items": ["前一天早睡", "赛前复查装备"]},
            {"heading": "携带清单", "items": ["学生证", "笔记本电脑", "保温杯"]},
        ]}
    if caller == "extract_graph":
        # 模板本身含 [[secret]] 字样，必须只看"孩子："那一行里的用户原话
        secret = "[[secret]]" in content.rsplit("孩子：", 1)[-1]
        return {
            "daily": "" if secret else "聊了参赛准备",
            "nodes": [{"label": "秘密心事" if secret else "机器人比赛",
                       "domain": "intellect", "type": "event", "status": "active",
                       "fact": "离线测试事实", "private": secret}],
            "edges": [],
            "affair": None,
            "longterm": "", "emotion": "",
        }
    return {}


def _install_fakes() -> dict:
    """替换 llm 三个入口 + 调用留痕，返回原函数供恢复。"""
    saved = {k: getattr(llm, k) for k in ("complete", "stream", "complete_json", "log_call")}
    llm.complete = fake_complete
    llm.stream = fake_stream
    llm.complete_json = fake_complete_json
    llm.log_call = lambda *a, **k: None  # 离线自检不污染 llm_calls.jsonl
    return saved


def _restore(saved: dict) -> None:
    for k, v in saved.items():
        setattr(llm, k, v)


def _cleanup() -> None:
    """删除测试档案与 profile 条目，data/child_xiaodou 一律不碰。"""
    shutil.rmtree(CHILD_DIR, ignore_errors=True)
    try:
        profiles = json.loads(PROFILES.read_text(encoding="utf-8"))
        if profiles.pop(NAME, None) is not None:
            PROFILES.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, ValueError):
        pass


# ------------------------------------------------------------------ HTTP 辅助

async def post(client: httpx.AsyncClient, path: str, body: dict) -> httpx.Response:
    return await client.post(path, json=body)


async def get_json(client: httpx.AsyncClient, path: str) -> dict:
    r = await client.get(path)
    r.raise_for_status()
    return r.json()


async def post_sse(client: httpx.AsyncClient, path: str, body: dict) -> list[dict]:
    events = []
    async with client.stream("POST", path, json=body) as resp:
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:]))
    return events


def _types(events: list[dict]) -> list[str]:
    return [e.get("type") for e in events]


# ------------------------------------------------------------------ 主流程

async def main() -> int:
    _cleanup()  # 上次跑挂掉留下的残留先清掉
    saved = _install_fakes()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                     timeout=30) as client:
            await _run(client)
    finally:
        _restore(saved)
        _cleanup()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    return 0 if passed == len(RESULTS) else 1


async def _run(client: httpx.AsyncClient) -> None:
    q = f"?name={NAME}"

    # 0. 登录：admin 账号（全能力 + 可用 name 指定任意档案，离线测最省事）
    r = await post(client, "/api/auth/login",
                   {"username": "admin", "password": "admin123"})
    token = r.json().get("token", "")
    record("login", r.status_code == 200 and bool(token), str(r.json())[:80])
    client.headers["Authorization"] = f"Bearer {token}"

    # 1. 建档
    r = await post(client, "/api/session", {"name": NAME})
    s = r.json()
    record("session", r.status_code == 200 and s.get("is_new") is True, str(s)[:80])

    # 2. 晨报（LLM 假身直出）
    b = await get_json(client, f"/api/briefing{q}")
    record("briefing", bool(b.get("text")) and "affairs" in b and "suggestions" in b,
           b.get("text", "")[:40])

    # 3. plan 通道：SSE 事件顺序（契约 §5）
    evs = await post_sse(client, "/api/chat",
                         {"name": NAME, "message": "我报名了机器人比赛，帮我准备"})
    types = _types(evs)
    expect_order = ["mode", "affair", "plan", "card", "done"]
    idx = [types.index(t) if t in types else -1 for t in expect_order]
    order_ok = all(i >= 0 for i in idx) and idx == sorted(idx)
    mode_ev = next((e for e in evs if e["type"] == "mode"), {})
    node_running = [e for e in evs if e["type"] == "node" and e.get("status") == "running"]
    node_done = [e for e in evs if e["type"] == "node" and e.get("status") == "done"]
    action_kinds = [e.get("kind") for e in evs if e["type"] == "action"]
    card = next((e for e in evs if e["type"] == "card"), {}).get("card") or {}
    mem = next((e for e in evs if e["type"] == "memory"), None)
    # action* 必须在 card 之前（契约 §5）
    act_before_card = ("card" in types and all(
        types.index("card") > i for i, e in enumerate(evs) if e["type"] == "action"))
    record("plan_sse_order", order_ok and act_before_card, f"events={types}")
    record("plan_sse_fields",
           mode_ev.get("mode") == "plan" and mode_ev.get("mood") == "happy"
           and len(node_running) == 2 and len(node_done) == 2
           and bool(card.get("sections")),
           f"mode={mode_ev.get('mode')} nodes={len(node_done)} actions={action_kinds}")
    record("actions_ran",
           "reminder" in action_kinds and "checklist" in action_kinds
           and "parent_confirm" in action_kinds,
           str(action_kinds))
    record("memory_event",
           bool(mem) and any(n.get("label") == "机器人比赛" for n in mem.get("added_nodes", [])),
           str(mem)[:80] if mem else "no memory event")

    # 4. 落盘检查（事件驱动的真执行结果）
    aff = await get_json(client, f"/api/affairs{q}")
    record("affair_created", len(aff.get("affairs", [])) >= 1, f"affairs={len(aff.get('affairs', []))}")
    cl_ids = [e.get("payload", {}).get("checklist_id")
              for e in evs if e["type"] == "action" and e.get("kind") == "checklist"]
    if cl_ids:
        cl = await get_json(client, f"/api/checklist/{cl_ids[0]}{q}")
        record("checklist_persisted", len(cl.get("checklist", {}).get("items", [])) == 3,
               f"cid={cl_ids[0]}")
    else:
        record("checklist_persisted", False, "无 checklist action")
    inbox = await get_json(client, f"/api/parent/inbox{q}")
    record("inbox_persisted", len(inbox.get("items", [])) >= 1, f"items={len(inbox.get('items', []))}")
    reminders = json.loads((CHILD_DIR / "reminders.json").read_text(encoding="utf-8")) \
        if (CHILD_DIR / "reminders.json").exists() else []
    record("reminder_persisted", len(reminders) >= 1, f"reminders={len(reminders)}")
    g = await get_json(client, f"/api/graph{q}&view=child")
    record("graph_node_added",
           any(n.get("label") == "机器人比赛" for n in g.get("nodes", [])),
           f"nodes={len(g.get('nodes', []))}")
    daily_files = list((CHILD_DIR / "daily").glob("*.md")) if (CHILD_DIR / "daily").is_dir() else []
    record("daily_written", len(daily_files) >= 1, f"daily={len(daily_files)}")

    # 5. 悄悄话：private 节点只在 child 视角可见（含 view=非parent 不泄露的白名单校验）
    sevs = await post_sse(client, "/api/chat",
                          {"name": NAME, "message": "[[secret]]我偷偷喜欢原神"})
    smem = next((e for e in sevs if e["type"] == "memory"), {})
    record("secret_marked",
           smem.get("secret") is True and any(
               n.get("private") for n in smem.get("added_nodes", [])),
           str(smem)[:80])
    g_child = await get_json(client, f"/api/graph{q}&view=child")
    g_parent = await get_json(client, f"/api/graph{q}&view=parent")
    g_bad = await get_json(client, f"/api/graph{q}&view=hacker")
    has_secret = lambda gg: any(n.get("label") == "秘密心事" for n in gg.get("nodes", []))
    record("private_isolation",
           has_secret(g_child) and not has_secret(g_parent) and not has_secret(g_bad),
           f"child={has_secret(g_child)} parent={has_secret(g_parent)} bad={has_secret(g_bad)}")
    # 悄悄话不落文件层（只有占位行，不写私密事实）
    topic_text = "".join(p.read_text(encoding="utf-8")
                         for p in (CHILD_DIR / "topics").glob("*.md"))
    record("secret_not_in_files", "原神" not in topic_text and "秘密心事" not in topic_text)

    # 6. 非法输入：stage 校验 → 400 而不是 500
    aid = aff["affairs"][0]["id"]
    r = await post(client, "/api/affairs",
                   {"name": NAME, "id": aid, "patch": {"stage": "bogus"}})
    record("bad_stage_400", r.status_code == 400, f"status={r.status_code}")
    r = await post(client, "/api/checklist/nonexistent",
                   {"name": NAME, "index": 0, "done": True})
    record("checklist_404", r.status_code == 404, f"status={r.status_code}")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
