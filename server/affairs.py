"""事务（affair）存储：阶段推进、倒计时、日历导出。

事务是"正在办的一件事"（参赛 / 换电脑 / 康复…），比主题更重：有阶段、负责人、
清单、动作和历史。数据落在 `data/<child>/affairs.json`（结构见契约 §2.2），
写入一律走 `store.write_json`（原子写 + tmp→rename）。

契约 §3.3 把本类定为**同步**接口：方法内部不含 await（因此单事件循环内不会
被别的协程打断）。调用方若要跨线程 / 多请求并发安全，请先持有
`store.lock_for(child_dir)` 再调用，actions.py 就是这么做的。
"""
from __future__ import annotations

import functools
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .store import read_json, slug, write_json, write_lock

# 契约 §3.3 固定的阶段顺序，advance 只认这六个
STAGES = ["discovered", "planning", "executing", "waiting", "followup", "done"]
STAGE_ORDER = {s: i for i, s in enumerate(STAGES)}
STAGE_CN = {
    "discovered": "刚发现",
    "planning": "规划中",
    "executing": "执行中",
    "waiting": "等待中",
    "followup": "跟进中",
    "done": "已完成",
}
OWNER_CN = {"butler": "管家", "child": "孩子", "parent": "家长"}
FIELD_CN = {
    "title": "标题",
    "kind": "类型",
    "stage": "阶段",
    "due": "截止日期",
    "owner_next": "下一步",
    "summary": "摘要",
    "linked_nodes": "关联",
    "progress": "进度",
    "checklist_id": "清单",
    "actions": "动作",
}
# 这几个字段归本模块管，patch 里出现也一律忽略
_RESERVED = {"id", "created", "updated", "log"}


def now_iso() -> str:
    """契约 §2.2 的时间戳格式：本地时间、秒级。"""
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _stamp() -> str:
    """iCalendar 的 UTC 时间戳。"""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _stage(value, default: str = "discovered") -> str:
    """校验阶段名，非法直接报错（避免写坏看板）。"""
    if value is None or str(value).strip() == "":
        return default
    s = str(value).strip()
    if s not in STAGE_ORDER:
        raise ValueError(f"未知事务阶段：{s}（可选：{'、'.join(STAGES)}）")
    return s


