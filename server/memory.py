"""文件式记忆：读（活跃块注入 + 主题检索）与写（LLM 抽取 + 原子落盘）。

目录布局（data/child_xxx/）：
  MEMORY.md     长期记忆
  topics/*.md   主题档案（头部 status/related 元数据 + 正文事实追加）
  daily/*.md    每日沉淀
  index.json    {name, topics: {名: {status, related, file}}}
  graph.json    成长图谱，由 graph.py 负责；抽取若带 graph_store 则一并合并
所有写操作走 store.py 的按目录写锁 + tmp→rename 原子替换，评委并发操作不会写坏档案。
"""
from __future__ import annotations

import asyncio
import re
from datetime import date
from pathlib import Path

from . import llm, prompts
from .store import atomic_write, bigrams, fence_memory, lock_for, read_json, write_json


def _parse_topic(text: str) -> dict:
    meta = {"status": "active", "related": []}
    body_lines = []
    in_body = False
    for line in text.splitlines():
        if not in_body:
            s = line.strip()
            if s == "---":
                in_body = True
            elif s.startswith("status:"):
                meta["status"] = s.split(":", 1)[1].strip() or "active"
            elif s.startswith("related:"):
                raw = s.split(":", 1)[1]
                meta["related"] = [w.strip() for w in re.split(r"[,，]", raw) if w.strip()]
            continue
        body_lines.append(line)
    meta["body"] = "\n".join(body_lines).strip()
    return meta


def _render_topic(name: str, status: str, related: list[str], body: str) -> str:
    rel = ", ".join(related)
    today = date.today().isoformat()
    return f"# {name}\nstatus: {status}\nrelated: {rel}\nupdated: {today}\n---\n\n{body.strip()}\n"


