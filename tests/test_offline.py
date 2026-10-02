"""离线自检（契约 §7）：monkeypatch server.llm，不联网跑通核心链路。

用法：.venv/bin/python tests/test_offline.py
覆盖：登录 → briefing → plan 全链路 SSE 事件顺序（§5：mode→recall?→affair→plan→
      node*→action*→card→done→memory）→ 记忆/事务落盘（清单回挂、执行链存档）→
      悄悄话 private 强制（即使模型漏标）→ graph 视角白名单 → 家长写权限 403 →
      非法 stage 400。
数据目录用 PANDA_DATA_DIR 指向一次性沙箱，真实 data/ 一个字节都不碰。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 必须先于 server 包导入：config 在 import 时读 PANDA_DATA_DIR
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_offline_")

import httpx  # noqa: E402

from server import config, llm  # noqa: E402
from server.main import app  # noqa: E402

NAME = "test_离线"
SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
CHILD_DIR = SANDBOX / f"child_{NAME}"

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
        # 故意让悄悄话轮 private=False：模拟 LLM 漏标，服务端必须兜底强制 private
        return {
            "daily": "" if secret else "聊了参赛准备",
            "nodes": [{"label": "秘密心事" if secret else "机器人比赛",
                       "domain": "intellect", "type": "event", "status": "active",
                       "fact": "离线测试事实", "private": False}],
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
    """整个沙箱目录一次性删除，真实 data/ 一律不碰。"""
    shutil.rmtree(SANDBOX, ignore_errors=True)


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


async def get_sse(client: httpx.AsyncClient, path: str) -> list[dict]:
    """GET 版 SSE（晨报/问候的 ?stream=1）。"""
    events = []
    async with client.stream("GET", path) as resp:
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:]))
    return events


def _types(events: list[dict]) -> list[str]:
    return [e.get("type") for e in events]


# ------------------------------------------------------------------ 主流程

async def main() -> int:
    saved = _install_fakes()  # 沙箱是新建临时目录，无需预清理
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
        # 清单必须回挂到事务上，否则详情抽屉永远够不着它
        linked = [a for a in aff.get("affairs", []) if a.get("checklist_id") == cl_ids[0]]
        record("checklist_linked", len(linked) == 1,
               f"linked={linked[0]['id'] if linked else '无'}")
    else:
        record("checklist_persisted", False, "无 checklist action")
        record("checklist_linked", False, "无 checklist action")
    # 执行链连同节点终态存进事务，详情抽屉的"DAG 回放"才能展示真链
    plan = (aff.get("affairs") or [{}])[0].get("plan") or {}
    record("plan_archived",
           len(plan.get("nodes", [])) == 2
           and all(n.get("status") == "done" for n in plan["nodes"]),
           f"nodes={len(plan.get('nodes', []))}")
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

    # 7. 家长只读：写事务/勾清单 → 403，看板读 → 200；收件箱决定权仍在
    r = await post(client, "/api/auth/login",
                   {"username": "豆豆妈", "password": "mama123"})
    ptoken = r.json().get("token", "")
    record("parent_login", r.status_code == 200 and bool(ptoken))
    client.headers["Authorization"] = f"Bearer {ptoken}"
    pq = "?name=小豆"
    r = await post(client, "/api/checklist/nonexistent",
                   {"name": "小豆", "index": 0, "done": True})
    record("parent_checklist_403", r.status_code == 403, f"status={r.status_code}")
    r = await post(client, "/api/affairs",
                   {"name": "小豆", "patch": {"title": "家长越权测试"}})
    record("parent_affairs_403", r.status_code == 403, f"status={r.status_code}")
    # 家长不能和管家聊天：web/app.js 的 canChat 判定就钉在这一条上。
    # 节点抽屉的「问问管家这件事」必须对家长收起来，而不是点了等服务端 403——
    # 早先抽屉无条件渲染那颗按钮、send() 又静默 return，家长点了像界面卡死。
    r = await post(client, "/api/chat",
                   {"name": "小豆", "message": "关于「数学作业」，你还记得什么"})
    record("parent_chat_403", r.status_code == 403, f"status={r.status_code}")
    r = await client.get(f"/api/affairs{pq}")
    record("parent_read_ok", r.status_code == 200, f"status={r.status_code}")
    # 收件箱决定仍是家长的正当写权限（iid 不存在 → 404 而非 403，说明过了能力关）
    r = await post(client, "/api/parent/inbox/nonexistent",
                   {"name": "小豆", "action": "approve"})
    record("parent_inbox_allowed", r.status_code == 404, f"status={r.status_code}")

    # 8. 账号→档案越权防线回归：别名登录、撞名目录、query token 收窄、聊天限频
    (SANDBOX / "aliases.seed.json").write_text(
        json.dumps({"xiaodou": "小豆"}, ensure_ascii=False), encoding="utf-8")
    client.headers.pop("Authorization", None)
    # 别名 + 正确密码 → 身份归一到小豆本人
    r = await post(client, "/api/auth/login",
                   {"username": "xiaodou", "password": "panda123"})
    j = r.json()
    record("alias_login_ok",
           r.status_code == 200 and j.get("username") == "小豆",
           f"status={r.status_code} user={j.get('username')}")
    # 别名 + 错密码 → 401：绝不能因"未知名"自动注册而绕过小豆的密码
    r = await post(client, "/api/auth/login",
                   {"username": "xiaodou", "password": "hackme"})
    record("alias_no_bypass", r.status_code == 401, f"status={r.status_code}")
    # 别名不能注册成独立账号（否则永远被旧账号遮住，登不进去）
    r = await post(client, "/api/auth/register",
                   {"username": "xiaodou", "password": "pass1234",
                    "question": "q", "answer": "a"})
    record("alias_register_blocked", r.status_code == 400, f"status={r.status_code}")
    # 清洗/分隔符撞档：a.b 与 a_b 映射到同一 slug，但必须各自独立目录
    r = await post(client, "/api/auth/login", {"username": "a.b", "password": "pw1"})
    ok1 = r.status_code == 200
    r = await post(client, "/api/auth/login", {"username": "a_b", "password": "pw2"})
    record("slug_collision_users", ok1 and r.status_code == 200,
           f"statuses={ok1},{r.status_code}")
    dirs = sorted(p.name for p in SANDBOX.glob("child_a_b*"))
    record("dir_collision_split", dirs == ["child_a_b", "child_a_b_2"], str(dirs))
    owners = sorted(
        json.loads((SANDBOX / d / "index.json").read_text(encoding="utf-8"))["name"]
        for d in dirs)
    record("dir_owner_distinct", owners == ["a.b", "a_b"], str(owners))
    # ?token= 只在 /api/ics/ 生效，其它端点必须 401
    r = await client.get(f"/api/graph?token={token}")
    record("query_token_rejected", r.status_code == 401, f"status={r.status_code}")
    r = await client.get(f"/api/ics/nonexistent_aid?token={token}")
    record("ics_query_token_ok", r.status_code == 404,  # 认证过了→事务不存在
           f"status={r.status_code}")
    # 每账号聊天限频：30 条/5 分钟（挡公网刷 Key）
    r = await post(client, "/api/auth/login", {"username": "限速员", "password": "pw1"})
    client.headers["Authorization"] = f"Bearer {r.json()['token']}"
    codes = []
    for _ in range(31):
        rr = await client.post("/api/chat",
                               json={"name": "限速员", "message": "你好"})
        codes.append(rr.status_code)
    record("chat_rate_limit",
           codes[-1] == 429 and all(c == 200 for c in codes[:-1]),
           f"codes={codes.count(200)}x200 tail={codes[-1]}")
    client.headers.pop("Authorization", None)

    # 9. executor 祖先作用域：并行分支的产物不掺进别的 LLM 节点的上下文
    from server import executor, sessions as _sess_mod
    sess = await _sess_mod.login(NAME)
    seen: dict[str, str] = {}

    async def cap_complete(messages, *, caller="unknown", **kw):
        if caller == "node":
            content = str(messages[-1]["content"])
            title = content.split("本环节：", 1)[-1].split("—", 1)[0].strip()
            seen[title] = content
            return f"结果#{title}"
        return "无关"

    async def _noop_emit(_e):
        pass

    saved_complete = llm.complete
    llm.complete = cap_complete
    try:
        plan = {"title": "钻石形", "nodes": [
            {"id": "r", "title": "根", "tool": "llm",
             "args": {"task": "根"}, "depends_on": []},
            {"id": "a", "title": "甲支", "tool": "llm",
             "args": {"task": "甲"}, "depends_on": ["r"]},
            {"id": "b", "title": "乙支", "tool": "llm",
             "args": {"task": "乙"}, "depends_on": ["r"]},
            {"id": "s", "title": "汇总", "tool": "llm",
             "args": {"task": "汇"}, "depends_on": ["a"]},
        ]}
        await executor.run_plan(plan, sess.store, "测试", _noop_emit)
    finally:
        llm.complete = saved_complete
    ctx_s = seen.get("汇总", "")
    record("exec_ancestor_scope",
           "结果#根" in ctx_s and "结果#甲支" in ctx_s and "结果#乙支" not in ctx_s,
           f"s_ctx={'根' if '结果#根' in ctx_s else '?'}/{'甲' if '结果#甲支' in ctx_s else '?'}/{'乙!' if '结果#乙支' in ctx_s else '乙ok'}")

    # 10. 扩展端点：增长雷达 / 梦想 / 传话筒 / PATCH / 时间轴切片 / 日志分页 / 流式晨报问候
    client.headers["Authorization"] = f"Bearer {token}"  # 前面的用例把 header 换成过家长，切回 admin

    gr = await get_json(client, f"/api/growth{q}")
    record("growth", len(gr.get("dimensions", [])) == 5 and "totals" in gr,
           f"dims={len(gr.get('dimensions', []))}")

    r = await post(client, "/api/dream", {"name": NAME, "text": ""})
    record("dream_invite", r.status_code == 200 and bool(r.json().get("text")),
           str(r.json())[:60])

    r = await post(client, "/api/relay",
                   {"name": NAME, "direction": "child2teacher", "text": "老师我想再想想"})
    rj = r.json()
    record("relay", r.status_code == 200 and ("message" in rj or "parent_text" in rj),
           str(rj)[:60])

    # PATCH：局部更新事务（旧契约 §2.6），只改 stage，正文不动
    before = await get_json(client, f"/api/affairs/{aid}{q}")
    r = await client.patch(f"/api/affairs/{aid}", json={
        "name": NAME, "stage": "waiting", "note": "离线 PATCH"})
    after = await get_json(client, f"/api/affairs/{aid}{q}")
    record("affair_patch",
           r.status_code == 200 and after["affair"]["stage"] == "waiting"
           and after["affair"]["title"] == before["affair"]["title"],
           f"status={r.status_code} stage={after['affair'].get('stage')}")
    r = await client.patch(f"/api/affairs/{aid}", json={"name": NAME})
    record("affair_patch_empty_400", r.status_code == 400, f"status={r.status_code}")

    # 时间轴切片：until 在节点出现之前 → 空图；until 很晚 → 全量
    snap_early = await get_json(client, f"/api/graph/snapshot{q}&view=child&until=2000-01-01")
    snap_late = await get_json(client, f"/api/graph/snapshot{q}&view=child&until=2999-12-31")
    record("graph_snapshot",
           snap_early.get("nodes") == [] and any(
               n.get("label") == "机器人比赛" for n in snap_late.get("nodes", [])),
           f"early={len(snap_early.get('nodes', []))} late={len(snap_late.get('nodes', []))}")

    lg = await get_json(client, "/api/logs?limit=5&offset=0")
    record("logs_pagination",
           "calls" in lg and lg.get("limit") == 5 and lg.get("offset") == 0
           and isinstance(lg.get("total"), int),
           f"total={lg.get('total')} limit={lg.get('limit')}")
    lg2 = await get_json(client, "/api/logs?limit=999999")
    record("logs_limit_clamped", lg2.get("limit") == 200, f"limit={lg2.get('limit')}")

    # 流式晨报/问候：token* → done（done 带本地数据）；LLM 假身只会吐两个 token
    gev = await get_sse(client, f"/api/greeting{q}&stream=1")
    gtypes = _types(gev)
    gdone = next((e for e in gev if e["type"] == "done"), {})
    record("greeting_stream",
           "token" in gtypes and "done" in gtypes and gtypes.index("done") == len(gtypes) - 1
           and "reminders" in gdone,
           f"events={gtypes}")
    bev = await get_sse(client, f"/api/briefing{q}&stream=1")
    btypes = _types(bev)
    bdone = next((e for e in bev if e["type"] == "done"), {})
    record("briefing_stream",
           "token" in btypes and "done" in btypes and "affairs" in bdone
           and "suggestions" in bdone,
           f"events={btypes}")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
