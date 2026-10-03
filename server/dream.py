"""Dreaming 记忆整理引擎（设计参考 OpenPanda internal/memory/dream.go）。

管家的记忆只增不理：daily 每轮追加从不合并，MEMORY.md 到 200 行直接
折叠丢事实——反复出现的重要事和一次性的碎碎念躺在同一层。

三阶段、全确定性、不调 LLM（梦不需要再造一个大脑）：

  Light  扫 daily/*.md 收集事实行，跨天近似去重成候选：
         同一件事说过 3 次 → 一个候选（记下出现在哪几天、共几次）
  REM    按主题词把候选分组，写一页"梦日记"（dream/YYYY-MM-DD.md）：
         可视化"管家昨晚在想什么"，演示与调试两用
  Deep   五信号打分晋升：跨天多样性 + 频率 + 新近度 + 跨度 + 概念密度。
         跨过门槛的事实追加进 MEMORY.md，行首标 [梦] ——出处可查，
         评委一眼分清哪些是管家自己"梦"出来的长期记忆

隐私边界：悄悄话的 daily 占位行（"悄悄话一条"）不含任何内容，
天然进不了候选；secret 轮也不触发做梦（调用方负责）。
"""
from __future__ import annotations

import asyncio
import re
from datetime import date
from pathlib import Path

from .memory import MemoryStore, _is_dup
from .store import atomic_write, lock_for, read_json, write_json

_STATE_FILE = "dream_state.json"
_DIARY_DIR = "dream"
_SECRET_SKIP = "悄悄话一条"      # SECRET_MARKER 的特征词，命中即跳过
_TOPIC_TAG = re.compile(r"（话题：[^）]*）\s*$")
_BULLET = re.compile(r"^-\s*")
_DAY_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}[ 0-9:：]*")
_NOISE = ("管家", "小豆说", "我问", "他说", "她说")

# 晋升门槛：至少出现在 2 个不同的日子（单日反复说=当天的事，隔天才叫放不下），
# 且综合分过线。权重沿用 OpenPanda 的配比思想，按我们的信号集重排。
_MIN_DAYS = 2
_PROMOTE_SCORE = 0.6
_W_DAYS, _W_FREQ, _W_RECENT, _W_SPAN, _W_DENSE = 0.30, 0.25, 0.15, 0.15, 0.15
_TOP_THEMES = 4               # 梦日记里写的主题组数
_STATE_PROMOTED = "promoted"  # state 里已晋升过的规范行 → 幂等不重升


def _norm(text: str) -> str:
    """规范化事实行用于近似去重：剥话题尾巴、项目符号、日期前缀与标点。"""
    t = _TOPIC_TAG.sub("", _BULLET.sub("", text.strip()))
    t = _DAY_PREFIX.sub("", t)
    return re.sub(r"[，。！？；、\s:：]+", "", t)


def _parse_day(path: Path) -> date | None:
    try:
        return date.fromisoformat(path.stem)
    except ValueError:
        return None


def _light(store: MemoryStore) -> list[dict]:
    """阶段一：扫全部 daily，跨天近似去重成候选事实。"""
    cands: list[dict] = []  # {text, norm, days:set[date], count:int}
    daily_dir = store.dir / "daily"
    if not daily_dir.is_dir():
        return cands
    for f in sorted(daily_dir.glob("*.md")):
        day = _parse_day(f)
        if day is None:
            continue
        try:
            lines = f.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for ln in lines:
            raw = ln.strip()
            if not raw.startswith("-") or _SECRET_SKIP in raw:
                continue
            norm = _norm(raw)
            if len(norm) < 6:  # 太短的不是事实是碎碎念（"好开心"）
                continue
            hit = next((c for c in cands if _is_dup(norm, [c["norm"]])), None)
            if hit is None:
                cands.append({"text": raw.lstrip("- ").strip(), "norm": norm,
                              "days": {day}, "count": 1})
            else:
                hit["days"].add(day)
                hit["count"] += 1
                if len(raw) > len(hit["text"]):  # 留信息最全的那一版说法
                    hit["text"] = raw.lstrip("- ").strip()
    return cands


def _score(c: dict, today: date) -> float:
    """阶段三打分：五信号加权，0..1。"""
    days, count = c["days"], c["count"]
    day_div = min(len(days) / 3, 1.0)                       # 至少 3 天才满分
    freq = min(count / 4, 1.0)                              # 4 次起满分
    span = min((max(days) - min(days)).days / 7, 1.0)       # 跨一周满分
    recent = max(0.0, 1.0 - (today - max(days)).days / 14)  # 两周内线性衰减
    dense = min(len(c["norm"]) / 24, 1.0)                   # 有实料的句子更长
    return (_W_DAYS * day_div + _W_FREQ * freq + _W_SPAN * span
            + _W_RECENT * recent + _W_DENSE * dense)