class MemoryStore:
    """一个孩子的记忆档案（对应 data/child_*/ 目录）。"""

    def __init__(self, child_dir: Path):
        self.dir = child_dir

    @property
    def index_path(self) -> Path:
        return self.dir / "index.json"

    def read_index(self) -> dict:
        """读 index.json；缺文件或损坏时回落空白索引，不抛错。"""
        return read_json(self.index_path, {"name": self.dir.name, "topics": {}})

    @property
    def child_name(self) -> str:
        return self.read_index().get("name") or self.dir.name.removeprefix("child_")

    def _topic_text(self, rel_file: str) -> str:
        try:
            return (self.dir / rel_file).read_text(encoding="utf-8")
        except OSError:
            return ""

    def active_block(self) -> str:
        """活跃关注点块：MEMORY.md 全文 + 所有 active 主题正文。每轮必注入，实现"一直知道"。"""
        index = self.read_index()
        parts = []
        try:
            parts.append(self.dir.joinpath("MEMORY.md").read_text(encoding="utf-8").strip())
        except OSError:
            pass
        for name, info in index.get("topics", {}).items():
            if info.get("status") != "active":
                continue
            meta = _parse_topic(self._topic_text(info.get("file", "")))
            if meta["body"]:
                parts.append(f"【{name}】{meta['body']}")
        return fence_memory("\n\n".join(parts))

    @staticmethod
    def _bigrams(text: str) -> set[str]:
        return bigrams(text)

    def retrieve(self, query: str, limit: int = 3) -> str:
        """按关键词重叠检索相关主题（含非 active）+ 最近一篇 daily。"""
        index = self.read_index()
        q_grams = self._bigrams(query)
        scored = []
        for name, info in index.get("topics", {}).items():
            words = [name] + list(info.get("related", []))
            hay = " ".join(words)
            score = len(q_grams & self._bigrams(hay))
            score += 3 * sum(1 for w in words if w and w in query)
            if score:
                scored.append((score, name, info))
        scored.sort(key=lambda x: -x[0])
        parts = []
        for _, name, info in scored[:limit]:
            if info.get("status") == "active":
                continue  # 活跃主题已在活跃块中
            meta = _parse_topic(self._topic_text(info.get("file", "")))
            if meta["body"]:
                parts.append(f"【{name}（状态：{meta['status']}）】{meta['body']}")
        daily_dir = self.dir / "daily"
        if daily_dir.is_dir():
            latest = sorted(daily_dir.glob("*.md"))[-1:]
            for f in latest:
                parts.append(f"【{f.stem} 日记】{f.read_text(encoding='utf-8').strip()}")
        return fence_memory("\n\n".join(parts))

    def topic_names(self) -> str:
        return ", ".join(self.read_index().get("topics", {}).keys()) or "（空）"

    def due_reminders(self) -> list[dict]:
        """到期提醒：daily 每天触发；weekly:sat 每周对应日；日期当天及前 2 天提示。"""
        items = read_json(self.dir / "reminders.json", [])
        if not isinstance(items, list):
            return []
        today = date.today()
        wd_en = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][today.weekday()]
        due = []
        for r in items:
            t = str(r.get("time", ""))
            if t == "daily" or t == f"weekly:{wd_en}":
                due.append(r)
            else:
                try:
                    days = (date.fromisoformat(t) - today).days
                    if 0 <= days <= 2:
                        due.append(r)
                except ValueError:
                    continue
        return [{"text": str(r.get("text", "")), "time": str(r.get("time", ""))} for r in due if r.get("text")]

    def export(self) -> dict:
        """给记忆本页用的完整档案。"""
        index = self.read_index()
        topics = []
        for name, info in index.get("topics", {}).items():
            meta = _parse_topic(self._topic_text(info.get("file", "")))
            topics.append({
                "name": name,
                "status": info.get("status", "active"),
                "related": info.get("related", []),
                "body": meta["body"],
                "file": info.get("file", ""),
            })
        daily = []
        daily_dir = self.dir / "daily"
        if daily_dir.is_dir():
            for f in sorted(daily_dir.glob("*.md"), reverse=True):
                content = f.read_text(encoding="utf-8").strip()
                if content.startswith("#"):
                    content = content.split("\n", 1)[-1].strip()
                daily.append({"date": f.stem, "content": content})
        try:
            memory_md = self.dir.joinpath("MEMORY.md").read_text(encoding="utf-8").strip()
        except OSError:
            memory_md = ""
        return {"name": index.get("name", ""), "memory_md": memory_md, "topics": topics, "daily": daily}

    async def write_extraction(self, data: dict, is_secret: bool = False) -> None:
        """把 LLM 抽取结果落盘：daily 追加 + 主题 upsert + MEMORY.md 追加。单写锁保护。

        is_secret（悄悄话轮）时由代码强制隔离：daily 只写"存在性"占位行，
        topics / longterm 一律不落盘——私密事实只允许进 graph.json 的 private 节点，
        因为文件层记忆会被注入家长侧的传话筒 prompt，一旦落盘就是潜在泄露。
        """
        lock = lock_for(self.dir)
        async with lock:
            await asyncio.to_thread(self._write_extraction_sync, data, is_secret)

    _SECRET_MARKER = "（悄悄话一条，内容保密，只记进孩子自己的图谱）"

    def _write_extraction_sync(self, data: dict, is_secret: bool = False) -> None:
        today = date.today().isoformat()
        if is_secret:
            # 只留"今天有过一条悄悄话"的存在性记录，内容绝不进文件层
            daily_path = self.dir / "daily" / f"{today}.md"
            if daily_path.exists():
                old = daily_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {today}\n\n"
            if self._SECRET_MARKER not in old:
                atomic_write(daily_path, old + f"- {self._SECRET_MARKER}\n")
            return
        daily_text = (data.get("daily") or "").strip()
        if daily_text:
            daily_path = self.dir / "daily" / f"{today}.md"
            if daily_path.exists():
                old = daily_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {today}\n\n"
            atomic_write(daily_path, old + f"- {daily_text}\n")

        index = self.read_index()
        for t in data.get("topics") or []:
            name = (t.get("name") or "").strip()
            fact = (t.get("fact") or "").strip()
            if not name or not fact:
                continue
            status = t.get("status") or "active"
            related = [str(w).strip() for w in t.get("related") or [] if str(w).strip()]
            info = index.setdefault("topics", {}).get(name)
            if info:
                meta = _parse_topic(self._topic_text(info.get("file", "")))
                body = (meta["body"] + f"\n- {today}：{fact}").strip()
                merged_rel = sorted(set(info.get("related", [])) | set(related))
                atomic_write(self.dir / info["file"], _render_topic(name, status, merged_rel, body))
                info.update({"status": status, "related": merged_rel})
            else:
                safe = re.sub(r"[^\w一-鿿-]", "_", name)[:40] or "topic"
                rel_file = f"topics/{safe}.md"
                atomic_write(self.dir / rel_file, _render_topic(name, status, related, f"- {today}：{fact}"))
                index["topics"][name] = {"status": status, "related": related, "file": rel_file}
        write_json(self.index_path, index)

        longterm = (data.get("longterm") or "").strip()
        if longterm:
            mem_path = self.dir / "MEMORY.md"
            if mem_path.exists():
                old = mem_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {self.child_name}的长期记忆\n"
            atomic_write(mem_path, old + f"- {longterm}\n")


