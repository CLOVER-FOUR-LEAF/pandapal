"""动作执行器：把规划里的"动作"真的落到档案上。

契约 §3.4 的五种 kind：
  reminder       追加一条提醒（reminders.json）
  checklist      建 / 补一份携带清单（checklists.json）
  parent_confirm 请家长确认一件事（parent_inbox.json，status=pending）
  ics            生成日历文本，只回传不落盘（前端做下载）
  draft          代办文书：LLM 真写一份文稿（自我介绍/申请书/信/总结），
                 落盘 drafts.json 并挂回事务——"说一件事，给我一个结果"

写入一律走 `store.write_json`（原子写）+ `store.lock_for`（按目录写锁），
清单/收件箱/文稿复用 `affairs.AffairStore`，不另起一套读写。
未知 kind 不抛异常，返回 ok=False 让上层把回执发给前端就行。
"""
from __future__ import annotations

import asyncio
import io
import re
import uuid
from datetime import date
from pathlib import Path

from . import files, llm, prompts, tools
from .affairs import AffairStore, ics_text
from .memory import MemoryStore
from .store import lock_for, read_json, slug, write_json

KINDS = ("reminder", "checklist", "parent_confirm", "ics", "draft")
# 规划节点可能给这些别名，统一归到五种 kind 上
_ALIAS = {
    "remind": "reminder", "提醒": "reminder",
    "todo": "checklist", "pack": "checklist", "清单": "checklist",
    "confirm": "parent_confirm", "parent": "parent_confirm", "家长确认": "parent_confirm",
    "calendar": "ics", "ical": "ics", "日历": "ics",
    "doc": "draft", "document": "draft", "essay": "draft", "letter": "draft",
    "文稿": "draft", "写稿": "draft", "起草": "draft",
}
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_WEEKDAYS_CN = {"mon": "周一", "tue": "周二", "wed": "周三", "thu": "周四", "fri": "周五", "sat": "周六", "sun": "周日"}
_CN_WEEK = {"一": "mon", "二": "tue", "三": "wed", "四": "thu", "五": "fri", "六": "sat", "日": "sun", "天": "sun"}


def _norm_kind(kind: str) -> str:
    k = str(kind or "").strip().lower()
    return _ALIAS.get(k, k)


def _time_value(raw: str) -> tuple[str, str]:
    """提醒时间 → (存库值, 人话)。

    支持 existing 档案里的三种写法：daily / weekly:sat / YYYY-MM-DD，
    外加 weekly-sat、周六、sat 这些变体，认不出的一律当每天。
    """
    t = str(raw or "daily").strip()
    low = t.lower()
    if low in ("daily", "everyday", "每天", "每日"):
        return "daily", "每天"
    if low in ("weekly", "每周", "周"):
        return "weekly:sat", "每周六"
    m = re.match(r"^weekly[:：_-]?([a-z]{3})$", low) or re.match(r"^([a-z]{3})$", low)
    if m and m.group(1) in _WEEKDAYS_CN:
        wd = m.group(1)
        return f"weekly:{wd}", f"每{_WEEKDAYS_CN[wd]}"
    m = re.match(r"^(?:每)?周([一二三四五六日天])$", t)
    if m:
        wd = _CN_WEEK[m.group(1)]
        return f"weekly:{wd}", f"每{_WEEKDAYS_CN[wd]}"
    # "10/17"、"10-17"、"10月17日" 这类没年份的写法，补今年
    m = re.match(r"^(\d{1,2})(?:[/\-.月])(\d{1,2})日?$", t)
    if m:
        try:
            return date(date.today().year, int(m.group(1)), int(m.group(2))).isoformat(), t
        except ValueError:
            pass
    try:
        return date.fromisoformat(low.replace("/", "-")[:10]).isoformat(), t
    except ValueError:
        return "daily", "每天"


def _items(spec) -> list[dict]:
    """清单项规整：允许 ["学生证", ...] 或 [{"text","note"}, ...]。"""
    if isinstance(spec, (str, dict)):
        spec = [spec]
    out: list[dict] = []
    seen: set[str] = set()
    for raw in spec or []:
        if isinstance(raw, str):
            raw = {"text": raw}
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or raw.get("title") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append({"text": text, "done": bool(raw.get("done")), "note": str(raw.get("note") or "").strip()})
    return out