def _iso_date(value) -> str | None:
    """任意日期值 → "YYYY-MM-DD" 字符串；无法识别返回 None。"""
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip().replace("/", "-")[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def _parse_date(value) -> date | None:
    s = _iso_date(value)
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def _str_list(value) -> list[str]:
    """规整成去重的字符串列表（linked_nodes 用）。"""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return []
    out: list[str] = []
    for v in value:
        s = str(v).strip()
        if s and s not in out:
            out.append(s)
    return out


def _norm_progress(value) -> dict:
    """进度统一成 {"mode","value"}；调用方直接给数字时按百分比理解。"""
    if isinstance(value, dict):
        mode = str(value.get("mode") or "none").strip()
        if mode not in ("days", "percent", "none"):
            mode = "none"
        try:
            num = float(value.get("value") or 0)
        except (TypeError, ValueError):
            num = 0.0
        return {"mode": mode, "value": int(num) if num == int(num) else num}
    if isinstance(value, bool) or value is None or value == "":
        return {"mode": "none", "value": 0}
    try:
        return {"mode": "percent", "value": int(value)}
    except (TypeError, ValueError):
        return {"mode": "none", "value": 0}


def _entry(actor: str, text: str) -> dict:
    return {"ts": now_iso(), "actor": str(actor or "butler"), "text": str(text).strip()}


def _changed_note(patch: dict) -> str:
    """没给 note 时，自动写一句"改了哪些字段"。"""
    keys = [FIELD_CN.get(k, k) for k in (patch or {}) if k not in _RESERVED]
    return "更新：" + "、".join(keys) if keys else "更新事务"


def _safe_id(text: str) -> str:
    s = re.sub(r"[^\w一-鿿-]", "_", str(text or "")).strip("_")
    return s[:40] or "affair"


def ics_text(affair: dict) -> str:
    """事务 → VCALENDAR 文本（全天事件，日期 YYYYMMDD，换行 CRLF）。"""
    due = _parse_date(affair.get("due")) or date.today()
    title = str(affair.get("title") or affair.get("id") or "事务").strip()
    stage = str(affair.get("stage") or "")
    owner = str(affair.get("owner_next") or "")
    bits = [str(affair.get("summary") or "").strip()]
    bits.append(f"状态：{STAGE_CN.get(stage, stage or '未知')}")
    bits.append(f"下一步：{OWNER_CN.get(owner, owner or '管家')}")
    if not _parse_date(affair.get("due")):
        bits.append("（原事务未定日期，此处按今天占位）")
    if affair.get("linked_nodes"):
        bits.append("关联：" + "、".join(_str_list(affair.get("linked_nodes"))))
    bits.append("由 PandaButler 生成")
    uid = f"{affair.get('id') or slug(title)}-{affair.get('created') or due.isoformat()}@pandabutler"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//PandaButler//事务日历//CN",
        "BEGIN:VEVENT",
        f"UID:{_esc(uid)}",
        f"DTSTAMP:{_stamp()}",
        f"DTSTART;VALUE=DATE:{due.strftime('%Y%m%d')}",
        f"DTEND;VALUE=DATE:{(due + timedelta(days=1)).strftime('%Y%m%d')}",
        f"SUMMARY:{_esc(title)}",
        f"DESCRIPTION:{_esc('｜'.join(b for b in bits if b))}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines) + "\r\n"


def _esc(text: str) -> str:
    """iCalendar 文本值转义：反斜杠、分号、逗号、换行。"""
    s = str(text or "")
    for a, b in (("\\", "\\\\"), (";", "\\;"), (",", "\\,"), ("\r\n", "\\n"), ("\n", "\\n")):
        s = s.replace(a, b)
    return s


def _locked(method):
    """把同步的「读—改—写」整体放进目录写锁里。

    契约 §3.3 要求这些方法是同步的，但 A4 直接在请求处理函数里调（同步上下文，
    拿不到 asyncio.Lock）。`store.write_lock` 是可重入的按目录线程锁，正好用来防止
    两个评委同时点看板时互相覆盖对方刚写的字段。asyncio.to_thread 路径同样受益。
    """

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with write_lock(self.dir):
            return method(self, *args, **kwargs)

    return wrapper


class AffairStore:
    """一个孩子的事务档案（data/<child>/affairs.json）。"""

    def __init__(self, child_dir: Path):
        self.dir = Path(child_dir)

    @property
    def path(self) -> Path:
        return self.dir / "affairs.json"

    # ---------- 读写 ----------

    def _load(self) -> dict:
        data = read_json(self.path, None)
        if not isinstance(data, dict) or not isinstance(data.get("affairs"), list):
            return {"version": 1, "affairs": []}
        return data

    def _save(self, data: dict) -> None:
        write_json(self.path, data)

    def _find(self, root: dict, aid: str) -> dict | None:
        for a in root["affairs"]:
            if isinstance(a, dict) and str(a.get("id")) == str(aid):
                return a
        return None

    def _new_id(self, title: str, taken: set[str]) -> str:
        base, n = _safe_id(title), 2
        aid = base
        while aid in taken:
            aid, n = f"{base}_{n}", n + 1
        return aid

    # ---------- 契约 §3.3 ----------

    def list(self, include_done: bool = False) -> list[dict]:
        """全部事务；默认不含已完成。"""
        affairs = self._load()["affairs"]
        if include_done:
            return list(affairs)
        return [a for a in affairs if isinstance(a, dict) and a.get("stage") != "done"]

    def get(self, aid: str) -> dict | None:
        return self._find(self._load(), aid)

    @_locked
    def create(self, data: dict) -> dict:
        """新建事务：自动补 id/created/log；同 id 视为覆盖（幂等）。"""
        data = dict(data or {})
        root = self._load()
        affairs = root["affairs"]
        title = str(data.get("title") or "未命名事务").strip()
        aid = str(data.get("id") or "").strip()
        if not aid:
            aid = self._new_id(title, {str(a.get("id")) for a in affairs if isinstance(a, dict)})
        affair = {
            "id": aid,
            "title": title,
            "kind": str(data.get("kind") or "goal"),
            "stage": _stage(data.get("stage")),
            "due": _iso_date(data.get("due")),
            "owner_next": str(data.get("owner_next") or "butler"),
            "summary": str(data.get("summary") or ""),
            "linked_nodes": _str_list(data.get("linked_nodes")),
            "progress": _norm_progress(data.get("progress")),
            "checklist_id": data.get("checklist_id"),
            "actions": [a for a in data.get("actions") or []],
            "log": [_entry(data.get("actor") or "butler", f"新建事务：{title}")],
            "created": _iso_date(data.get("created")) or date.today().isoformat(),
            "updated": date.today().isoformat(),
        }
        for k, v in data.items():  # 调用方额外字段（如 source）一并留下，不丢信息
            affair.setdefault(k, v)
        old = self._find(root, aid)
        if old is not None:
            affair["created"] = old.get("created") or affair["created"]
            affair["log"] = [e for e in old.get("log") or [] if isinstance(e, dict)] + affair["log"]
            affairs[affairs.index(old)] = affair
        else:
            affairs.append(affair)
        self._save(root)
        return affair

    @_locked
    def update(self, aid: str, patch: dict, actor: str = "butler", note: str = "") -> dict:
        """按 patch 改任意字段（stage/due/progress/checklist_id/actions/summary/…）。

        id 不存在时按 patch 新建（upsert），不抛异常——SSE 流里掉链子比宽容更糟。
        每次写入都会追加一条 log 并刷新 updated。
        """
        root = self._load()
        affair = self._find(root, aid)
        if affair is None:
            fresh = dict(patch or {})
            fresh["id"] = aid
            fresh.setdefault("actor", actor)
            return self.create(fresh)
        for key, value in (patch or {}).items():
            if key in _RESERVED:
                continue
            if key == "stage":
                if value not in (None, ""):
                    affair["stage"] = _stage(value)
            elif key == "due":
                affair["due"] = _iso_date(value)
            elif key == "progress":
                affair["progress"] = _norm_progress(value)
            elif key == "linked_nodes":
                affair["linked_nodes"] = _str_list(value)
            elif key == "actions":
                affair["actions"] = [a for a in value or []]
            elif key == "title":
                affair["title"] = str(value or affair.get("title") or "")
            else:
                affair[key] = value
        affair["log"] = [e for e in affair.get("log") or [] if isinstance(e, dict)]
        affair["log"].append(_entry(actor, note or _changed_note(patch)))
        affair["updated"] = date.today().isoformat()
        self._save(root)
        return affair

    @_locked
    def advance(self, aid: str, stage: str, actor: str = "butler", note: str = "") -> dict:
        """推进到指定阶段（必须是契约里的六个之一，可跨阶段，不禁止回退）。"""
        target = _stage(stage)
        root = self._load()
        affair = self._find(root, aid)
        if affair is None:
            return self.create({"id": aid, "title": aid, "stage": target, "actor": actor})
        old = str(affair.get("stage") or "discovered")
        affair["stage"] = target
        affair["log"] = [e for e in affair.get("log") or [] if isinstance(e, dict)]
        affair["log"].append(
            _entry(actor, note or f"{STAGE_CN.get(old, old)} → {STAGE_CN.get(target, target)}")
        )
        affair["updated"] = date.today().isoformat()
        self._save(root)
        return affair

    def due_soon(self, days: int = 7, items: list[dict] | None = None) -> list[dict]:
        """due 在 days 天内或已过期的事务（不含 done），按紧急度升序。

        `days` 为负数即已过期，`overdue` 同步标出来，前端直接显示"逾期 N 天"。
        `items` 传入已加载的事务列表时不再重复读盘（调用方刚 list() 过）。
        """
        today = date.today()
        out: list[dict] = []
        for a in (self._load()["affairs"] if items is None else items):
            if not isinstance(a, dict) or a.get("stage") == "done":
                continue
            d = _parse_date(a.get("due"))
            if d is None:
                continue
            left = (d - today).days
            if left > int(days):
                continue
            out.append({
                "id": a.get("id"),
                "title": a.get("title"),
                "kind": a.get("kind"),
                "stage": a.get("stage"),
                "due": _iso_date(a.get("due")),
                "owner_next": a.get("owner_next"),
                "summary": a.get("summary") or "",
                "days": left,
                "overdue": left < 0,
            })
        out.sort(key=lambda x: x["days"])
        return out

    def snapshot(self) -> dict:
        """GET /api/affairs 用：全量事务 + 看板用的轻量字段。"""
        affairs = [a for a in self._load()["affairs"] if isinstance(a, dict)]
        board = [
            {
                "id": a.get("id"),
                "title": a.get("title"),
                "stage": a.get("stage"),
                "owner_next": a.get("owner_next"),
                "progress": _norm_progress(a.get("progress")),
                "summary": a.get("summary") or "",
                "due": _iso_date(a.get("due")),
            }
            for a in sorted(affairs, key=lambda x: STAGE_ORDER.get(str(x.get("stage")), 99))
        ]
        return {"affairs": affairs, "board": board}

    def ics(self, aid: str) -> str:
        """VCALENDAR 文本；事务不存在时抛 KeyError，由调用方转 404。"""
        affair = self.get(aid)
        if affair is None:
            raise KeyError(aid)
        return ics_text(affair)

    # ---------- 携带清单（checklists.json，契约 §2.3）----------
    # 清单与家长收件箱都归 AffairStore 管，actions.py 复用这里的方法，不另起一套。

    @property
    def checklist_path(self) -> Path:
        return self.dir / "checklists.json"

    def _load_checklists(self) -> dict:
        data = read_json(self.checklist_path, None)
        if not isinstance(data, dict) or not isinstance(data.get("checklists"), dict):
            return {"checklists": {}}
        return data

    def _load_inbox(self) -> dict:
        data = read_json(self.inbox_path, None)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return {"items": []}
        return data

    def checklist(self, cid: str) -> dict:
        """取一份清单；不存在抛 KeyError。"""
        cl = self._load_checklists()["checklists"].get(str(cid))
        if not isinstance(cl, dict):
            raise KeyError(cid)
        return cl

    @_locked
    def put_checklist(self, cid: str, title: str, items: list[dict]) -> dict:
        """整体写回一份清单（actions.py 建/补清单时调用）。"""
        root = self._load_checklists()
        root["checklists"][str(cid)] = {"title": str(title or cid), "items": list(items)}
        write_json(self.checklist_path, root)
        return root["checklists"][str(cid)]

    @_locked
    def append_checklist_items(self, cid: str, title: str, items: list[dict]) -> dict:
        """清单不存在就建，存在则**只补缺项**（按 text 去重），不覆盖已有勾选状态。"""
        new_items = [_norm_item(i) for i in items or []]
        try:
            cl = self.checklist(cid)
        except KeyError:
            return self.put_checklist(cid, title, new_items)
        if title and not cl.get("title"):
            cl["title"] = str(title)
        have = {str(i.get("text")) for i in cl.get("items") or [] if isinstance(i, dict)}
        cl["items"] = list(cl.get("items") or []) + [i for i in new_items if i["text"] not in have]
        return self.put_checklist(cid, cl.get("title") or cid, cl["items"])

    @_locked
    def toggle_item(self, cid: str, index: int, done: bool) -> dict:
        """勾选第 index 项并落盘，返回更新后的整份清单。

        清单不存在抛 KeyError；索引越界抛 IndexError。
        """
        root = self._load_checklists()
        cl = root["checklists"].get(str(cid))
        if not isinstance(cl, dict):
            raise KeyError(cid)
        items = list(cl.get("items") or [])
        idx = int(index)
        if idx < 0 or idx >= len(items):
            raise IndexError(index)
        item = dict(items[idx])
        item["done"] = bool(done)
        items[idx] = item
        cl["items"] = items
        root["checklists"][str(cid)] = cl
        write_json(self.checklist_path, root)
        return cl

    # ---------- 家长收件箱（parent_inbox.json，契约 §2.4）----------

    @property
    def inbox_path(self) -> Path:
        return self.dir / "parent_inbox.json"

    def inbox(self) -> list[dict]:
        """收件箱条目，新的在前。"""
        items = [i for i in self._load_inbox()["items"] if isinstance(i, dict)]
        return sorted(items, key=lambda i: str(i.get("created") or ""), reverse=True)

    @_locked
    def add_inbox(
        self,
        title: str,
        detail: str = "",
        affair_id: str | None = None,
        extra: dict | None = None,
    ) -> dict:
        """追加一条待家长确认的事（status=pending），id 唯一。"""
        root = self._load_inbox()
        taken = {str(i.get("id")) for i in root["items"] if isinstance(i, dict)}
        item = {
            "id": _new_iid(taken),
            "affair_id": affair_id,
            "title": str(title or "需要家长确认").strip(),
            "detail": str(detail or "").strip(),
            "status": "pending",
            "created": now_iso(),
            "decided_at": None,
            "reply": "",
        }
        for k, v in (extra or {}).items():
            item.setdefault(k, v)
        root["items"].append(item)
        write_json(self.inbox_path, root)
        return item

    @_locked
    def decide_inbox(self, iid: str, action: str, reply: str = "") -> dict:
        """家长裁决：action ∈ approve|reject，写 status/decided_at/reply。

        条目不存在抛 KeyError；action 非法抛 ValueError。
        """
        act = str(action or "").strip().lower()
        if act not in ("approve", "reject"):
            raise ValueError(f"未知裁决动作：{action}（可选：approve、reject）")
        root = self._load_inbox()
        item = next((i for i in root["items"] if isinstance(i, dict) and str(i.get("id")) == str(iid)), None)
        if item is None:
            raise KeyError(iid)
        item["status"] = "approved" if act == "approve" else "rejected"
        item["decided_at"] = now_iso()
        item["reply"] = str(reply or "")
        write_json(self.inbox_path, root)
        return item

    # ---------- 交付文稿（drafts.json）----------
    # "帮我写一份自我介绍/给老师的一封信"这类代办产物：LLM 真写全文，
    # 落盘到孩子档案，可回放、可挂到事务上。与清单/收件箱同套读写纪律。

    @property
    def drafts_path(self) -> Path:
        return self.dir / "drafts.json"

    def _load_drafts(self) -> dict:
        data = read_json(self.drafts_path, None)
        if not isinstance(data, dict) or not isinstance(data.get("drafts"), list):
            return {"drafts": []}
        return data

    def drafts(self, affair_id: str | None = None) -> list[dict]:
        """全部文稿，新的在前；给 affair_id 时只取挂在该事务上的。"""
        items = [d for d in self._load_drafts()["drafts"] if isinstance(d, dict)]
        if affair_id:
            items = [d for d in items if str(d.get("affair_id")) == str(affair_id)]
        return sorted(items, key=lambda d: str(d.get("created") or ""), reverse=True)

    def draft(self, did: str) -> dict:
        """取一份文稿；不存在抛 KeyError。"""
        for d in self._load_drafts()["drafts"]:
            if isinstance(d, dict) and str(d.get("id")) == str(did):
                return d
        raise KeyError(did)

    @_locked
    def add_draft(self, title: str, body: str, affair_id: str | None = None) -> dict:
        """存一份文稿：同一事务下同标题视为同一份（重写更新正文，幂等）。"""
        root = self._load_drafts()
        title = str(title or "未命名文稿").strip()
        body = str(body or "")
        for d in root["drafts"]:
            if (isinstance(d, dict) and str(d.get("affair_id") or "") == str(affair_id or "")
                    and str(d.get("title")) == title):
                d["body"] = body
                d["created"] = now_iso()
                write_json(self.drafts_path, root)
                return d
        taken = {str(d.get("id")) for d in root["drafts"] if isinstance(d, dict)}
        draft = {
            "id": _new_did(taken),
            "title": title,
            "body": body,
            "affair_id": str(affair_id) if affair_id else None,
            "created": now_iso(),
        }
        root["drafts"].append(draft)
        write_json(self.drafts_path, root)
        return draft


def _new_did(taken: set[str]) -> str:
    """文稿 id：dr_<8 位随机>。"""
    for _ in range(64):
        did = f"dr_{uuid.uuid4().hex[:8]}"
        if did not in taken:
            return did
    return f"dr_{uuid.uuid4().hex[:12]}"


def _norm_item(item) -> dict:
    """清单项规整成 {"text","done","note"}；也给纯字符串留条路。"""
    if isinstance(item, str):
        item = {"text": item}
    item = dict(item or {})
    return {
        "text": str(item.get("text") or "").strip(),
        "done": bool(item.get("done")),
        "note": str(item.get("note") or "").strip(),
    }


def _new_iid(taken: set[str]) -> str:
    """收件箱 id：pi_<8 位随机>，撞了就再抽一次。"""
    for _ in range(64):
        iid = f"pi_{uuid.uuid4().hex[:8]}"
        if iid not in taken:
            return iid
    return f"pi_{uuid.uuid4().hex[:12]}"
