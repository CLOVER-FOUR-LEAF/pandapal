"""PandaButler Server：FastAPI 应用与 API 端点。

端点：
  POST /api/auth/login   用户名+密码登录 → Bearer token（未知名自动注册孩子档）
  POST /api/auth/logout  注销 token
  GET  /api/auth/me      当前登录信息（刷新恢复会话用）
  POST /api/session    登录选档：名字 → 绑定 data/{child}/ 档案目录
  GET  /api/greeting   开场主动问候（记忆驱动生成）
  GET  /api/briefing   管家晨间巡检（事务 + 临近截止 + 主动建议）
  POST /api/chat       对话主入口（SSE 流：闲聊 token / 事务规划链 / 动作执行）
  GET  /api/graph      成长图谱（view=child|parent）
  GET  /api/affairs    事务看板
  POST /api/affairs    新建/更新事务
  POST /api/checklist/{cid}  清单勾选
  GET  /api/parent/inbox     家长待确认收件箱
  POST /api/parent/inbox/{iid}  家长确认/驳回
  POST /api/relay      传话筒（老师→家长 / 孩子→老师）
  GET  /api/ics/{aid}  日历导出
  GET  /api/memory     记忆本
  GET  /api/history    本会话历史（刷新恢复）
  GET  /api/logs       LLM 调用留痕（评委验真，仅 admin）
  GET  /api/health     健康检查

鉴权：除 /api/health、/api/auth/* 与静态资源外，一律要求 Bearer token；
每个端点标注能力（cap），由 auth.CAPS 按角色裁决；非 admin 的 name 参数
必须与账号绑定的孩子档案一致，家长视角的私密过滤在服务端强制执行。
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import (actions, affairs, auth, config, executor, graph, llm, memory, planner,
               prompts, router, sessions, synth)

app = FastAPI(title="PandaButler", docs_url=None, redoc_url=None)

_background: set[asyncio.Task] = set()
SECRET_PREFIX = "[[secret]]"


def _bg(task: asyncio.Task) -> None:
    _background.add(task)
    task.add_done_callback(_background.discard)


class AuthReq(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    password: str = Field(min_length=1, max_length=64)


class SessionReq(BaseModel):
    name: str = Field(default="", max_length=24)


class ChatReq(BaseModel):
    name: str = Field(default="", max_length=24)
    message: str = Field(min_length=1, max_length=2000)


class AffairReq(BaseModel):
    name: str = Field(default="", max_length=24)
    id: str | None = None
    patch: dict | None = None  # 契约 §4 字段名
    data: dict | None = None   # 兼容旧调用方


class ChecklistReq(BaseModel):
    name: str = Field(default="", max_length=24)
    index: int
    done: bool


class InboxReq(BaseModel):
    name: str = Field(default="", max_length=24)
    action: str = Field(pattern="^(approve|reject)$")
    reply: str = ""


class RelayReq(BaseModel):
    name: str = Field(default="", max_length=24)
    direction: str = Field(pattern="^(teacher2parent|child2teacher)$")
    text: str = Field(min_length=1, max_length=2000)


class DreamReq(BaseModel):
    name: str = Field(default="", max_length=24)
    text: str = Field(default="", max_length=1000)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _get_session(name: str):
    try:
        return await sessions.login(name)
    except ValueError:
        raise HTTPException(400, "名字不能为空")


# ---------------------------------------------------------------- 鉴权

def _token(request: Request) -> str:
    """Bearer 头优先；?token= 兜底给 window.open 下载（ics）这类不能带头的场景。"""
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.query_params.get("token", "")


def _user(request: Request) -> dict:
    u = auth.user_for_token(_token(request))
    if not u:
        raise HTTPException(401, "请先登录")
    return u


def _need(user: dict, cap: str) -> None:
    if not auth.can(user, cap):
        role_name = auth.ROLE_NAMES.get(user["role"], user["role"])
        raise HTTPException(403, f"{role_name}账号没有「{auth.cap_label(cap)}」权限")


async def _auth_session(request: Request, cap: str, name: str | None = None):
    """认证 + 能力校验 + 档案名归一，返回 (user, session)。"""
    user = _user(request)
    _need(user, cap)
    try:
        eff = auth.resolve_child(user, name)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return user, await _get_session(eff)


@app.post("/api/auth/login")
async def api_auth_login(req: AuthReq):
    try:
        res = auth.login(req.username, req.password)
    except ValueError as e:
        raise HTTPException(401, str(e))
    user = res["user"]
    sess = await _get_session(user["child"])
    return {
        "token": res["token"],
        "username": user["username"],
        "role": user["role"],
        "role_name": auth.ROLE_NAMES.get(user["role"], user["role"]),
        "name": sess.name,
        "is_new": res["is_new"],
    }


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request):
    auth.logout(_token(request))
    return {"ok": True}


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    user = _user(request)
    return {"username": user["username"], "role": user["role"],
            "role_name": auth.ROLE_NAMES.get(user["role"], user["role"]),
            "name": user["child"]}


def _stores(sess):
    """一个会话关联的三套存储视图。"""
    return (
        graph.GraphStore(sess.dir),
        affairs.AffairStore(sess.dir),
        memory.MemoryStore(sess.dir),
    )


# ---------------------------------------------------------------- 会话

@app.post("/api/session")
async def api_session(request: Request, req: SessionReq):
    _, sess = await _auth_session(request, "session", req.name)
    g, a, _ = _stores(sess)
    return {
        "name": sess.name,
        "is_new": sess.is_new,
        "child": sess.store.child_name,
        "graph_nodes": len(g.export()["nodes"]),
        "affairs": len(a.list()),
    }


@app.get("/api/greeting")
async def api_greeting(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "greeting", name)
    _, a, _ = _stores(sess)
    block = sess.store.active_block()
    try:
        text = await llm.complete(
            [{"role": "user", "content": prompts.GREETING.format(
                name=sess.name,
                now=datetime.now().strftime("%Y-%m-%d %H:%M 星期") + "一二三四五六日"[datetime.now().weekday()],
                affairs_brief=_affairs_brief(a),
                memory_block=block or "（还没有记忆，这是第一次见面）",
            )}],
            max_tokens=600,
            caller="greeting",
        )
    except llm.LLMError as e:
        raise HTTPException(502, f"LLM 暂不可用：{e}")
    return {"text": text.strip(), "reminders": sess.store.due_reminders(), "name": name}


# ---------------------------------------------------------------- 晨间巡检

def _left(d: dict) -> str:
    """due_soon 条目的剩余天数文案（过期则说逾期）。"""
    days = int(d.get("days") or 0)
    return f"已过期 {-days} 天" if days < 0 else f"还有 {days} 天"


def _affairs_brief(a_store, limit: int = 6) -> str:
    items = a_store.list()[:limit]
    if not items:
        return "（目前没有正在跟进的事）"
    lines = []
    for it in items:
        due = f"，截止 {it['due']}" if it.get("due") else ""
        lines.append(f"- [{it['id']}] {it['title']}（阶段：{it.get('stage')}，待办方：{it.get('owner_next')}{due}）：{it.get('summary', '')}")
    return "\n".join(lines)


@app.get("/api/briefing")
async def api_briefing(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "briefing", name)
    g, a, m = _stores(sess)
    snapshot = a.snapshot()
    due = a.due_soon(days=30)  # 演示档案里主事件在 16 天后，窗口放宽到 30 天
    due_brief = "\n".join(
        f"- {d['title']}：{d['due']}（{_left(d)}）" for d in due
    ) or "（最近没有临近截止的事）"

    affair_brief_text = _affairs_brief(a)
    mem_block = m.active_block()
    graph_block = g.brief_block(limit=30)
    if graph_block:
        mem_block = f"{mem_block}\n\n{graph_block}"

    # 主动建议："近期反复提起"检测——同一节点被提及 >=3 次、事实跨 >=2 个不同的天、
    # 最近 10 天内还在提，且还没挂在任何事务上。确定性规则，不靠 LLM 猜。
    # 注意：private（悄悄话）节点绝不能出现在建议里——那是孩子没打算让人知道的事
    linked = {nid for it in a.list() for nid in it.get("linked_nodes") or []}
    cutoff = date.today() - timedelta(days=10)
    candidates = []
    for n in g.load().get("nodes", []):
        if n.get("private") or n.get("id") in linked:
            continue
        if n.get("type") not in ("goal", "interest") or n.get("status") == "done":
            continue
        days = {str(f.get("date"))[:10] for f in n.get("facts") or [] if isinstance(f, dict)}
        try:
            recent = date.fromisoformat(str(n.get("last_seen"))[:10]) >= cutoff
        except ValueError:
            recent = False
        if int(n.get("weight") or 1) >= 3 and len(days) >= 2 and recent:
            candidates.append(n)
    candidates.sort(key=lambda x: -int(x.get("weight") or 1))
    suggestions = [{
        "text": f"要不要我帮你把「{n['label']}」的事接过来，做成一个计划？",
        "affair_id": None,  # 契约 §4：建议尚未落成事务，id 为 null；node_id 附带图谱来源
        "node_id": n["id"],
    } for n in candidates[:2]]

    try:
        text = await llm.complete(
            [{"role": "user", "content": prompts.BRIEFING.format(
                name=sess.name,
                now=datetime.now().strftime("%Y-%m-%d %H:%M 星期") + "一二三四五六日"[datetime.now().weekday()],
                affairs_brief=affair_brief_text,
                due_brief=due_brief,
                memory_block=mem_block or "（暂无记忆）",
            )}],
            max_tokens=800,
            caller="briefing",
        )
    except llm.LLMError as e:
        # 晨报失败不影响界面：给一句基于本地数据的兜底
        text = f"早，{sess.name}！我替你盯着 {len(snapshot['affairs'])} 件事。" + (f"最近要紧的是：{due[0]['title']}。" if due else "")
        if not due and not snapshot["affairs"]:
            text = f"早，{sess.name}！今天还没有要盯的事，有事随时叫我。"
        print(f"[briefing] LLM 不可用，已降级：{e}")

    return {
        "text": text.strip(),
        "affairs": snapshot["board"],
        "due_soon": due,
        "suggestions": suggestions,
    }


# ---------------------------------------------------------------- 对话主流程

def _chat_messages(sess, message: str, recall_block: str = "", extra_rule: str = "") -> list[dict]:
    """人设 + 活跃关注点块 + 图谱检索 + 历史尾部。extra_rule 用于 explain 等分支追加讲解规则。"""
    system = prompts.PERSONA.format(name=sess.name)
    if extra_rule:
        system += "\n\n" + extra_rule
    active = sess.store.active_block()
    related = sess.store.retrieve(message)
    mem_parts = []
    if active:
        mem_parts.append(f"你一直记得的关于 {sess.name} 的事：\n{active}")
    if recall_block:
        mem_parts.append(f"和这次聊天可能相关的记忆：\n{recall_block}")
    if related:
        mem_parts.append(f"（补充）{related}")
    if mem_parts:
        system += "\n\n" + "\n\n".join(mem_parts)
    msgs = [{"role": "system", "content": system}]
    # 只透传 role/content：secret 等内部字段不能进 LLM 请求体
    msgs.extend({"role": m["role"], "content": m["content"]} for m in sess.history)
    msgs.append({"role": "user", "content": message})
    return msgs


def _make_checklist_from_card(card: dict) -> list[str]:
    """从卡片里挑出可以勾选的条目（清单类板块）。"""
    items = []
    for sec in card.get("sections", []):
        head = str(sec.get("heading", ""))
        if any(k in head for k in ("携带", "清单", "要带", "准备什么", "物品")):
            items.extend(str(i) for i in sec.get("items", []))
    return items[:12]


async def _settle_memory(sess, user_msg: str, reply: str, is_secret: bool = False) -> dict | None:
    """回复发完之后再做：抽取图谱节点/边 + 事务沉淀，并返回 memory 事件载荷。

    返回的载荷里可能带 "affair_event"（事务阶段推进后的看板更新），由调用方
    单独作为 affair 事件下发，不进 memory 事件本体。is_secret 时绝不碰事务档案：
    私密原话一旦写进 affairs.json 的 log 就泄露了。
    """
    g, a, _ = _stores(sess)
    try:
        gdata = await memory.extract_and_store(sess.store, user_msg, reply,
                                               graph_store=g, is_secret=is_secret,
                                               affairs_brief=_affairs_brief(a))
    except Exception as e:  # noqa: BLE001 沉淀失败不能影响对话
        print(f"[memory] 图谱沉淀失败：{e}")
        return None
    if not gdata:
        return None
    # 事务侧的轻量沉淀：孩子汇报了进展 → 推进阶段（只对已存在的事务生效，防幻觉造单）
    aff = gdata.pop("affair", None)
    if aff and not is_secret and a.get(aff["id"]):
        try:
            updated = a.advance(aff["id"], aff["stage"], actor="child",
                                note=aff["note"] or user_msg[:40])
            gdata["affair_event"] = {"type": "affair", "action": "update", "affair": updated}
        except (KeyError, ValueError):
            pass
    return gdata


async def _chat_stream(sess, raw_message: str):
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    is_secret = raw_message.startswith(SECRET_PREFIX)
    message = raw_message[len(SECRET_PREFIX):].strip() if is_secret else raw_message
    if not message:
        message = "（发来一条没写内容的悄悄话）"  # [[secret]] 空消息兜底，不进意图分类

    async def emit(event: dict) -> None:
        await queue.put(event)

    reply_text = ""
    g_store, a_store, m_store = _stores(sess)

    async def work():
        nonlocal reply_text
        cls = await router.classify(message, _affairs_brief(a_store, limit=4))
        intent, mood = cls["intent"], cls["mood"]
        if intent == "affair_update" and not cls.get("affair_id"):
            intent = "chat"  # 没指到具体事务的"汇报"按闲聊走，不再静默落入 chat 分支
        # 契约 §5：mode 是第一个事件，mood 随 mode 一起下发
        mode = {"new_affair": "plan", "affair_update": "affair",
                "relay": "relay", "explain": "explain"}.get(intent, "chat")
        await emit({"type": "mode", "mode": mode, "mood": mood})

        # ① 想起来了：图谱检索 → recall 事件（同时注入 prompt）
        hit = g_store.recall(message, limit=4)
        if hit["nodes"]:
            await emit({"type": "recall", "nodes": hit["nodes"], "edges": hit["edges"]})

        if intent == "relay":
            out = await _do_relay(sess, "child2teacher", message)
            reply_text = out.get("message", "")
            await emit({"type": "relay_result", **out})
            return

        if intent == "new_affair":
            # ② 接下这件事：建事务
            affair = await _open_affair(sess, a_store, message, hit)
            if affair:
                await emit({"type": "affair", "action": "create", "affair": a_store.get(affair["id"])})
            try:
                plan = await planner.make_plan(sess.store, message, a_store.snapshot())
            except planner.PlanError:
                plan = None
            if plan:
                await emit({
                    "type": "plan", "title": plan["title"],
                    "nodes": [{"id": n["id"], "title": n["title"], "tool": n["tool"],
                               "depends_on": n["depends_on"]} for n in plan["nodes"]],
                })
                results = await executor.run_plan(plan, sess.store, message, emit)
                card = await synth.synthesize(sess.store, message, results)
            else:
                card = await synth.direct_card(sess.store, message)
            reply_text = synth.card_to_text(card)

            # ③ 实际去执行：加提醒 / 生成清单 / 请家长确认。
            # 契约 §5：action* 在 card 之前——动作回执先落看板，卡片再压轴出场
            if affair:
                await _execute_actions(sess, a_store, affair, card, message, emit)
            await emit({"type": "card", "card": card})

        elif intent == "affair_update":
            patch = {"summary": message[:60]}
            try:
                updated = a_store.update(cls["affair_id"], patch, actor="child", note=message[:40])
                await emit({"type": "affair", "action": "update", "affair": updated})
            except Exception:  # noqa: BLE001 事务 id 失效时照常聊天
                pass
            chunks = []
            async for tok in llm.stream(_chat_messages(sess, message, hit["block"]), max_tokens=600, caller="chat"):
                chunks.append(tok)
                await emit({"type": "token", "text": tok})
            reply_text = "".join(chunks)

        elif intent == "explain":
            # 讲懂知识点：复用闲聊通道，但在人设后追加"用自己的经历打比方"的讲解规则
            chunks = []
            async for tok in llm.stream(
                    _chat_messages(sess, message, hit["block"],
                                   extra_rule=prompts.EXPLAIN_RULE),
                    max_tokens=600, caller="explain"):
                chunks.append(tok)
                await emit({"type": "token", "text": tok})
            reply_text = "".join(chunks)

        else:
            chunks = []
            async for tok in llm.stream(_chat_messages(sess, message, hit["block"]), max_tokens=600, caller="chat"):
                chunks.append(tok)
                await emit({"type": "token", "text": tok})
            reply_text = "".join(chunks)

    async def runner():
        try:
            await work()
            await emit({"type": "done"})
        except llm.LLMError as e:
            await emit({"type": "error", "message": f"管家的大脑暂时连不上啦：{e}"})
        except Exception as e:  # noqa: BLE001
            await emit({"type": "error", "message": f"出了点小问题：{e}"})
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield _sse(event)
    finally:
        if not task.done():
            task.cancel()

    # ④ 回复已发完，再做记忆沉淀，并把结果作为 memory 事件补发
    if reply_text:
        u_entry = {"role": "user", "content": raw_message if is_secret else message}
        a_entry = {"role": "assistant", "content": reply_text}
        if is_secret:
            u_entry["secret"] = a_entry["secret"] = True
        sess.history.extend([u_entry, a_entry])
        # 悄悄话：把带 [[secret]] 标记的原文交给抽取器，它才知道要标成 private；
        # is_secret 同时让文件层落盘走占位行——私密内容绝不写进 topics/daily/MEMORY.md
        gdata = await _settle_memory(sess, raw_message if is_secret else message, reply_text,
                                     is_secret)
        if gdata:
            aff_ev = gdata.pop("affair_event", None)  # 事务阶段推进 → 看板实时刷新
            if aff_ev:
                yield _sse(aff_ev)
            if is_secret:
                gdata["secret"] = True
            if gdata.get("added_nodes") or gdata.get("added_edges") or gdata.get("updated"):
                yield _sse({"type": "memory", **gdata})


async def _open_affair(sess, a_store, message: str, hit: dict) -> dict | None:
    """把一句需求变成一个事务（不额外调 LLM：用消息与前几个命中节点拼出事务）。"""
    try:
        linked = [n["id"] for n in hit["nodes"][:3]]
        title = re.sub(r"[，。！？!?~～\s]+", "", message)[:18] or "新的事"
        snapshot = a_store.list()
        # 同一件事已在看板上就不重复建
        for it in snapshot:
            if it["title"][:6] and it["title"][:6] in message:
                return None
        affair = a_store.create({
            "title": title,
            "kind": "event",
            "stage": "planning",
            "owner_next": "butler",
            "summary": "管家正在筹备",
            "linked_nodes": linked,
            "progress": {"mode": "none", "value": 0},
            "log": [{"ts": datetime.now().isoformat(timespec="seconds"), "actor": "butler",
                     "text": f"接下这件事：{message[:40]}"}],
        })
        return affair
    except Exception as e:  # noqa: BLE001 建事务失败不影响出方案
        print(f"[affair] 创建失败：{e}")
        return None


async def _execute_actions(sess, a_store, affair: dict, card: dict, message: str, emit) -> None:
    """规划完了真去执行：加提醒、生成清单、必要时请家长确认。"""
    to_run = []
    # 提醒：从卡片里挑"提醒/注意"类的条目
    reminders = []
    for sec in card.get("sections", []):
        if any(k in str(sec.get("heading", "")) for k in ("提醒", "注意", "健康", "准备")):
            reminders.extend(str(i) for i in sec.get("items", []))
    for text in reminders[:3]:
        to_run.append({"kind": "reminder", "text": text[:40]})
    # 清单
    checklist_items = _make_checklist_from_card(card)
    if checklist_items:
        to_run.append({"kind": "checklist", "title": "携带清单", "items": checklist_items})
    # 需要家长出手的（出行/付费类）：只用明确的出行/参赛词，"我想去学钢琴"这类不算
    if any(k in message for k in ("比赛", "出行", "参加", "报名", "行程", "车票", "机票", "酒店", "出发")) \
            and affair.get("kind") in ("travel", "event"):
        to_run.append({
            "kind": "parent_confirm",
            "title": f"{affair['title']}：需要家长帮忙确认的事",
            "detail": "管家已把行程与清单准备好，请家长确认交通与报名相关事项。",
        })

    for act in to_run:
        try:
            result = await actions.run_action(sess.dir, affair, act)
            await emit({"type": "action", **result})
            if result.get("ok"):
                a_store.update(affair["id"], {
                    "actions": (affair.get("actions") or []) + [act],
                }, actor="butler", note=f"执行了 {act['kind']}")
        except Exception as e:  # noqa: BLE001 单个动作失败不拖垮整链
            await emit({"type": "action", "kind": act.get("kind", "?"), "ok": False, "detail": str(e), "payload": {}})


@app.post("/api/chat")
async def api_chat(request: Request, req: ChatReq):
    _, sess = await _auth_session(request, "chat", req.name)
    try:
        await asyncio.wait_for(sess.lock.acquire(), timeout=0.3)
    except asyncio.TimeoutError:
        raise HTTPException(429, "管家还在回复上一条，稍等一下哦")

    async def guarded():
        try:
            async for chunk in _chat_stream(sess, req.message):
                yield chunk
        finally:
            sess.lock.release()

    return StreamingResponse(
        guarded(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- 图谱 / 事务 / 清单

@app.get("/api/graph")
async def api_graph(request: Request, name: str = "", view: str = "child"):
    user, sess = await _auth_session(request, "graph", name)
    if user["role"] == "parent":
        view = "parent"  # 家长视角的私密过滤在服务端强制，不信客户端参数
    g, _, _ = _stores(sess)
    return g.export(view=view)


@app.get("/api/affairs")
async def api_affairs(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "affairs", name)
    _, a, _ = _stores(sess)
    return a.snapshot()


@app.post("/api/affairs")
async def api_affairs_write(request: Request, req: AffairReq):
    _, sess = await _auth_session(request, "affairs", req.name)
    _, a, _ = _stores(sess)
    patch = req.patch or req.data or {}
    try:
        if req.id and a.get(req.id):
            return {"affair": a.update(req.id, patch, actor="user", note="看板更新")}
        return {"affair": a.create(patch or {"title": "新的事"})}
    except ValueError as e:  # 非法 stage 等校验错误 → 400，而不是 500
        raise HTTPException(400, str(e))


@app.get("/api/affairs/{aid}")
async def api_affair_detail(request: Request, aid: str, name: str = ""):
    _, sess = await _auth_session(request, "affairs", name)
    _, a, _ = _stores(sess)
    affair = a.get(aid)
    if affair is None:
        raise HTTPException(404, "事务不存在")
    return {"affair": affair}


@app.get("/api/checklist/{cid}")
async def api_checklist_get(request: Request, cid: str, name: str = ""):
    _, sess = await _auth_session(request, "checklist", name)
    _, a, _ = _stores(sess)
    try:
        return {"checklist": a.checklist(cid)}
    except KeyError:
        raise HTTPException(404, "清单不存在")


@app.post("/api/checklist/{cid}")
async def api_checklist(request: Request, cid: str, req: ChecklistReq):
    _, sess = await _auth_session(request, "checklist", req.name)
    _, a, _ = _stores(sess)
    try:
        return {"checklist": a.toggle_item(cid, req.index, req.done)}
    except (KeyError, IndexError):
        raise HTTPException(404, "清单项不存在")


@app.get("/api/ics/{aid}")
async def api_ics(request: Request, aid: str, name: str = ""):
    _, sess = await _auth_session(request, "ics", name)
    _, a, _ = _stores(sess)
    try:
        ics = a.ics(aid)
    except KeyError:
        raise HTTPException(404, "事务不存在")
    return PlainTextResponse(
        ics,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{aid}.ics"'},
    )


# ---------------------------------------------------------------- 家长侧

@app.get("/api/parent/inbox")
async def api_inbox(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "inbox", name)
    g, a, _ = _stores(sess)
    items = a.inbox()
    secrets = [n for n in g.load().get("nodes", []) if n.get("private")]
    return {"items": items, "secret_count": len(secrets)}


@app.post("/api/parent/inbox/{iid}")
async def api_inbox_decide(request: Request, iid: str, req: InboxReq):
    _, sess = await _auth_session(request, "inbox", req.name)
    _, a, _ = _stores(sess)
    try:
        item = a.decide_inbox(iid, req.action, req.reply)
    except KeyError:
        raise HTTPException(404, "该事项不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if item.get("affair_id"):
        note = "家长已确认" if req.action == "approve" else "家长驳回，需另想办法"
        try:
            a.advance(item["affair_id"], "followup" if req.action == "approve" else "executing",
                      actor="parent", note=note)
        except KeyError:
            pass
    return {"item": item}


async def _do_relay(sess, direction: str, text: str) -> dict:
    g, _, _ = _stores(sess)
    # 结构性隔离（参考 OpenPanda isolation.go）：传话筒的产出是给家长/老师看的，
    # 记忆只能来自图谱层——brief_block/recall 在构造上就剔除了 private 节点，
    # 文件层记忆（可能混入心事）没有任何代码路径会进入这条 prompt。
    mem = g.brief_block(limit=24)
    rec = g.recall(text, limit=3)["block"]
    if rec:
        mem = f"{mem}\n\n和这段话相关的记忆：\n{rec}" if mem else rec
    tpl = prompts.RELAY_T2P if direction == "teacher2parent" else prompts.RELAY_C2T
    prompt = tpl.format(
        name=sess.name, text=text,
        memory_block=mem or "（暂无记忆）",
    )
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": prompt}],
            max_tokens=700,
            caller="relay",
        )
    except Exception:  # noqa: BLE001
        # 模型两次都没吐出 JSON 时降级：直接要一段纯文本译文，别让按钮整个报错
        try:
            raw = await llm.complete(
                [{"role": "user", "content":
                  prompt + "\n\n（注意：不要输出 JSON，直接把整理好的那段话写出来，两三句话即可。）"}],
                max_tokens=500, temperature=0.4, caller="relay")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"翻译失败：{e}")
        raw = raw.strip()
        if not raw:
            raise HTTPException(502, "翻译失败：模型没有给出内容")
        if direction == "teacher2parent":
            return {"direction": direction, "parent_text": raw,
                    "advice": "", "child_text": ""}
        return {"direction": direction, "message": raw, "advice": ""}
    if direction == "teacher2parent":
        return {
            "direction": direction,
            "parent_text": str(data.get("parent_text", "")),
            "advice": str(data.get("advice", "")),
            "child_text": str(data.get("child_text", "")),
        }
    return {"direction": direction, "message": str(data.get("message", "")),
            "advice": str(data.get("advice", ""))}


@app.post("/api/relay")
async def api_relay(request: Request, req: RelayReq):
    _, sess = await _auth_session(request, "relay", req.name)
    return await _do_relay(sess, req.direction, req.text)


# ---------------------------------------------------------------- 成长雷达 / 梦想

_DOMAIN_CN = {"ethics": "德", "intellect": "智", "health": "体", "aesthetics": "美", "labor": "劳"}
_STATUS_FACTOR = {"done": 1.15, "active": 1.0, "dropped": 0.35}


def _growth_stats(g: graph.GraphStore, view: str) -> dict:
    """五育雷达：从记忆图谱确定性统计（提及权重 × 新近度 × 状态加成），不靠 LLM 猜。"""
    nodes = g.load()["nodes"]
    if view == "parent":
        nodes = [n for n in nodes if not n.get("private")]
    today = date.today()
    dims = []
    for dom in graph.DOMAINS:
        members = [n for n in nodes if n.get("domain") == dom]
        engagement = 0.0
        evidence = []
        for n in members:
            try:
                age = max(0, (today - date.fromisoformat(str(n.get("last_seen"))[:10])).days)
            except ValueError:
                age = 540
            recency = 0.45 + 0.55 * max(0.0, 1 - age / 540)
            factor = _STATUS_FACTOR.get(n.get("status"), 1.0)
            engagement += int(n.get("weight") or 1) * recency * factor
            for f in n.get("facts") or []:
                if isinstance(f, dict) and f.get("text"):
                    evidence.append({"date": str(f.get("date") or ""), "text": str(f["text"]),
                                     "node_id": n["id"], "node": str(n.get("label") or n["id"])})
        score = round(100 * (1 - pow(2.718281828, -engagement / 55)))
        if members:
            score = max(10, min(96, score))
        evidence.sort(key=lambda x: x["date"], reverse=True)
        dims.append({
            "domain": dom, "name": _DOMAIN_CN[dom], "score": score,
            "nodes": len(members), "evidence": evidence[:3],
        })
    return {
        "dimensions": dims,
        "totals": {"nodes": len(nodes), "edges": len(g.load()["edges"]),
                   "done": sum(1 for n in nodes if n.get("status") == "done")},
        "source": "graph",
    }


@app.get("/api/growth")
async def api_growth(request: Request, name: str = "", view: str = "child"):
    user, sess = await _auth_session(request, "growth", name)
    if user["role"] == "parent":
        view = "parent"  # 服务端强制：家长看不到悄悄话节点
    g, _, m = _stores(sess)
    data = _growth_stats(g, "parent" if view == "parent" else "child")
    # 一句点评：LLM 可用就生成，失败就省略（数据本身已经够看）
    try:
        dims_txt = "，".join(f"{d['name']} {d['score']}" for d in data["dimensions"])
        ev_txt = "；".join(
            f"{e['node']}：{e['text']}" for d in data["dimensions"] for e in d["evidence"][:1]
        ) or "（暂无）"
        data["comment"] = (await llm.complete(
            [{"role": "user", "content": prompts.GROWTH_NOTE.format(
                name=sess.name, dims=dims_txt, evidence=ev_txt)}],
            max_tokens=500, caller="growth")).strip()
    except Exception:  # noqa: BLE001 点评是锦上添花，绝不挡数据
        data["comment"] = ""
    return data


@app.post("/api/dream")
async def api_dream(request: Request, req: DreamReq):
    """「说说我的梦想」：孩子说梦想 → 接住并落成记忆；没说 → 主动邀请。"""
    _, sess = await _auth_session(request, "dream", req.name)
    mem_block = sess.store.active_block() or "（还没有记忆，慢慢了解中）"
    g, a, _ = _stores(sess)
    graph_brief = g.brief_block(limit=20)
    if graph_brief:
        mem_block = f"{mem_block}\n\n{graph_brief}"
    text = req.text.strip()
    try:
        tpl = prompts.DREAM if text else prompts.DREAM_INVITE
        reply = (await llm.complete(
            [{"role": "user", "content": tpl.format(name=sess.name, text=text or "（还没说）",
                                                    memory_block=mem_block)}],
            max_tokens=700, caller="dream")).strip()
    except llm.LLMError as e:
        if text:
            raise HTTPException(502, f"管家的大脑暂时连不上啦：{e}")
        # 邀请语降级：用本地数据说实话
        tops = sorted(g.load()["nodes"], key=lambda n: -int(n.get("weight") or 1))
        hot = tops[0]["label"] if tops else ""
        reply = (f"我注意到你最近一直在惦记「{hot}」，这里面藏着你的梦想吗？跟我说说～"
                 if hot else "今天第一次见，来说说你的梦想吧，我帮你记着。")
        return {"text": reply, "llm": False}
    out = {"text": reply, "llm": True}
    if text:
        gdata = await _settle_memory(sess, f"我的梦想：{text}", reply)
        if gdata and (gdata.get("added_nodes") or gdata.get("added_edges") or gdata.get("updated")):
            out["memory"] = gdata
    return out


# ---------------------------------------------------------------- 记忆 / 历史 / 日志

@app.get("/api/memory")
async def api_memory(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "memory", name)
    return sess.store.export()


@app.get("/api/history")
async def api_history(request: Request, name: str = ""):
    user, sess = await _auth_session(request, "history", name)
    hist = list(sess.history)
    if user["role"] == "parent":
        # 服务端强制过滤悄悄话轮（secret 标记 + 兼容旧的 [[secret]] 前缀记录）
        hist = [m for m in hist if not m.get("secret")
                and not str(m.get("content", "")).startswith(SECRET_PREFIX)]
    return {"history": hist}


@app.get("/api/logs")
async def api_logs(request: Request, limit: int = 50):
    """LLM 调用日志：评委可据此核验全部输出为真实生成。仅 admin。"""
    _need(_user(request), "logs")
    return {"calls": llm.read_logs(min(limit, 200))}


@app.get("/api/health")
async def api_health():
    return {"ok": True, "llm_configured": bool(config.LLM_API_KEY), "protocol": config.LLM_PROTOCOL}


@app.get("/")
async def index():
    return FileResponse(config.WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=config.WEB_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host=config.HOST, port=config.PORT, reload=False)
