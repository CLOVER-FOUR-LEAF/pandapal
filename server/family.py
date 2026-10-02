"""家庭侧服务：家长周报 / 通知落地 / 童年备忘录导出。

  GET  /api/parent/weekly  家长周报：本周事务进展 + 记忆里的新变化 → LLM 写成一页周报
  POST /api/notice         学校/机构通知 → 按孩子记忆出专属版 + 自动建事务/清单/提醒
                           （admin 可带 names 批量下发："一份通知，千家千版"）
  GET  /api/export         童年备忘录：把孩子档案目录原样打包成 zip 交还给孩子

隐私边界与传话筒一致（参考 OpenPanda isolation.go）：周报和通知的产出会给家长看，
记忆只取图谱层——brief_block/recall 在构造上剔除 private 节点，文件层记忆没有代码路径
进入这两条 prompt；本周事实统计同样先滤掉 private。导出只给孩子本人（和 admin）：
那是孩子自己的档案，悄悄话也在里面。

挂在 main.py 末尾 include_router，因此这里要用 main 里的鉴权/会话辅助；但**不能在顶层
import**：`python -m server.main` 时本模块的入口名是 __main__，顶层 `from .main import`
会让 server.main 被当作另一个模块二次导入，触发 main ↔ family 循环导入而启动失败
（uvicorn 直接 import server.main:app 时反而正常，问题只在 -m 启动路径上暴露）。
"""
from __future__ import annotations

import asyncio
import io
import re
import sys
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import actions, auth, graph, llm, prompts, sessions, store
from .affairs import STAGE_CN, AffairStore

router = APIRouter()


# 被 main 导入时（include_router），绑定的就是那个 main 模块本身——
# 不能每次调用都按名字去 sys.modules 现查：server 包被重新导入后（pytest 里
# 多个测试文件各用一个沙箱）现查会拿到另一套 auth/会话，token 对不上直接 401。
# `python -m server.main` 时 main 的模块名是 __main__，这里拿不到，退回延迟导入。
_MAIN = sys.modules.get(f"{__package__}.main")


def _m():
    """取 main 的鉴权/会话辅助（避免顶层循环导入，见模块 docstring）。"""
    global _MAIN
    if _MAIN is None:
        from . import main as _loaded
        _MAIN = _loaded
    return _MAIN



# ---------------------------------------------------------------- 家长周报

def _in_window(ts: str, since: date) -> bool:
    try:
        return date.fromisoformat(str(ts)[:10]) >= since
    except ValueError:
        return False


def _weekly_collect(a: AffairStore, g: graph.GraphStore, days: int) -> dict:
    """确定性统计本周发生了什么（随 to_thread 整体离事件循环）。全程剔除 private。"""
    since = date.today() - timedelta(days=days)
    affairs_all = a.list(include_done=True)  # 含已结案：周报要说"这周办完了什么"
    moved, created, closed = [], [], []
    for it in affairs_all:
        if not isinstance(it, dict):
            continue
        logs = [e for e in it.get("log") or [] if isinstance(e, dict) and _in_window(e.get("ts"), since)]
        if _in_window(it.get("created"), since):
            created.append(it)
        if it.get("stage") == "done" and logs:
            closed.append(it)
        elif logs:
            moved.append({"title": it.get("title"), "stage": STAGE_CN.get(it.get("stage"), it.get("stage")),
                          "owner_next": it.get("owner_next"), "due": it.get("due"),
                          "events": [str(e.get("text"))[:40] for e in logs[-3:]]})
    gdata = g.load()
    facts = []
    for n in gdata["nodes"]:
        if n.get("private"):
            continue
        for f in n.get("facts") or []:
            if isinstance(f, dict) and _in_window(f.get("date"), since) and f.get("text"):
                facts.append({"date": str(f["date"])[:10], "node": str(n.get("label") or n["id"]),
                              "type": n.get("type"), "text": str(f["text"])[:80]})
    facts.sort(key=lambda x: x["date"], reverse=True)
    new_nodes = [str(n.get("label")) for n in gdata["nodes"]
                 if not n.get("private") and _in_window(n.get("first_seen"), since)]
    pending = [i for i in a.inbox() if i.get("status") == "pending"]
    secrets = sum(1 for n in gdata["nodes"] if n.get("private"))
    return {
        "since": since.isoformat(), "until": date.today().isoformat(),
        "stats": {"affairs_open": sum(1 for i in affairs_all if isinstance(i, dict) and i.get("stage") != "done"),
                  "created": len(created), "closed": len(closed), "moved": len(moved),
                  "new_memories": len(facts), "inbox_pending": len(pending), "secret_count": secrets},
        "moved": moved[:6], "closed": [str(i.get("title")) for i in closed][:6],
        "created": [str(i.get("title")) for i in created][:6],
        "facts": facts[:12], "new_nodes": new_nodes[:8],
        "due": a.due_soon(days=14, items=[i for i in affairs_all if isinstance(i, dict)]),
        "graph_block": g.brief_block(limit=20, g=gdata),
    }