def _themes(cands: list[dict]) -> list[tuple[str, list[dict]]]:
    """REM 主题分组：抓候选里反复出现的实词当主题标签（确定性，不挑模型）。"""
    freq: dict[str, list[dict]] = {}
    stop = set(_NOISE) | {"一天", "今天", "明天", "昨天", "现在", "我们", "他们", "自己"}
    for c in cands:
        for w in set(re.findall(r"[一-鿿]{2,4}", c["norm"])):
            if w in stop:
                continue
            freq.setdefault(w, []).append(c)
    # 主题词按"关联候选数"粗排：越能串起多条记忆的词越像真主题；
    # 已归组的候选不再重复进别的组，免得日记里同一件事换词又说一遍
    ranked = sorted(freq.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    groups, used = [], set()
    for word, members in ranked:
        fresh = [m for m in members if id(m) not in used]
        if len(fresh) >= 2:
            groups.append((word, fresh))
            used.update(id(m) for m in fresh)
        if len(groups) >= _TOP_THEMES:
            break
    return groups


def _diary(store: MemoryStore, groups: list[tuple[str, list[dict]]],
           promoted: list[str], today: date) -> None:
    """写一页梦日记：管家昨晚整理记忆时'想'到了什么。"""
    lines = [f"# {today.isoformat()} 的梦", ""]
    if promoted:
        lines += ["## 记住的事", ""]
        lines += [f"- {t}" for t in promoted]
        lines.append("")
    if groups:
        lines += ["## 最近总在想", ""]
        for word, members in groups:
            days = sorted({d.isoformat() for m in members for d in m["days"]})
            lines.append(f"- 「{word}」：{len(members)} 件事，横跨 {len(days)} 天")
    (store.dir / _DIARY_DIR).mkdir(exist_ok=True)
    atomic_write(store.dir / _DIARY_DIR / f"{today.isoformat()}.md",
                 "\n".join(lines).rstrip() + "\n")


async def maybe_dream(store: MemoryStore) -> dict | None:
    """每个档案每天最多梦一次；梦过当天就跳过。返回本轮摘要或 None。

    调用方在轮后空闲时 fire-and-forget；全程确定性文件操作（毫秒级），
    写锁与原子写照旧——做梦是锦上添花，不该惊动对话。
    """
    today = date.today().isoformat()
    state = read_json(store.dir / _STATE_FILE, {})
    if state.get("last_day") == today:
        return None
    lock = lock_for(store.dir)
    async with lock:
        state = read_json(store.dir / _STATE_FILE, {})  # 锁内复查：并发下只梦一次
        if state.get("last_day") == today:
            return None
        summary = await _dream_once(store, state)
        state["last_day"] = today
        write_json(store.dir / _STATE_FILE, state)
    return summary


async def _dream_once(store: MemoryStore, state: dict) -> dict:
    cands = await asyncio.to_thread(_light, store)
    today = date.today()
    mem_lines = await asyncio.to_thread(
        lambda: (store.dir / "MEMORY.md").read_text(encoding="utf-8").splitlines()
        if (store.dir / "MEMORY.md").exists() else [])
    mem_norms = [_norm(l) for l in mem_lines if l.strip()]
    seen = set(state.get(_STATE_PROMOTED) or [])
    promoted: list[str] = []
    for c in sorted(cands, key=lambda c: _score(c, today), reverse=True):
        if len(c["days"]) < _MIN_DAYS or _score(c, today) < _PROMOTE_SCORE:
            continue
        if c["norm"] in seen or _is_dup(c["text"], mem_norms):
            continue  # 已经在长期记忆里/梦过一次的事不再晋升——梦不重复
        line = f"- {today.isoformat()}：[梦] {c['text']}"
        await asyncio.to_thread(store._append_memory_line, line)
        mem_norms.append(c["norm"])
        seen.add(c["norm"])
        promoted.append(c["text"])
    groups = _themes(cands)
    await asyncio.to_thread(_diary, store, groups, promoted, today)
    state[_STATE_PROMOTED] = sorted(seen)[-400:]  # 有界：防多年后 state 无限长
    return {"promoted": len(promoted), "themes": len(groups),
            "candidates": len(cands)}