async def extract_and_store(store: MemoryStore, user_msg: str, assistant_msg: str,
                            graph_store=None, is_secret: bool = False,
                            affairs_brief: str = "") -> dict | None:
    """轮后异步沉淀：LLM 抽取 → 落盘。失败静默（沉淀不阻塞对话）。

    不传 graph_store：与从前完全一致（daily/topics/MEMORY.md），返回 None。
    传了 graph_store：改用 EXTRACT_GRAPH 一次抽取，除原有沉淀外合并成长图谱，
    返回 main.py 的 memory 事件载荷；没有新增节点/边/事务进展则返回 None（不发事件）。
    is_secret 时文件层只写占位行，私密事实只进图谱 private 节点（见 write_extraction）。
    """
    try:
        if graph_store is None:
            name, topic_names = await asyncio.to_thread(
                lambda: (store.child_name, store.topic_names()))
            data = await llm.complete_json(
                [
                    {"role": "system", "content": "你是记忆整理模块，只输出 JSON。"},
                    {"role": "user", "content": prompts.EXTRACT.format(
                        name=name,
                        topic_names=topic_names,
                        user=user_msg,
                        assistant=assistant_msg,
                    )},
                ],
                max_tokens=600,
                caller="extract",
            )
            await store.write_extraction(data, is_secret=is_secret)
            return None

        name, graph_brief = await asyncio.to_thread(
            lambda: (store.child_name, graph_store.brief_block(limit=24)))
        data = await llm.complete_json(
            [
                {"role": "system", "content": "你是记忆整理模块，只输出 JSON。"},
                {"role": "user", "content": prompts.EXTRACT_GRAPH.format(
                    name=name,
                    graph_brief=graph_brief or "（还没有图谱，这是第一批节点）",
                    affairs_brief=affairs_brief or "（目前没有正在跟进的事）",
                    user=user_msg,
                    assistant=assistant_msg,
                )},
            ],
            max_tokens=900,
            caller="extract_graph",
        )
        if is_secret:
            # 服务端强制兜底：悄悄话的图谱节点一律 private、事务进展一律丢弃，
            # 不依赖模型自觉——模型漏标 private 时私密事实会混进公共节点，
            # 家长图谱 / 晨报 / 传话筒 prompt 会全链路泄露。
            for n in data.get("nodes") or []:
                if isinstance(n, dict):
                    n["private"] = True
            data["affair"] = None
        # 记忆文件与 graph.json 是两份独立存储，写盘并行（各自内部已 to_thread + 目录锁）
        _, merged = await asyncio.gather(
            store.write_extraction(data, is_secret=is_secret),
            asyncio.to_thread(graph_store.merge, data),
        )
        event = await asyncio.to_thread(_graph_event, graph_store, merged) or {}
        affair = _valid_affair(data.get("affair"))
        if affair:
            event["affair"] = affair
        return event or None
    except Exception as e:
        print(f"[memory] 沉淀失败（不影响对话）: {e}")
        return None


def _valid_affair(raw) -> dict | None:
    """抽取结果里的 affair 字段：必须是 {id, stage, note} 且 stage 合法，否则丢弃。"""
    if not isinstance(raw, dict):
        return None
    aid = str(raw.get("id") or "").strip()
    stage = str(raw.get("stage") or "").strip()
    if not aid or stage not in ("executing", "waiting", "followup", "done"):
        return None
    return {"id": aid, "stage": stage, "note": str(raw.get("note") or "")[:40]}


def _graph_event(graph_store, merged: dict) -> dict | None:
    """把 merge 结果整理成 §5 的 memory 事件载荷；没有新增就返回 None。"""
    added_nodes = merged.get("added_nodes") or []
    added_edges = merged.get("added_edges") or []
    updated = merged.get("updated") or []
    if not added_nodes and not added_edges and not updated:
        return None
    labels = {n["id"]: n.get("label", n["id"]) for n in added_nodes}
    note = _note(graph_store, added_nodes, added_edges, labels)
    if updated:
        upd = "、".join(dict.fromkeys(str(u.get("label") or u.get("id")) for u in updated[:3]))
        note = f"{note}；补充进：{upd}" if note else f"记进了：{upd}"
    return {
        "added_nodes": added_nodes,
        "added_edges": added_edges,
        "updated": updated,
        "note": note,
    }


def _note(graph_store, added_nodes: list[dict], added_edges: list[dict], labels: dict) -> str:
    """用新增节点/边的标签拼一句人话，如"记下了：攒钱 —为了→ 换电脑"。"""
    names = list(dict.fromkeys(n.get("label", n.get("id", "")) for n in added_nodes))
    ids = dict(labels)
    try:
        ids.update({n["id"]: n.get("label", n["id"]) for n in graph_store.load().get("nodes", [])})
    except Exception:  # noqa: BLE001 图谱读失败就用已给的标签拼
        pass
    edges = [
        f"{ids.get(e.get('source'), e.get('source'))} —{e.get('rel') or '联想到'}→ "
        f"{ids.get(e.get('target'), e.get('target'))}"
        for e in added_edges[:2]
    ]
    parts = [p for p in (["、".join(names)] if names else []) + edges if p]
    return "记下了：" + "；".join(parts) if parts else ""