def _result(kind: str, ok: bool, detail: str, payload: dict) -> dict:
    """固定返回结构（契约 §3.4）。"""
    return {"kind": kind, "ok": ok, "detail": detail, "payload": payload}


def _reminders_path(child_dir: Path) -> Path:
    return child_dir / "reminders.json"


def _new_rid(taken: set[str]) -> str:
    for _ in range(64):
        rid = f"r_{uuid.uuid4().hex[:8]}"
        if rid not in taken:
            return rid
    return f"r_{uuid.uuid4().hex[:12]}"


async def run_action(child_dir: Path, affair: dict, action: dict) -> dict:
    """执行一个动作并落盘；异常在内部消化成 ok=False 的回执。"""
    affair = affair or {}
    action = action or {}
    kind = _norm_kind(action.get("kind"))
    # draft 的大头是 LLM 写稿（秒级），攥着目录写锁等它会堵住别的写入：
    # 先在锁外生成，锁内只做文件落盘（_do_draft 内部处理）
    if kind == "draft":
        try:
            return await _do_draft(Path(child_dir), affair, action)
        except Exception as e:  # noqa: BLE001
            return _result("draft", False, f"文稿没写成：{e}", {})
    store = AffairStore(child_dir)
    lock = lock_for(Path(child_dir))  # 契约 §3.1：普通函数，返回 asyncio.Lock
    try:
        async with lock:
            if kind == "reminder":
                return await asyncio.to_thread(_do_reminder, child_dir, affair, action)
            if kind == "checklist":
                return await asyncio.to_thread(_do_checklist, store, affair, action)
            if kind == "parent_confirm":
                return await asyncio.to_thread(_do_parent_confirm, store, affair, action)
            if kind == "ics":
                return _do_ics(affair)
    except Exception as e:  # noqa: BLE001 单个动作失败不该中断整条规划流
        return _result(kind or "unknown", False, f"动作执行失败：{e}", {})
    return _result(kind or "unknown", False, f"未知动作类型：{action.get('kind')}", {})


def _do_reminder(child_dir: Path, affair: dict, action: dict) -> dict:
    """追加提醒到 data/<child>/reminders.json（结构见现有文件）。"""
    text = str(action.get("text") or affair.get("title") or "待办提醒").strip()
    raw_time = str(action.get("at") or action.get("time") or affair.get("due") or "daily")
    time_value, human = _time_value(raw_time)
    items = read_json(_reminders_path(child_dir), None)
    if not isinstance(items, list):
        items = []
    # 幂等：同文同时间的提醒不重复入库——同一事务重跑规划不该刷一屏重复提醒
    for it in items:
        if isinstance(it, dict) and it.get("text") == text and it.get("time") == time_value:
            return _result("reminder", True, f"这条提醒已在（{human}），不重复添加",
                           {"reminder": it, "count": len(items), "dedup": True})
    taken = {str(i.get("id")) for i in items if isinstance(i, dict)}
    item = {"id": _new_rid(taken), "text": text, "time": time_value, "fired": False}
    items.append(item)
    write_json(_reminders_path(child_dir), items)
    return _result("reminder", True, f"已加 1 条提醒（{human}）", {"reminder": item, "count": len(items)})


def _do_checklist(store: AffairStore, affair: dict, action: dict) -> dict:
    """在 checklists.json 建 / 补清单：已有 checklist_id 时只补缺项。"""
    cid = str(affair.get("checklist_id") or action.get("checklist_id") or "").strip()
    title = str(action.get("title") or affair.get("title") or "携带清单").strip()
    if not cid:
        cid = f"{slug(str(affair.get('id') or title), 20)}_pack"
    new_items = _items(action.get("items") or action.get("list") or [])
    try:
        before = len(store.checklist(cid).get("items") or [])
        existed = True
    except KeyError:
        before, existed = 0, False
    if existed:
        cl = store.append_checklist_items(cid, title, new_items)
        added = len(cl["items"]) - before
    else:
        cl = store.put_checklist(cid, title, new_items)
        added = len(new_items)
    if added:
        detail = f"清单「{cl['title']}」{'补了' if existed else '建好了'} {added} 项，共 {len(cl['items'])} 项"
    else:
        detail = f"清单「{cl['title']}」已齐（{len(cl['items'])} 项）"
    return _result("checklist", True, detail, {"checklist_id": cid, "checklist": cl, "added": added})