def _weekly_fallback(name: str, d: dict) -> dict:
    """LLM 不可用时只用统计数据说实话，不伪造生成。"""
    s = d["stats"]
    hl = (f"这周管家替{name}盯着 {s['affairs_open']} 件事，推进了 {s['moved']} 件、"
          f"办完 {s['closed']} 件，记下 {s['new_memories']} 条新变化。")
    return {"headline": hl,
            "highlights": [f"{m['title']}：{m['stage']}" for m in d["moved"][:3]],
            "watch": [f"{x['title']} {x['due']}（{x['days']} 天后）" for x in d["due"][:2]],
            "suggestion": "", "praise": "", "llm": False}


def _weekly_prompt(name: str, d: dict) -> str:
    moved = "\n".join(f"- {m['title']}（{m['stage']}，下一步该 {m['owner_next']}）：{'；'.join(m['events'])}"
                      for m in d["moved"]) or "（本周没有推进的事务）"
    facts = "\n".join(f"- {f['date']} [{f['node']}] {f['text']}" for f in d["facts"]) or "（本周没有新记下的事）"
    due = "\n".join(f"- {x['title']}：{x['due']}（还有 {x['days']} 天）" for x in d["due"]) or "（两周内没有截止）"
    return prompts.WEEKLY.format(
        name=name, since=d["since"], until=d["until"], moved=moved,
        closed="、".join(d["closed"]) or "（无）", created="、".join(d["created"]) or "（无）",
        facts=facts, due=due, memory_block=d["graph_block"] or "（暂无）")


@router.get("/api/parent/weekly")
async def api_weekly(request: Request, name: str = "", days: int = 7):
    _, sess = await _m()._auth_session(request, "weekly", name)
    g, a, _ = _m()._stores(sess)
    days = max(1, min(int(days), 31))
    d = await asyncio.to_thread(_weekly_collect, a, g, days)
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": _weekly_prompt(sess.name, d)}],
            max_tokens=900, caller="weekly")
        report = {
            "headline": str(data.get("headline") or "").strip(),
            "highlights": [str(x) for x in data.get("highlights") or [] if str(x).strip()][:4],
            "watch": [str(x) for x in data.get("watch") or [] if str(x).strip()][:3],
            "suggestion": str(data.get("suggestion") or "").strip(),
            "praise": str(data.get("praise") or "").strip(),
            "llm": True,
        }
        if not report["headline"]:
            raise ValueError("周报缺 headline")
    except Exception as e:  # noqa: BLE001 周报写不出来也要给家长看到统计
        print(f"[weekly] LLM 不可用，已降级：{e}")
        report = _weekly_fallback(sess.name, d)
    return {"name": sess.name, "since": d["since"], "until": d["until"],
            "stats": d["stats"], "report": report}


# ---------------------------------------------------------------- 通知落地

class NoticeReq(BaseModel):
    name: str = Field(default="", max_length=24)
    names: list[str] | None = Field(default=None, max_length=30)  # 仅 admin：批量下发
    text: str = Field(min_length=4, max_length=2000)
    source: str = Field(default="老师", max_length=20)


def _flat(text: str) -> str:
    return re.sub(r"[^\w一-鿿]+", "", text or "")


def _claim(a: AffairStore, title: str) -> dict | None:
    """同一份通知重复粘贴不重复建单：标题 bigram 覆盖率 ≥1/2 视为同一件事。"""
    grams = store.bigrams(_flat(title))
    if not grams:
        return None
    for it in a.list():
        t = store.bigrams(_flat(it.get("title")))
        if t and len(t & grams) / len(t) >= 0.5:
            return it
    return None


