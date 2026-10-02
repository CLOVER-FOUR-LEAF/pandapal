"""PandaButler Server：FastAPI 应用与 API 端点。

端点：
  POST /api/session   登录选档：名字 → 绑定 data/{child}/ 档案目录
  GET  /api/greeting  开场主动问候（记忆驱动生成）
  POST /api/chat      对话主入口（SSE 流：闲聊 token 流 / 规划链节点状态+卡片）
  GET  /api/memory    记忆本页数据
  GET  /api/health    健康检查
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, executor, llm, memory, planner, prompts, router, sessions, synth

app = FastAPI(title="PandaButler", docs_url=None, redoc_url=None)

_background: set[asyncio.Task] = set()


def _bg(task: asyncio.Task) -> None:
    _background.add(task)
    task.add_done_callback(_background.discard)


class SessionReq(BaseModel):
    name: str = Field(min_length=1, max_length=24)


class ChatReq(BaseModel):
    name: str = Field(min_length=1, max_length=24)
    message: str = Field(min_length=1, max_length=2000)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _get_session(name: str):
    try:
        return await sessions.login(name)
    except ValueError:
        raise HTTPException(400, "名字不能为空")


@app.post("/api/session")
async def api_session(req: SessionReq):
    sess = await _get_session(req.name)
    return {"name": sess.name, "is_new": sess.is_new, "child": sess.store.child_name}


@app.get("/api/greeting")
async def api_greeting(name: str):
    sess = await _get_session(name)
    block = sess.store.active_block()
    try:
        text = await llm.complete(
            [{"role": "user", "content": prompts.GREETING.format(
                name=sess.name,
                now=datetime.now().strftime("%Y-%m-%d %H:%M 星期") + "一二三四五六日"[datetime.now().weekday()],
                memory_block=block or "（还没有记忆，这是第一次见面）",
            )}],
            max_tokens=200,
        )
    except llm.LLMError as e:
        raise HTTPException(502, f"LLM 暂不可用：{e}")
    return {"text": text.strip()}


def _chat_messages(sess, message: str) -> list[dict]:
    """人设 + 活跃关注点块 + 相关主题检索 + 历史尾部。"""
    system = prompts.PERSONA.format(name=sess.name)
    active = sess.store.active_block()
    related = sess.store.retrieve(message)
    mem_parts = []
    if active:
        mem_parts.append(f"你一直记得的关于 {sess.name} 的事：\n{active}")
    if related:
        mem_parts.append(f"和这次聊天可能相关的记忆：\n{related}")
    if mem_parts:
        system += "\n\n" + "\n\n".join(mem_parts)
    msgs = [{"role": "system", "content": system}]
    msgs.extend(sess.history)
    msgs.append({"role": "user", "content": message})
    return msgs


async def _chat_stream(sess, message: str):
    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def emit(event: dict) -> None:
        await queue.put(event)

    reply_text = ""

    async def work():
        nonlocal reply_text
        kind = await router.classify(message)
        if kind == "plan":
            await emit({"type": "mode", "mode": "plan"})
            try:
                plan = await planner.make_plan(sess.store, message)
            except planner.PlanError:
                plan = None
            if plan:
                await emit({
                    "type": "plan", "title": plan["title"],
                    "nodes": [{"id": n["id"], "title": n["title"], "depends_on": n["depends_on"]}
                              for n in plan["nodes"]],
                })
                results = await executor.run_plan(plan, sess.store, message, emit)
                card = await synth.synthesize(sess.store, message, results)
            else:
                # 保底：DAG 失败时单次调用直出卡片（仍为真实生成，只无过程展示）
                card = await synth.direct_card(sess.store, message)
            await emit({"type": "card", "card": card})
            reply_text = synth.card_to_text(card)
        else:
            await emit({"type": "mode", "mode": "chat"})
            chunks = []
            async for tok in llm.stream(_chat_messages(sess, message), max_tokens=600):
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
    # 轮后：历史尾部 + 异步沉淀记忆
    if reply_text:
        sess.history.append({"role": "user", "content": message})
        sess.history.append({"role": "assistant", "content": reply_text})
        _bg(asyncio.create_task(memory.extract_and_store(sess.store, message, reply_text)))


@app.post("/api/chat")
async def api_chat(req: ChatReq):
    sess = await _get_session(req.name)
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


@app.get("/api/memory")
async def api_memory(name: str):
    sess = await _get_session(name)
    return sess.store.export()


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
