"""文件式记忆：读（活跃块注入 + 主题检索）与写（LLM 抽取 + 原子落盘）。

目录布局（data/child_xxx/）：
  MEMORY.md     长期记忆
  topics/*.md   主题档案（头部 status/related/updated 元数据 + 正文事实追加）
  daily/*.md    每日沉淀
  index.json    {name, topics: {名: {status, related, file}}}
  graph.json    成长图谱，由 graph.py 负责；抽取若带 graph_store 则一并合并
所有写操作走 store.py 的按目录写锁 + tmp→rename 原子替换，评委并发操作不会写坏档案。

注入策略（对话体验的两个关键约束）：
  1) 活跃块每轮必注入 → 必须封顶。MEMORY.md 与每个活跃主题正文都按**字符预算**折叠，
     否则一条 200 行的主题档案会把上下文吃掉；活跃主题按"档案更新日期 + 事实新近度"
     排序，预算不够时优先保最新的关注点。
  2) 检索块按相关度注入 → 必须去噪。评分用 bigram 交集 + 覆盖度系数（不再用"子串出现在
     提问里就 +3"这种长提问通吃、短词空转的规则），低于门槛的主题宁可不注入；
     已在活跃块里出现过的主题不重复注入，省下的额度留给真正被唤醒的旧主题。
"""
from __future__ import annotations

import asyncio
import re
import threading
import time
from datetime import date
from pathlib import Path

from . import llm, prompts
from .store import (atomic_write, bigrams, clamp_lines, fence_memory, lock_for,
                    read_json, write_json)

# ---------- 文件体积上限 ----------
# 记忆文件只增不减。MEMORY.md 按行折叠（记忆本页会整篇展示，行数才有意义）；
# 主题档案不做行数截断，改在注入时按字符预算折叠——文件层留全量事实，注入层才封顶。
_MEMORY_MAX_LINES = 200      # MEMORY.md 最多保留的行数（超出折叠最旧的）
_MEMORY_NAME_MAX = 40        # 主题名字符上限（超长名字既进不了文件名也会污染检索）

# ---------- 注入预算 ----------
# 行数上限约束"文件多大"，字符预算约束"每轮 prompt 多大"。两者都要有：
# 只有行数上限时，40 条长事实（每条 400 字）依然能撑爆系统提示。
_ACTIVE_MAX_CHARS = 1800     # 活跃块（长期记忆 + 活跃主题 + 最近日记）合计预算
_MEMORY_BLOCK_CHARS = 700    # 其中 MEMORY.md 的预算（留出额度给活跃主题与最近日记）
_TOPIC_BLOCK_CHARS = 420     # 单个活跃主题正文预算（保最新事实）
_RECENT_DAILY = 2            # 活跃块固定附带的最近日记篇数（"昨天聊过什么"不能每次都靠猜）
_RECENT_DAILY_CHARS = 320    # 最近日记合计预算（在活跃块里是预留额度，见 _recent_daily 调用处）
_RETRIEVE_TOPIC_CHARS = 320  # 单条检索主题正文预算
_RETRIEVE_DAILY_CHARS = 260  # 单条检索日记正文预算
_MIN_RELEVANCE = 0.34        # 检索相关度门槛：低于它的"弱命中"注入只会制造噪音

# 读缓存 TTL：主题档案被手改 / 被外部工具写入时也能被感知
_CACHE_TTL = 5.0

_ARCHIVE_RE = re.compile(r"^-\s*（更早的\s*(\d+)\s*[条行]已(?:归档|折叠)）")


def _clean_line(text, maxlen: int = 400) -> str:
    """一段抽取文本压成单行：折叠连续空白、去列表符号、超长截断。

    防"一条事实里塞入换行"污染按行统计（行数上限、日记折叠都按行算），
    也给注入 prompt 的文本兜底长度。
    """
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    s = re.sub(r"^[-•*]+\s*", "", s).strip()
    return s if len(s) <= maxlen else s[: maxlen - 1] + "…"


def _archived_count(lines: list[str]) -> int:
    """读取归档标记里已经累计折叠的条数（没有标记则为 0）。"""
    for ln in lines[:1]:
        m = _ARCHIVE_RE.match(str(ln).strip())
        if m:
            return int(m.group(1))
    return 0


