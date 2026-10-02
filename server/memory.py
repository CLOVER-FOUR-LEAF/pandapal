"""文件式记忆：读（活跃块注入 + 主题检索）与写（LLM 抽取 + 原子落盘）。

目录布局（data/child_xxx/）：
  MEMORY.md     长期记忆
  topics/*.md   主题档案（头部 status/related 元数据 + 正文事实追加）
  daily/*.md    每日沉淀
  index.json    {name, topics: {名: {status, related, file}}}
所有写操作走单写锁 + tmp→rename 原子替换，评委并发操作不会写坏档案。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import date, datetime
from pathlib import Path

from . import llm, prompts

_LOCKS: dict[Path, asyncio.Lock] = {}
_LOCKS_GUARD = asyncio.Lock()


async def _lock_for(child_dir: Path) -> asyncio.Lock:
    async with _LOCKS_GUARD:
        return _LOCKS.setdefault(child_dir, asyncio.Lock())


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


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
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"name": self.dir.name, "topics": {}}

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
        return "\n\n".join(parts)

    @staticmethod
    def _bigrams(text: str) -> set[str]:
        runs = re.findall(r"[\u4e00-\u9fff]+", text)
        return {r[i : i + 2] for r in runs for i in range(len(r) - 1)} | {
            w.lower() for w in re.findall(r"[A-Za-z0-9]+", text)
        }

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
        return "\n\n".join(parts)

    def topic_names(self) -> str:
        return ", ".join(self.read_index().get("topics", {}).keys()) or "（空）"

    def due_reminders(self) -> list[dict]:
        """到期提醒：daily 每天触发；weekly:sat 每周对应日；日期当天及前 2 天提示。"""
        try:
            items = json.loads((self.dir / "reminders.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
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

    async def write_extraction(self, data: dict) -> None:
        """把 LLM 抽取结果落盘：daily 追加 + 主题 upsert + MEMORY.md 追加。单写锁保护。"""
        lock = await _lock_for(self.dir)
        async with lock:
            await asyncio.to_thread(self._write_extraction_sync, data)

    def _write_extraction_sync(self, data: dict) -> None:
        today = date.today().isoformat()
        daily_text = (data.get("daily") or "").strip()
        if daily_text:
            daily_path = self.dir / "daily" / f"{today}.md"
            old = ""
            if daily_path.exists():
                old = daily_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {today}\n\n"
            _atomic_write(daily_path, old + f"- {daily_text}\n")

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
                _atomic_write(self.dir / info["file"], _render_topic(name, status, merged_rel, body))
                info.update({"status": status, "related": merged_rel})
            else:
                safe = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name)[:40] or "topic"
                rel_file = f"topics/{safe}.md"
                _atomic_write(self.dir / rel_file, _render_topic(name, status, related, f"- {today}：{fact}"))
                index["topics"][name] = {"status": status, "related": related, "file": rel_file}
        _atomic_write(self.index_path, json.dumps(index, ensure_ascii=False, indent=2))

        longterm = (data.get("longterm") or "").strip()
        if longterm:
            mem_path = self.dir / "MEMORY.md"
            old = ""
            if mem_path.exists():
                old = mem_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {self.child_name}的长期记忆\n"
            _atomic_write(mem_path, old + f"- {longterm}\n")


async def extract_and_store(store: MemoryStore, user_msg: str, assistant_msg: str) -> None:
    """轮后异步沉淀：LLM 抽取 → 落盘。失败静默（沉淀不阻塞对话）。"""
    try:
        data = await llm.complete_json(
            [
                {"role": "system", "content": "你是记忆整理模块，只输出 JSON。"},
                {"role": "user", "content": prompts.EXTRACT.format(
                    name=store.child_name,
                    topic_names=store.topic_names(),
                    user=user_msg,
                    assistant=assistant_msg,
                )},
            ],
            max_tokens=600,
            caller="extract",
        )
        await store.write_extraction(data)
    except Exception as e:
        print(f"[memory] 沉淀失败（不影响对话）: {e}")