def _do_parent_confirm(store: AffairStore, affair: dict, action: dict) -> dict:
    """追加一条待家长确认的事（status=pending）。"""
    title = str(action.get("title") or action.get("text") or affair.get("title") or "需要家长确认").strip()
    detail = str(action.get("detail") or affair.get("summary") or "").strip()
    # 幂等：同一事务的同标题请求若还在 pending，不重复塞家长收件箱
    for it in store.inbox():
        if (it.get("status") == "pending" and it.get("title") == title
                and it.get("affair_id") == affair.get("id")):
            return _result("parent_confirm", True, f"这条已在收件箱等确认：{title}",
                           {"item": it, "dedup": True})
    item = store.add_inbox(title, detail, affair.get("id"), extra={"action": str(action.get("text") or "")})
    return _result("parent_confirm", True, f"已送到家长收件箱等确认：{title}", {"item": item})


def _do_ics(affair: dict) -> dict:
    """生成日历文本，payload 里带上全文供前端下载。"""
    text = ics_text(affair)
    due = str(affair.get("due") or "")
    return _result("ics", True, f"已生成日历文件（{due or '未定日期'}）", {"text": text, "affair_id": affair.get("id")})


async def _do_draft(child_dir: Path, affair: dict, action: dict) -> dict:
    """代办文书：LLM 真写一份文稿 → 落盘 drafts.json → 再落一份可下载文件。

    action 字段：request=孩子原话（必填素材）、context=刚查到的方案/卡片文本、
    title=可选指定题目。文稿全文进 payload，前端直接出文稿卡（"给我一个结果"）。

    交付物双落盘是"说一件事、给我一个能拿走的结果"：drafts.json 管对话里的
    卡片回读，files/ 里的文件管下载打印（复制粘贴丢格式，孩子交作业要 Word）。
    文件写挂了不连累文稿本身——卡照样出，只是没有下载按钮（诚实降级）。
    """
    request = str(action.get("request") or action.get("text") or affair.get("title") or "").strip()
    context = str(action.get("context") or "").strip() or "（无前置素材，靠记忆与常识写）"
    mem_store = MemoryStore(child_dir)
    mem = await asyncio.to_thread(mem_store.active_block)
    if _LONG_FORM.search(request):
        # 论文/报告这类长文稿一次调用写不好：提纲 → 各节并行写 → 拼成 markdown。
        # 产物是"能交差的成稿"，不是"怎么写"的建议——这是 draft 的完整形态。
        title, body = await _write_paper(mem_store, request, context, mem)
    else:
        data = await llm.complete_json(
            [
                {"role": "system", "content": "你是文书起草模块，只输出 JSON。"},
                {"role": "user", "content": prompts.DRAFT.format(
                    name=mem_store.child_name,
                    request=request or "写一份文稿",
                    context=context,
                    memory_block=mem or "（暂无记忆）",
                )},
            ],
            max_tokens=1600,
            caller="draft",
        )
        title = str(data.get("title") or action.get("title") or "文稿").strip()[:40]
        body = str(data.get("body") or data.get("text") or "").strip()
    if not body:
        raise ValueError("文稿正文为空")
    try:
        file_item = await asyncio.to_thread(_draft_to_file, child_dir, title, body)
    except Exception:  # noqa: BLE001 交付文件是加分项，不是文稿成立的前提
        file_item = None
    draft = await asyncio.to_thread(
        AffairStore(child_dir).add_draft, title, body, affair.get("id"),
        file_item.get("id") if file_item else None)
    return _result(
        "draft", True, f"文稿写好了：《{title}》，点开看看",
        {"draft_id": draft["id"], "title": title, "body": body,
         "affair_id": affair.get("id"), "created": draft.get("created"),
         **({"file_id": file_item["id"], "file_name": file_item.get("name"),
             "file_ext": file_item.get("ext")} if file_item else {})})


# 长文稿锚点：命中这些词的需求，单发调用写出来只会是"写作建议"——必须分段生成
_LONG_FORM = re.compile(r"论文|报告|作文|文章|总结|综述|文档|材料|小论文|研究")