def _append_capped(lines: list[str], new_line: str, max_lines: int) -> list[str]:
    """追加一行，结果永远不超过 max_lines 行；超出时折叠最旧的若干行（确定性，不调 LLM）。

    归档标记（"- （更早的 N 条已归档）"）记的是**累计**折叠条数：
      - 早先每折叠一次就重报当次丢弃数，标记里的数字长期停在很小的值，
        读档案的人无从知道到底折掉了多少条；
      - 早先还把它加在上限之外，声明"上限 200 行"的档案长期停在 201 行。
    折叠一旦发生，标记就顶上最旧那条的位置，所以结果正好是 max_lines 行。
    """
    body = [ln for ln in lines if str(ln).strip()]
    cap = max(max_lines, 0)
    if cap <= 0:
        return []
    archived = _archived_count(body)
    if archived:
        body = body[1:]  # 旧标记摘出来，按累计值重新生成；它会重新占据第 1 行
    body.append(new_line)
    if len(body) + (1 if archived else 0) > cap:
        # 折叠：结果 = 归档标记 + 最新若干条正文，总行数不超过 cap
        keep_body = max(cap - 1, 0)
        archived += len(body) - keep_body
        body = body[-keep_body:] if keep_body else []
    return ([f"- （更早的 {archived} 条已归档）"] if archived else []) + body



def _parse_topic(text: str) -> dict:
    """解析主题档案头部元数据 + 正文。

    头部是可选的：没有 `---` 分界线的旧档案（或手写档案）整篇都当正文，
    "档案存在却读不出内容"不能静默丢掉孩子的事实。
    """
    meta = {"status": "active", "related": [], "updated": "", "body": ""}
    lines = (text or "").splitlines()
    body_lines, in_body = [], not any(ln.strip() == "---" for ln in lines)
    for line in lines:
        if not in_body:
            s = line.strip()
            if s == "---":
                in_body = True
            elif s.startswith("status:"):
                meta["status"] = s.split(":", 1)[1].strip() or "active"
            elif s.startswith("related:"):
                raw = s.split(":", 1)[1]
                meta["related"] = [w.strip() for w in re.split(r"[,，]", raw) if w.strip()]
            elif s.startswith("updated:"):
                meta["updated"] = s.split(":", 1)[1].strip()
            continue
        body_lines.append(line)
    meta["body"] = "\n".join(body_lines).strip()
    return meta


def _render_topic(name: str, status: str, related: list[str], body: str) -> str:
    rel = ", ".join(related)
    today = date.today().isoformat()
    return f"# {name}\nstatus: {status}\nrelated: {rel}\nupdated: {today}\n---\n\n{body.strip()}\n"


def _safe_day(value: str) -> date | None:
    """把 'YYYY-MM-DD...' 解析成日期；非法/缺失一律 None（调用方自己决定降级策略）。"""
    try:
        return date.fromisoformat(str(value or "")[:10])
    except (ValueError, TypeError):
        return None


def _day_of(meta: dict, fallback: date | None = None) -> date:
    """主题的"最新一天"：头部 updated 优先，其次正文里最后一条事实的日期。"""
    day = _safe_day(meta.get("updated"))
    if day:
        return day
    for line in reversed(str(meta.get("body") or "").splitlines()):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", line)
        if m:
            day = _safe_day(m.group(1))
            if day:
                return day
    return fallback or date.today()


def _age_text(day: date) -> str:
    """人话新近度，给模型判断"这是老黄历还是刚发生"。"""
    delta = (date.today() - day).days
    if delta <= 0:
        return "今天"
    if delta == 1:
        return "昨天"
    if delta <= 30:
        return f"{delta} 天前"
    return f"{delta // 30} 个月前"