async def _land_notice(sess, text: str, source: str) -> dict:
    """一个孩子的落地：LLM 读通知+记忆 → 专属版文案 → 事务/清单/提醒真落盘。"""
    g, a, _ = _m()._stores(sess)
    mem = await asyncio.to_thread(g.brief_block, limit=24)
    rec = (await asyncio.to_thread(g.recall, text, limit=3))["block"]
    if rec:
        mem = f"{mem}\n\n和这份通知相关的记忆：\n{rec}" if mem else rec
    brief = await asyncio.to_thread(_m()._affairs_brief, a, 6)
    data = await llm.complete_json(
        [{"role": "user", "content": prompts.NOTICE.format(
            name=sess.name, now=_m()._now_text(), source=source, text=text,
            affairs_brief=brief, memory_block=mem or "（暂无记忆）")}],
        max_tokens=1200, caller="notice")
    title = str(data.get("title") or "").strip()[:18] or "学校通知"
    due = str(data.get("due") or "").strip() or None
    checklist = [str(x).strip() for x in data.get("checklist") or [] if str(x).strip()][:10]
    reminders = [r for r in data.get("reminders") or [] if isinstance(r, dict) and r.get("text")][:3]
    personal = [str(x).strip() for x in data.get("personal") or [] if str(x).strip()][:3]
    linked = [n["id"] for n in (await asyncio.to_thread(g.recall, text, limit=3))["nodes"][:3]]

    old = await asyncio.to_thread(_claim, a, title)
    summary = str(data.get("summary") or "").strip()[:120] or f"{source}发来的通知，管家已接手"
    if old:
        affair = await asyncio.to_thread(a.update, old["id"], {"summary": summary, "due": due or old.get("due")},
                                         actor="butler", note=f"{source}又发了通知：{title}")
        created = False
    else:
        affair = await asyncio.to_thread(a.create, {
            "title": title, "kind": str(data.get("kind") or "event"), "stage": "planning",
            "owner_next": "child", "summary": summary, "due": due, "linked_nodes": linked,
            "progress": {"mode": "none", "value": 0}, "actor": "butler", "source": "notice",
        })
        created = True

    results = []
    to_run = []
    if checklist:
        to_run.append({"kind": "checklist", "title": f"{title}清单", "items": checklist})
    for r in reminders:
        to_run.append({"kind": "reminder", "text": str(r["text"])[:40], "at": r.get("at") or affair.get("due")})
    if affair.get("due") and not reminders:
        to_run.append({"kind": "reminder", "text": f"截止：{title}", "at": affair["due"]})
    patch: dict = {}
    for act in to_run:
        res = await actions.run_action(sess.dir, affair, act)
        results.append(res)
        if res.get("ok") and act["kind"] == "checklist":
            cid = (res.get("payload") or {}).get("checklist_id")
            if cid:  # 清单回挂事务，否则详情抽屉够不着
                patch["checklist_id"] = cid
                affair["checklist_id"] = cid
    if patch:
        affair = await asyncio.to_thread(a.update, affair["id"], patch, actor="butler",
                                         note=f"按通知建好清单 {len(checklist)} 项")
    return {
        "name": sess.name,
        "affair": affair, "created": created,
        "parent_text": str(data.get("parent_text") or "").strip(),
        "child_text": str(data.get("child_text") or "").strip(),
        "personal": personal,
        "actions": [{"kind": r.get("kind"), "ok": r.get("ok"), "detail": r.get("detail")} for r in results],
    }


@router.post("/api/notice")
async def api_notice(request: Request, req: NoticeReq):
    user = _m()._user(request)
    _m()._need(user, "notice")
    if req.names:
        # 批量下发是机构侧能力：只有 admin（代表学校/机构账号）能一次覆盖多个孩子
        if user["role"] != "admin":
            raise HTTPException(403, "只有机构账号能批量下发通知")
        names = list(dict.fromkeys(n.strip() for n in req.names if n and n.strip()))[:30]
        known = sessions._read_profiles()
        missing = [n for n in names if n not in known]
        if missing:  # 批量下发只发给已有档案的孩子，名字打错不能顺手建出一堆空档
            raise HTTPException(400, f"这些孩子还没有档案：{'、'.join(missing)}")
    else:
        try:
            names = [auth.resolve_child(user, req.name)]
        except PermissionError as e:
            raise HTTPException(403, str(e))
    sem = asyncio.Semaphore(4)

    async def one(n: str) -> dict:
        async with sem:
            try:
                sess = await _m()._get_session(n)
                return await _land_notice(sess, req.text.strip(), req.source.strip() or "老师")
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001 一家失败不影响其它家
                print(f"[notice] {n} 落地失败：{e}")
                return {"name": n, "error": f"这份通知没落地成功：{e}"}

    out = await asyncio.gather(*(one(n) for n in names))
    if len(out) == 1 and out[0].get("error"):
        raise HTTPException(502, out[0]["error"])
    return {"results": out}


# ---------------------------------------------------------------- 童年备忘录导出

_EXPORT_README = """熊猫管家 · 童年备忘录
====================

这是 {name} 的完整成长档案，导出于 {now}。

数据即文件：这里的每一份文件就是管家记住的全部，没有藏在别处的副本。
  MEMORY.md / topics/ / daily/   管家的文字记忆（长期记忆、主题、每日沉淀）
  graph.json                      记忆星球（成长图谱）
  affairs.json                    一件件办过的事
  checklists.json / reminders.json / drafts.json   清单、提醒、管家代写的文稿
  history.json                    最近的对话

这份档案属于 {name} 本人。里面也有只对你说过的悄悄话，请自己保管好。
"""


def _build_zip(child_dir: Path, name: str) -> bytes:
    buf = io.BytesIO()
    root = child_dir.resolve()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", _EXPORT_README.format(
            name=name, now=datetime.now().strftime("%Y-%m-%d %H:%M")))
        for p in sorted(child_dir.rglob("*")):
            # 只打包档案目录里的普通文件：跳过符号链接与原子写残留的临时文件
            if p.is_symlink() or not p.is_file() or p.name.endswith(".tmp") or p.name.startswith("."):
                continue
            if root not in p.resolve().parents:
                continue
            z.write(p, p.relative_to(child_dir).as_posix())
    return buf.getvalue()


@router.get("/api/export")
async def api_export(request: Request, name: str = ""):
    _, sess = await _m()._auth_session(request, "export", name)
    data = await asyncio.to_thread(_build_zip, Path(sess.dir), sess.name)
    fname = f"童年备忘录-{sess.name}-{date.today().isoformat()}.zip"
    safe = f"panda-memoir-{date.today().isoformat()}.zip"  # ASCII 兜底名；中文名走 filename*
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(fname)}"})