# 长文稿的分节上限：再多节并写下去，孩子等不起、token 也烧得没边
_PAPER_MAX_SECTIONS = 6


async def _write_paper(mem_store: MemoryStore, request: str, context: str,
                       mem: str) -> tuple[str, str]:
    """长文稿两段式生成：提纲定结构 → 各节并行写真内容 → 拼成 markdown 正文。

    一节写挂了不整篇作废——那节如实标"没写出来"，比交一篇缺块还装齐的诚实。
    """
    outline = await llm.complete_json(
        [
            {"role": "system", "content": "你是文书提纲模块，只输出 JSON。"},
            {"role": "user", "content": prompts.PAPER_OUTLINE.format(
                name=mem_store.child_name,
                request=request,
                context=context or "（无前置素材）",
                memory_block=mem or "（暂无记忆）",
                now=tools.now_text(),
            )},
        ],
        max_tokens=900,
        caller="paper_outline",
    )
    title = str(outline.get("title") or "文稿").strip()[:40]
    sections = [s for s in (outline.get("sections") or [])
                if isinstance(s, dict) and str(s.get("heading") or "").strip()]
    if not sections:
        raise ValueError("提纲为空")
    sections = sections[:_PAPER_MAX_SECTIONS]

    async def _sec(sec: dict) -> str:
        return await llm.complete(
            [
                {"role": "system", "content": "你是文书写作模块，只写这一节的正文。"},
                {"role": "user", "content": prompts.PAPER_SECTION.format(
                    name=mem_store.child_name,
                    title=title,
                    heading=str(sec["heading"])[:30],
                    request=request,
                    points="；".join(str(p) for p in (sec.get("points") or [])[:4]) or "（无要点）",
                    context=context or "（无前置素材）",
                    memory_block=mem or "（暂无记忆）",
                    now=tools.now_text(),
                )},
            ],
            max_tokens=1200,
            caller="paper",
        )

    parts = await asyncio.gather(*(_sec(s) for s in sections), return_exceptions=True)
    chunks = [f"# {title}"]
    for sec, part in zip(sections, parts):
        chunks.append(f"\n\n## {str(sec['heading']).strip()[:30]}\n")
        if isinstance(part, str) and part.strip():
            chunks.append(part.strip())
        else:
            chunks.append("（这一节没写出来，留着自己补。）")
    return title or "文稿", "".join(chunks).strip()


# markdown 行内标记：进 Word 的是给孩子打印/上交的东西，** 和 ` 不能留在字面上
_MD_INLINE = re.compile(r"[*`_]+")


def _md_clean(text: str) -> str:
    return _MD_INLINE.sub("", str(text or "")).strip()


def _draft_docx(title: str, body: str) -> bytes:
    """文稿正文 → .docx 字节：LLM 写的是 markdown 风文本，
    标题/列表/引用映射成 Word 样式，其余按普通段落走（如实排版，不重写内容）。
    """
    import docx  # python-docx：读附件依赖它，写文稿顺带可写（零新增依赖）

    doc = docx.Document()
    doc.add_heading(_md_clean(title) or "文稿", level=0)
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            doc.add_heading(_md_clean(m.group(2)) or " ", level=min(len(m.group(1)), 4))
            continue
        m = re.match(r"^[-*·•]\s+(.*)", line)
        if m:
            doc.add_paragraph(_md_clean(m.group(1)), style="List Bullet")
            continue
        m = re.match(r"^\d+[.、)]\s*(.*)", line)
        if m:
            doc.add_paragraph(_md_clean(m.group(1)), style="List Number")
            continue
        m = re.match(r"^>\s*(.*)", line)
        if m:
            doc.add_paragraph(_md_clean(m.group(1)), style="Intense Quote")
            continue
        doc.add_paragraph(_md_clean(line))
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _draft_to_file(child_dir: Path, title: str, body: str) -> dict:
    """文稿落成 files/ 里一份可下载文件：.docx 优先（打印/交作业的场景），
    python-docx 出岔子退 .md——下载入口始终有，格式降级如实反映在扩展名上。"""
    store = files.FileStore(child_dir)
    try:
        return store.save(_draft_docx(title, body), f"{title}.docx",
                          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                          origin="generated")
    except Exception:
        return store.save(body.encode("utf-8"), f"{title}.md",
                          "text/markdown", origin="generated")