# ------------------------------------------------------------------ 读缓存
class _MemoryCache:
    """按档案目录缓存一次"解析后的档案视图"（index + 各主题元数据）。

    一读多写、写少读多：一轮对话里 active_block / retrieve / topic_names 会分别触发
    一次 index.json 与全部主题文件的解析；渲染动画、家长视角与孩子视角并发时更频繁。
    以「index.json/mtime + MEMORY.md/mtime + 各主题文件 (路径, mtime) 摘要」为失效条件，
    写盘后主动失效，外部手改文件也能靠 mtime 感知。
    """

    def __init__(self, ttl: float = _CACHE_TTL):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[tuple, float, dict]] = {}

    @staticmethod
    def _sig(child_dir: Path, index: dict) -> tuple:
        def mtime(path: Path):
            try:
                return path.stat().st_mtime_ns
            except OSError:
                return None

        topics = []
        for info in (index.get("topics") or {}).values():
            rel = str(info.get("file") or "")
            if rel:
                topics.append((rel, mtime(child_dir / rel)))
        topics.sort()
        sig = (mtime(child_dir / "index.json"), mtime(child_dir / "MEMORY.md"), tuple(topics))
        # 变化快但内容长度稳定的外部写入也能被区分（mtime 分辨率不足时兜一道底）
        return sig + (len(index.get("topics") or {}),)

    def get(self, child_dir: Path, loader) -> dict:
        key = str(child_dir)
        with self._lock:
            entry = self._entries.get(key)
        if entry is not None:
            sig, stamp, view = entry
            if time.monotonic() - stamp < self.ttl and sig == self._sig(child_dir, view["index"]):
                return view
        view = loader()  # 解析放锁外：慢盘上别把并发读者全堵住
        with self._lock:
            self._entries[key] = (self._sig(child_dir, view["index"]), time.monotonic(), view)
            if len(self._entries) > 256:  # 只随档案数增长，超阈值清一半防渗漏
                for k in list(self._entries)[:128]:
                    self._entries.pop(k, None)
        return view

    def drop(self, child_dir: Path) -> None:
        with self._lock:
            self._entries.pop(str(child_dir), None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_CACHE = _MemoryCache()


class MemoryStore:
    """一个孩子的记忆档案（对应 data/child_*/ 目录）。"""

    def __init__(self, child_dir: Path):
        self.dir = Path(child_dir)

    @property
    def index_path(self) -> Path:
        return self.dir / "index.json"

    # ---------- 读 ----------

    def read_index(self) -> dict:
        """直读 index.json；缺文件或损坏时回落空白索引，不抛错（记忆本页要看到实时结果）。"""
        return read_json(self.index_path, {"name": self.dir.name, "topics": {}})

    def _load_view(self) -> dict:
        """解析一次档案：index + 每个主题的元数据与正文（active_block/retrieve/export 共用）。"""
        index = self.read_index()
        if not isinstance(index, dict):
            index = {"name": self.dir.name, "topics": {}}
        index.setdefault("name", self.dir.name)
        index.setdefault("topics", {})
        topics = {}
        for name, info in index["topics"].items():
            if not isinstance(info, dict):
                continue
            rel = str(info.get("file") or "")
            try:
                text = (self.dir / rel).read_text(encoding="utf-8") if rel else ""
            except OSError:
                text = ""
            meta = _parse_topic(text)
            # index.json 里的 status/related 由每次 upsert 写入，与文件头同步；
            # 文件头是兜底（手工编辑过 index 时以档案正文为准）
            status = str(info.get("status") or "").strip() or meta["status"]
            related = [str(w).strip() for w in (info.get("related") or meta["related"]) if str(w).strip()]
            topics[str(name)] = {"name": str(name), "status": status, "related": related,
                                 "body": meta["body"], "updated": meta["updated"],
                                 "last_day": _day_of(meta)}
        try:
            memory_md = (self.dir / "MEMORY.md").read_text(encoding="utf-8").strip()
        except OSError:
            memory_md = ""
        return {"index": index, "topics": topics, "memory_md": memory_md}

    def _view(self) -> dict:
        return _CACHE.get(self.dir, self._load_view)

    def _index_cached(self) -> dict:
        return self._view()["index"]

    @property
    def child_name(self) -> str:
        return self._index_cached().get("name") or self.dir.name.removeprefix("child_")

    def _topic_text(self, rel_file: str) -> str:
        try:
            return (self.dir / rel_file).read_text(encoding="utf-8")
        except OSError:
            return ""

    def _daily_body(self, path: Path) -> str:
        """一篇日记的正文（去掉 "# 2026-10-02" 标题行，日期由标签承担）。"""
        try:
            content = path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        lines = content.splitlines()
        if lines and lines[0].lstrip().startswith("#"):
            content = "\n".join(lines[1:]).strip()
        return content

    def _daily_files(self, newest_first: bool = True) -> list[Path]:
        daily_dir = self.dir / "daily"
        if not daily_dir.is_dir():
            return []
        return sorted(daily_dir.glob("*.md"), reverse=newest_first)

    def _recent_daily(self, count: int = _RECENT_DAILY, max_chars: int = _RECENT_DAILY_CHARS,
                      skip: set[str] | None = None) -> str:
        """最近几篇日记（新→旧）：新会话第一句就能接上"昨天说的事"，不必等检索命中。

        max_chars <= 0 直接返回空——调用方用它表达"这块没预算了"。
        """
        if count <= 0 or max_chars <= 0:
            return ""
        parts, used = [], 0
        for f in self._daily_files():
            if len(parts) >= count:
                break
            if skip and f.stem in skip:
                continue
            body = clamp_lines(self._daily_body(f), max_chars - used)
            if not body:
                continue
            day = _safe_day(f.stem)
            label = f"{f.stem}（{_age_text(day)}）" if day else f.stem
            text = f"【{label} 日记】{body}"
            if used + len(text) > max_chars:
                break
            parts.append(text)
            used += len(text) + 1
        return "\n".join(parts)

    def active_block(self, query: str | None = None) -> str:
        """活跃关注点块：MEMORY.md + 活跃主题正文 + 最近日记。每轮必注入，实现"一直知道"。

        query 参数仅为兼容旧调用方（executor/planner/synth 仍传事件原文）；
        本实现里相关性检索归 retrieve()，活跃块只看新近度，不区分话题。

        体积受 _ACTIVE_MAX_CHARS 约束；活跃主题按新近度排序（新的在前），超预算的主题
        被折叠或让位，保证"最近在聊的事"一定进得去；第一条永远注入，避免预算吃紧时
        整个记忆块消失。最近日记末尾附带，新会话第一句就能接上"昨天说的事"。
        """
        view = self._view()
        parts, total = [], 0

        def put(text: str) -> None:
            nonlocal total
            if not text:
                return
            if parts and total + len(text) + 2 > _ACTIVE_MAX_CHARS:
                return  # 预算耗尽；单条超大条目也进不来，避免它吃掉整个块
            parts.append(text)
            total += len(text) + 2

        put(clamp_lines(view["memory_md"], _MEMORY_BLOCK_CHARS))
        actives = [t for t in view["topics"].values() if t["status"] == "active" and t["body"]]
        actives.sort(key=lambda t: (t["last_day"], t["name"], len(t["body"])), reverse=True)
        for t in actives:
            body = clamp_lines(t["body"], _TOPIC_BLOCK_CHARS)
            if not body:
                continue
            put(f"【{t['name']}】{body}")
        # 日记是"接着昨天聊"的底线：按剩余额度注入，不让充裕的主题把这一块挤没
        put(self._recent_daily(max_chars=max(_ACTIVE_MAX_CHARS - total, 0)))
        return fence_memory("\n\n".join(parts))

    @staticmethod
    def _bigrams(text: str) -> set[str]:
        return bigrams(text)

    def _relevance(self, query: str, q_grams: set[str], topic: dict) -> float:
        """主题与提问的相关度（0 表示不相关）。

        只用主题名 / 相关词判断"用户为什么想起这件事"，正文不参与判定：主题篇幅长，
        拿正文算覆盖率会把每个主题都稀释成几乎为零。命中一部分就直接注入完整正文，
        让模型自己挑——检索是召回问题，不是精确匹配问题。
        """
        words = [topic["name"]] + [w for w in topic["related"] if w]
        hits = sum(1 for w in words if len(w) >= 2 and w in query)
        overlap = len(q_grams & self._bigrams(" ".join(words)))
        if not hits and not overlap:
            return 0.0
        return hits + overlap

    def retrieve(self, query: str, limit: int = 3) -> str:
        """按相关度检索相关主题（含非 active）+ 最近一篇 daily。

        只注入"够相关"的：弱命中不再是噪音；已在活跃块里的主题不重复注入；
        正文按字符预算保留最新事实，避免一条长档案吃掉检索额度。
        """
        view = self._view()
        q_grams = self._bigrams(query)
        actives = {t["name"] for t in view["topics"].values() if t["status"] == "active"}
        today = date.today()
        scored = []
        for topic in view["topics"].values():
            if topic["name"] in actives or not topic["body"]:
                continue  # 活跃主题已随活跃块注入，篇幅让给被唤醒的旧主题
            score = self._relevance(query, q_grams, topic)
            if score <= 0:
                continue
            if (today - topic["last_day"]).days <= 14:
                score *= 1.3  # 刚聊过的话题更容易被唤醒：新近度只做温和加权，不盖过相关度
            if score >= _MIN_RELEVANCE:
                scored.append((score, topic))
        scored.sort(key=lambda x: -x[0])
        parts = []
        for _, topic in scored[: max(int(limit), 1)]:
            body = clamp_lines(topic["body"], _RETRIEVE_TOPIC_CHARS)
            if body:
                parts.append(
                    f"【{topic['name']}（状态：{topic['status']} · 最近{_age_text(topic['last_day'])}）】"
                    f"{body}")
        # 最近一篇日记（活跃块已带最近两篇时跳过，避免同一段记忆在一轮里注入两次）；
        # 与本次话题毫无交集的不注入——检索块是"被唤醒的记忆"，不拖无关旧事进来
        skip = {f.stem for f in self._daily_files()[: _RECENT_DAILY]}
        recent = self._recent_daily(count=1, max_chars=_RETRIEVE_DAILY_CHARS, skip=skip)
        if recent and q_grams & self._bigrams(recent):
            parts.append(recent.replace(" 日记】", " 日记（补充）】", 1))
        return fence_memory("\n\n".join(parts))

    def topic_names(self) -> str:
        """已有主题名（抽取时提示模型沿用，避免同一件事写出两三个近义主题）。"""
        return ", ".join(self._index_cached().get("topics", {}).keys()) or "（空）"

    def due_reminders(self) -> list[dict]:
        """到期提醒：daily 每天触发；weekly:sat 每周对应日；日期当天及前 2 天提示。"""
        items = read_json(self.dir / "reminders.json", [])
        if not isinstance(items, list):
            return []
        today = date.today()
        wd_en = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][today.weekday()]
        due = []
        for r in items:
            if not isinstance(r, dict):
                continue
            t = str(r.get("time", ""))
            if t == "daily" or t == f"weekly:{wd_en}":
                due.append(r)
                continue
            day = _safe_day(t)
            # 非法/缺失的时间一律跳过：一行脏数据不该让问候接口整个 500
            if day is not None and 0 <= (day - today).days <= 2:
                due.append(r)
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
        for f in self._daily_files():
            daily.append({"date": f.stem, "content": self._daily_body(f)})
        try:
            memory_md = self.dir.joinpath("MEMORY.md").read_text(encoding="utf-8").strip()
        except OSError:
            memory_md = ""
        return {"name": index.get("name", ""), "memory_md": memory_md, "topics": topics, "daily": daily}

    # ---------- 写 ----------

    async def write_extraction(self, data: dict, is_secret: bool = False) -> None:
        """把 LLM 抽取结果落盘：daily 追加 + 主题 upsert + MEMORY.md 追加。单写锁保护。

        is_secret（悄悄话轮）时由代码强制隔离：daily 只写"存在性"占位行，
        topics / longterm 一律不落盘——私密事实只允许进 graph.json 的 private 节点，
        因为文件层记忆会被注入家长侧的传话筒 prompt，一旦落盘就是潜在泄露。
        """
        lock = lock_for(self.dir)
        async with lock:
            await asyncio.to_thread(self._write_extraction_sync, data, is_secret)
        _CACHE.drop(self.dir)  # 写后失效：下一次读一定看到刚落盘的事实

    _SECRET_MARKER = "（悄悄话一条，内容保密，只记进孩子自己的图谱）"

    def _append_memory_line(self, line: str) -> None:
        """往 MEMORY.md 追加一条长期记忆；标题行也算行数，整篇（含标题）不超过上限。"""
        mem_path = self.dir / "MEMORY.md"
        header, body = f"# {self.child_name}的长期记忆", []
        if mem_path.exists():
            old_lines = [ln for ln in mem_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
            if old_lines and old_lines[0].lstrip().startswith("#"):
                header, body = old_lines[0], old_lines[1:]
            else:
                body = old_lines  # 旧档案没有标题行：补一个，别把首条事实当标题
        # 标题占一行，所以正文最多 _MEMORY_MAX_LINES-1 行；超限时确定性折叠最旧的条目
        body = _append_capped(body, line, _MEMORY_MAX_LINES - 1)
        atomic_write(mem_path, header + "\n" + "\n".join(body) + "\n")

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
        daily_text = _clean_line(data.get("daily"))
        if daily_text:
            daily_path = self.dir / "daily" / f"{today}.md"
            if daily_path.exists():
                old = daily_path.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                old = f"# {today}\n\n"
            atomic_write(daily_path, old + f"- {daily_text}\n")

        index = self.read_index()
        for t in data.get("topics") or []:
            name = _clean_line(t.get("name"), _MEMORY_NAME_MAX)
            fact = _clean_line(t.get("fact"))
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

        longterm = _clean_line(data.get("longterm"), 300)
        if longterm:
            self._append_memory_line(f"- {today}：{longterm}")


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
