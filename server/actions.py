"""动作执行器：把规划里的"动作"真的落到档案上。

契约 §3.4 的四种 kind：
  reminder       追加一条提醒（reminders.json）
  checklist      建 / 补一份携带清单（checklists.json）
  parent_confirm 请家长确认一件事（parent_inbox.json，status=pending）
  ics            生成日历文本，只回传不落盘（前端做下载）

写入一律走 `store.write_json`（原子写）+ `store.lock_for`（按目录写锁），
清单与收件箱复用 `affairs.AffairStore`，不另起一套读写。
未知 kind 不抛异常，返回 ok=False 让上层把回执发给前端就行。
"""
from __future__ import annotations

import asyncio
import re
import uuid
from datetime import date
from pathlib import Path

from .affairs import AffairStore, ics_text
from .store import lock_for, read_json, slug, write_json

KINDS = ("reminder", "checklist", "parent_confirm", "ics")
# 规划节点可能给这些别名，统一归到四种 kind 上
_ALIAS = {
    "remind": "reminder", "提醒": "reminder",
    "todo": "checklist", "pack": "checklist", "清单": "checklist",
    "confirm": "parent_confirm", "parent": "parent_confirm", "家长确认": "parent_confirm",
    "calendar": "ics", "ical": "ics", "日历": "ics",
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
    item = store.add_inbox(title, detail, affair.get("id"), extra={"action": str(action.get("text") or "")})
    return _result("parent_confirm", True, f"已送到家长收件箱等确认：{title}", {"item": item})


def _do_ics(affair: dict) -> dict:
    """生成日历文本，payload 里带上全文供前端下载。"""
    text = ics_text(affair)
    due = str(affair.get("due") or "")
    return _result("ics", True, f"已生成日历文件（{due or '未定日期'}）", {"text": text, "affair_id": affair.get("id")})
